/// Compact, unambiguous text form: `^1.2.3`, `~1.2.3`, `=1.2.3`, `>=1.0.0 <2.0.0`, `branch:main`, `rev:abc123`.
public func formatRequirement(_ req: Requirement) -> String {
    switch req {
    case let .version(.upToNextMajor, v): return "^\(v)"
    case let .version(.upToNextMinor, v): return "~\(v)"
    case let .version(.exact, v): return "=\(v)"
    case let .range(lower, upper, closed): return ">=\(lower) \(closed ? "<=" : "<")\(upper)"
    case let .branch(ref): return "branch:\(ref)"
    case let .revision(ref): return "rev:\(ref.prefix(12))"
    case let .unknown(raw): return collapseWhitespace(raw)
    }
}

func collapseWhitespace(_ s: String) -> String {
    var out = ""
    var inSpace = false
    for c in s {
        if c.isWhitespace {
            if !inSpace { out.append(" ") }
            inSpace = true
        } else {
            out.append(c)
            inSpace = false
        }
    }
    return out
}

/// The version a requirement starts from, if any.
public func requirementFloor(_ req: Requirement) -> SemVer? {
    switch req {
    case let .version(_, v): return parseVersion(v)
    case let .range(lower, _, _): return parseVersion(lower)
    default: return nil
    }
}

public func satisfies(_ req: Requirement, _ v: SemVer) -> Bool {
    switch req {
    case let .version(.upToNextMajor, min):
        guard let min = parseVersion(min) else { return false }
        return v >= min && v.major == min.major
    case let .version(.upToNextMinor, min):
        guard let min = parseVersion(min) else { return false }
        return v >= min && v.major == min.major && v.minor == min.minor
    case let .version(.exact, exact):
        return parseVersion(exact) == v
    case let .range(lower, upper, closed):
        guard let lo = parseVersion(lower), let hi = parseVersion(upper) else { return false }
        return v >= lo && (closed ? v <= hi : v < hi)
    default:
        return false
    }
}

/// Builds the requirement that moves `current` to `version`.
/// Keeps the existing kind unless `kind` is given; branch/revision pins become `^version`.
public func bumpRequirement(_ current: Requirement, _ version: SemVer, kind: VersionKind? = nil) -> Requirement {
    let v = version.description
    if let kind { return .version(kind, v) }
    switch current {
    case let .version(k, _):
        return .version(k, v)
    case let .range(_, upper, closed):
        if let hi = parseVersion(upper), closed ? version <= hi : version < hi {
            return .range(lower: v, upper: upper, closed: closed)
        }
        return .range(lower: v, upper: "\(version.major + 1).0.0", closed: false)
    default:
        return .version(.upToNextMajor, v)
    }
}

/// Compares requirements by meaning, so `=1.2` and `=1.2.0` (or `26.09.25` and `26.9.25`) are equal.
public func sameRequirement(_ a: Requirement, _ b: Requirement) -> Bool {
    func norm(_ v: String) -> String { normalizeVersion(v) ?? v }
    func canon(_ r: Requirement) -> Requirement {
        switch r {
        case let .version(k, v): return .version(k, norm(v))
        case let .range(lo, hi, closed): return .range(lower: norm(lo), upper: norm(hi), closed: closed)
        default: return r
        }
    }
    return formatRequirement(canon(a)) == formatRequirement(canon(b))
}

// MARK: - Identity

/// Last path component of a URL or path, without a trailing `.git` or slash.
public func nameFromUrl(_ url: String) -> String {
    var s = Substring(url)
    while s.last == "/" { s = s.dropLast() }
    if s.hasSuffix(".git") { s = s.dropLast(4) }
    let last = s.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == ":" }).last ?? ""
    return last.isEmpty ? url : String(last)
}

/// SwiftPM's package identity for a source-control URL.
public func identityFromUrl(_ url: String) -> String {
    nameFromUrl(url).lowercased()
}

/// Normalized URL for comparisons (scheme-less, no user, no `.git`, lowercase).
public func canonicalUrl(_ url: String) -> String {
    var s = Substring(url.lowercased())
    while let c = s.first, c.isWhitespace { s = s.dropFirst() }
    while let c = s.last, c.isWhitespace { s = s.dropLast() }
    if let r = s.range(of: "://"), s[..<r.lowerBound].allSatisfy({ $0.isASCIILetter || $0 == "+" }), !s[..<r.lowerBound].isEmpty {
        s = s[r.upperBound...]
    }
    if let at = s.firstIndex(of: "@"), !s[..<at].contains("/"), at != s.startIndex {
        s = s[s.index(after: at)...]
    }
    var out = String(s)
    if let colon = out.firstIndex(of: ":") { out.replaceSubrange(colon...colon, with: "/") }
    while out.hasSuffix("/") { out.removeLast() }
    if out.hasSuffix(".git") { out.removeLast(4) }
    return out
}
