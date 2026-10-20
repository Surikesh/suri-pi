import { spawn } from "node:child_process";

const script = String.raw`
ObjC.import('Foundation'); ObjC.import('AppKit');
function input(){return ObjC.unwrap($.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile,$.NSUTF8StringEncoding));}
function run(argv){
  const mode=argv[0],origin=argv[1];
  if(mode==='open'){const url=input();if(!$.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url)))throw Error('OPEN_FAILED');return 'opened';}
  const chrome=Application('Google Chrome');if(!chrome.running())return JSON.stringify({state:'missing'});
  const windows=chrome.windows();let selected=null;
  for(let wi=0;wi<windows.length;wi++){
    const tabs=windows[wi].tabs();
    for(let ti=0;ti<tabs.length;ti++){
      const url=tabs[ti].url();if(url!==origin&&!url.startsWith(origin+'/'))continue;
      if(mode==='reuse'&&String(tabs[ti].id())!==argv[2])continue;
      const match=url.match(/[?&]window=([a-f0-9-]{36})(?:&|$)/i);
      const candidate={window:windows[wi],tab:tabs[ti],tabIndex:ti+1,client:match?match[1]:null};
      if(!selected)selected=candidate;
      if(wi===0&&tabs[ti].id()===windows[wi].activeTab().id()){selected=candidate;break;}
    }
    if(selected&&wi===0)break;
  }
  if(!selected)return JSON.stringify({state:'missing'});
  if(mode==='inspect')return JSON.stringify({state:'found',tabId:String(selected.tab.id()),clientInstanceId:selected.client});
  if(mode!=='reuse'||selected.client!==argv[3])throw Error('REUSE_IDENTITY_CHANGED');
  selected.tab.url=input();selected.window.activeTabIndex=selected.tabIndex;selected.window.index=1;chrome.activate();return 'reused';
}`;
type Runner = (
  executable: string,
  args: string[],
  options?: { input?: string },
) => Promise<{ stdout: string }>;
const runPrivate: Runner = (executable, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Error("BROWSER_REUSE_UNAVAILABLE"));
    }, 15000);
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 8192) stdout += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error("BROWSER_REUSE_UNAVAILABLE"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout });
      else reject(Error("BROWSER_REUSE_UNAVAILABLE"));
    });
  });
export async function openBrowser(
  url: string,
  options: {
    platform?: string;
    execFile?: Runner;
    checkpoint?: (clientInstanceId: string) => Promise<boolean>;
    newTab?: boolean;
  } = {},
) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
    throw Error("BROWSER_ORIGIN_INVALID");
  if ((options.platform ?? process.platform) !== "darwin")
    throw Error("BROWSER_OPEN_UNAVAILABLE");
  const run = options.execFile ?? runPrivate;
  const invoke = (mode: string, tabId = "", input?: string, client = "") =>
    run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, mode, parsed.origin, tabId, client],
      { input },
    );
  // Do not expose automation output or launch material; retain only the stage
  // so a denied inspection is distinguishable from a failed browser open.
  let stage = "inspect";
  try {
    if (!options.newTab) {
      const found = JSON.parse((await invoke("inspect")).stdout);
      if (found.state === "found") {
        stage = "checkpoint";
        if (
          typeof found.tabId !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(found.clientInstanceId ?? "") ||
          !(await options.checkpoint?.(found.clientInstanceId))
        )
          throw Error("BROWSER_REUSE_UNAVAILABLE");
        stage = "reuse";
        if (
          (
            await invoke("reuse", found.tabId, url, found.clientInstanceId)
          ).stdout.trim() !== "reused"
        )
          throw Error("BROWSER_REUSE_UNAVAILABLE");
        return "reused";
      }
      if (found.state !== "missing") throw Error("BROWSER_REUSE_UNAVAILABLE");
    }
    stage = "open";
    if ((await invoke("open", "", url)).stdout.trim() !== "opened")
      throw Error("BROWSER_OPEN_UNAVAILABLE");
    return "opened";
  } catch {
    throw Error(`BROWSER_REUSE_UNAVAILABLE: ${stage}`);
  }
}
