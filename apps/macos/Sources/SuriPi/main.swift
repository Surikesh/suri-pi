import SwiftUI
import WebKit
import AppKit
import UniformTypeIdentifiers

@MainActor final class BrowserModel: NSObject, ObservableObject, WKNavigationDelegate, WKScriptMessageHandler {
    @Published var status = "Starting Suri Pi…"
    @Published private(set) var phase = ShellPhase.starting
    let webView: WKWebView
    var allowedOrigin: URL?
    var benchmarkStarted = false
    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "suri")
        webView.navigationDelegate = self
        webView.isInspectable = true
    }
    func showProgress(_ message:String, phase next:ShellPhase) { status=message;phase=next }
    func showRecovery(_ message:String) { status=message;phase = .recoveryRequired }
    func showReady() { status="";phase = .ready }
    func key(_ name:String)->String { "suri."+Data((ProcessInfo.processInfo.environment["SURI_DATA_DIR"] ?? "default").utf8).base64EncodedString()+"."+name }
    var bundledBase:URL { Bundle.main.resourceURL!.appendingPathComponent("app") }
    var developmentCheckout:URL? {
        let environmentPath=ProcessInfo.processInfo.environment["SURI_DEVELOPMENT_CHECKOUT"]
        guard let path=environmentPath ?? UserDefaults.standard.string(forKey:key("developmentCheckout")) else { return nil }
        return validCheckout(URL(fileURLWithPath:path))
    }
    func validCheckout(_ candidate:URL)->URL? {
        let root=candidate.standardizedFileURL.resolvingSymlinksInPath()
        var directory:ObjCBool=false
        guard FileManager.default.fileExists(atPath:root.path,isDirectory:&directory),directory.boolValue,
              FileManager.default.fileExists(atPath:root.appendingPathComponent("package.json").path),
              FileManager.default.fileExists(atPath:root.appendingPathComponent("dist/apps/host/src/cli.js").path) else { return nil }
        return root
    }
    func command(_ arguments: [String]) async throws -> Data {
        let bundled=bundledBase
        let checkout=developmentCheckout
        let cliBase=checkout ?? bundled
        return try await Task.detached(priority:.userInitiated) {
        let process = Process()
        process.executableURL = bundled.appendingPathComponent("bin/node")
        process.arguments = [cliBase.appendingPathComponent("dist/apps/host/src/cli.js").path] + arguments
        process.currentDirectoryURL = cliBase
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = bundled.appendingPathComponent("bin").path + ":" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin") + ":/opt/homebrew/bin:/usr/local/bin"
        if let checkout { environment["SURI_UI_CHECKOUT"] = checkout.path }
        process.environment = environment
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw NSError(domain: "SuriCommandExit", code: Int(process.terminationStatus)) }
        return data
        }.value
    }
    func diagnosticFailure(_ stage:String, code:Int = 0) {
        guard let index=CommandLine.arguments.firstIndex(of:"--navigation-diagnostics"), CommandLine.arguments.indices.contains(index+1),
              let bytes=try? JSONSerialization.data(withJSONObject:["stage":stage,"code":code]) else { return }
        try? bytes.write(to:URL(fileURLWithPath:CommandLine.arguments[index+1]),options:.atomic)
    }
    // Opt-in, bounded evidence from this WKWebView; never records URL queries,
    // cookies, asset identifiers, session names, or transcript content.
    func navigationDiagnostics() async {
        guard let index=CommandLine.arguments.firstIndex(of:"--navigation-diagnostics"), CommandLine.arguments.indices.contains(index+1) else { return }
        let destination=URL(fileURLWithPath:CommandLine.arguments[index+1])
        let script = """
        const icons=[...document.querySelectorAll('.session-project-icon')];
        const samples=icons.slice(0,8).map(e=>{const c=getComputedStyle(e),r=e.getBoundingClientRect(),i=e.querySelector('img');return {width:r.width,height:r.height,display:c.display,visibility:c.visibility,opacity:c.opacity,image:i?{complete:i.complete,width:i.naturalWidth,height:i.naturalHeight}:null,folder:!!e.querySelector('svg')}});
        const image=icons.map(e=>e.querySelector('img')).find(Boolean);
        let asset='not-requested';
        const candidates=[image?.src,...performance.getEntriesByType('resource').map(e=>e.name)].filter(Boolean);
        const assetURL=candidates.find(s=>{const u=new URL(s);return u.origin===location.origin && u.pathname.startsWith('/v1/assets/')});
        if(assetURL){try{const r=await fetch(assetURL,{signal:AbortSignal.timeout(3000)});asset=String(r.status)}catch{asset='fetch-failed'}}
        return JSON.stringify({origin:location.origin,path:location.pathname,shellContract:Number(new URLSearchParams(location.search).get('shell')||0),scripts:[...document.scripts].map(s=>{try{return new URL(s.src).pathname}catch{return ''}}).filter(Boolean).slice(0,8),ready:!!window.suriReady,updateReady:window.suriUpdate?.ready ?? null,viewReady:window.suriViewReady?.() ?? null,shell:!!document.querySelector('.shell'),requiredChunk:!!document.querySelector('[data-required-chunk-loading]'),rows:document.querySelectorAll('.session-row').length,list:!!document.querySelector('.flat-sessions'),icons:icons.length,imageCount:icons.filter(e=>e.querySelector('img')).length,folderCount:icons.filter(e=>e.querySelector('svg')).length,imageScheme:image?new URL(image.src).protocol:null,samples,asset});
        """
        do {
            let text:String = try await withCheckedThrowingContinuation { continuation in
                webView.callAsyncJavaScript(script,arguments:[:],in:nil,in:.page) { result in
                    switch result {
                    case .success(let value):
                        if let text=value as? String { continuation.resume(returning:text) } else { continuation.resume(throwing:NSError(domain:"SuriDiagnostics",code:1)) }
                    case .failure(let error): continuation.resume(throwing:error)
                    }
                }
            }
            try Data(text.utf8).write(to:destination,options:.atomic)
            try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:destination.path)
            NSApp.activate(ignoringOtherApps:true);webView.window?.makeKeyAndOrderFront(nil)
            let image=try await webView.takeSnapshot(configuration:nil)
            if let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) { try png.write(to:destination.deletingPathExtension().appendingPathExtension("png"),options:.atomic) }
        } catch { try? Data("{\"stage\":\"wk-navigation-diagnostics\",\"error\":\"evaluation-or-snapshot-failed\"}".utf8).write(to:destination,options:.atomic) }
    }
    func loadBootstrap(_ url:URL) {
        diagnosticFailure("navigation-pending")
        webView.load(URLRequest(url:url))
    }
    func start() {
        if allowedOrigin != nil && webView.url != nil && phase == .ready { return }
        diagnosticFailure("bootstrap-pending")
        showProgress("Starting Suri Pi…", phase:.starting)
        Task {
            do {
                let clientId=UserDefaults.standard.string(forKey:key("clientId")) ?? UUID().uuidString
                UserDefaults.standard.set(clientId,forKey:key("clientId"))
                let data = try await command(["bootstrap",clientId])
                guard let value = try JSONSerialization.jsonObject(with: data) as? [String:String], let origin = value["origin"], let nonce = value["nonce"], let base = URL(string: origin), let url=BootstrapNavigation.url(origin:origin,nonce:nonce,benchmark:ProcessInfo.processInfo.environment["SURI_NATIVE_BENCHMARK"] == "1") else { throw NSError(domain:"Suri",code:2) }
                allowedOrigin = base
                loadBootstrap(url)
            } catch { diagnosticFailure("bootstrap",code:(error as NSError).code);showRecovery("Suri host could not start. Reconnect to the retained host or recover the previous verified host.") }
        }
    }
    func flush() async throws { try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Void,Error>) in webView.callAsyncJavaScript("await window.suriFlush?.(); return true", arguments: [:], in: nil, in: .page, completionHandler:{ result in switch result { case .success:continuation.resume();case .failure(let error):continuation.resume(throwing:error) } }) } }
    func ready() async -> Bool { await withCheckedContinuation { continuation in webView.evaluateJavaScript("Boolean(window.suriReady && (!window.suriUpdate || window.suriUpdate.ready))") { value,error in continuation.resume(returning:error == nil && (value as? Bool)==true) } } }
    // Reload follows the host entry point, just like a fresh browser launch.
    // Importing a candidate is a separate explicit operation: a legacy host may
    // advertise an older compatible candidate as "ready" indefinitely.
    func reload() { Task { do { try await flush(); reauthenticate() } catch { showRecovery("Could not save the draft. Your current interface is retained.") } } }
    func loadReadyBuild() { Task { do { try await flush(); let data=try await command(["ui-builds"]); let receipt=try JSONSerialization.jsonObject(with:data) as? [String:Any]; let result=receipt?["result"] as? [String:Any]; if let ready=result?["ready"] as? String { let activated=try await command(["activate-ui",ready]); let receipt=try JSONSerialization.jsonObject(with:activated) as? [String:Any]; let result=receipt?["result"] as? [String:Any]; if let path=result?["url"] as? String, let origin=allowedOrigin, let url=BootstrapNavigation.appURL(origin:origin,path:path) { webView.load(URLRequest(url:url)); return } }; webView.reload() } catch { showRecovery("Could not save the draft or activate the UI. Your current interface is retained.") } } }
    func reauthenticate() {
        showProgress("Reconnecting to the Suri host…", phase:.reconnecting)
        Task {
            do {
                let clientId=UserDefaults.standard.string(forKey:key("clientId")) ?? UUID().uuidString
                UserDefaults.standard.set(clientId,forKey:key("clientId"))
                let data=try await command(["bootstrap-running",clientId])
                guard let value=try JSONSerialization.jsonObject(with:data) as? [String:String],let origin=value["origin"],let nonce=value["nonce"],let base=URL(string:origin),let url=BootstrapNavigation.url(origin:origin,nonce:nonce) else { throw NSError(domain:"Suri",code:6) }
                allowedOrigin=base
                loadBootstrap(url)
            } catch { showRecovery("Suri could not renew its local connection. Retry the exact running host or recover the previous verified host.") }
        }
    }
    func rollback() { if let origin = allowedOrigin,let url=BootstrapNavigation.appURL(origin:origin,path:UserDefaults.standard.string(forKey:key("previousUiPath")) ?? "/") { webView.load(URLRequest(url:url)) } }
    func selectDevelopmentCheckout() {
        let panel=NSOpenPanel();panel.canChooseDirectories=true;panel.canChooseFiles=false;panel.allowsMultipleSelection=false;panel.prompt="Use for Development"
        if panel.runModal() == .OK,let selected=panel.url {
            guard let checkout=validCheckout(selected) else { showRecovery("Build this checkout first. Its dist host entry point is missing.");return }
            UserDefaults.standard.set(checkout.path,forKey:key("developmentCheckout"))
            Task { do { _=try await command(["associate-ui",checkout.path]);showReady() } catch { UserDefaults.standard.removeObject(forKey:key("developmentCheckout"));showRecovery("The development checkout could not be associated.") } }
        }
    }
    func usePackagedHost() { UserDefaults.standard.removeObject(forKey:key("developmentCheckout"));showReady() }
    func openUpdates() {
        webView.callAsyncJavaScript("window.dispatchEvent(new Event('suri-open-updates')); return Boolean(window.suriUpdate)", arguments:[:], in:nil, in:.page) { result in
            if case .success(let value) = result, value as? Bool == true { return }
            Task { @MainActor in self.showRecovery("The modern Updates surface is unavailable. Reconnect to a contract-2 host before requesting a restart.") }
        }
    }
    func recoverPreviousHost() {
        showProgress("Recovering the previous verified host…", phase:.reconnecting)
        Task {
            do {
                _ = try await command(["updates","recover-host","--previous"])
                reauthenticate()
            } catch {
                showRecovery("Previous-host recovery was refused or failed. A running host was not replaced.")
            }
        }
    }
    func picker() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Open project"
        if panel.runModal() == .OK, let path = panel.url?.path {
            Task { do { _ = try await command(["add-project", path]); webView.reload() } catch { showRecovery("The project could not be registered.") } }
        }
    }
    func importSession(workspaceId:String,runtimeId:String) {
        let panel=NSOpenPanel();panel.canChooseFiles=true;panel.canChooseDirectories=false;panel.allowsMultipleSelection=true;panel.allowedContentTypes=[.json];panel.prompt="Review Pi histories"
        if panel.runModal() == .OK {
            let paths=panel.urls.map(\.path)
            Task { do {
                try await flush()
                let data=try await command(["grant-files"]+paths)
                guard let files=try JSONSerialization.jsonObject(with:data) as? [[String:String]] else { throw NSError(domain:"Suri",code:3) }
                try await withCheckedThrowingContinuation { (continuation:CheckedContinuation<Void,Error>) in
                    webView.callAsyncJavaScript("window.suriImportFiles?.(files)",arguments:["files":files],in:nil,in:.page) { result in
                        switch result { case .success: continuation.resume(); case .failure(let error): continuation.resume(throwing:error) }
                    }
                }
            } catch { showRecovery("History preview failed. The originals were not changed.") } }
        }
    }
    func revealPath(_ path:String) {
        let url=URL(fileURLWithPath:path).standardizedFileURL
        guard url.path.hasPrefix("/"),FileManager.default.fileExists(atPath:url.path) else { showRecovery("That workspace is no longer available on disk.");return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
    func openPath(_ path:String, choosingApplication:Bool) {
        let url=URL(fileURLWithPath:path).standardizedFileURL
        guard url.path.hasPrefix("/"),FileManager.default.fileExists(atPath:url.path) else { showRecovery("That file is no longer available on disk.");return }
        if !choosingApplication { NSWorkspace.shared.open(url);return }
        let panel=NSOpenPanel();panel.canChooseFiles=true;panel.canChooseDirectories=false;panel.allowsMultipleSelection=false;panel.allowedContentTypes=[.application];panel.directoryURL=URL(fileURLWithPath:"/Applications");panel.prompt="Open With"
        if panel.runModal() == .OK,let application=panel.url {
            NSWorkspace.shared.open([url],withApplicationAt:application,configuration:NSWorkspace.OpenConfiguration()) { _,error in
                if error != nil { Task { @MainActor in self.showRecovery("The selected application could not open this file.") } }
            }
        }
    }
    func selectSession(_ id:String) {
        Task {
            for _ in 0..<100 {
                if await ready() {
                    webView.callAsyncJavaScript("window.suriSelectSession?.(id); return true",arguments:["id":id],in:nil,in:.page) { _ in }
                    NSApp.activate(ignoringOtherApps:true)
                    webView.window?.makeKeyAndOrderFront(nil)
                    return
                }
                try? await Task.sleep(for:.milliseconds(100))
            }
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let origin = allowedOrigin, message.frameInfo.securityOrigin.host == "127.0.0.1", message.frameInfo.securityOrigin.port == origin.port, let body = message.body as? [String:String] else { return }
        switch body["type"] {
        case "pickDirectory": picker()
        case "reload": reload()
        case "reauthenticate": reauthenticate()
        case "hostLifecycle":
            switch body["state"] {
            case "restartInProgress": showProgress("Restarting the Suri host. Your saved window will reconnect automatically…", phase:.restartInProgress)
            case "reconnecting": showProgress("The replacement host is verified. Reconnecting this window…", phase:.reconnecting)
            case "recoveryRequired": showRecovery("Secure reconnection did not complete. Retry the running host or recover the previous verified host.")
            case "ready": showReady()
            default: break
            }
        case "importSession": if let workspace=body["workspaceId"],let runtime=body["runtimeId"] { importSession(workspaceId:workspace,runtimeId:runtime) }
        case "revealPath": if let path=body["path"] { revealPath(path) }
        case "openPath": if let path=body["path"] { openPath(path,choosingApplication:false) }
        case "openWithPath": if let path=body["path"] { openPath(path,choosingApplication:true) }
        case "quit": NSApp.terminate(nil)
        default: break
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.host == allowedOrigin?.host && url.port == allowedOrigin?.port && url.scheme == "http" { decisionHandler(.allow) }
        else { if navigationAction.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let url=webView.url
        Task { for _ in 0..<100 { if webView.url?.path != url?.path { return }; if await ready() { showReady();Task { await benchmark(); await navigationDiagnostics() };let path=url?.path ?? "/";let old=UserDefaults.standard.string(forKey:key("uiPath")) ?? "/";if old != path { UserDefaults.standard.set(old,forKey:key("previousUiPath")) };UserDefaults.standard.set(path,forKey:key("uiPath"));return };try? await Task.sleep(for:.milliseconds(100)) };diagnosticFailure("ui-readiness-timeout");await navigationDiagnostics();showRecovery("The interface did not become ready. Reload the previous UI or reconnect to the retained host.") }
    }
    func benchmark() async {
        guard !benchmarkStarted, ProcessInfo.processInfo.environment["SURI_NATIVE_BENCHMARK"] == "1",
              let root = ProcessInfo.processInfo.environment["SURI_DATA_DIR"],
              FileManager.default.fileExists(atPath:root+"/.suri-performance.json") else { return }
        benchmarkStarted = true
        while !NSApp.isActive || webView.window?.isKeyWindow != true { try? await Task.sleep(for:.milliseconds(100)) }
        let script = """
        const wait = ms => new Promise(r => setTimeout(r,ms));
        const paint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        for(let i=0;i<100 && !document.querySelector('textarea:not(:disabled)');i++) await wait(100);
        const editor=document.querySelector('textarea:not(:disabled)');
        if(!editor) throw Error('Fixture editor missing');
        await wait(1000);await paint();window.suriPaintSamples=[];
        const old=editor.value;
        const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
        const scroller=document.querySelector('.transcript');scroller.scrollTop=100;await wait(100);
        const anchor=scroller.scrollTop, samples=[];let previous=performance.now(),stalls=0,measuring=true;
        function frame(now){if(now-previous>200)stalls++;previous=now;if(measuring)requestAnimationFrame(frame)}requestAnimationFrame(frame);
        for(let i=0;i<50;i++){const start=performance.now();setter.call(editor,'Native benchmark draft '+i);editor.dispatchEvent(new Event('input',{bubbles:true}));await paint();samples.push(performance.now()-start)}
        await wait(1500);measuring=false;
        const sorted=samples.sort((a,b)=>a-b), events=(window.suriPaintSamples??[]).sort((a,b)=>a-b);
        const preserved=editor.value==='Native benchmark draft 49';
        setter.call(editor,old);editor.dispatchEvent(new Event('input',{bubbles:true}));await paint();await window.suriFlush?.();
        const inputP95=sorted[Math.floor(sorted.length*.95)],eventP95=events[Math.floor(events.length*.95)];
        const overflow=document.documentElement.scrollWidth>innerWidth;
        const anchorStable=Math.abs(scroller.scrollTop-anchor)<2;
        return JSON.stringify({engine:'native WKWebView',inputP95,eventP95,eventSamples:events.length,stalls,overflow,anchorStable,draftPreserved:preserved,passed:inputP95<=100&&eventP95<=150&&events.length>=20&&stalls===0&&!overflow&&preserved&&anchorStable});
        """
        do {
            let text: String = try await withCheckedThrowingContinuation { continuation in
                webView.callAsyncJavaScript(script,arguments:[:],in:nil,in:.page,completionHandler:{ result in
                    switch result { case .success(let value):
                        if let text=value as? String {continuation.resume(returning:text)} else {continuation.resume(throwing:NSError(domain:"SuriBenchmark",code:1))}
                    case .failure(let error):continuation.resume(throwing:error) }
                })
            }
            try Data(text.utf8).write(to:URL(fileURLWithPath:root+"/native-benchmark.json"),options:.atomic)
        } catch { try? Data("{\"passed\":false,\"error\":\"Native benchmark did not complete\"}".utf8).write(to:URL(fileURLWithPath:root+"/native-benchmark.json")) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let code=(error as NSError).code
        diagnosticFailure("provisional-navigation",code:code)
        if ShellPhase.navigationFailureRequiresRecovery(error) { showRecovery("The interface could not reconnect to the running host. Retry the exact running host or recover the previous verified host.") }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let code=(error as NSError).code
        diagnosticFailure("navigation",code:code)
        if ShellPhase.navigationFailureRequiresRecovery(error) { showRecovery("The interface navigation failed. Retry the exact running host or recover the previous verified host.") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { diagnosticFailure("web-content-terminated"); showRecovery("The interface process stopped. Reconnect to the running host; no prompt will be resubmitted.") }
}
@MainActor final class SuriDelegate:NSObject,NSApplicationDelegate {
    weak var model:BrowserModel?
    var pendingSessionId:String?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool { false }
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows flag:Bool)->Bool {
        if !flag { sender.windows.first(where:{$0.canBecomeMain})?.makeKeyAndOrderFront(nil) }
        return true
    }
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        Task { do { try await model.flush();sender.reply(toApplicationShouldTerminate:true) } catch {model.showRecovery("The draft could not be saved. Keep this window open and retry.");sender.reply(toApplicationShouldTerminate:false)} }
        return .terminateLater
    }
    func application(_ application:NSApplication,open urls:[URL]) {
        guard let url=urls.first(where:{$0.scheme=="suri-pi" && $0.host=="session"}),let id=url.pathComponents.dropFirst().first,!id.isEmpty else { return }
        if let model { model.selectSession(id) } else { pendingSessionId=id }
    }
}
struct WebSurface: NSViewRepresentable {
    let model: BrowserModel
    func makeNSView(context: Context) -> WKWebView { model.webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
@main struct SuriPiApp: App {
    @NSApplicationDelegateAdaptor(SuriDelegate.self) private var delegate
    @StateObject private var model = BrowserModel()
    var body: some Scene {
        WindowGroup("Suri Pi", id:"main") {
            ZStack {
                WebSurface(model:model).frame(maxWidth:.infinity,maxHeight:.infinity)
                if model.phase != .ready { VStack(spacing:16) { Text(model.status).multilineTextAlignment(.center).frame(maxWidth:420); if model.phase == .recoveryRequired { Button("Reconnect to Running Host") { model.reauthenticate() };Button("Reload Previous UI") { model.rollback() };Button("Recover Previous Verified Host") { model.recoverPreviousHost() } } else if model.phase.showsProgress { ProgressView() } }.padding(30).background(.regularMaterial).cornerRadius(12) }
            }.frame(minWidth:390,minHeight:500).task { delegate.model=model;model.start();if let id=delegate.pendingSessionId { delegate.pendingSessionId=nil;model.selectSession(id) } }.onDisappear { Task { try? await model.flush() } }
        }.defaultSize(width:1180,height:820).commands {
            CommandGroup(after:.toolbar) { Button("Zoom In") { model.webView.pageZoom=min(2,model.webView.pageZoom+0.25) }.keyboardShortcut("+"); Button("Zoom Out") { model.webView.pageZoom=max(0.5,model.webView.pageZoom-0.25) }.keyboardShortcut("-"); Button("Actual Size") { model.webView.pageZoom=1 }.keyboardShortcut("0") }
            CommandGroup(replacing:.newItem) { Button("Open Project…") { model.picker() }.keyboardShortcut("o"); Divider(); Button("Reload UI") { model.reload() }.keyboardShortcut("r",modifiers:[.command,.shift]); Button("Reload Previous UI") { model.rollback() }; Button("Load Ready UI Build") { model.loadReadyBuild() }; Button("Open Updates…") { model.openUpdates() }; Button("Reconnect to Running Host") { model.reauthenticate() }; Divider(); Button("Select Development Checkout…") { model.selectDevelopmentCheckout() }; Button("Use Packaged Host") { model.usePackagedHost() }.disabled(model.developmentCheckout == nil); Button("Recover Previous Verified Host…") { model.recoverPreviousHost() }.disabled(model.phase != .recoveryRequired) }
        }
    }
}
