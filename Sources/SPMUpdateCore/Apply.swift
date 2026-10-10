import Foundation

public struct Decision: Equatable, Sendable {
    /// Package name, identity or URL.
    public var selector: String
    /// `latest` | `major` | `minor` | `patch` | explicit version.
    public var target: String
    public var kind: VersionKind?
    /// Optional manifest filter (label, basename or path).
    public var manifest: String?

    public init(selector: String, target: String, kind: VersionKind? = nil, manifest: String? = nil) {
        self.selector = selector
        self.target = target
        self.kind = kind
        self.manifest = manifest
    }
}

public struct Change {
    /// Index into the checked dependencies.
    public var c: Int
    public var m: Int
    public var name: String
    public var from: Requirement
    public var to: Requirement
}

public struct Skip: Equatable {
    public var m: Int
    public var name: String
    public var reason: String
}

public struct Plan {
    public var changes: [Change] = []
    public var skipped: [Skip] = []
    public var errors: [String] = []
}

private let kindPrefix: [Character: VersionKind] = ["^": .upToNextMajor, "~": .upToNextMinor, "=": .exact]
private let kindNames: [String: VersionKind] = [
    "^": .upToNextMajor, "~": .upToNextMinor, "=": .exact,
    "upToNextMajor": .upToNextMajor, "upToNextMinor": .upToNextMinor, "exact": .exact,
]

public func parseKind(_ s: String?) throws -> VersionKind? {
    guard let s else { return nil }
    guard let k = kindNames[s] else {
        throw UsageError("invalid requirement kind '\(s)' (use upToNextMajor|upToNextMinor|exact or ^|~|=)")
    }
    return k
}

/// Parses `Name@target`, where target may carry a `^`/`~`/`=` prefix.
public func parseDecisionArg(_ arg: String) throws -> Decision {
    guard let at = arg.lastIndex(of: "@"), at != arg.startIndex, arg.index(after: at) != arg.endIndex else {
        throw UsageError("invalid decision '\(arg)' (expected <package>@<latest|major|minor|patch|version>)")
    }
    var target = String(arg[arg.index(after: at)...])
    var kind: VersionKind?
    if let first = target.first, let k = kindPrefix[first] {
        kind = k
        target.removeFirst()
    }
    return Decision(selector: String(arg[..<at]), target: target, kind: kind)
}

/// Accepts `{"decisions":[...]}` or a bare array of `{package, target, requirement?, manifest?}`.
public func parsePlanFile(_ data: Data) throws -> [Decision] {
    let json: Any
    do {
        json = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    } catch {
        throw UsageError("plan is not valid JSON: \(error.localizedDescription)")
    }
    guard let list = (json as? [Any]) ?? ((json as? [String: Any])?["decisions"] as? [Any]) else {
        throw UsageError("plan must be an array or {\"decisions\":[...]}")
    }
    return try list.enumerated().map { i, item in
        let d = item as? [String: Any]
        guard let selector = (d?["package"] ?? d?["name"]) as? String, let target = d?["target"] as? String else {
            throw UsageError("plan entry \(i): needs string \"package\" and \"target\"")
        }
        var parsed = try parseDecisionArg("\(selector)@\(target)")
        if let k = try parseKind(d?["requirement"] as? String) { parsed.kind = k }
        parsed.manifest = d?["manifest"] as? String
        return parsed
    }
}

private func levenshtein(_ a: [Character], _ b: [Character]) -> Int {
    var dp = Array(0...b.count)
    for i in 1...max(a.count, 1) where !a.isEmpty {
        var prev = dp[0]
        dp[0] = i
        for j in stride(from: 1, through: b.count, by: 1) {
            let tmp = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] == b[j - 1] ? 0 : 1))
            prev = tmp
        }
    }
    return dp[b.count]
}

public func suggest(_ input: String, _ names: [String]) -> String? {
    let lower = Array(input.lowercased())
    var best: (name: String, d: Int)?
    var seen = Set<String>()
    for n in names where seen.insert(n).inserted {
        let d = levenshtein(lower, Array(n.lowercased()))
        if best == nil || d < best!.d { best = (n, d) }
    }
    guard let best, best.d <= max(2, input.utf16.count / 3) else { return nil }
    return best.name
}

private func matches(_ c: CheckedDep, _ d: Decision, _ manifests: [Manifest]) -> Bool {
    let sel = d.selector.lowercased()
    let hit = c.dep.identity == sel || c.dep.name.lowercased() == sel
        || (c.dep.url.map { canonicalUrl($0) == canonicalUrl(d.selector) } ?? false)
    guard hit else { return false }
    guard let want = d.manifest else { return true }
    let m = manifests[c.m]
    let abs = Path.absolute(want)
    return m.label == want || Path.basename(m.label) == want || abs == m.path
        || (m.type == .xcodeproj && abs == Path.dirname(m.path))
}

private let levels: Set<String> = ["latest", "major", "minor", "patch"]

private enum Resolution {
    case change(Change)
    case skip(Skip)
    case error(String)
}

/// Resolves one decision against one dependency.
private func resolveOne(_ index: Int, _ c: CheckedDep, _ d: Decision, force: Bool) -> Resolution {
    let dep = c.dep, a = c.a, m = c.m, name = dep.name
    if dep.source != .remote { return .error("\(name): \(dep.source.rawValue) packages can't be updated") }
    if case .unknown = dep.req { return .error("\(name): unsupported requirement '\(formatRequirement(dep.req))'") }

    var version: SemVer?
    let target = d.target.lowercased()
    if levels.contains(target) {
        if a.status == .error { return .error("\(name): can't resolve '\(d.target)': \(a.err ?? "")") }
        if a.status == .pinned {
            return .error("\(name): pinned to \(formatRequirement(dep.req)); give an explicit version, e.g. \(name)@\(a.latest ?? "1.0.0")")
        }
        let level: Level = target == "latest" ? .major : Level(rawValue: target)!
        version = (targetVersion(a, level) ?? a.baseline).flatMap { SemVer(strict: $0) }
    } else {
        guard let v = parseVersion(d.target) else { return .error("\(name): invalid version '\(d.target)'") }
        version = v
        if !force {
            if a.status == .error {
                return .error("\(name): can't verify \(v) exists (\(a.err ?? "")); pass --force to write anyway")
            }
            if !a.all.contains(v) {
                return .error("\(name): no tag \(v)\(a.latest.map { " (newest: \($0))" } ?? ""); pass --force to write anyway")
            }
            if let floor = requirementFloor(dep.req), v < floor {
                return .error("\(name): \(v) is a downgrade from \(formatRequirement(dep.req)); pass --force to allow")
            }
        }
    }
    guard let version else { return .skip(Skip(m: m, name: name, reason: "no version available")) }
    let to = bumpRequirement(dep.req, version, kind: d.kind)
    if sameRequirement(dep.req, to) { return .skip(Skip(m: m, name: name, reason: "unchanged")) }
    return .change(Change(c: index, m: m, name: name, from: dep.req, to: to))
}

public func planDecisions(_ checked: [CheckedDep], _ manifests: [Manifest], _ decisions: [Decision], force: Bool) -> Plan {
    var plan = Plan()
    var claimed: [Int: Decision] = [:]
    for d in decisions {
        let hits = checked.indices.filter { matches(checked[$0], d, manifests) }
        if hits.isEmpty {
            if d.manifest != nil {
                var anywhere = d
                anywhere.manifest = nil
                var labels: [String] = []
                for c in checked where matches(c, anywhere, manifests) {
                    let l = manifests[c.m].label
                    if !labels.contains(l) { labels.append(l) }
                }
                if !labels.isEmpty {
                    plan.errors.append("'\(d.selector)' is not in \(d.manifest!) (found in \(labels.joined(separator: ", ")))")
                    continue
                }
            }
            let hint = suggest(d.selector, checked.map(\.dep.name))
            plan.errors.append("unknown package '\(d.selector)'\(d.manifest.map { " in \($0)" } ?? "")\(hint.map { " (did you mean \($0)?)" } ?? "")")
            continue
        }
        for i in hits {
            if let prev = claimed[i] {
                plan.errors.append("\(checked[i].dep.name): conflicting decisions '\(prev.target)' and '\(d.target)'")
                continue
            }
            claimed[i] = d
            switch resolveOne(i, checked[i], d, force: force) {
            case let .change(c): plan.changes.append(c)
            case let .skip(s): plan.skipped.append(s)
            case let .error(e): plan.errors.append(e)
            }
        }
    }
    return plan
}

/// Plans a bulk update of every remote dependency to the newest version allowed by `level`.
public func planBulk(_ checked: [CheckedDep], level: Level, only: Set<String>, skip: Set<String>) -> Plan {
    var plan = Plan()
    func selected(_ c: CheckedDep, _ set: Set<String>) -> Bool {
        set.contains(c.dep.identity) || set.contains(c.dep.name.lowercased())
    }
    for (i, c) in checked.enumerated() {
        let dep = c.dep, a = c.a, m = c.m
        guard dep.source == .remote else { continue }
        if !only.isEmpty, !selected(c, only) { continue }
        if selected(c, skip) { plan.skipped.append(Skip(m: m, name: dep.name, reason: "--skip")); continue }
        if a.status == .pinned {
            plan.skipped.append(Skip(m: m, name: dep.name, reason: "pinned \(formatRequirement(dep.req))"))
            continue
        }
        if a.status == .error { plan.skipped.append(Skip(m: m, name: dep.name, reason: a.err ?? "error")); continue }
        if case .unknown = dep.req {
            plan.skipped.append(Skip(m: m, name: dep.name, reason: "unsupported requirement '\(formatRequirement(dep.req))'"))
            continue
        }
        guard let version = (targetVersion(a, level) ?? a.baseline).flatMap({ SemVer(strict: $0) }) else { continue }
        let to = bumpRequirement(dep.req, version)
        if !sameRequirement(dep.req, to) {
            plan.changes.append(Change(c: i, m: m, name: dep.name, from: dep.req, to: to))
        } else if level != .major, let major = a.major {
            plan.skipped.append(Skip(m: m, name: dep.name, reason: "major \(major) available (use \(dep.name)@major)"))
        }
    }
    return plan
}

/// Writes all changes. Every manifest is edited in memory first so a failure writes nothing.
public func writeChanges(_ plan: Plan, _ checked: [CheckedDep], _ manifests: [Manifest]) throws {
    var order: [Int] = []
    var byManifest: [Int: [Change]] = [:]
    for ch in plan.changes {
        if byManifest[ch.m] == nil { order.append(ch.m) }
        byManifest[ch.m, default: []].append(ch)
    }
    var outputs: [(String, String)] = []
    for mi in order {
        let man = manifests[mi]
        guard let data = FileManager.default.contents(atPath: man.path) else { throw ToolError("can't read \(man.path)") }
        let text = String(decoding: data, as: UTF8.self)
        let changes = byManifest[mi]!
        let next: String
        switch man.type {
        case .package:
            next = editPackageSwift(text, changes.compactMap { ch in
                guard case let .packageSwift(start, end, style) = checked[ch.c].dep.handle else { return nil }
                return PackageSwiftEdit(start: start, end: end, style: style, prev: ch.from, next: ch.to)
            })
        case .xcodeproj:
            next = try editXcodeProject(text, changes.compactMap { ch in
                guard case let .xcode(id) = checked[ch.c].dep.handle else { return nil }
                return XcodeEdit(id: id, name: ch.name, next: ch.to)
            })
        }
        outputs.append((man.path, next))
    }
    for (path, text) in outputs {
        do {
            try Data(text.utf8).write(to: URL(fileURLWithPath: path))
        } catch {
            throw ToolError("can't write \(path): \(error.localizedDescription)")
        }
    }
}

/// The command that refreshes Package.resolved for the manifests that changed.
public func resolveHint(_ plan: Plan, _ manifests: [Manifest]) -> String? {
    let types = Set(plan.changes.map { manifests[$0.m].type })
    var hints: [String] = []
    if types.contains(.package) { hints.append("swift package resolve") }
    if types.contains(.xcodeproj) { hints.append("xcodebuild -resolvePackageDependencies") }
    return hints.isEmpty ? nil : hints.joined(separator: " && ")
}
