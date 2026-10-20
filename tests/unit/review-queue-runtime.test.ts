import { compileC } from "../../scripts/native-helper.mjs";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  chmod,
  copyFile,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ReviewQueueRuntime,
  ReviewQueueRuntimeError,
  candidateDigest,
  type QueueAuthority,
} from "../../packages/pi-adapter/src/review-queue-runtime.js";
import { ReviewQueueWorkerProfile } from "../../packages/pi-adapter/src/review-queue-worker.js";
import {
  REVIEW_QUEUE_CONTROL_PROTOCOL,
  ReviewQueueHost,
} from "../../packages/pi-adapter/src/review-queue-host.js";

const execFile = promisify(execFileCallback);
const helper = resolve("dist/native/suri-helper");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "suri-review-runtime-"));
  const repository = join(root, "repo");
  const scratch = join(root, "scratch");
  await Promise.all([mkdir(repository), mkdir(scratch)]);
  const canonicalRepository = await realpath(repository);
  const authority: QueueAuthority = {
    sourceHostSessionId: randomUUID(),
    sourceChannelId: randomUUID(),
    workspaceId: randomUUID(),
    repository: canonicalRepository,
    runtimeId: randomUUID(),
  };
  return { root, repository: canonicalRepository, scratch, authority };
}
async function cleanup(root: string) {
  await execFile("/bin/chmod", ["-R", "u+w", root]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
const launchInput = (
  paths: Awaited<ReturnType<typeof fixture>>,
  epoch = 1,
  hostWorkerSessionId = randomUUID(),
) => ({
  repository: paths.repository,
  epoch,
  authority: paths.authority,
  hostWorkerSessionId,
});

describe("review queue runtime enforcement", () => {
  it("fences one source-owned writer, snapshots immutable bytes, and scopes epochs", async () => {
    const one = await fixture();
    const two = await fixture();
    const runtime = new ReviewQueueRuntime(join(one.root, "snapshots"), helper);
    const writer = await runtime.launchImplementer("one", launchInput(one, 3));
    const other = await runtime.launchImplementer("two", launchInput(two, 99));
    await runtime.mutate(writer.sessionId!, 3, "src/a.txt", "one");
    runtime.suspendWriter(writer.sessionId!, 3, one.authority);
    expect(
      runtime.proveQuiescent(writer.sessionId!, 3, one.authority).data,
    ).toEqual({
      writerRevoked: true,
      drained: true,
    });
    const digest = await candidateDigest(one.repository, helper);
    await expect(
      runtime.launchReviewer("cross-source-review", {
        implementerSessionId: writer.sessionId!,
        candidateRoot: one.repository,
        candidateDigest: digest,
        scratchRoot: one.scratch,
        epoch: 3,
        authority: two.authority,
        hostWorkerSessionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ category: "source_authority_mismatch" });
    const reviewer = await runtime.launchReviewer("review", {
      implementerSessionId: writer.sessionId!,
      candidateRoot: one.repository,
      candidateDigest: digest,
      scratchRoot: one.scratch,
      epoch: 3,
      authority: one.authority,
      hostWorkerSessionId: randomUUID(),
    });
    await writeFile(join(one.repository, "src/a.txt"), "drifted");
    expect(await runtime.read(reviewer.sessionId!, "src/a.txt")).toBe("one");
    runtime.resumeWriter(writer.sessionId!, 3, one.authority);
    await runtime.mutate(writer.sessionId!, 3, "src/a.txt", "two");
    expect(other.sessionId).toBeTruthy();
    await Promise.all([cleanup(one.root), cleanup(two.root)]);
  });

  it.runIf(process.platform === "darwin")(
    "denies descendants, shells, outside reads, and network while allowing repository data",
    async () => {
      const paths = await fixture();
      const runtime = new ReviewQueueRuntime(
        join(paths.root, "snapshots"),
        helper,
      );
      const writer = await runtime.launchImplementer(
        "writer",
        launchInput(paths),
      );
      await writeFile(join(paths.repository, "inside.txt"), "inside");
      const inside = await runtime.execute(writer.sessionId!, 1, "/bin/cat", [
        join(paths.repository, "inside.txt"),
      ]);
      expect(inside).toMatchObject({ exitCode: 0, stdout: "inside" });
      for (const outside of ["/etc/hosts", join(paths.root, "outside.txt")]) {
        await writeFile(join(paths.root, "outside.txt"), "outside");
        const denied = await runtime.execute(writer.sessionId!, 1, "/bin/cat", [
          outside,
        ]);
        expect(denied.exitCode).not.toBe(0);
        expect(denied.stdout).not.toContain("outside");
      }
      const touched = join(paths.repository, "touched.txt");
      expect(
        (
          await runtime.execute(writer.sessionId!, 1, "/usr/bin/touch", [
            touched,
          ])
        ).exitCode,
      ).toBe(0);
      expect(await readFile(touched, "utf8")).toBe("");
      await expect(
        runtime.execute(writer.sessionId!, 1, "/bin/sh", ["-c", "printf bad"]),
      ).rejects.toMatchObject({ category: "process_denied" });
      const renamedShell = join(paths.root, "harmless-tool");
      const copiedInterpreter = join(paths.root, "formatter");
      const linkedInterpreter = join(paths.root, "compiler");
      await copyFile("/bin/sh", renamedShell);
      await copyFile("/usr/bin/python3", copiedInterpreter);
      await link(copiedInterpreter, linkedInterpreter);
      await Promise.all([
        chmod(renamedShell, 0o700),
        chmod(copiedInterpreter, 0o700),
        chmod(linkedInterpreter, 0o700),
      ]);
      for (const deniedExecutable of [
        renamedShell,
        copiedInterpreter,
        linkedInterpreter,
      ])
        await expect(
          runtime.execute(writer.sessionId!, 1, deniedExecutable, []),
        ).rejects.toMatchObject({ category: "process_denied" });

      const metadataSource = join(paths.root, "metadata.c");
      const metadataBinary = join(paths.root, "metadata-probe");
      await writeFile(
        metadataSource,
        `#include <sys/stat.h>\n#include <stdio.h>\nint main(int c,char**v){struct stat s;for(int i=1;i<c;i++)printf("%d\\n",stat(v[i],&s));return 0;}\n`,
      );
      compileC(metadataSource, metadataBinary);
      const metadata = await runtime.execute(
        writer.sessionId!,
        1,
        metadataBinary,
        [
          join(paths.repository, "inside.txt"),
          "/etc/hosts",
          join(paths.root, "outside.txt"),
        ],
      );
      expect(metadata).toMatchObject({ exitCode: 0, stdout: "0\n-1\n-1\n" });

      const execSource = join(paths.root, "exec.c");
      const execBinary = join(paths.root, "exec-probe");
      await writeFile(
        execSource,
        `#include <unistd.h>\nint main(int c,char**v){execv(v[1],v+1);return 13;}\n`,
      );
      compileC(execSource, execBinary);
      const repositoryTouch = join(paths.repository, "touch-copy");
      await copyFile("/usr/bin/touch", repositoryTouch);
      await chmod(repositoryTouch, 0o700);
      for (const secondExecutable of ["/usr/bin/touch", repositoryTouch]) {
        const marker = join(
          paths.repository,
          `secondary-${secondExecutable === repositoryTouch ? "repo" : "system"}`,
        );
        expect(
          (
            await runtime.execute(writer.sessionId!, 1, execBinary, [
              secondExecutable,
              marker,
            ])
          ).exitCode,
        ).toBe(13);
        await expect(readFile(marker)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }

      const late = join(paths.repository, "late.txt");
      const source = join(paths.root, "fork.c");
      const binary = join(paths.root, "fork-probe");
      await writeFile(
        source,
        `#include <unistd.h>\n#include <fcntl.h>\nint main(int c,char**v){pid_t p=fork();if(p<0)return 7;if(!p){usleep(300000);int f=open(v[1],O_WRONLY|O_CREAT,0600);write(f,"late",4);close(f);_exit(0);}return 0;}\n`,
      );
      compileC(source, binary);
      expect(
        (await runtime.execute(writer.sessionId!, 1, binary, [late])).exitCode,
      ).toBe(7);
      runtime.suspendWriter(writer.sessionId!, 1, paths.authority);
      expect(
        runtime.proveQuiescent(writer.sessionId!, 1, paths.authority).data,
      ).toMatchObject({ drained: true });
      await new Promise((done) => setTimeout(done, 450));
      await expect(readFile(late)).rejects.toMatchObject({ code: "ENOENT" });

      let connections = 0;
      const server = createServer((socket) => {
        connections++;
        socket.end("HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok");
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const port = (server.address() as { port: number }).port;
      runtime.resumeWriter(writer.sessionId!, 1, paths.authority);
      const network = await runtime.execute(
        writer.sessionId!,
        1,
        "/usr/bin/curl",
        ["--max-time", "1", `http://127.0.0.1:${port}/`],
      );
      server.close();
      expect(network.exitCode).not.toBe(0);
      expect(connections).toBe(0);

      const revokeSource = join(paths.root, "revoke.c");
      const revokeBinary = join(paths.root, "revoke-probe");
      const revokedWrite = join(paths.repository, "revoked-late.txt");
      await writeFile(
        revokeSource,
        `#include <unistd.h>\n#include <fcntl.h>\nint main(int c,char**v){usleep(300000);int f=open(v[1],O_WRONLY|O_CREAT,0600);write(f,"late",4);close(f);return 0;}\n`,
      );
      compileC(revokeSource, revokeBinary);
      const active = runtime.execute(writer.sessionId!, 1, revokeBinary, [
        revokedWrite,
      ]);
      await new Promise((done) => setTimeout(done, 50));
      runtime.close(writer.sessionId!);
      await expect(active).rejects.toMatchObject({
        category: "process_interrupted",
      });
      await new Promise((done) => setTimeout(done, 350));
      await expect(readFile(revokedWrite)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await cleanup(paths.root);
    },
  );

  it("uses descriptor-relative reads/writes/results and rejects symlink traversal", async () => {
    const paths = await fixture();
    const runtime = new ReviewQueueRuntime(
      join(paths.root, "snapshots"),
      helper,
    );
    const writer = await runtime.launchImplementer(
      "writer",
      launchInput(paths),
    );
    const outside = join(paths.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(paths.repository, "escape"));
    await expect(
      runtime.mutate(writer.sessionId!, 1, "escape/out.txt", "bad"),
    ).rejects.toMatchObject({ category: "path_denied" });
    runtime.suspendWriter(writer.sessionId!, 1, paths.authority);
    await expect(
      candidateDigest(paths.repository, helper),
    ).rejects.toMatchObject({
      category: "candidate_symlink_denied",
    });
    await rm(join(paths.repository, "escape"));
    const digest = await candidateDigest(paths.repository, helper);
    const reviewer = await runtime.launchReviewer("review", {
      implementerSessionId: writer.sessionId!,
      candidateRoot: paths.repository,
      candidateDigest: digest,
      scratchRoot: paths.scratch,
      epoch: 1,
      authority: paths.authority,
      hostWorkerSessionId: randomUUID(),
    });
    await symlink(outside, join(paths.scratch, "escape"));
    await expect(
      runtime.writeReviewerResult(reviewer.sessionId!, "escape/verdict", "bad"),
    ).rejects.toMatchObject({ category: "path_denied" });
    await runtime.writeReviewerResult(
      reviewer.sessionId!,
      "verdict.json",
      "{}",
    );
    expect(await readFile(join(paths.scratch, "verdict.json"), "utf8")).toBe(
      "{}",
    );
    await cleanup(paths.root);
  });

  it.runIf(process.platform === "darwin")(
    "binds control to source/workspace and rejects target collisions before launch",
    async () => {
      const paths = await fixture();
      const runtime = new ReviewQueueRuntime(
        join(paths.root, "snapshots"),
        helper,
      );
      const profile = new ReviewQueueWorkerProfile(
        runtime,
        resolve("packages/pi-adapter/src/review-queue-extension.ts"),
      );
      const existing = new Map<string, boolean>();
      let launches = 0;
      const host = new ReviewQueueHost(
        runtime,
        profile,
        join(paths.root, "results"),
        async () => {
          launches++;
          return { status: "completed" };
        },
        (id) => ({
          exists: existing.has(id),
          active: existing.get(id) ?? false,
        }),
      );
      const packet = {
        protocol: REVIEW_QUEUE_CONTROL_PROTOCOL,
        operation: "launch_implementer",
        key: "launch",
        targetSessionId: randomUUID(),
        epoch: 1,
      };
      const launch: any = await host.handleControl(paths.authority, packet);
      expect(launch.ok).toBe(true);
      expect(
        ((await host.handleControl(paths.authority, packet)) as any).duplicate,
      ).toBe(true);
      expect(launches).toBe(1);
      const changed = await host.handleControl(paths.authority, {
        ...packet,
        epoch: 2,
      });
      expect(changed).toMatchObject({
        ok: false,
        category: "request_payload_mismatch",
      });
      const otherSource = { ...paths.authority, sourceChannelId: randomUUID() };
      expect(
        await host.handleControl(otherSource, {
          protocol: REVIEW_QUEUE_CONTROL_PROTOCOL,
          operation: "suspend_writer",
          implementerSessionId: launch.receipt.sessionId,
          epoch: 1,
        }),
      ).toMatchObject({ ok: false, category: "source_authority_mismatch" });
      expect(
        await host.handleControl(
          { ...paths.authority, workspaceId: randomUUID() },
          {
            protocol: REVIEW_QUEUE_CONTROL_PROTOCOL,
            operation: "prove_quiescent",
            implementerSessionId: launch.receipt.sessionId,
            epoch: 1,
          },
        ),
      ).toMatchObject({ ok: false, category: "source_authority_mismatch" });
      for (const active of [false, true]) {
        const id = randomUUID();
        existing.set(id, active);
        expect(
          await host.handleControl(paths.authority, {
            ...packet,
            key: `collision-${active}`,
            targetSessionId: id,
          }),
        ).toMatchObject({ ok: false, category: "target_session_collision" });
      }
      expect(launches).toBe(1);
      host.sourceExited(
        paths.authority.sourceHostSessionId,
        paths.authority.sourceChannelId,
      );
      expect(
        await host.handleControl(paths.authority, {
          ...packet,
          key: "after-source-revocation",
          targetSessionId: randomUUID(),
        }),
      ).toMatchObject({ ok: false, category: "source_authority_revoked" });

      const failingRuntime = new ReviewQueueRuntime(
        join(paths.root, "failure-snapshots"),
        helper,
      );
      const failingHost = new ReviewQueueHost(
        failingRuntime,
        new ReviewQueueWorkerProfile(
          failingRuntime,
          resolve("packages/pi-adapter/src/review-queue-extension.ts"),
        ),
        join(paths.root, "failure-results"),
        async () => {
          throw new ReviewQueueRuntimeError(
            "worker_boot_failed",
            "Synthetic asynchronous boot failure.",
          );
        },
      );
      expect(
        await failingHost.handleControl(paths.authority, {
          ...packet,
          key: "asynchronous-boot-failure",
          targetSessionId: randomUUID(),
        }),
      ).toMatchObject({ ok: false, category: "worker_boot_failed" });
      await cleanup(paths.root);
    },
  );
});
