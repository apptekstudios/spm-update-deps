/// How a requirement was spelled, so edits keep the author's style.
public enum ReqStyle: Sendable {
    case label, method, range
}

// The scanner works on UTF-8 bytes: every token it looks for is ASCII, offsets stay exact,
// and string contents (which may hold any Unicode) are copied through untouched.
typealias Bytes = [UInt8]

private let quote = UInt8(ascii: "\""), slash = UInt8(ascii: "/"), star = UInt8(ascii: "*")
private let backslash = UInt8(ascii: "\\"), newline = UInt8(ascii: "\n")

extension Array where Element == UInt8 {
    func has(_ s: StaticString, at i: Int) -> Bool {
        s.withUTF8Buffer { buf in
            guard i >= 0, i + buf.count <= count else { return false }
            for k in 0..<buf.count where self[i + k] != buf[k] { return false }
            return true
        }
    }

    func string(_ from: Int, _ to: Int) -> String {
        String(decoding: self[from..<to], as: UTF8.self)
    }
}

func isSpace(_ c: UInt8) -> Bool { c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D || c == 0x0B || c == 0x0C }
func isIdentByte(_ c: UInt8) -> Bool {
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F
}

/// If `src[i]` starts a comment or string literal, returns the index just past it; otherwise `i`.
func skipTrivia(_ src: Bytes, _ i: Int) -> Int {
    if src.has("//", at: i) {
        var j = i
        while j < src.count, src[j] != newline { j += 1 }
        return j
    }
    if src.has("/*", at: i) {
        // Swift block comments nest.
        var depth = 1, j = i + 2
        while j < src.count, depth > 0 {
            if src.has("/*", at: j) { depth += 1; j += 2 }
            else if src.has("*/", at: j) { depth -= 1; j += 2 }
            else { j += 1 }
        }
        return min(j, src.count)
    }
    if src.has("\"\"\"", at: i) {
        var j = i + 3
        while j < src.count, !src.has("\"\"\"", at: j) { j += 1 }
        return j < src.count ? j + 3 : src.count
    }
    if i < src.count, src[i] == quote {
        var j = i + 1
        while j < src.count {
            let c = src[j]
            if c == backslash { j += 2 }
            else if c == quote { return j + 1 }
            else if c == newline { return j }
            else { j += 1 }
        }
        return min(j, src.count)
    }
    return i
}

private func isComment(_ src: Bytes, _ i: Int) -> Bool {
    src.has("//", at: i) || src.has("/*", at: i)
}

/// Removes comments (but not string contents) from a code fragment, collapsing whitespace.
private func stripComments(_ text: Bytes) -> String {
    var out = Bytes()
    var i = 0
    while i < text.count {
        let j = skipTrivia(text, i)
        if j != i {
            if isComment(text, i) { out.append(0x20) } else { out.append(contentsOf: text[i..<j]) }
            i = j
        } else {
            out.append(text[i])
            i += 1
        }
    }
    var collapsed = Bytes()
    for c in out {
        if isSpace(c) {
            if collapsed.last != 0x20 { collapsed.append(0x20) }
        } else {
            collapsed.append(c)
        }
    }
    while collapsed.first == 0x20 { collapsed.removeFirst() }
    while collapsed.last == 0x20 { collapsed.removeLast() }
    return String(decoding: collapsed, as: UTF8.self)
}

struct Arg {
    var start: Int
    var end: Int
    var text: String
    var label: String?
}

/// `name:` prefix of an argument, if it has one.
private func argLabel(_ text: String) -> String? {
    var label = ""
    var it = text.unicodeScalars.makeIterator()
    guard let first = it.next(), first == "_" || (first.isASCII && first.properties.isAlphabetic) else { return nil }
    label.unicodeScalars.append(first)
    while let c = it.next() {
        if c == "_" || (c.isASCII && (c.properties.isAlphabetic || ("0"..."9").contains(c))) {
            label.unicodeScalars.append(c)
            continue
        }
        var c = c
        while c == " " || c == "\t" || c == "\n" { guard let n = it.next() else { return nil }; c = n }
        return c == ":" ? label : nil
    }
    return nil
}

/// Splits the arguments of a call whose `(` is at `open`. Returns args and the index of the closing `)`.
private func splitArgs(_ src: Bytes, _ open: Int) -> (args: [Arg], close: Int)? {
    var args: [Arg] = []
    var depth = 0
    // Span of code (not whitespace or comments) in the current argument, so edits never eat comments.
    var codeStart = -1, codeEnd = -1
    func mark(_ from: Int, _ to: Int) {
        if codeStart == -1 { codeStart = from }
        codeEnd = to
    }
    func push() {
        if codeStart != -1 {
            let text = stripComments(Array(src[codeStart..<codeEnd]))
            args.append(Arg(start: codeStart, end: codeEnd, text: text, label: argLabel(text)))
        }
        codeStart = -1
        codeEnd = -1
    }
    var i = open + 1
    while i < src.count {
        let j = skipTrivia(src, i)
        if j != i {
            if !isComment(src, i) { mark(i, j) } // string literal
            i = j
            continue
        }
        let c = src[i]
        let isOpen = c == UInt8(ascii: "(") || c == UInt8(ascii: "[") || c == UInt8(ascii: "{")
        let isClose = c == UInt8(ascii: ")") || c == UInt8(ascii: "]") || c == UInt8(ascii: "}")
        if !isSpace(c), !(depth == 0 && (c == UInt8(ascii: ",") || c == UInt8(ascii: ")"))) { mark(i, i + 1) }
        if isOpen {
            depth += 1
        } else if isClose {
            if depth == 0 {
                guard c == UInt8(ascii: ")") else { return nil }
                push()
                return (args, i)
            }
            depth -= 1
        } else if c == UInt8(ascii: ","), depth == 0 {
            push()
        }
        i += 1
    }
    return nil
}

// MARK: - Requirement arguments

/// A tiny matcher for the fixed requirement shapes: `word`, `"literal"`, punctuation, optional spaces.
private struct Matcher {
    let s: [Character]
    var i = 0
    init(_ text: String) { s = Array(text) }
    mutating func spaces() { while i < s.count, s[i].isWhitespace { i += 1 } }
    mutating func lit(_ t: String) -> Bool {
        let t = Array(t)
        guard i + t.count <= s.count, Array(s[i..<(i + t.count)]) == t else { return false }
        i += t.count
        return true
    }
    /// `"..."` with no quotes or backslashes inside.
    mutating func str() -> String? {
        guard i < s.count, s[i] == "\"" else { return nil }
        var j = i + 1
        while j < s.count, s[j] != "\"" {
            if s[j] == "\\" { return nil }
            j += 1
        }
        guard j < s.count else { return nil }
        let v = String(s[(i + 1)..<j])
        i = j + 1
        return v
    }
    var atEnd: Bool { i == s.count }
}

/// Matches `prefix` `"value"` `suffix` where spaces may appear around punctuation.
private func matchShape(_ text: String, _ prefix: [String], _ suffix: [String]) -> String? {
    var m = Matcher(text)
    for (k, p) in prefix.enumerated() {
        if k > 0 { m.spaces() }
        guard m.lit(p) else { return nil }
    }
    m.spaces()
    guard let v = m.str() else { return nil }
    for p in suffix {
        m.spaces()
        guard m.lit(p) else { return nil }
    }
    return m.atEnd ? v : nil
}

/// Parses the text of a single requirement argument.
public func parseRequirementArg(_ raw: String) -> (req: Requirement, style: ReqStyle) {
    let t = collapseEnds(raw)
    if let v = matchShape(t, ["from", ":"], []) { return (.version(.upToNextMajor, v), .label) }
    if let v = matchShape(t, [".upToNextMajor", "(", "from", ":"], [")"]) { return (.version(.upToNextMajor, v), .method) }
    if let v = matchShape(t, [".upToNextMinor", "(", "from", ":"], [")"]) { return (.version(.upToNextMinor, v), .method) }
    if let v = matchShape(t, ["exact", ":"], []) { return (.version(.exact, v), .label) }
    if let v = matchShape(t, [".exact", "("], [")"]) { return (.version(.exact, v), .method) }
    if let v = matchShape(t, ["branch", ":"], []) { return (.branch(v), .label) }
    if let v = matchShape(t, [".branch", "("], [")"]) { return (.branch(v), .method) }
    if let v = matchShape(t, ["revision", ":"], []) { return (.revision(v), .label) }
    if let v = matchShape(t, [".revision", "("], [")"]) { return (.revision(v), .method) }
    var m = Matcher(t)
    if let lo = m.str() {
        m.spaces()
        let closed: Bool? = m.lit("..<") ? false : m.lit("...") ? true : nil
        if let closed {
            m.spaces()
            if let hi = m.str(), m.atEnd { return (.range(lower: lo, upper: hi, closed: closed), .range) }
        }
    }
    return (.unknown(t), .label)
}

private func collapseEnds(_ s: String) -> String {
    var sub = Substring(s)
    while let c = sub.first, c.isWhitespace { sub = sub.dropFirst() }
    while let c = sub.last, c.isWhitespace { sub = sub.dropLast() }
    return String(sub)
}

/// Renders a requirement argument, keeping `style` when the kind is unchanged.
public func renderRequirementArg(_ req: Requirement, style: ReqStyle, previous: Requirement) -> String {
    let keep = req.kindTag == previous.kindTag && style == .method
    switch req {
    case let .version(.upToNextMajor, v): return keep ? ".upToNextMajor(from: \"\(v)\")" : "from: \"\(v)\""
    case let .version(.upToNextMinor, v): return ".upToNextMinor(from: \"\(v)\")"
    case let .version(.exact, v): return keep ? ".exact(\"\(v)\")" : "exact: \"\(v)\""
    case let .range(lo, hi, closed): return "\"\(lo)\"\(closed ? "..." : "..<")\"\(hi)\""
    case let .branch(r): return keep ? ".branch(\"\(r)\")" : "branch: \"\(r)\""
    case let .revision(r): return keep ? ".revision(\"\(r)\")" : "revision: \"\(r)\""
    case let .unknown(raw): return raw
    }
}

private func stringLiteral(_ text: String) -> String? {
    var m = Matcher(text)
    guard let v = m.str(), m.atEnd else { return nil }
    return v
}

private func argValue(_ arg: Arg) -> String {
    guard let colon = arg.text.firstIndex(of: ":") else { return collapseEnds(arg.text) }
    return collapseEnds(String(arg.text[arg.text.index(after: colon)...]))
}

// MARK: - Parse

public func parsePackageSwift(_ text: String) -> [Dependency] {
    let src = Bytes(text.utf8)
    var deps: [Dependency] = []
    var i = 0
    while i < src.count {
        let j = skipTrivia(src, i)
        if j != i { i = j; continue }
        if src.has(".package", at: i), !(i + 8 < src.count && isIdentByte(src[i + 8])) {
            var k = i + 8
            while k < src.count, isSpace(src[k]) { k += 1 }
            if k < src.count, src[k] == UInt8(ascii: "("), let call = splitArgs(src, k) {
                if let dep = depFromArgs(call.args) { deps.append(dep) }
                i = call.close + 1
                continue
            }
        }
        i += 1
    }
    return deps
}

private func depFromArgs(_ args: [Arg]) -> Dependency? {
    func index(_ label: String) -> Int? { args.firstIndex { $0.label == label } }
    let explicitName = index("name").flatMap { stringLiteral(argValue(args[$0])) }

    if let p = index("path") {
        let path = stringLiteral(argValue(args[p])) ?? argValue(args[p])
        let name = explicitName ?? nameFromUrl(path)
        return Dependency(name: name, identity: name.lowercased(), source: .local, url: nil, fetchUrl: nil,
                          req: .unknown("path:\(path)"), handle: .none)
    }

    let urlIdx = index("url")
    guard let keyIdx = urlIdx ?? index("id"), let key = stringLiteral(argValue(args[keyIdx])) else { return nil }
    let reqArg = keyIdx + 1 < args.count ? args[keyIdx + 1] : nil
    let (req, style) = reqArg.map { parseRequirementArg($0.text) } ?? (.unknown(""), .label)
    let handle: Handle = reqArg.map { .packageSwift(start: $0.start, end: $0.end, style: style) } ?? .none

    guard urlIdx != nil else {
        // Registry dependency: `.package(id: "scope.name", from: "1.0.0")`
        let name = key.split(separator: ".").last.map(String.init) ?? key
        return Dependency(name: explicitName ?? name, identity: key.lowercased(), source: .registry, url: nil, fetchUrl: nil,
                          req: req, handle: handle)
    }
    return Dependency(name: explicitName ?? nameFromUrl(key), identity: identityFromUrl(key), source: .remote, url: key,
                      fetchUrl: nil, req: req, handle: handle)
}

// MARK: - Edit

public struct PackageSwiftEdit {
    public var start: Int
    public var end: Int
    public var style: ReqStyle
    public var prev: Requirement
    public var next: Requirement
}

/// The string literals a requirement is written with, in source order.
private func requirementLiterals(_ req: Requirement) -> [String] {
    switch req {
    case let .version(_, v): return [v]
    case let .range(lo, hi, _): return [lo, hi]
    case let .branch(r), let .revision(r): return [r]
    case .unknown: return []
    }
}

/// When the kind is unchanged, swaps just the string literals so every bit of the author's
/// formatting (spacing, comments, line breaks) survives. Returns nil if that isn't possible.
private func swapLiterals(_ arg: Bytes, prev: Requirement, next: Requirement) -> Bytes? {
    guard prev.kindTag == next.kindTag else { return nil }
    let from = requirementLiterals(prev), to = requirementLiterals(next)
    var spans: [(Int, Int)] = []
    var i = 0
    while i < arg.count {
        if arg[i] == quote {
            var j = i + 1
            while j < arg.count, arg[j] != quote { j += arg[j] == backslash ? 2 : 1 }
            guard j < arg.count else { return nil }
            spans.append((i, j + 1))
            i = j + 1
        } else {
            i += 1
        }
    }
    guard spans.count == from.count else { return nil }
    for (k, s) in spans.enumerated() where arg.string(s.0 + 1, s.1 - 1) != from[k] { return nil }
    var out = Bytes()
    var last = 0
    for (k, s) in spans.enumerated() {
        out.append(contentsOf: arg[last..<s.0])
        out.append(contentsOf: Bytes("\"\(to[k])\"".utf8))
        last = s.1
    }
    out.append(contentsOf: arg[last...])
    return out
}

/// Applies requirement edits, touching only each requirement argument's text.
public func editPackageSwift(_ text: String, _ edits: [PackageSwiftEdit]) -> String {
    var out = Bytes(text.utf8)
    for e in edits.sorted(by: { $0.start > $1.start }) {
        let original = Array(out[e.start..<e.end])
        let replacement = swapLiterals(original, prev: e.prev, next: e.next)
            ?? Bytes(renderRequirementArg(e.next, style: e.style, previous: e.prev).utf8)
        out.replaceSubrange(e.start..<e.end, with: replacement)
    }
    return String(decoding: out, as: UTF8.self)
}
