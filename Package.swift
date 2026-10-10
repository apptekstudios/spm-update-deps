// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "spm-update",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "spm-update", targets: ["spm-update"]),
    ],
    targets: [
        .target(name: "SPMUpdateCore"),
        .executableTarget(name: "spm-update", dependencies: ["SPMUpdateCore"]),
        .testTarget(
            name: "SPMUpdateCoreTests",
            dependencies: ["SPMUpdateCore"],
            exclude: ["Fixtures"]
        ),
    ]
)
