import Foundation
import WebKit

enum ShellPhase: String, Equatable {
    case starting
    case ready
    case restartInProgress
    case reconnecting
    case recoveryRequired

    var showsProgress: Bool {
        switch self {
        case .starting, .restartInProgress, .reconnecting: true
        case .ready, .recoveryRequired: false
        }
    }

    var canRecoverPreviousHost: Bool { self == .recoveryRequired }

    static func navigationFailureRequiresRecovery(_ error: Error) -> Bool {
        // WebKit exposes WebKitErrorFrameLoadInterruptedByPolicyChange as code 102,
        // but the current Swift overlay does not provide a typed enum case for it.
        let policyChangeCancellationCode = 102
        let failure = error as NSError
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled {
            return false
        }
        if failure.domain == WKError.errorDomain && failure.code == policyChangeCancellationCode {
            return false
        }
        return true
    }
}
