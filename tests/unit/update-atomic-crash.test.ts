import { expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Kill only disposable file-writer children, never a host, Pi process or user session.
const writer = `
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const [moduleUrl, path, stage] = process.argv.slice(1);
async function pause(at) { if(stage!==at)return; process.send({stage:at});setInterval(()=>{},1000);await new Promise(()=>{}); }
const originalOpen=fs.open, originalRename=fs.rename;
fs.open=async(...args)=>{
 const fd=await originalOpen(...args);
 if(!String(args[0]).startsWith(path+'.tmp-'))return fd;
 return new Proxy(fd,{get(target,key){
  if(key==='writeFile')return async(...values)=>{await target.writeFile(...values);await pause('after-write');};
  if(key==='sync')return async()=>{await target.sync();await pause('after-sync');};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
};
fs.rename=async(...args)=>{if(args[1]===path)await pause('before-rename');await originalRename(...args);if(args[1]===path)await pause('after-rename');};
syncBuiltinESMExports();
let boundary='module-import';
try { const {writeUpdateFile}=await import(moduleUrl);boundary='atomic-write';await writeUpdateFile(path,JSON.stringify({revision:2,marker:'new'})); }
catch(error) {process.send({stage:'writer-failed',boundary,code: /^[A-Z_]{1,80}$/.test(error.code??'')?error.code:'UNTYPED_ERROR',errorType:['Error','TypeError','SyntaxError'].includes(error.name)?error.name:'OtherError'});process.exitCode=1;}
`;

test.each(["after-write", "after-sync", "before-rename", "after-rename"])(
  "process death %s leaves a complete old or new atomic record",
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), "suri-atomic-crash-"));
    let child: ChildProcess | undefined;
    try {
      const path = join(root, "state.json");
      await writeFile(path, JSON.stringify({ revision: 1, marker: "old" }), {
        mode: 0o600,
      });
      child = spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--input-type=module",
          "-e",
          writer,
          pathToFileURL(resolve("apps/host/src/update-state.ts")).href,
          path,
          stage,
        ],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      const processChild = child;
      const message = await new Promise((accept, reject) => {
        const timeout = setTimeout(
          () => reject(Error("ATOMIC_WRITER_STAGE_TIMEOUT")),
          5000,
        );
        processChild.once("message", (value) => {
          clearTimeout(timeout);
          accept(value);
        });
        processChild.once("exit", () => {
          clearTimeout(timeout);
          reject(Error("ATOMIC_WRITER_EXITED_EARLY"));
        });
      });
      expect(message).toEqual({ stage });
      child.kill("SIGKILL");
      await once(child, "exit");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
        stage === "after-rename"
          ? { revision: 2, marker: "new" }
          : { revision: 1, marker: "old" },
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
