// swift-tools-version: 6.2
// DropKit : tout ce qui ne depend pas de l'ecran. Modeles, reseau, formats,
// memoire locale. Compile aussi pour macOS, ce qui permet de le tester avec
// `swift test` sans simulateur.
import PackageDescription

let package = Package(
    name: "DropKit",
    defaultLocalization: "fr",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "DropKit", targets: ["DropKit"]),
    ],
    targets: [
        .target(name: "DropKit"),
        .testTarget(name: "DropKitTests", dependencies: ["DropKit"]),
    ]
)
