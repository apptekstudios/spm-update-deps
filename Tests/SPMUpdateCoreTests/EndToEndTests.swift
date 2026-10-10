// End-to-end tests: the real CLI binary and real `git ls-remote`, against local git
// repositories with tags (no network).

import Foundation
@testable import SPMUpdateCore
import XCTest

private enum Env {
    /// The built `spm-update` executable, next to the test bundle.
    static let binary: String = {
        #if os(macOS)
        for bundle in Bundle.allBundles where bundle.bundlePath.hasSuffix(".xctest") {
            return bundle.bundleURL.deletingLastPathComponent().appendingPathComponent("spm-update").path
        }
        #endif
        return Bundle.main.bundleURL.appendingPathComponent("spm-update").path
    }()

    static let tmp = makeTempDir("spm-update-e2e")
    static let cache = Path.join(tmp, "cache")

    static let urls: [String: String] = {
        func repo(_ name: String, _ tags: [String]) -> String {
            let dir = Path.join(Path.join(tmp, "repos"), "\(name).git")
            try! FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try! sh(["git", "init", "-q"], cwd: dir)
            try! sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], cwd: dir)
            for t in tags { try! sh(["git", "tag", t], cwd: dir) }
            return "file://\(dir)"
        }
        return [
            "Alpha": repo("Alpha", ["1.0.0", "1.0.1", "1.1.0", "v2.0.0", "2.1.0-beta.1"]),
            "Beta": repo("Beta", ["0.9.0", "1.0.0", "1.0.5"]),
            "Gamma": repo("Gamma", ["3.0.0", "3.2.0"]),
        ]
    }()
}

private struct Result {
    var out: String
    var err: String
    var code: Int32
}

private func cli(_ args: [String], stdin: String? = nil) throws -> Result {
    try launch(Env.binary, args, stdin: stdin)
}

/// Runs a shell pipeline (for tests about how output behaves through pipes).
private func shell(_ command: String) throws -> Result {
    try launch("/bin/sh", ["-c", command], stdin: nil)
}

private func launch(_ executable: String, _ args: [String], stdin: String?) throws -> Result {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: executable)
    p.arguments = args
    var env = ProcessInfo.processInfo.environment
    env["SPM_UPDATE_CACHE_DIR"] = Env.cache
    env["NO_COLOR"] = "1"
    env["SPM_UPDATE_FORMAT"] = nil
    p.environment = env
    let out = Pipe(), err = Pipe(), input = Pipe()
    p.standardOutput = out
    p.standardError = err
    p.standardInput = stdin == nil ? FileHandle.nullDevice : input
    try p.run()
    if let stdin {
        input.fileHandleForWriting.write(Data(stdin.utf8))
        try input.fileHandleForWriting.close()
    }
    var errData = Data()
    let done = DispatchSemaphore(value: 0)
    Thread { errData = err.fileHandleForReading.readDataToEndOfFile(); done.signal() }.start()
    let outData = out.fileHandleForReading.readDataToEndOfFile()
    done.wait()
    p.waitUntilExit()
    func trim(_ d: Data) -> String { String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) }
    return Result(out: trim(outData), err: trim(errData), code: p.terminationStatus)
}

private func read(_ path: String) -> String { try! String(contentsOfFile: path, encoding: .utf8) }
private func write(_ path: String, _ text: String) { try! text.write(toFile: path, atomically: true, encoding: .utf8) }

private func freshProject() -> String {
    let u = Env.urls
    let dir = makeTempDir(Path.join(Env.tmp, "proj"))
    write(Path.join(dir, "Package.swift"), """
    // swift-tools-version:5.9
    import PackageDescription
    let package = Package(
        name: "P",
        dependencies: [
            .package(url: "\(u["Alpha"]!)", .upToNextMajor(from: "1.0.0")),
            .package(url: "\(u["Beta"]!)", exact: "1.0.0"),
            .package(url: "\(u["Gamma"]!)", branch: "main"),
        ]
    )

    """)
    write(Path.join(dir, "Package.resolved"),
          #"{"pins":[{"identity":"alpha","location":"\#(u["Alpha"]!)","state":{"version":"1.0.1"}}],"version":2}"#)
    return dir
}

private func json(_ s: String) -> [String: Any] {
    try! JSONSerialization.jsonObject(with: Data(s.utf8)) as! [String: Any]
}

final class CheckEndToEndTests: XCTestCase {
    func testTSV() throws {
        let r = try cli(["check", freshProject(), "--format", "tsv"])
        XCTAssertEqual(r.code, 0)
        XCTAssertEqual(r.out, [
            "#0 Package.swift",
            "m\tpkg\treq\tresolved\tpatch\tminor\tmajor\tstatus",
            "0\tAlpha\t^1.0.0\t1.0.1\t-\t1.1.0\t2.0.0\tmajor",
            "0\tBeta\t=1.0.0\t-\t1.0.5\t-\t-\tpatch",
            "0\tGamma\tbranch:main\t-\t-\t-\t3.2.0\tpinned",
        ].joined(separator: "\n"))
    }

    func testJSONIsCompactAndOmitsEmptyFields() throws {
        let r = try cli([freshProject(), "--json", "--outdated", "--versions"])
        XCTAssertFalse(r.out.contains("\n"))
        let doc = json(r.out)
        XCTAssertEqual(doc["manifests"] as? [[String: String]], [["path": "Package.swift", "type": "package", "resolved": "Package.resolved"]])
        let deps = doc["deps"] as! [[String: Any]]
        XCTAssertEqual(deps.map { $0["name"] as! String }, ["Alpha", "Beta"])
        XCTAssertEqual(deps[0] as NSDictionary, [
            "m": 0, "name": "Alpha", "url": Env.urls["Alpha"]!, "req": "^1.0.0", "resolved": "1.0.1", "status": "outdated",
            "update": "major", "minor": "1.1.0", "major": "2.0.0", "inRange": true, "versions": ["2.0.0", "1.1.0"],
        ] as NSDictionary)
        XCTAssertEqual(doc["summary"] as? [String: Int], ["manifests": 1, "total": 3, "outdated": 2, "major": 1, "patch": 1, "pinned": 1])
    }

    func testPlainTableHasNoANSIWhenPiped() throws {
        let r = try cli([freshProject()])
        XCTAssertFalse(r.out.contains("\u{1b}["))
        XCTAssertTrue(r.out.contains("next: spm-update update --level minor | spm-update apply Alpha@major"))
    }

    func testFailOnOutdatedExits2() throws {
        XCTAssertEqual(try cli([freshProject(), "--fail-on-outdated", "--tsv"]).code, 2)
    }

    func testRelativeURLsResolveAgainstManifestFolder() throws {
        _ = Env.urls
        let dir = makeTempDir(Path.join(Env.tmp, "rel"))
        write(Path.join(dir, "Package.swift"), "let package = Package(name: \"R\", dependencies: [\n  .package(url: \"../repos/Gamma.git\", from: \"3.0.0\"),\n])\n")
        let r = try cli(["check", dir, "--tsv"])
        XCTAssertEqual(r.out.components(separatedBy: "\n").last, "0\tGamma\t^3.0.0\t-\t-\t3.2.0\t-\tminor")
    }

    func testLargeJSONIsNotTruncatedThroughASlowPipe() throws {
        let dir = makeTempDir(Path.join(Env.tmp, "big"))
        let lines = Array(repeating: "        .package(url: \"\(Env.urls["Alpha"]!)\", from: \"1.0.0\"),", count: 600)
        write(Path.join(dir, "Package.swift"), "let package = Package(name: \"Big\", dependencies: [\n\(lines.joined(separator: "\n"))\n])\n")
        // A slow reader on a pipe is what exposed truncation at the 64KB pipe buffer.
        let r = try shell("'\(Env.binary)' check '\(dir)' --json --versions | (sleep 1; cat)")
        XCTAssertEqual(r.code, 0)
        XCTAssertGreaterThan(r.out.utf8.count, 65536)
        XCTAssertEqual((json(r.out)["deps"] as! [Any]).count, 600)
    }
}

final class ApplyEndToEndTests: XCTestCase {
    func testDryRunWritesNothing() throws {
        let dir = freshProject()
        let before = read(Path.join(dir, "Package.swift"))
        let r = try cli(["apply", dir, "Alpha@minor", "Beta@patch", "--dry-run"])
        XCTAssertEqual(r.code, 0)
        XCTAssertEqual(r.out, "Alpha\t^1.0.0 -> ^1.1.0\nBeta\t=1.0.0 -> =1.0.5\ndry run: 2 changes, nothing written")
        XCTAssertEqual(read(Path.join(dir, "Package.swift")), before)
    }

    func testWritesDecisionsAndKeepsArgumentStyle() throws {
        let dir = freshProject(), u = Env.urls
        let r = try cli(["apply", dir, "Alpha@major", "Beta@~1.0.5", "Gamma@3.2.0", "--json"])
        XCTAssertEqual(r.code, 0)
        XCTAssertEqual(json(r.out) as NSDictionary, [
            "v": 1,
            "changes": [
                ["m": 0, "name": "Alpha", "from": "^1.0.0", "to": "^2.0.0"],
                ["m": 0, "name": "Beta", "from": "=1.0.0", "to": "~1.0.5"],
                ["m": 0, "name": "Gamma", "from": "branch:main", "to": "^3.2.0"],
            ],
            "next": "swift package resolve",
        ] as NSDictionary)
        let text = read(Path.join(dir, "Package.swift"))
        XCTAssertTrue(text.contains(".package(url: \"\(u["Alpha"]!)\", .upToNextMajor(from: \"2.0.0\")),"))
        XCTAssertTrue(text.contains(".package(url: \"\(u["Beta"]!)\", .upToNextMinor(from: \"1.0.5\")),"))
        XCTAssertTrue(text.contains(".package(url: \"\(u["Gamma"]!)\", from: \"3.2.0\"),"))
    }

    func testAnyInvalidDecisionMeansNothingIsWritten() throws {
        let dir = freshProject()
        let before = read(Path.join(dir, "Package.swift"))
        let r = try cli(["apply", dir, "Alpha@minor", "Beta@7.0.0"])
        XCTAssertEqual(r.code, 1)
        XCTAssertTrue(r.out.contains("error: Beta: no tag 7.0.0 (newest: 1.0.5)"))
        XCTAssertEqual(read(Path.join(dir, "Package.swift")), before)
    }

    func testReadsPlanFromStdin() throws {
        let r = try cli(["apply", freshProject(), "--plan", "-", "--tsv"], stdin: #"{"decisions":[{"package":"beta","target":"patch"}]}"#)
        XCTAssertEqual(r.code, 0)
        XCTAssertEqual(r.out, "Beta\t=1.0.0 -> =1.0.5\nwrote 1 change\nnext: swift package resolve")
    }

    func testUsageErrorsExit1WithHint() throws {
        let r = try cli(["apply", freshProject()])
        XCTAssertEqual(r.code, 1)
        XCTAssertTrue(r.err.contains("apply needs decisions"))
        XCTAssertTrue(r.err.contains("--help"))
    }
}

final class UpdateEndToEndTests: XCTestCase {
    func testLevelMinorUpdatesWithinMajorAndPreservesPins() throws {
        let r = try cli(["update", freshProject(), "--level", "minor"])
        XCTAssertEqual(r.code, 0)
        XCTAssertEqual(r.out, [
            "Alpha\t^1.0.0 -> ^1.1.0", "Beta\t=1.0.0 -> =1.0.5", "skip Gamma: pinned branch:main", "wrote 2 changes",
            "next: swift package resolve",
        ].joined(separator: "\n"))
    }

    func testLegacyPathUpdateSkipForm() throws {
        let dir = freshProject()
        let r = try cli([dir, "update", "--skip", "Beta", "-q"])
        XCTAssertEqual(r.code, 0)
        XCTAssertEqual(r.out, "")
        let text = read(Path.join(dir, "Package.swift"))
        XCTAssertTrue(text.contains(#".upToNextMajor(from: "2.0.0")"#))
        XCTAssertTrue(text.contains(#"exact: "1.0.0""#))
    }

    func testXcodeProjectsEditedInPlace() throws {
        let u = Env.urls
        let dir = makeTempDir(Path.join(Env.tmp, "xc"))
        try FileManager.default.createDirectory(atPath: Path.join(dir, "App.xcodeproj"), withIntermediateDirectories: true)
        let pbx = Fixtures.pbxproj
            .replacingOccurrences(of: "https://github.com/Alamofire/Alamofire.git", with: u["Alpha"]!)
            .replacingOccurrences(of: "https://github.com/onevcat/Kingfisher", with: u["Beta"]!)
            .replacingOccurrences(of: "https://github.com/apple/swift-log.git", with: u["Gamma"]!)
            .replacingOccurrences(of: "minimumVersion = 1.4.0", with: "minimumVersion = 3.0.0")
            .replacingOccurrences(of: "maximumVersion = 2.0.0", with: "maximumVersion = 4.0.0")
            .replacingOccurrences(of: "version = 7.0.0", with: "version = 1.0.0")
        write(Path.join(dir, "App.xcodeproj/project.pbxproj"), pbx)
        let r = try cli(["update", dir, "--level", "minor", "--json"])
        // Alpha's requirement (^5.0.0) is above every tag, so it is left alone.
        XCTAssertEqual(json(r.out)["changes"] as? NSArray, [
            ["m": 0, "name": "Beta", "from": "=1.0.0", "to": "=1.0.5"],
            ["m": 0, "name": "Gamma", "from": ">=3.0.0 <4.0.0", "to": ">=3.2.0 <4.0.0"],
        ] as NSArray)
        let after = read(Path.join(dir, "App.xcodeproj/project.pbxproj"))
        XCTAssertTrue(after.contains("version = 1.0.5;"))
        XCTAssertTrue(after.contains("minimumVersion = 3.2.0;"))
    }
}
