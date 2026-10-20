// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "SuriPi", platforms: [.macOS(.v14)], products: [.executable(name: "SuriPi", targets: ["SuriPi"])], targets: [.executableTarget(name: "SuriPi", swiftSettings: [.unsafeFlags(["-parse-as-library"])]), .testTarget(name: "SuriPiTests", dependencies: ["SuriPi"])])
