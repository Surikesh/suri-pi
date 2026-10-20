import { createServer as createNetServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  realpath,
  chmod,
  stat,
  copyFile,
  unlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { importHeader, inspectImportHeader } from "./import-header.js";
import { Storage } from "./storage.js";
import { Assets } from "./assets.js";
import { UiBuilds } from "./ui-builds.js";
import { UpdateStatus } from "./update-status.js";
import { ModernUpdates } from "./modern-updates.js";
import { createRestartLifecycle } from "./restart-lifecycle.js";
import { RetainedHosts } from "./retained-hosts.js";
import { AsyncJobOwner } from "./async-jobs.js";
import { createStream } from "./host-stream.js";
import { createInteractions } from "./host-interactions.js";
import { createMessageWrites } from "./host-message-writes.js";
import { createTransport } from "./host-transport.js";
import { createGrants } from "./host-grants.js";
import { createHttp } from "./host-http.js";
import { createWs } from "./host-ws.js";
import { createHostControl } from "./host-control.js";
import { createCatalogCommands } from "./host-commands-catalog.js";
import { createSettingsCommands } from "./host-commands-settings.js";
import { createCommandLeaves } from "./host-wiring.js";
import { createSessionJobs } from "./host-jobs-session.js";
import { createRunJobs } from "./host-jobs-run.js";
import {
  httpCaps,
  wsCaps,
  buildControlCaps,
  type HostLive,
} from "./host-caps.js";
import { isUpdateCommand } from "../../../packages/protocol/src/update-commands.js";
import {
  admittedWhileClosing,
  hostStopping,
  createPureCommands,
  hasUpdateTarget,
  updateRejected,
  wantsWindowDraftOwner,
  windowDraftOwner,
  checkShutdownIdentity,
  checkShutdownIdle,
} from "./host-decisions.js";
import {
  lockReleaser,
  savedCheckout,
  updatesArgs,
  listenerFailure,
  checkControlPath,
  controlBindFailure,
  endpointJson,
} from "./host-startup.js";
import type { HostOptions, ExecuteInternal } from "./host-types.js";
import { createWork } from "./host-work.js";
import { createControlConnection } from "./host-control-restart.js";
import { createRuntime } from "./host-runtime.js";
import { createQueue } from "./host-queue.js";
import { createQueueWorkers } from "./host-queue-workers.js";
import { createSessionBroker } from "./host-session-broker.js";
import { createSessionStart } from "./host-session-start.js";
import { reportDiagnostic } from "./safe-diagnostics.js";
import { classifyStartupError, StartupBoundaryError } from "./preflight.js";
import { Resources, acquireLock } from "./resources.js";
import { DirectoryPicker } from "./directory-picker.js";
import { RuntimeValidator } from "./runtime-validation.js";
import { closeAndRetire } from "./runtime-exit.js";
import { PiClient, probe } from "../../../packages/pi-adapter/src/index.js";
import {
  SuriError,
  failure,
  requiredString,
  type Command,
  type Data,
  type Receipt,
} from "../../../packages/protocol/src/index.js";
export type { HostOptions } from "./host-types.js";
export async function startHost(options: HostOptions) {
  const launchIdentity = options.launchIdentity
    ? Object.freeze({ ...options.launchIdentity })
    : undefined;
  process.umask(0o077);
  await mkdir(join(options.root, "run"), { recursive: true, mode: 0o700 });
  let lock: Awaited<ReturnType<typeof acquireLock>>;
  try {
    lock = await acquireLock(
      options.helper,
      join(options.root, "run", "host.lock"),
    );
  } catch {
    throw new StartupBoundaryError(classifyStartupError("lock"));
  }
  const releaseLock = lockReleaser(lock);
  let store: Storage;
  try {
    store = new Storage(options.root);
  } catch {
    await releaseLock();
    throw new StartupBoundaryError(classifyStartupError("storage"));
  }
  const assets = new Assets(store);
  const directoryPicker = new DirectoryPicker(options.directoryHome);
  let uiCheckout = options.uiCheckout;
  try {
    uiCheckout = savedCheckout(
      await readFile(join(options.root, "ui-checkout.json"), "utf8"),
      uiCheckout,
    );
  } catch {
    // No readable saved checkout: keep the configured default.
  }
  const ui = new UiBuilds(options.root, options.assets, uiCheckout);
  const updateStatus = new UpdateStatus(
    options.root,
    options.helper,
    launchIdentity,
  );
  const transport = createTransport({ cookieName: () => cookieName });
  const grants = createGrants();
  const { grant, validationGrant } = grants;
  const runtimeValidator = options.runtimeValidator ?? new RuntimeValidator();
  const children = new Map<string, PiClient>();
  const hostRuntime = createRuntime({
    children,
    store,
    closing: () => closing,
    queueBinding: (id) => queueWorkers.reviewQueueHost.binding(id),
    hasInteraction: (id) => interactions.hasSession(id),
    hasImageWrite: (id) => messageWrites.hasImageWrite(id),
  });
  const { idle, reapIdleRuntimes } = hostRuntime;
  const hostQueue = createQueue({
    store,
    emit: (sessionId, type, p) => emit(sessionId, type, p),
  });
  const queueWorkers = createQueueWorkers({
    store,
    options,
    executeUnlocked,
    hostRuntime,
  });
  const { reviewQueueHost, assertQueueBootPermit, markQueueSessionState } =
    queueWorkers;
  hostRuntime.startReaper();
  const stream = createStream({ store, transport });
  const { publish } = stream;
  const interactions = createInteractions({
    client: (sessionId) => hostRuntime.client(sessionId),
    publish,
  });
  let origin = "";
  let cookieName = "";
  const instanceId = randomUUID();
  let modernUpdates: ModernUpdates | undefined;
  if (options.modernUpdates) {
    try {
      modernUpdates = await ModernUpdates.create(
        updatesArgs(options, uiCheckout, instanceId, store, launchIdentity),
      );
    } catch (error) {
      hostRuntime.stopReaper();
      store.close();
      await releaseLock();
      throw error;
    }
  }
  let closing = false;
  let shutdownStage = "running";
  let pendingIngress = 0;
  let pendingUpdateControls = 0;
  let closePromise: Promise<void> | undefined;
  const resources = new Resources(options.helper, stream.fanoutTerminal);
  const cmds = createCatalogCommands({
    store,
    options,
    launchIdentity,
    modernUpdates: () => modernUpdates,
    directoryPicker,
    validationGrant,
    hostRuntime,
    publish,
    idle,
  });
  const { catalog } = cmds;
  const settings = createSettingsCommands({ store });
  const messageWrites = createMessageWrites({
    assets,
    closing: () => closing,
    hostRuntime,
    hostQueue,
    publish,
    interactions,
  });
  const { emit } = messageWrites;
  const { sessionCmds, runCmds, piCmds, fileCmds, assetCmds, importCmds } =
    createCommandLeaves({
      store,
      root: options.root,
      assets,
      resources,
      ui,
      grants,
      hostRuntime,
      hostQueue,
      interactions,
      publish,
      emit,
      idle,
      closing: () => closing,
    });
  const sessionBroker = createSessionBroker({
    store,
    options,
    instanceId,
    reviewQueueHost,
    executeUnlocked,
    markQueueSessionState,
    hostRuntime,
  });
  const { startSession } = createSessionStart({
    store,
    options,
    emit,
    publish,
    closing: () => closing,
    hostRuntime,
    reviewQueueHost,
    assertQueueBootPermit,
    markQueueSessionState,
    sessionBroker,
  });
  const asyncJobs = new AsyncJobOwner({
    persistReceipt: (receipt) => store.receipt(receipt),
    markAsync: (id, streamId) => store.markAsync(id, streamId),
    publish,
  });
  const sessionJobs = createSessionJobs({
    store,
    hostRuntime,
    publish,
    runtimeValidator,
    startSession,
  });
  const runJobs = createRunJobs({
    store,
    hostRuntime,
    hostQueue,
    assets,
    emit,
    startSession,
  });
  const pureCommands = createPureCommands();
  const { protectedWork, activeWork, unresolvedCompletions } = createWork({
    store,
    hostRuntime,
    messageWrites,
    interactions,
    resources,
    modernUpdates: () => modernUpdates,
    jobs: asyncJobs,
    pendingCommands: () => pendingCommands.size,
    pendingIngress: () => pendingIngress,
    pendingUpdateControls: () => pendingUpdateControls,
  });
  const retainedHosts = new RetainedHosts(options.root);
  let lifecycle: Awaited<ReturnType<typeof createRestartLifecycle>> | undefined;
  try {
    if (modernUpdates)
      lifecycle = await createRestartLifecycle({
        root: options.root,
        identity: launchIdentity,
        modern: modernUpdates,
        origin: () => origin,
        work: protectedWork,
      });
  } catch (error) {
    await modernUpdates?.stop();
    await resources.closeAndWait();
    store.close();
    await releaseLock();
    throw error;
  }
  async function executeUnlocked(
    c: Command,
    clientId: string,
    internal?: ExecuteInternal,
  ): Promise<Receipt> {
    const previous = store.reserve(c);
    if (previous) return previous;
    if (closing && !admittedWhileClosing(c.type))
      return store.receipt(failure(c.id, hostStopping()));
    const p: Data = c.payload;
    const id = c.sessionId;
    let result: Data = {};
    try {
      if (id) store.get("session", id);
      if (
        modernUpdates &&
        isUpdateCommand(c.type) &&
        hasUpdateTarget(c.type, p)
      ) {
        try {
          const updated = await modernUpdates.command(
            c.type,
            p,
            clientId,
            activeWork() - Math.min(pendingIngress, 1) - 1 <= 0,
          );
          publish("updates", "updates.changed", modernUpdates.snapshot());
          return store.receipt({
            v: 1,
            id: c.id,
            status: "completed",
            result: updated as Data,
          });
        } catch (error) {
          throw updateRejected(error);
        }
      }
      let draftOwner = clientId;
      if (modernUpdates && wantsWindowDraftOwner(c.type))
        draftOwner = windowDraftOwner(modernUpdates, p, clientId);
      switch (c.type) {
        case "host.get":
          result = cmds.hostGet();
          break;
        case "updates.get":
          cmds.updatesGetGuard(p);
          try {
            if (modernUpdates) {
              await modernUpdates.reconcile();
              result = modernUpdates.snapshot();
            } else
              result = await updateStatus.snapshot(instanceId, store.epoch);
          } catch (error) {
            throw cmds.updatesGetFailure(error);
          }
          break;
        case "catalog.get":
          result = cmds.catalogGet();
          break;
        case "directory.list":
          result = await cmds.directoryList(clientId, p);
          break;
        case "directory.create":
          result = await cmds.directoryCreate(clientId, p);
          break;
        case "project.add": {
          const root = await realpath(
            p.directorySelectionId
              ? await directoryPicker.consume(clientId, cmds.selectionId(p))
              : grant(cmds.grantId(p), "directory"),
          );
          cmds.requireDirectory(await stat(root));
          result = cmds.projectAdd(root, p);
          break;
        }
        case "project.update":
          result = cmds.projectUpdate(c, p);
          break;
        case "section.create":
          result = cmds.sectionCreate(p);
          break;
        case "section.update":
          result = cmds.sectionUpdate(c, p);
          break;
        case "section.delete":
          result = cmds.sectionDelete(c, p);
          break;
        case "workspace.add": {
          store.get("project", requiredString(p, "projectId"));
          const root = await realpath(
            p.directorySelectionId
              ? await directoryPicker.consume(clientId, cmds.selectionId(p))
              : grant(cmds.grantId(p), "directory"),
          );
          cmds.requireDirectory(await stat(root));
          result = cmds.workspaceAdd(root, p);
          break;
        }
        case "workspace.forget":
          result = cmds.workspaceForget(c, p);
          break;
        case "project.forget":
          result = cmds.projectForget(c, p);
          break;
        case "runtime.list":
          result = cmds.runtimeList();
          break;
        case "runtime.register": {
          const executable = grant(
            requiredString(p, "executableGrantId"),
            "executable",
          );
          const expectedVersion = requiredString(p, "expectedVersion");
          const check = options.simulated
            ? cmds.simulatedRuntime(
                executable,
                expectedVersion,
                createHash("sha256")
                  .update(await readFile(executable))
                  .digest("hex"),
              )
            : await probe(executable, expectedVersion);
          result = cmds.runtimeRegister(check);
          break;
        }
        case "runtime.validate": {
          const { runtimeId, profile } = cmds.runtimeValidatePrelude(p);
          return asyncJobs.submit(
            c,
            sessionJobs.runtimeValidate(runtimeId, profile),
          );
        }
        case "session.create": {
          const workspace = sessionCmds.sessionCreateTarget(p);
          try {
            await realpath(workspace.root);
          } catch {
            throw sessionCmds.workspaceUnavailable();
          }
          result = sessionCmds.sessionCreate(p, workspace, internal);
          break;
        }
        case "session.resume":
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          idle(id, true);
          return asyncJobs.submit(c, sessionJobs.sessionResume(id, internal));
        case "session.reorder":
          result = sessionCmds.sessionReorder(p);
          break;
        case "session.rename":
        case "session.archive":
        case "session.pin":
        case "session.highlight":
          result = sessionCmds.sessionPatch(c, p, id);
          break;
        case "session.close":
          result = sessionCmds.sessionClose(id);
          break;
        case "session.history":
          result = sessionCmds.sessionHistory(p, id);
          break;
        case "run.submit": {
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          const prelude = runCmds.runSubmitPrelude(p, id);
          const { text, attachmentIds } = prelude;
          // Reserve before any awaited prompt work; the job's finally releases it.
          hostRuntime.addSubmission(id);
          try {
            let immediateExtension = false;
            if (prelude.probesExtension) {
              const candidate = runCmds.extensionName(text);
              const pi = await startSession(id);
              const available = await pi.request("get_commands");
              immediateExtension = runCmds.isExtension(available, candidate);
            }
            runCmds.runSubmitTouch(prelude, p, id, immediateExtension);
            const message = await assets.prompt(attachmentIds, id, text);
            runCmds.runSubmitShadow(c, p, id, text, message, clientId);
            return asyncJobs.submit(c, runJobs.runSubmit(p, id, message));
          } catch (error) {
            hostRuntime.removeSubmission(id);
            throw error;
          }
        }
        case "run.cancel":
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          return asyncJobs.submit(
            c,
            runJobs.runCancel(id, () => draftOwner),
          );
        case "run.forceStop":
          result = runCmds.runForceStop(id);
          break;
        case "queue.clear":
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          return asyncJobs.submit(
            c,
            runJobs.queueClear(id, () => draftOwner),
          );
        case "queue.update": {
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          const update = runCmds.queueUpdatePrelude(p, id);
          return asyncJobs.submit(
            c,
            runJobs.queueUpdate(c, id, clientId, update),
          );
        }
        case "session.reload":
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          idle(id);
          return asyncJobs.submit(c, sessionJobs.sessionReload(id));
        case "usage.codex": {
          const read = piCmds.usageCodex();
          if (!read) {
            result = { available: false, reason: "unavailable" };
            break;
          }
          result = await read;
          break;
        }
        case "session.context": {
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          const ctx = piCmds.contextPrelude(id);
          const { session, cachedContext, pi } = ctx;
          const stats =
            pi && !pi.hasPendingRequests
              ? await pi.request("get_session_stats")
              : { contextUsage: cachedContext };
          const { contextUsage, snapshot } = piCmds.contextUsage(
            id,
            ctx,
            stats,
          );
          let codexUsage: Data | undefined = snapshot.usage.codexUsage;
          const read = piCmds.contextCodexRead(id, session);
          if (read) {
            const fresh = await piCmds.contextRace(read);
            if (fresh.available === true) codexUsage = fresh;
          }
          result = piCmds.contextResult(contextUsage, pi, codexUsage);
          break;
        }
        case "session.export": {
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          idle(id);
          const directory = join(options.root, "exports");
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const outputPath = join(directory, `${randomUUID()}.html`);
          try {
            await (
              await startSession(id)
            ).request("export_html", {
              outputPath,
            });
            const html = await readFile(outputPath, "utf8");
            const current = store.get("session", id);
            result = await assets.output(
              html,
              id,
              sessionCmds.exportOptions(current),
            );
          } finally {
            // Best effort: the export output file may not exist; cleanup must not mask the export result.
            await unlink(outputPath).catch(() => undefined);
          }
          break;
        }
        case "model.list":
        case "thinking.list":
        case "commands.list":
        case "model.set":
        case "thinking.set":
        case "session.compact":
        case "session.tree":
        case "session.info": {
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          const observationalRuntimeCommand = piCmds.piPrelude(c, id);
          const pi = observationalRuntimeCommand
            ? hostRuntime.client(id)
            : await startSession(id, undefined, "other");
          const builtins = piCmds.piBuiltins();
          if (!pi && c.type === "commands.list") {
            result = { commands: builtins, runtimeAvailable: false };
            break;
          }
          if (!pi) throw piCmds.runtimeUnavailable();
          if (c.type === "model.list") result = await pi.models();
          else {
            const [method, params] = piCmds.piRequestArgs(c, p);
            result = await pi.request(method, params);
            result = piCmds.piResult(c, builtins, result);
            if (c.type === "model.set") {
              const state = await pi.request("get_state");
              result = piCmds.modelSetApply(c, id, state);
            }
            if (c.type === "thinking.set") {
              const state = await pi.request("get_state");
              result = piCmds.thinkingSetApply(c, id, state);
            }
          }
          break;
        }
        case "interaction.respond":
          result = runCmds.interactionRespond(p, id);
          break;
        case "preferences.get":
          result = settings.preferencesGet();
          break;
        case "preferences.patch":
          result = settings.preferencesPatch(c, p);
          break;
        case "draft.get":
          result = settings.draftGet(id, draftOwner);
          break;
        case "draft.save":
          result = settings.draftSave(c, p, id, draftOwner);
          break;
        case "file.list":
        case "file.read":
          result = await fileCmds.fileRead(c, p);
          break;
        case "externalFile.read": {
          const path = fileCmds.externalReadPath(p);
          const canonical = await realpath(path).catch(fileCmds.externalFail);
          const info = await stat(canonical).catch(fileCmds.externalFail);
          fileCmds.externalReadCheck(canonical, path, info);
          result = await fileCmds.externalRead(canonical, p);
          break;
        }
        case "externalFile.open":
        case "externalFile.openWith":
        case "externalFile.reveal": {
          const path = fileCmds.externalOpenPath(p);
          const canonical = await realpath(path);
          const info = await stat(canonical);
          fileCmds.externalOpenCheck(canonical, path, info);
          result = await fileCmds.externalOpen(c, canonical);
          break;
        }
        case "file.write":
          result = await fileCmds.fileWrite(p);
          break;
        case "file.open":
        case "file.openWith":
        case "file.reveal":
          result = await fileCmds.fileOpen(c, p);
          break;
        case "attachment.workspace": {
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          const { w, path } = assetCmds.attachmentPrelude(p, id);
          const file = await assetCmds.attachmentRead(w, path);
          assetCmds.attachmentCheck(file);
          const asset = await assetCmds.attachmentUpload(file, path, id);
          result = { ...asset, contextPath: path };
          break;
        }
        case "git.status":
        case "git.diff":
        case "workspace.list": {
          const w = fileCmds.gitWorkspace(p);
          result = await fileCmds.gitRead(w, c, p);
          if (c.type === "workspace.list")
            result = fileCmds.workspaceCandidates(w, result);
          break;
        }
        case "workspace.select": {
          const candidate = fileCmds.workspaceSelectCandidate(p);
          const root = await realpath(candidate.root);
          result = fileCmds.workspaceSelectPut(candidate, root);
          break;
        }
        case "terminal.create":
          result = fileCmds.terminalCreate(p);
          break;
        case "terminal.attach":
        case "terminal.input":
        case "terminal.resize":
        case "terminal.close":
          result = fileCmds.terminalCommand(c, p);
          break;
        case "ui.builds":
          result = await assetCmds.uiBuilds();
          break;
        case "ui.activate": {
          const buildId = assetCmds.uiBuildId(p);
          await assetCmds.uiImport(buildId);
          result = assetCmds.uiActivated(buildId);
          break;
        }
        case "ui.rollback":
          result = assetCmds.uiRollback();
          break;
        case "project.discoverIcon": {
          const project = assetCmds.iconProject(p);
          let autoIconId: string | null = null;
          for (const path of assetCmds.iconPaths()) {
            try {
              const file = await resources.file(project.root, path, false);
              if (file.truncated) continue;
              const { bytes, hash } = assetCmds.iconDigest(file, path);
              if (project.autoIconHash === hash && project.autoIconId) {
                await assets.read(project.autoIconId);
                autoIconId = project.autoIconId;
              } else {
                const asset = await assetCmds.iconUpload(bytes, path);
                autoIconId = asset.id;
              }
              project.autoIconHash = hash;
              break;
            } catch {
              /* Missing, symlinked, oversized or undecodable candidates are ignored. */
            }
          }
          result = assetCmds.iconDiscovered(project, autoIconId);
          break;
        }
        case "icon.clear":
          result = assetCmds.iconClear(c, p);
          break;
        case "icon.set":
          result = assetCmds.iconSet(c, p);
          break;
        case "artifact.get": {
          const { asset, bytes } = await assets.read(
            requiredString(p, "artifactId"),
            assetCmds.artifactOwner(id),
          );
          result = assetCmds.artifactSlice(p, asset, bytes);
          break;
        }
        case "session.read":
          result = sessionCmds.sessionRead(p, id);
          break;
        case "session.markUnread":
          result = sessionCmds.sessionMarkUnread(id);
          break;
        case "session.branch":
        case "session.clone": {
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          const parent = sessionCmds.sessionForkPrelude(c, id);
          return asyncJobs.submit(c, sessionJobs.sessionFork(c, p, id, parent));
        }
        case "session.runtime": {
          if (!id) throw new SuriError("VALIDATION", "Select a session.");
          const { old, runtime } = sessionCmds.sessionRuntimePrelude(c, p, id);
          const child = hostRuntime.client(id);
          if (child) {
            await closeAndRetire(child);
            hostRuntime.dropClient(id);
          }
          let piFile = old.piFile;
          if (piFile) {
            const dest = sessionCmds.runtimeSwitchFile(options.root, id);
            await copyFile(piFile, dest);
            piFile = dest;
          }
          sessionCmds.sessionRuntimePut(old, runtime, piFile);
          try {
            await startSession(id);
          } catch (e) {
            store.put("session", old);
            throw e;
          }
          result = store.get("session", id);
          break;
        }
        case "session.import": {
          const { source, w } = importCmds.importPrelude(p);
          const file = await readFile(source);
          const header = await importHeader(file, w.root);
          const nextId = randomUUID();
          const { dir, piFile } = importCmds.importTarget(nextId);
          try {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await copyFile(source, piFile);
            const next = importCmds.importPut(p, w, nextId, piFile, header);
            await (await startSession(nextId)).closeAndWait();
            result = importCmds.importSettle(nextId, next);
          } catch (error) {
            await importCmds.importRollback(nextId, dir);
            throw error;
          }
          break;
        }
        case "session.importPreview": {
          const { ids, w, existing } = importCmds.previewPrelude(p);
          const candidates: Data[] = [];
          for (const grantId of ids) {
            const source = importCmds.previewGrant(grantId);
            try {
              const file = await readFile(source);
              const header = inspectImportHeader(file);
              let sameWorkspace = false;
              try {
                sameWorkspace =
                  (await realpath(header.cwd)) === (await realpath(w.root));
              } catch {
                // An unresolvable cwd or root leaves sameWorkspace false.
              }
              candidates.push(
                importCmds.previewCandidate(
                  grantId,
                  source,
                  header,
                  sameWorkspace,
                  existing,
                ),
              );
            } catch {
              candidates.push(importCmds.previewIncompatible(grantId, source));
            }
          }
          result = { candidates };
          break;
        }
        case "session.importBatch": {
          const batch = importCmds.batchPrelude(p);
          const { ids, w } = batch;
          const imported: Data[] = [];
          const skipped: Data[] = [];
          for (const grantId of ids) {
            const source = importCmds.batchGrant(grantId);
            const file = await readFile(source);
            const header = await importHeader(file, w.root);
            const duplicate = importCmds.batchDuplicate(grantId, header);
            if (duplicate) {
              skipped.push(duplicate);
              continue;
            }
            const nextId = randomUUID();
            const { dir, piFile } = importCmds.importTarget(nextId);
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await copyFile(source, piFile);
            const next = importCmds.batchPut(
              batch,
              nextId,
              source,
              piFile,
              header,
            );
            try {
              const pi = await startSession(nextId);
              imported.push(importCmds.batchSettle(pi, nextId, next, grantId));
              importCmds.batchDiscard(grantId);
            } catch (error) {
              importCmds.batchRollback(nextId);
              await rm(dir, { recursive: true, force: true });
              throw error;
            }
          }
          result = { imported, skipped };
          break;
        }
        case "host.shutdown":
          checkShutdownIdentity(p, instanceId);
          if (p.closeTerminals === true) await resources.closeAndWait();
          checkShutdownIdle(
            closing,
            activeWork,
            pendingIngress,
            pendingCommands.size,
          );
          closing = true;
          for (const s of store.list("session")) idle(s.id);
          setImmediate(() => {
            void close().catch(() => {
              reportDiagnostic("shutdown", "HOST_SHUTDOWN_FAILED");
            });
          });
          result = { stopping: true, instanceId };
          break;
        default:
          throw new SuriError(
            "UNKNOWN_COMMAND",
            "This operation is not implemented.",
          );
      }
      return store.receipt({ v: 1, id: c.id, status: "completed", result });
    } catch (e) {
      if (!(e instanceof SuriError))
        reportDiagnostic("command", "COMMAND_EXECUTION_FAILED");
      return store.receipt(failure(c.id, e));
    }
  }
  const serial = new Map<string, Promise<unknown>>();
  const pendingCommands = new Set<Promise<Receipt>>();
  async function execute(c: Command, clientId: string): Promise<Receipt> {
    let operation: Promise<Receipt>;
    if (
      !c.sessionId ||
      ["run.cancel", "run.forceStop", "interaction.respond"].includes(c.type)
    )
      operation = Promise.resolve().then(() => executeUnlocked(c, clientId));
    else {
      const prior = serial.get(c.sessionId) ?? Promise.resolve();
      // A failed prior command already reported to its own caller; it must not block the next command on this session.
      operation = prior
        .catch(() => {})
        .then(() => executeUnlocked(c, clientId));
      serial.set(c.sessionId, operation);
    }
    if (!pureCommands.has(c.type)) pendingCommands.add(operation);
    try {
      return await operation;
    } finally {
      pendingCommands.delete(operation);
      if (c.sessionId && serial.get(c.sessionId) === operation)
        serial.delete(c.sessionId);
    }
  }
  const live: HostLive = {
    origin: () => origin,
    cookieName: () => cookieName,
    closing: () => closing,
    shutdownStage: () => shutdownStage,
    modernUpdates: () => modernUpdates,
    lifecycle: () => lifecycle,
  };
  const http = createHttp(
    httpCaps(live, {
      options,
      assets,
      ui,
      retainedHosts,
      launchIdentity,
      instanceId,
      transport,
      grants,
      pureCommands,
      execute,
      beginIngress: () => {
        pendingIngress += 1;
      },
      endIngress: () => {
        pendingIngress -= 1;
      },
    }),
  );
  const ws = createWs(
    wsCaps(live, { http, transport, stream, store, resources, catalog }),
  );
  ws.registerUpgrade();
  ws.registerConnection();
  try {
    await http.listen();
  } catch (error) {
    await lifecycle?.restart.stop();
    await modernUpdates?.stop();
    await resources.closeAndWait();
    ws.close();
    store.close();
    await releaseLock();
    throw listenerFailure(error);
  }
  const address = http.address();
  origin = `http://127.0.0.1:${address.port}`;
  cookieName = `suri_${address.port}`;
  const socketPath = join(options.root, "run", "control.sock");
  try {
    await unlink(socketPath);
  } catch {
    // No stale control socket to remove.
  }
  const controlCaps = buildControlCaps(live, {
    launchIdentity,
    instanceId,
    hostRuntime,
    activeWork,
    protectedWork,
    unresolvedCompletions,
    transport,
    grants,
    options,
    store,
    updateStatus,
    ui,
    idle,
    close,
    setClosing: (value) => (closing = value),
    beginUpdateControl: () => void pendingUpdateControls++,
    endUpdateControl: () => void pendingUpdateControls--,
  });
  const control = createNetServer(
    createControlConnection(controlCaps, createHostControl(controlCaps)),
  );
  try {
    checkControlPath(socketPath);
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await writeFile(
      join(options.root, "run", "endpoint.json"),
      endpointJson(store.epoch, origin, socketPath),
      { mode: 0o600 },
    );
  } catch (error) {
    await close();
    throw controlBindFailure(error);
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (shutdownStage === "running") {
        shutdownStage = "http";
        stream.terminateAll();
        await new Promise<void>((resolve) => ws.close(() => resolve()));
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
        });
      }
      shutdownStage = "drain";
      interactions.clearTimers();
      await asyncJobs.drain();
      if (pendingCommands.size) await Promise.allSettled([...pendingCommands]);
      hostRuntime.stopReaper();
      await lifecycle?.restart.stop();
      await modernUpdates?.stop();
      shutdownStage = "children";
      await Promise.all(
        hostRuntime.clients().map((child) => child.closeAndWait()),
      );
      await resources.closeAndWait();
      messageWrites.flushAll();
      let batch;
      while ((batch = messageWrites.nextDrain())) await batch;
      shutdownStage = "storage";
      store.close();
      shutdownStage = "lock";
      await releaseLock();
      shutdownStage = "control";
      await new Promise<void>((resolve) => control.close(() => resolve()));
    })();
    // A rejected close keeps ownership; only the failed promise is dropped so a later close retries from drain.
    closePromise.catch(() => (closePromise = undefined));
    return closePromise;
  }
  lifecycle?.restart.start();
  modernUpdates?.start(() =>
    publish("updates", "updates.changed", modernUpdates!.snapshot()),
  );
  return {
    origin,
    store,
    execute,
    close,
    children,
    reviewQueueHost,
    reapIdleRuntimes,
    resources,
    publish,
    socketPath,
  };
}
