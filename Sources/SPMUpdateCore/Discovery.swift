import Foundation

// MARK: - Paths

enum Path {
    static func absolute(_ p: String) -> String {
        let base = p.hasPrefix("/") ? p : FileManager.default.currentDirectoryPath + "/" + p
        return normalize(base)
    }

    /// Resolves `.` and `..` and collapses slashes (like Node's `path.resolve`).
    static func normalize(_ p: String) -> String {
        var parts: [Substring] = []
        for c in p.split(separator: "/", omittingEmptySubsequences: true) {
            if c == "." { continue }
            if c == ".." { if !parts.isEmpty { parts.removeLast() }; continue }
            parts.append(c)
        }
        return "/" + parts.joined(separator: "/")
    }

    static func join(_ a: String, _ b: String) -> String { a.hasSuffix("/") ? a + b : a + "/" + b }

    static func dirname(_ p: String) -> String {
        guard let i = p.lastIndex(of: "/") else { return "." }
        return i == p.startIndex ? "/" : String(p[..<i])
    }

    static func basename(_ p: String) -> String {
        p.split(separator: "/").last.map(String.init) ?? p
    }

    /// `to` relative to `from`, for paths under `from`.
    static func relative(_ from: String, _ to: String) -> String {
        let prefix = from.hasSuffix("/") ? from : from + "/"
        if to == from { return "" }
        if to.hasPrefix(prefix) { return String(to.dropFirst(prefix.count)) }
        // Not under `from`: walk up as needed.
        let f = from.split(separator: "/"), t = to.split(separator: "/")
        var k = 0
        while k < f.count, k < t.count, f[k] == t[k] { k += 1 }
        return (Array(repeating: "..", count: f.count - k) + t[k...].map(String.init)).joined(separator: "/")
    }

    static func exists(_ p: String) -> Bool { FileManager.default.fileExists(atPath: p) }

    static func isDirectory(_ p: String) -> Bool? {
        var dir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: p, isDirectory: &dir) else { return nil }
        return dir.boolValue
    }
}

// MARK: - Package.resolved

public struct Pin: Sendable {
    public var version: String?
    public var branch: String?
    public var revision: String?
}

/// Parses Package.resolved (format v1, v2 or v3) into identity → pin.
public func parseResolved(_ data: Data) -> [String: Pin] {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    let list = (json["pins"] as? [[String: Any]]) ?? ((json["object"] as? [String: Any])?["pins"] as? [[String: Any]]) ?? []
    var pins: [String: Pin] = [:]
    for p in list {
        let location = (p["location"] as? String) ?? (p["repositoryURL"] as? String)
        guard let identity = (p["identity"] as? String) ?? location.map(identityFromUrl) ?? (p["package"] as? String)?.lowercased()
        else { continue }
        let s = p["state"] as? [String: Any] ?? [:]
        pins[identity.lowercased()] = Pin(version: s["version"] as? String, branch: s["branch"] as? String,
                                          revision: s["revision"] as? String)
    }
    return pins
}

private let swiftpmResolved = "xcshareddata/swiftpm/Package.resolved"

/// Finds the Package.resolved that belongs to a manifest.
func findResolvedFile(_ manifestPath: String, _ type: ManifestType) -> String? {
    if type == .package {
        let p = Path.join(Path.dirname(manifestPath), "Package.resolved")
        return Path.exists(p) ? p : nil
    }
    let xcodeproj = Path.dirname(manifestPath)
    let embedded = Path.join(Path.join(xcodeproj, "project.xcworkspace"), swiftpmResolved)
    if Path.exists(embedded) { return embedded }
    // A sibling workspace (e.g. App.xcworkspace next to App.xcodeproj) owns resolution when present.
    let parent = Path.dirname(xcodeproj)
    let own = Path.basename(xcodeproj).replacingOccurrences(of: ".xcodeproj", with: "") + ".xcworkspace"
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: parent) else { return nil }
    let workspaces = names.filter { $0.hasSuffix(".xcworkspace") }.sorted { ($0 == own ? 0 : 1) < ($1 == own ? 0 : 1) }
    for ws in workspaces {
        let p = Path.join(Path.join(parent, ws), swiftpmResolved)
        if Path.exists(p) { return p }
    }
    return nil
}

public func readResolved(_ path: String?) -> [String: Pin] {
    guard let path, let data = FileManager.default.contents(atPath: path) else { return [:] }
    return parseResolved(data)
}

// MARK: - Manifests

private let ignoredDirs: Set<String> = [
    ".build", ".git", ".swiftpm", "Pods", "Carthage", "DerivedData", "node_modules", "SourcePackages", "checkouts",
]

struct FoundManifest {
    var path: String
    var type: ManifestType
}

/// Entry types without following symlinks (like `readdir` with file types).
private func entries(_ dir: String) -> [(name: String, isFile: Bool, isDir: Bool)] {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
    return names.sorted(by: collationLess).map { name in
        let attrs = try? FileManager.default.attributesOfItem(atPath: Path.join(dir, name))
        let type = attrs?[.type] as? FileAttributeType
        return (name, type == .typeRegular, type == .typeDirectory)
    }
}

private func scanDir(_ dir: String, recursive: Bool, depth: Int, into out: inout [FoundManifest]) {
    for e in entries(dir) {
        let full = Path.join(dir, e.name)
        if e.isFile, e.name == "Package.swift" {
            out.append(FoundManifest(path: full, type: .package))
        } else if e.isDir, e.name.hasSuffix(".xcodeproj") {
            let pbx = Path.join(full, "project.pbxproj")
            if Path.exists(pbx) { out.append(FoundManifest(path: pbx, type: .xcodeproj)) }
        } else if recursive, depth < 6, e.isDir, !ignoredDirs.contains(e.name), !e.name.hasPrefix("."),
                  !e.name.hasSuffix(".xcworkspace") {
            scanDir(full, recursive: recursive, depth: depth + 1, into: &out)
        }
    }
}

/// Resolves the target path to a root directory and the manifest files to inspect.
func findManifestFiles(_ target: String, recursive: Bool) throws -> (root: String, files: [FoundManifest]) {
    let abs = Path.absolute(target)
    guard let isDir = Path.isDirectory(abs) else { throw UsageError("path not found: \(target)") }
    if !isDir {
        switch Path.basename(abs) {
        case "Package.swift": return (Path.dirname(abs), [FoundManifest(path: abs, type: .package)])
        case "project.pbxproj": return (Path.dirname(Path.dirname(abs)), [FoundManifest(path: abs, type: .xcodeproj)])
        default: throw UsageError("not a Package.swift or project.pbxproj: \(target)")
        }
    }
    if abs.hasSuffix(".xcodeproj") {
        let pbx = Path.join(abs, "project.pbxproj")
        guard Path.exists(pbx) else { throw UsageError("no project.pbxproj in \(target)") }
        return (Path.dirname(abs), [FoundManifest(path: pbx, type: .xcodeproj)])
    }
    var files: [FoundManifest] = []
    scanDir(abs, recursive: recursive, depth: 0, into: &files)
    guard !files.isEmpty else {
        throw UsageError("no Package.swift or .xcodeproj in \(target)\(recursive ? "" : " (try --recursive)")")
    }
    return (abs, files)
}

func loadManifest(root: String, _ f: FoundManifest) throws -> Manifest {
    guard let data = FileManager.default.contents(atPath: f.path) else { throw ToolError("can't read \(f.path)") }
    let text = String(decoding: data, as: UTF8.self)
    var deps = f.type == .package ? parsePackageSwift(text) : parseXcodeProject(text)
    for i in deps.indices {
        // SwiftPM resolves relative source-control URLs (`url: "../Foo"`) against the manifest's folder.
        if let url = deps[i].url, url.hasPrefix("./") || url.hasPrefix("../") {
            deps[i].fetchUrl = Path.normalize(Path.join(Path.dirname(f.path), url))
        }
    }
    let labelPath = f.type == .xcodeproj ? Path.dirname(f.path) : f.path
    let rel = Path.relative(root, labelPath)
    return Manifest(path: f.path, label: rel.isEmpty ? Path.basename(labelPath) : rel, type: f.type,
                    resolvedPath: findResolvedFile(f.path, f.type), deps: deps)
}

public func loadManifests(_ target: String, recursive: Bool) throws -> (root: String, manifests: [Manifest]) {
    let (root, files) = try findManifestFiles(target, recursive: recursive)
    return (root, try files.map { try loadManifest(root: root, $0) })
}
