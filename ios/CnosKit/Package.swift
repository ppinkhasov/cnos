// swift-tools-version: 5.9
import PackageDescription

// CnosKit — the platform-agnostic core of the cnos native client.
//
// Deliberately depends on Foundation ONLY (no SwiftUI / SwiftTerm / AVFoundation)
// so it compiles and unit-tests with the command-line Swift toolchain on macOS,
// and stays portable to a future Linux client. The iOS app target (SwiftUI +
// SwiftTerm + voice capture) lives outside this package and depends on it.
let package = Package(
    name: "CnosKit",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "CnosKit", targets: ["CnosKit"]),
    ],
    targets: [
        .target(name: "CnosKit"),
        // XCTest suite — runs in Xcode (the canonical tests once Xcode is present).
        .testTarget(name: "CnosKitTests", dependencies: ["CnosKit"]),
        // Plain-Swift verifier that runs the same checks via `swift run cnos-verify`,
        // so the core logic is verifiable with only the Command Line Tools (no XCTest).
        .executableTarget(name: "cnos-verify", dependencies: ["CnosKit"]),
    ]
)
