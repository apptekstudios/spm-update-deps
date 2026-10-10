import Foundation

// project.pbxproj support. Only the Swift package reference objects matter, so they are found by
// scanning the text: a full parse of a large project (~1MB) takes most of a second. Values are
// read as raw text, because unquoted `version = 1.10;` must not become the number 1.1.

func requirementFromPbx(_ r: [String: String]?) -> Requirement {
    guard let r else { return .unknown("none") }
    let min = r["minimumVersion"] ?? ""
    switch r["kind"] {
    case "upToNextMajorVersion": return .version(.upToNextMajor, min)
    case "upToNextMinorVersion": return .version(.upToNextMinor, min)
    case "exactVersion": return .version(.exact, r["version"] ?? "")
    // Xcode's "Range of Versions" is half-open: min ..< max.
    case "versionRange": return .range(lower: min, upper: r["maximumVersion"] ?? "", closed: false)
    case "branch": return .branch(r["branch"] ?? "")
    case "revision": return .revision(r["revision"] ?? "")
    case let kind: return .unknown(kind ?? "unknown")
    }
}

/// Keys in the order Xcode writes them (sorted).
func requirementToPbx(_ req: Requirement) -> [(String, String)] {
    switch req {
    case let .version(.upToNextMajor, v): return [("kind", "upToNextMajorVersion"), ("minimumVersion", v)]
    case let .version(.upToNextMinor, v): return [("kind", "upToNextMinorVersion"), ("minimumVersion", v)]
    case let .version(.exact, v): return [("kind", "exactVersion"), ("version", v)]
    case let .range(lo, hi, _): return [("kind", "versionRange"), ("maximumVersion", hi), ("minimumVersion", lo)]
    case let .branch(r): return [("branch", r), ("kind", "branch")]
    case let .revision(r): return [("kind", "revision"), ("revision", r)]
    case .unknown: return []
    }
}

private func isPbxBareByte(_ c: UInt8) -> Bool {
    isIdentByte(c) || c == UInt8(ascii: "$") || c == UInt8(ascii: "/") || c == UInt8(ascii: ":") || c == UInt8(ascii: ".")
}

/// Reads a value at `i` (quoted string or bare word); returns it unquoted and the index after it.
private func readPbxValue(_ b: Bytes, _ i: Int) -> (String, Int)? {
    guard i < b.count else { return nil }
    if b[i] == UInt8(ascii: "\"") {
        var out = Bytes()
        var j = i + 1
        while j < b.count, b[j] != UInt8(ascii: "\"") {
            if b[j] == UInt8(ascii: "\\"), j + 1 < b.count { j += 1 }
            out.append(b[j])
            j += 1
        }
        guard j < b.count else { return nil }
        return (String(decoding: out, as: UTF8.self), j + 1)
    }
    var j = i
    while j < b.count, !isSpace(b[j]), b[j] != UInt8(ascii: ";") { j += 1 }
    return j > i ? (b.string(i, j), j) : nil
}

/// All `key = value;` pairs directly in `b[from..<to]` (nested `{...}` values are skipped).
private func pbxFields(_ b: Bytes, _ from: Int, _ to: Int) -> [String: String] {
    var out: [String: String] = [:]
    var i = from
    while i < to {
        while i < to, isSpace(b[i]) || b[i] == UInt8(ascii: ";") { i += 1 }
        let keyStart = i
        while i < to, isIdentByte(b[i]) { i += 1 }
        guard i > keyStart else { i += 1; continue }
        let key = b.string(keyStart, i)
        while i < to, isSpace(b[i]) { i += 1 }
        guard i < to, b[i] == UInt8(ascii: "=") else { continue }
        i += 1
        while i < to, isSpace(b[i]) { i += 1 }
        if i < to, b[i] == UInt8(ascii: "{") || b[i] == UInt8(ascii: "(") {
            var depth = 0
            repeat {
                if b[i] == UInt8(ascii: "{") || b[i] == UInt8(ascii: "(") { depth += 1 }
                if b[i] == UInt8(ascii: "}") || b[i] == UInt8(ascii: ")") { depth -= 1 }
                i += 1
            } while i < to && depth > 0
            continue
        }
        if let (v, next) = readPbxValue(b, i), next <= to {
            out[key] = v
            i = next
        } else {
            i += 1
        }
    }
    return out
}

private func lastIndex(of byte: UInt8, in b: Bytes, before i: Int) -> Int? {
    var j = i - 1
    while j >= 0 { if b[j] == byte { return j }; j -= 1 }
    return nil
}

private func firstIndex(of pattern: Bytes, in b: Bytes, from i: Int) -> Int? {
    guard !pattern.isEmpty, b.count >= pattern.count else { return nil }
    var j = i
    let last = b.count - pattern.count
    while j <= last {
        if b[j] == pattern[0], b[j..<(j + pattern.count)].elementsEqual(pattern) { return j }
        j += 1
    }
    return nil
}

struct PbxObject {
    var id: String
    var isa: String
    /// Byte range of the object body: after `{`, up to its closing line.
    var open: Int
    var close: Int
    var indent: Bytes
}

/// Finds Swift package reference objects. Keys are sorted in pbxproj files, so `isa` precedes any nested `{`.
private func scanPackageObjects(_ b: Bytes) -> [PbxObject] {
    var out: [PbxObject] = []
    let isa = Bytes("isa".utf8)
    var i = 0
    while let at = firstIndex(of: isa, in: b, from: i) {
        i = at + 3
        guard at == 0 || !isIdentByte(b[at - 1]) else { continue }
        var j = i
        while j < b.count, isSpace(b[j]) { j += 1 }
        guard j < b.count, b[j] == UInt8(ascii: "=") else { continue }
        j += 1
        while j < b.count, isSpace(b[j]) { j += 1 }
        guard let (value, _) = readPbxValue(b, j),
              value == "XCRemoteSwiftPackageReference" || value == "XCLocalSwiftPackageReference",
              let open = lastIndex(of: UInt8(ascii: "{"), in: b, before: at) else { continue }
        let lineStart = (lastIndex(of: UInt8(ascii: "\n"), in: b, before: open) ?? -1) + 1
        var k = lineStart
        while k < open, b[k] == 0x20 || b[k] == 0x09 { k += 1 }
        let indent = Array(b[lineStart..<k])
        if k < open, b[k] == UInt8(ascii: "\"") { k += 1 }
        let idStart = k
        while k < open, isIdentByte(b[k]) { k += 1 }
        guard k > idStart else { continue }
        let closer = Bytes("\n".utf8) + indent + Bytes("};".utf8)
        let close = firstIndex(of: closer, in: b, from: open) ?? b.count
        out.append(PbxObject(id: b.string(idStart, k), isa: value, open: open + 1, close: close, indent: indent))
    }
    return out
}

struct BlockLocation {
    /// Index just after `requirement = {`.
    var open: Int
    /// Index of the closing `}`.
    var close: Int
    var indent: Bytes
}

/// Finds the `requirement = { ... };` block of one package reference by object ID.
private func locateRequirementBlock(_ b: Bytes, id: String) -> BlockLocation? {
    scanPackageObjects(b).first(where: { $0.id == id }).flatMap { locateRequirementBlock(b, in: $0) }
}

private func locateRequirementBlock(_ b: Bytes, in obj: PbxObject) -> BlockLocation? {
    let key = Bytes("requirement".utf8)
    var i = obj.open
    while let at = firstIndex(of: key, in: b, from: i), at < obj.close {
        i = at + key.count
        guard !isIdentByte(b[at - 1]), i < b.count, !isIdentByte(b[i]) else { continue }
        var j = i
        while j < obj.close, isSpace(b[j]) { j += 1 }
        guard j < obj.close, b[j] == UInt8(ascii: "=") else { continue }
        j += 1
        while j < obj.close, isSpace(b[j]) { j += 1 }
        guard j < obj.close, b[j] == UInt8(ascii: "{") else { continue }
        let open = j + 1
        guard let close = firstIndex(of: [UInt8(ascii: "}")], in: b, from: open), close < obj.close else { return nil }
        let lineStart = (lastIndex(of: UInt8(ascii: "\n"), in: b, before: at) ?? -1) + 1
        return BlockLocation(open: open, close: close, indent: Array(b[lineStart..<at]))
    }
    return nil
}

public func parseXcodeProject(_ text: String) -> [Dependency] {
    let b = Bytes(text.utf8)
    var deps: [Dependency] = []
    for obj in scanPackageObjects(b) {
        let fields = pbxFields(b, obj.open, obj.close)
        if obj.isa == "XCRemoteSwiftPackageReference" {
            guard let url = fields["repositoryURL"] else { continue }
            let req = locateRequirementBlock(b, in: obj).map { pbxFields(b, $0.open, $0.close) }
            deps.append(Dependency(name: nameFromUrl(url), identity: identityFromUrl(url), source: .remote, url: url,
                                   fetchUrl: nil, req: requirementFromPbx(req), handle: .xcode(id: obj.id)))
        } else {
            let path = fields["relativePath"] ?? fields["path"] ?? ""
            let name = nameFromUrl(path)
            deps.append(Dependency(name: name, identity: name.lowercased(), source: .local, url: nil, fetchUrl: nil,
                                   req: .unknown("path:\(path)"), handle: .none))
        }
    }
    return deps.sorted { collationLess($0.name, $1.name) }
}

/// Quotes values the way Xcode does: bare words for [A-Za-z0-9_$/:.], quoted otherwise.
func pbxValue(_ value: String) -> String {
    let escaped = value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    return !escaped.isEmpty && escaped.utf8.allSatisfy(isPbxBareByte) ? escaped : "\"\(escaped)\""
}

public struct XcodeEdit {
    public var id: String
    public var name: String
    public var next: Requirement
}

/// Rewrites each edited `requirement = { ... };` block in place, leaving the rest of the file
/// byte-for-byte unchanged. Throws (before anything is written) if a block can't be located.
public func editXcodeProject(_ text: String, _ edits: [XcodeEdit]) throws -> String {
    var b = Bytes(text.utf8)
    for e in edits {
        guard let loc = locateRequirementBlock(b, id: e.id) else {
            throw ToolError("can't locate the requirement block for \(e.name) in project.pbxproj; edit it in Xcode")
        }
        let indent = String(decoding: loc.indent, as: UTF8.self)
        let inner = indent.contains("\t") ? indent + "\t" : indent + "  "
        let body = requirementToPbx(e.next).map { "\n\(inner)\($0.0) = \(pbxValue($0.1));" }.joined()
        b.replaceSubrange(loc.open..<loc.close, with: Bytes((body + "\n" + indent).utf8))
    }
    return String(decoding: b, as: UTF8.self)
}

/// Name ordering close to ICU's default collation: case-insensitive, lowercase first on ties.
func collationLess(_ a: String, _ b: String) -> Bool {
    let la = a.lowercased(), lb = b.lowercased()
    if la != lb { return la.unicodeScalars.lexicographicallyPrecedes(lb.unicodeScalars) }
    return a.unicodeScalars.lexicographicallyPrecedes(b.unicodeScalars) == false && a != b
}
