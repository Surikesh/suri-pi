import Foundation
import Testing
import WebKit
@testable import SuriPi

@Test func freshBootstrapFollowsHostInsteadOfRememberedBuild() throws {
    let url = try #require(BootstrapNavigation.url(origin: "http://127.0.0.1:63213/ui/legacy-build/index.html?nativeReload=old", nonce: "test-nonce"))
    #expect(url.path == "/")
    #expect(url.query == "shell=2")
    #expect(url.fragment == "nonce=test-nonce")
}

@Test func reauthenticationAcceptsNewVerifiedLoopbackPort() throws {
    let url = try #require(BootstrapNavigation.url(origin: "http://127.0.0.1:54321", nonce: "test-nonce"))
    #expect(url.port == 54321)
    #expect(url.path == "/")
}

@Test func credentialsNeverEnterQueryEvenInBenchmarkMode() throws {
    let url = try #require(BootstrapNavigation.url(origin: "http://127.0.0.1:54321", nonce: "test-nonce", benchmark: true))
    #expect(url.query == "shell=2&nativeBenchmark=1")
    #expect(url.fragment == "nonce=test-nonce")
}

@Test func noncanonicalOriginsAreRejected() {
    for origin in ["https://127.0.0.1:1234", "http://localhost:1234", "http://example.com:1234", "http://user@127.0.0.1:1234", "http://127.0.0.1"] {
        #expect(BootstrapNavigation.url(origin: origin, nonce: "test-nonce") == nil)
    }
}

@Test func nativeAppTransitionsPreserveShellContractAndExistingQuery() throws {
    let origin = try #require(URL(string: "http://127.0.0.1:54321"))
    let activated = try #require(BootstrapNavigation.appURL(origin: origin, path: "/app"))
    #expect(activated.path == "/app")
    #expect(activated.query == "shell=2")
    let fallback = try #require(BootstrapNavigation.appURL(origin: origin, path: "/app?fallback=1&shell=1#stale"))
    #expect(fallback.query == "fallback=1&shell=2")
    #expect(fallback.fragment == nil)
}

@Test func nativeAppTransitionsRejectAnotherOrigin() throws {
    let origin = try #require(URL(string: "http://127.0.0.1:54321"))
    #expect(BootstrapNavigation.appURL(origin: origin, path: "http://127.0.0.1:54322/app") == nil)
    #expect(BootstrapNavigation.appURL(origin: origin, path: "https://example.com/app") == nil)
}

@Test func shellLifecycleSeparatesProgressFromExplicitRecovery() {
    #expect(ShellPhase.starting.showsProgress)
    #expect(ShellPhase.restartInProgress.showsProgress)
    #expect(ShellPhase.reconnecting.showsProgress)
    #expect(!ShellPhase.ready.showsProgress)
    #expect(!ShellPhase.recoveryRequired.showsProgress)
    #expect(ShellPhase.recoveryRequired.canRecoverPreviousHost)
    #expect(!ShellPhase.restartInProgress.canRecoverPreviousHost)
    let superseded = NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
    let policyChange = NSError(domain: WKError.errorDomain, code: 102)
    let provisionalFailure = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
    let committedFailure = NSError(domain: WKError.errorDomain, code: WKError.Code.webContentProcessTerminated.rawValue)
    let unrelatedCodeCollision = NSError(domain: NSURLErrorDomain, code: 102)
    #expect(!ShellPhase.navigationFailureRequiresRecovery(superseded))
    #expect(!ShellPhase.navigationFailureRequiresRecovery(policyChange))
    #expect(ShellPhase.navigationFailureRequiresRecovery(provisionalFailure))
    #expect(ShellPhase.navigationFailureRequiresRecovery(committedFailure))
    #expect(ShellPhase.navigationFailureRequiresRecovery(unrelatedCodeCollision))
}
