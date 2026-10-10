import Foundation
@testable import SPMUpdateCore
import XCTest

private let available = versions(["3.0.0", "2.4.1", "2.4.0", "2.3.2", "2.3.1", "2.3.0"])

private func checked(_ name: String, _ req: Requirement, m: Int = 0, error: String? = nil) -> CheckedDep {
    let d = Dependency(name: name, identity: name.lowercased(), source: .remote, url: "https://github.com/acme/\(name).git",
                       fetchUrl: nil, req: req, handle: .none)
    return CheckedDep(m: m, dep: d, a: analyze(d, pin: nil, tags: error.map(TagResult.error) ?? available))
}

private let manifests = [
    Manifest(path: "/x/Package.swift", label: "Package.swift", type: .package, resolvedPath: nil, deps: []),
    Manifest(path: "/x/App.xcodeproj/project.pbxproj", label: "App.xcodeproj", type: .xcodeproj, resolvedPath: nil, deps: []),
]

private func changes(_ plan: Plan) -> [String] {
    plan.changes.map { "\($0.name) \(formatRequirement($0.from)) -> \(formatRequirement($0.to))" }
}

private func d(_ s: String, manifest: String? = nil) -> Decision {
    var x = try! parseDecisionArg(s)
    x.manifest = manifest
    return x
}

final class DecisionParsingTests: XCTestCase {
    func testTargetsAndKindPrefixes() throws {
        XCTAssertEqual(try parseDecisionArg("Alamofire@minor"), Decision(selector: "Alamofire", target: "minor"))
        XCTAssertEqual(try parseDecisionArg("Foo@~1.2.3"), Decision(selector: "Foo", target: "1.2.3", kind: .upToNextMinor))
        XCTAssertEqual(try parseDecisionArg("Foo@=1.2.3").kind, .exact)
        let ssh = try parseDecisionArg("git@github.com:a/b.git@1.0.0")
        XCTAssertEqual(ssh.selector, "git@github.com:a/b.git")
        XCTAssertEqual(ssh.target, "1.0.0")
        XCTAssertThrowsError(try parseDecisionArg("Foo"))
    }

    func testPlanFiles() throws {
        XCTAssertEqual(try parsePlanFile(Data(#"[{"package":"Foo","target":"1.0.0","requirement":"exact"}]"#.utf8)),
                       [Decision(selector: "Foo", target: "1.0.0", kind: .exact)])
        XCTAssertEqual(try parsePlanFile(Data(#"{"decisions":[{"package":"Foo","target":"minor","manifest":"Package.swift"}]}"#.utf8))[0].manifest,
                       "Package.swift")
        XCTAssertThrowsError(try parsePlanFile(Data(#"{"nope":1}"#.utf8)))
    }
}

final class PlanDecisionsTests: XCTestCase {
    let deps = [
        checked("Alpha", .version(.upToNextMajor, "2.3.0")),
        checked("Beta", .version(.exact, "2.3.1")),
        checked("Gamma", .branch("main")),
        checked("Alpha", .version(.upToNextMinor, "2.3.0"), m: 1),
    ]

    func testLevelKeywordsPerDependencyInEveryManifest() {
        let plan = planDecisions(deps, manifests, [d("alpha@minor"), d("Beta@patch")], force: false)
        XCTAssertEqual(plan.errors, [])
        XCTAssertEqual(changes(plan), ["Alpha ^2.3.0 -> ^2.4.1", "Alpha ~2.3.0 -> ~2.4.1", "Beta =2.3.1 -> =2.3.2"])
    }

    func testManifestFilterKindOverrideExplicitVersions() {
        let plan = planDecisions(deps, manifests, [d("Alpha@=3.0.0", manifest: "App.xcodeproj"), d("Gamma@2.4.0")], force: false)
        XCTAssertEqual(changes(plan), ["Alpha ~2.3.0 -> =3.0.0", "Gamma branch:main -> ^2.4.0"])
    }

    func testCollectsEveryErrorAndSuggestsNames() {
        let plan = planDecisions(deps, manifests, [d("Alpah@minor"), d("Beta@9.9.9"), d("Beta@1.0.0"), d("Gamma@latest")], force: false)
        XCTAssertTrue(plan.changes.isEmpty)
        XCTAssertEqual(plan.errors, [
            "unknown package 'Alpah' (did you mean Alpha?)",
            "Beta: no tag 9.9.9 (newest: 3.0.0); pass --force to write anyway",
            "Beta: conflicting decisions '9.9.9' and '1.0.0'",
            "Gamma: pinned to branch:main; give an explicit version, e.g. Gamma@3.0.0",
        ])
    }

    func testManifestFilterThatExcludesThePackageSaysWhereItIs() {
        let plan = planDecisions(deps, manifests, [d("Beta@patch", manifest: "App.xcodeproj")], force: false)
        XCTAssertEqual(plan.errors, ["'Beta' is not in App.xcodeproj (found in Package.swift)"])
    }

    func testForceAllowsUnknownTagsAndDowngrades() {
        XCTAssertEqual(changes(planDecisions(deps, manifests, [d("Beta@2.0.0")], force: true)), ["Beta =2.3.1 -> =2.0.0"])
        XCTAssertTrue(planDecisions(deps, manifests, [d("Beta@2.3.0")], force: false).errors[0].contains("downgrade"))
    }

    func testNoOpDecisionsAreSkipped() {
        let plan = planDecisions([checked("Top", .version(.upToNextMajor, "3.0.0"))], manifests, [d("Top@latest")], force: false)
        XCTAssertTrue(plan.changes.isEmpty)
        XCTAssertEqual(plan.skipped, [Skip(m: 0, name: "Top", reason: "unchanged")])
    }

    func testFetchErrorsBlockKeywordTargets() {
        let plan = planDecisions([checked("Err", .version(.exact, "1.0.0"), error: "timed out")], manifests, [d("Err@minor")], force: false)
        XCTAssertEqual(plan.errors, ["Err: can't resolve 'minor': timed out"])
    }
}

final class PlanBulkTests: XCTestCase {
    let deps = [
        checked("Alpha", .version(.upToNextMajor, "2.3.0")),
        checked("Beta", .version(.upToNextMajor, "2.4.1")),
        checked("Gamma", .branch("main")),
        checked("Delta", .version(.exact, "2.3.0")),
    ]

    func testLevelMinorStaysInMajorAndReportsHeldBackMajors() {
        let plan = planBulk(deps, level: .minor, only: [], skip: ["delta"])
        XCTAssertEqual(changes(plan), ["Alpha ^2.3.0 -> ^2.4.1"])
        XCTAssertEqual(plan.skipped.map { "\($0.name): \($0.reason)" }, [
            "Beta: major 3.0.0 available (use Beta@major)",
            "Gamma: pinned branch:main",
            "Delta: --skip",
        ])
    }

    func testLevelMajorGoesToLatestAndOnlyLimits() {
        XCTAssertEqual(changes(planBulk(deps, level: .major, only: ["beta"], skip: [])), ["Beta ^2.4.1 -> ^3.0.0"])
    }
}

final class OutputTests: XCTestCase {
    func testJSONMatchesJavaScriptStringify() {
        let doc = JSON.object([("a", .string("q\"\\/\n\t\u{1}é🚀")), ("b", .array([.int(1), .bool(true)])), ("c", .array([])), ("d", .object([]))])
        XCTAssertEqual(doc.render(pretty: false), #"{"a":"q\"\\/\n\t\u0001é🚀","b":[1,true],"c":[],"d":{}}"#)
        XCTAssertEqual(doc.render(pretty: true), "{\n  \"a\": \"q\\\"\\\\/\\n\\t\\u0001é🚀\",\n  \"b\": [\n    1,\n    true\n  ],\n  \"c\": [],\n  \"d\": {}\n}")
    }

    func testCompactDropsEmptyValues() {
        XCTAssertEqual(JSON.compact([("a", nil), ("b", .bool(false)), ("c", .array([])), ("d", .int(0))]).render(pretty: false), #"{"d":0}"#)
    }
}
