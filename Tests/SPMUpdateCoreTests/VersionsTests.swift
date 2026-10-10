import Foundation
@testable import SPMUpdateCore
import XCTest

private let lsRemote = [
    "a\trefs/tags/1.0.0",
    "b\trefs/tags/v1.0.1",
    "c\trefs/tags/1.1.0",
    "d\trefs/tags/1.2",
    "e\trefs/tags/1.2.3",
    "f\trefs/tags/2.0.0-beta.1",
    "g\trefs/tags/2.0.0",
    "h\trefs/tags/2.1.0",
    "i\trefs/tags/some-release-branch",
    "j\trefs/tags/1.1.0^{}",
].joined(separator: "\n")

private let tags = TagResult.versions(parseLsRemote(lsRemote))

final class TagParsingTests: XCTestCase {
    func testNormalizesTagsDropsJunkSortsNewestFirst() {
        XCTAssertEqual(parseLsRemote(lsRemote).map(\.description),
                       ["2.1.0", "2.0.0", "2.0.0-beta.1", "1.2.3", "1.2.0", "1.1.0", "1.0.1", "1.0.0"])
    }

    func testZeroPaddedCalendarVersionsReadLikeSwiftPM() {
        XCTAssertEqual(parseLsRemote("a\trefs/tags/26.09.25\nb\trefs/tags/26.10.02").map(\.description), ["26.10.2", "26.9.25"])
        let a = analyze(dep(.version(.exact, "26.09.25")), pin: Pin(version: "26.09.25"), tags: versions(["26.10.2", "26.9.25"]))
        XCTAssertEqual(a.status, .outdated)
        XCTAssertEqual(a.baseline, "26.9.25")
        XCTAssertEqual(a.minor, "26.10.2")
    }

    func testSemVerOrderingAndValidation() {
        XCTAssertLessThan(v("1.0.0-alpha"), v("1.0.0-alpha.1"))
        XCTAssertLessThan(v("1.0.0-alpha.1"), v("1.0.0-alpha.beta"))
        XCTAssertLessThan(v("1.0.0-beta.2"), v("1.0.0-beta.11"))
        XCTAssertLessThan(v("1.0.0-rc.1"), v("1.0.0"))
        XCTAssertNil(SemVer(strict: "01.0.0"))
        XCTAssertNil(SemVer(strict: "1.0.0-01"))
        XCTAssertEqual(normalizeVersion("v1.2.3+build.5"), "1.2.3")
        XCTAssertNil(normalizeVersion("1.2.3.4"))
        XCTAssertNil(normalizeVersion("release-1.0"))
    }
}

final class AnalyzeTests: XCTestCase {
    func testPatchMinorMajorFromRequirementFloor() {
        let a = analyze(dep(.version(.upToNextMajor, "1.0.0")), pin: nil, tags: tags)
        XCTAssertEqual(a.status, .outdated)
        XCTAssertEqual(a.update, .major)
        XCTAssertEqual([a.patch, a.minor, a.major], ["1.0.1", "1.2.3", "2.1.0"])
        XCTAssertEqual(a.inRange, true)
        XCTAssertFalse(a.newer.contains("2.0.0-beta.1"))
    }

    func testResolvedVersionIsBaseline() {
        let a = analyze(dep(.version(.upToNextMajor, "1.0.0")), pin: Pin(version: "1.2.3"), tags: tags)
        XCTAssertEqual(a.baseline, "1.2.3")
        XCTAssertNil(a.patch)
        XCTAssertNil(a.minor)
        XCTAssertEqual(a.major, "2.1.0")
    }

    func testStaleResolvedOutsideRequirementIsIgnored() {
        let a = analyze(dep(.version(.upToNextMajor, "2.0.0")), pin: Pin(version: "1.0.0"), tags: tags)
        XCTAssertEqual(a.baseline, "2.0.0")
        XCTAssertEqual(a.resolved, "1.0.0")
    }

    func testUpToDate() {
        let a = analyze(dep(.version(.exact, "2.1.0")), pin: nil, tags: tags)
        XCTAssertEqual(a.status, .upToDate)
        XCTAssertEqual(a.update, UpdateType.none)
    }

    func testInRangeFalseWhenRequirementExcludesNewestMinor() {
        XCTAssertEqual(analyze(dep(.version(.upToNextMinor, "1.0.0")), pin: nil, tags: tags).inRange, false)
    }

    func testPrereleasesAreOptIn() {
        let more = versions(["3.0.0-rc.1", "2.1.0", "2.0.0"])
        XCTAssertEqual(analyze(dep(.version(.upToNextMajor, "2.1.0")), pin: nil, tags: more).status, .upToDate)
        XCTAssertEqual(analyze(dep(.version(.upToNextMajor, "2.1.0")), pin: nil, tags: more, includePrerelease: true).major, "3.0.0-rc.1")
    }

    func testPrereleaseBaselineSeesLaterPrereleasesOfSameVersion() {
        let a = analyze(dep(.version(.upToNextMajor, "5.0.0-beta")), pin: nil,
                        tags: versions(["5.1.0-alpha.1", "5.0.0-beta.3", "5.0.0-beta.1", "4.9.3"]))
        XCTAssertEqual(a.update, .patch)
        XCTAssertEqual(a.patch, "5.0.0-beta.3")
        XCTAssertEqual(a.newer, ["5.0.0-beta.3", "5.0.0-beta.1"])
    }

    func testReleaseFlaggedEvenWhenResolvedAlreadyHasIt() {
        let a = analyze(dep(.version(.upToNextMajor, "5.0.0-beta")), pin: Pin(version: "5.0.0"),
                        tags: versions(["5.0.1", "5.0.0", "5.0.0-beta.3", "5.0.0-beta"]))
        XCTAssertEqual(a.status, .outdated)
        XCTAssertEqual(a.baseline, "5.0.0-beta")
        XCTAssertEqual(a.patch, "5.0.1")
        XCTAssertEqual(targetVersion(a, .patch), "5.0.1")
    }

    func testReleasePreferredOverLaterRC() {
        let a = analyze(dep(.version(.upToNextMajor, "5.0.0-beta")), pin: Pin(version: "5.0.0-rc.1"),
                        tags: versions(["5.0.0", "5.0.0-rc.2", "5.0.0-rc.1"]))
        XCTAssertEqual(a.baseline, "5.0.0-beta")
        XCTAssertEqual(a.patch, "5.0.0")
    }

    func testStaysOnPrereleasesUntilReleaseExists() {
        let a = analyze(dep(.version(.upToNextMajor, "5.0.0-beta")), pin: Pin(version: "5.0.0-beta.2"),
                        tags: versions(["5.0.0-rc.1", "5.0.0-beta.2", "4.9.0"]))
        XCTAssertEqual(a.baseline, "5.0.0-beta.2")
        XCTAssertEqual(a.patch, "5.0.0-rc.1")
    }

    func testIncludePrereleaseReleaseBeatsItsOwnRC() {
        let a = analyze(dep(.version(.upToNextMajor, "1.0.0")), pin: nil, tags: versions(["1.1.0", "1.1.0-rc.1"]), includePrerelease: true)
        XCTAssertEqual(a.minor, "1.1.0")
    }

    func testBranchPinsReportLatestRelease() {
        let a = analyze(dep(.branch("main")), pin: nil, tags: tags)
        XCTAssertEqual(a.status, .pinned)
        XCTAssertEqual(a.latest, "2.1.0")
    }

    func testFetchErrorsSurface() {
        let a = analyze(dep(.version(.exact, "1.0.0")), pin: nil, tags: .error("boom"))
        XCTAssertEqual(a.status, .error)
        XCTAssertEqual(a.err, "boom")
    }

    func testTargetVersionPerLevel() {
        let a = analyze(dep(.version(.upToNextMajor, "1.0.0")), pin: nil, tags: tags)
        XCTAssertEqual([targetVersion(a, .patch), targetVersion(a, .minor), targetVersion(a, .major)], ["1.0.1", "1.2.3", "2.1.0"])
    }
}

final class RequirementTests: XCTestCase {
    func testSatisfies() {
        XCTAssertTrue(satisfies(.version(.upToNextMajor, "1.0.0"), v("1.9.0")))
        XCTAssertFalse(satisfies(.version(.upToNextMajor, "1.0.0"), v("2.0.0")))
        XCTAssertFalse(satisfies(.version(.upToNextMinor, "1.2.0"), v("1.3.0")))
        XCTAssertFalse(satisfies(.range(lower: "1.0.0", upper: "2.0.0", closed: false), v("2.0.0")))
        XCTAssertTrue(satisfies(.range(lower: "1.0.0", upper: "2.0.0", closed: true), v("2.0.0")))
    }

    func testSameRequirementIgnoresSpelling() {
        XCTAssertTrue(sameRequirement(.version(.exact, "1.2"), .version(.exact, "1.2.0")))
        XCTAssertTrue(sameRequirement(.version(.exact, "26.09.25"), .version(.exact, "26.9.25")))
        XCTAssertFalse(sameRequirement(.version(.exact, "1.2.0"), .version(.upToNextMajor, "1.2.0")))
    }

    func testBumpKeepsKind() {
        func fmt(_ r: Requirement, _ s: String) -> String { formatRequirement(bumpRequirement(r, v(s))) }
        XCTAssertEqual(fmt(.version(.upToNextMinor, "1.0.0"), "1.4.0"), "~1.4.0")
        XCTAssertEqual(fmt(.version(.exact, "1.0.0"), "1.4.0"), "=1.4.0")
        XCTAssertEqual(fmt(.range(lower: "1.0.0", upper: "2.0.0", closed: false), "1.4.0"), ">=1.4.0 <2.0.0")
        XCTAssertEqual(fmt(.range(lower: "1.0.0", upper: "2.0.0", closed: false), "2.1.0"), ">=2.1.0 <3.0.0")
        XCTAssertEqual(fmt(.branch("main"), "1.4.0"), "^1.4.0")
        XCTAssertEqual(formatRequirement(bumpRequirement(.version(.upToNextMajor, "1.0.0"), v("1.4.0"), kind: .exact)), "=1.4.0")
    }

    func testIdentity() {
        XCTAssertEqual(nameFromUrl("https://github.com/apple/swift-log.git/"), "swift-log")
        XCTAssertEqual(identityFromUrl("git@github.com:Alamofire/Alamofire.git"), "alamofire")
        XCTAssertEqual(canonicalUrl("git@github.com:Apple/Swift-Log.git"), canonicalUrl("https://github.com/apple/swift-log"))
    }
}

private func pkt(_ s: String) -> String {
    let hex = String(s.utf8.count + 4, radix: 16)
    return String(repeating: "0", count: 4 - hex.count) + hex + s
}

final class LsRefsTests: XCTestCase {
    let oid = String(repeating: "a", count: 40)

    func testParsesPktLinesAndRejectsServerErrors() {
        XCTAssertEqual(parseLsRefsResponse(Data((pkt("\(oid) refs/tags/1.0.0\n") + pkt("\(oid) refs/tags/v1.1.0\n") + "0000").utf8)),
                       ["\(oid) refs/tags/1.0.0", "\(oid) refs/tags/v1.1.0"])
        XCTAssertNil(parseLsRefsResponse(Data((pkt("ERR upload-pack: not our ref\n") + "0000").utf8)))
        XCTAssertNil(parseLsRefsResponse(Data("<html>".utf8)))
    }

    func testFetchesOverHTTPAndFallsBackToGitOn401() async throws {
        let oid = oid
        let server = try TinyHTTPServer { req in
            if req.path.hasPrefix("/private") { return (401, "text/plain", "auth") }
            return (200, "application/x-git-upload-pack-result",
                    pkt("\(oid) refs/tags/1.0.0\n") + pkt("\(oid) refs/tags/2.0.0\n") + "0000")
        }
        defer { server.stop() }
        let fetcher = LiveTagFetcher(timeout: 5)
        let ok = await fetcher.fetch("http://127.0.0.1:\(server.port)/acme/Pkg.git")
        XCTAssertEqual(ok, versions(["2.0.0", "1.0.0"]))
        let first = try XCTUnwrap(server.seen.first)
        XCTAssertEqual(first.method, "POST")
        XCTAssertEqual(first.path, "/acme/Pkg.git/git-upload-pack")
        XCTAssertEqual(first.headers["git-protocol"], "version=2")
        XCTAssertTrue(first.body.contains("ref-prefix refs/tags/"))
        // 401 → git ls-remote (which can use credential helpers); here git fails too and says why.
        let denied = await fetcher.fetch("http://127.0.0.1:\(server.port)/private/Repo.git")
        guard case .error = denied else { return XCTFail("expected an error, got \(denied)") }
        XCTAssertTrue(server.seen.contains { $0.method == "GET" && $0.path.hasPrefix("/private/Repo.git/info/refs") })
    }
}

private final class Recorder: TagFetcher, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [String] = []
    var calls: [String] { lock.lock(); defer { lock.unlock() }; return _calls }
    func fetch(_ url: String) async -> TagResult {
        lock.lock(); _calls.append(url); lock.unlock()
        switch url {
        case "ok": return versions(["1.0.0"])
        case "gone": return .error("repository not found")
        default: return .error("timed out after 30s")
        }
    }
}

final class CacheTests: XCTestCase {
    func testCachesVersionsAndDefiniteFailuresNotTimeouts() async {
        setenv("SPM_UPDATE_CACHE_DIR", makeTempDir("spm-cache"), 1)
        defer { unsetenv("SPM_UPDATE_CACHE_DIR") }
        let inner = Recorder()
        let first = CachedTagFetcher(inner, ttlSeconds: 600)
        for u in ["ok", "gone", "slow"] { _ = await first.fetch(u) }
        first.flush()
        let second = CachedTagFetcher(inner, ttlSeconds: 600)
        let ok = await second.fetch("ok")
        let gone = await second.fetch("gone")
        _ = await second.fetch("slow")
        XCTAssertEqual(ok, versions(["1.0.0"]))
        XCTAssertEqual(gone, .error("repository not found"))
        XCTAssertEqual(inner.calls, ["ok", "gone", "slow", "slow"])
    }
}
