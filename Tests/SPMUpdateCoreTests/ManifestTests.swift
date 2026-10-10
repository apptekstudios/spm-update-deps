import Foundation
@testable import SPMUpdateCore
import XCTest

private let manifest = """
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Demo",
    dependencies: [
        .package(url: "https://github.com/a/From.git", from: "1.0.0"),
        .package(url: "https://github.com/a/Major.git", .upToNextMajor(from: "2.0.0")),
        .package(url: "https://github.com/a/Minor.git", .upToNextMinor(from: "3.1.0")),
        .package(url: "https://github.com/a/ExactLabel.git", exact: "4.0.0"),
        .package(url: "https://github.com/a/ExactMethod.git", .exact("5.0.0")),
        .package(url: "https://github.com/a/Branch.git", branch: "main"),
        .package(url: "https://github.com/a/Rev.git", revision: "0123456789abcdef0123"),
        .package(url: "https://github.com/a/Range.git", "1.0.0"..<"2.0.0"),
        .package(url: "https://github.com/a/Closed.git", "1.0.0"..."1.9.0"),
        // .package(url: "https://github.com/a/Commented.git", from: "1.0.0"),
        /* .package(url: "https://github.com/a/Block.git", from: "1.0.0"), */
        .package(
            name: "Named",
            url: "https://github.com/a/named-repo.git",
            .upToNextMajor(from: "1.2.0")
        ),
        .package(url: "https://github.com/a/Traits.git", from: "1.0.0", traits: ["Foo"]),
        .package(path: "../Local"),
        .package(id: "scope.Registry", from: "1.0.0"),
    ]
)

"""

private func edit(_ src: String, _ d: Dependency, _ next: Requirement) -> String {
    guard case let .packageSwift(start, end, style) = d.handle else { fatalError("no handle") }
    return editPackageSwift(src, [PackageSwiftEdit(start: start, end: end, style: style, prev: d.req, next: next)])
}

final class PackageSwiftTests: XCTestCase {
    let deps = parsePackageSwift(manifest)
    func named(_ n: String) -> Dependency { deps.first { $0.name == n }! }
    func req(_ n: String) -> String { formatRequirement(named(n).req) }

    func testParsesEveryRequirementForm() {
        XCTAssertEqual(req("From"), "^1.0.0")
        XCTAssertEqual(req("Major"), "^2.0.0")
        XCTAssertEqual(req("Minor"), "~3.1.0")
        XCTAssertEqual(req("ExactLabel"), "=4.0.0")
        XCTAssertEqual(req("ExactMethod"), "=5.0.0")
        XCTAssertEqual(req("Branch"), "branch:main")
        XCTAssertEqual(req("Rev"), "rev:0123456789ab")
        XCTAssertEqual(req("Range"), ">=1.0.0 <2.0.0")
        XCTAssertEqual(req("Closed"), ">=1.0.0 <=1.9.0")
        XCTAssertEqual(req("Traits"), "^1.0.0")
    }

    func testIgnoresCommentedOutDependencies() {
        XCTAssertFalse(deps.contains { $0.name == "Commented" || $0.name == "Block" })
    }

    func testMultiLineCallsWithName() {
        XCTAssertEqual(named("Named").identity, "named-repo")
        XCTAssertEqual(req("Named"), "^1.2.0")
    }

    func testLocalAndRegistryPackages() {
        XCTAssertEqual(named("Local").source, .local)
        XCTAssertEqual(named("Registry").source, .registry)
    }

    func testKeepsMethodStyleWithoutStrayParen() {
        let out = edit(manifest, named("Major"), .version(.upToNextMajor, "2.5.0"))
        XCTAssertTrue(out.contains(#".package(url: "https://github.com/a/Major.git", .upToNextMajor(from: "2.5.0")),"#))
        XCTAssertEqual(parsePackageSwift(out).count, deps.count)
    }

    func testKeepsLabelStyle() {
        XCTAssertTrue(edit(manifest, named("From"), .version(.upToNextMajor, "1.4.0")).contains(#"From.git", from: "1.4.0"),"#))
        XCTAssertTrue(edit(manifest, named("ExactLabel"), .version(.exact, "4.1.0")).contains(#"ExactLabel.git", exact: "4.1.0"),"#))
        XCTAssertTrue(edit(manifest, named("ExactMethod"), .version(.exact, "5.1.0")).contains(#"ExactMethod.git", .exact("5.1.0")),"#))
    }

    func testKeepsTrailingArguments() {
        XCTAssertTrue(edit(manifest, named("Traits"), .version(.upToNextMajor, "1.1.0")).contains(#"Traits.git", from: "1.1.0", traits: ["Foo"]),"#))
    }

    func testKeepsMultiLineFormatting() {
        let out = edit(manifest, named("Named"), .version(.upToNextMajor, "1.3.0"))
        XCTAssertTrue(out.contains("            url: \"https://github.com/a/named-repo.git\",\n            .upToNextMajor(from: \"1.3.0\")\n        ),"))
    }

    func testRangesAndKindChanges() {
        XCTAssertTrue(edit(manifest, named("Closed"), .range(lower: "1.5.0", upper: "1.9.0", closed: true)).contains(#""1.5.0"..."1.9.0""#))
        XCTAssertTrue(edit(manifest, named("Branch"), .version(.upToNextMajor, "1.0.0")).contains(#"Branch.git", from: "1.0.0"),"#))
        XCTAssertTrue(edit(manifest, named("From"), .version(.upToNextMinor, "1.4.0")).contains(#"From.git", .upToNextMinor(from: "1.4.0")),"#))
    }

    func testKeepsSpacingInsideRanges() {
        let src = ".package(\n  url: \"https://github.com/google/gtm-session-fetcher.git\",\n  \"4.0.0\" ..< \"6.0.0\"\n),"
        let d = parsePackageSwift(src)[0]
        XCTAssertEqual(edit(src, d, .range(lower: "4.5.0", upper: "6.0.0", closed: false)),
                       ".package(\n  url: \"https://github.com/google/gtm-session-fetcher.git\",\n  \"4.5.0\" ..< \"6.0.0\"\n),")
    }

    func testSeveralEditsAtOnce() {
        func e(_ d: Dependency, _ next: Requirement) -> PackageSwiftEdit {
            guard case let .packageSwift(s, en, st) = d.handle else { fatalError() }
            return PackageSwiftEdit(start: s, end: en, style: st, prev: d.req, next: next)
        }
        let out = editPackageSwift(manifest, [e(named("From"), .version(.upToNextMajor, "1.9.0")), e(named("Minor"), .version(.upToNextMinor, "3.1.4"))])
        let re = parsePackageSwift(out)
        XCTAssertEqual(formatRequirement(re.first { $0.name == "From" }!.req), "^1.9.0")
        XCTAssertEqual(formatRequirement(re.first { $0.name == "Minor" }!.req), "~3.1.4")
    }

    func testCommentsInsideCalls() {
        let src = """
        let package = Package(dependencies: [
        \t.package(
        \t\turl: "https://github.com/apple/swift-algorithms.git", // pinned for Foo
        \t\t.upToNextMajor(from: "1.1.0") // or `.upToNextMajor(from: "1.2.0")`
        \t),
        \t.package(url: "https://github.com/a/B.git", /* min */ from: "2.0.0"),
        ])
        """
        let ds = parsePackageSwift(src)
        XCTAssertEqual(ds.map { formatRequirement($0.req) }, ["^1.1.0", "^2.0.0"])
        let out = editPackageSwift(src, ds.map { d in
            guard case let .packageSwift(s, e, st) = d.handle else { fatalError() }
            return PackageSwiftEdit(start: s, end: e, style: st, prev: d.req, next: .version(.upToNextMajor, "9.9.9"))
        })
        XCTAssertTrue(out.contains(#".upToNextMajor(from: "9.9.9") // or `.upToNextMajor(from: "1.2.0")`"#))
        XCTAssertTrue(out.contains(#"/* min */ from: "9.9.9"),"#))
        XCTAssertTrue(out.contains("// pinned for Foo"))
    }

    func testUnicodeElsewhereInFileSurvivesEdits() {
        let src = "// Café ☕️ 🚀\n.package(url: \"https://x.com/a/Ünï.git\", from: \"1.0.0\"),\n// done ✅"
        let d = parsePackageSwift(src)[0]
        XCTAssertEqual(edit(src, d, .version(.upToNextMajor, "2.0.0")),
                       "// Café ☕️ 🚀\n.package(url: \"https://x.com/a/Ünï.git\", from: \"2.0.0\"),\n// done ✅")
    }
}

final class XcodeTests: XCTestCase {
    let pbx = Fixtures.pbxproj
    lazy var deps = parseXcodeProject(pbx)
    func id(_ name: String) -> String {
        guard case let .xcode(id) = deps.first(where: { $0.name == name })!.handle else { fatalError() }
        return id
    }

    func testReadsRemoteAndLocalReferences() {
        XCTAssertEqual(deps.map { "\($0.name) \(formatRequirement($0.req))" }, [
            "Alamofire ^5.0.0", "Core path:Packages/Core", "Kingfisher =7.0.0", "swift-argument-parser branch:main",
            "swift-log >=1.4.0 <2.0.0",
        ])
        XCTAssertEqual(deps.first { $0.name == "Core" }!.source, .local)
    }

    func testEditsOnlyTheRequirementBlock() throws {
        let out = try editXcodeProject(pbx, [
            XcodeEdit(id: id("Alamofire"), name: "Alamofire", next: .version(.upToNextMajor, "5.9.0")),
            XcodeEdit(id: id("swift-log"), name: "swift-log", next: .range(lower: "1.5.0", upper: "2.0.0", closed: false)),
            XcodeEdit(id: id("swift-argument-parser"), name: "swift-argument-parser", next: .version(.upToNextMinor, "1.3.0")),
        ])
        let before = pbx.components(separatedBy: "\n"), after = out.components(separatedBy: "\n")
        XCTAssertEqual(before.count, after.count)
        let changed = zip(before, after).filter { $0 != $1 }.map(\.1)
        XCTAssertEqual(changed, [
            "\t\t\t\tminimumVersion = 5.9.0;",
            "\t\t\t\tminimumVersion = 1.5.0;",
            "\t\t\t\tkind = upToNextMinorVersion;",
            "\t\t\t\tminimumVersion = 1.3.0;",
        ])
        let re = parseXcodeProject(out)
        XCTAssertEqual(formatRequirement(re.first { $0.name == "swift-argument-parser" }!.req), "~1.3.0")
        XCTAssertEqual(formatRequirement(re.first { $0.name == "swift-log" }!.req), ">=1.5.0 <2.0.0")
    }

    func testQuotesValuesThatNeedIt() throws {
        let out = try editXcodeProject(pbx, [XcodeEdit(id: id("Alamofire"), name: "Alamofire", next: .branch("feature-x"))])
        XCTAssertTrue(out.contains(#"branch = "feature-x";"#))
        XCTAssertEqual(formatRequirement(parseXcodeProject(out).first { $0.name == "Alamofire" }!.req), "branch:feature-x")
    }

    func testNumericLookingVersionsKeptAsWritten() {
        let p = pbx.replacingOccurrences(of: "version = 7.0.0;", with: "version = 1.10;")
            .replacingOccurrences(of: "minimumVersion = 5.0.0;", with: "minimumVersion = 2.0;")
        let parsed = parseXcodeProject(p)
        XCTAssertEqual(formatRequirement(parsed.first { $0.name == "Kingfisher" }!.req), "=1.10")
        XCTAssertEqual(formatRequirement(parsed.first { $0.name == "Alamofire" }!.req), "^2.0")
    }

    func testUnlocatableBlocksThrow() {
        XCTAssertThrowsError(try editXcodeProject(pbx, [XcodeEdit(id: "DOESNOTEXIST", name: "Ghost", next: .version(.exact, "1.0.0"))])) {
            XCTAssertTrue("\($0)".contains("can't locate the requirement block for Ghost"))
        }
    }
}

final class ResolvedTests: XCTestCase {
    func testV1() {
        let pins = parseResolved(Data("""
        {"object":{"pins":[
          {"package":"Alamofire","repositoryURL":"https://github.com/Alamofire/Alamofire.git","state":{"branch":null,"revision":"x","version":"5.8.1"}},
          {"package":"Foo","repositoryURL":"https://github.com/a/Foo","state":{"branch":"main","revision":"y","version":null}}
        ]},"version":1}
        """.utf8))
        XCTAssertEqual(pins["alamofire"]?.version, "5.8.1")
        XCTAssertEqual(pins["foo"]?.branch, "main")
        XCTAssertNil(pins["foo"]?.version)
    }

    func testV2V3() {
        let pins = parseResolved(Data("""
        {"originHash":"abc","pins":[{"identity":"swift-log","kind":"remoteSourceControl","location":"https://github.com/apple/swift-log.git","state":{"revision":"z","version":"1.5.4"}}],"version":3}
        """.utf8))
        XCTAssertEqual(pins["swift-log"]?.version, "1.5.4")
    }

    func testGarbage() {
        XCTAssertTrue(parseResolved(Data("not json".utf8)).isEmpty)
    }
}
