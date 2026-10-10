import Foundation

public enum Format: String, Sendable {
    case table, tsv, json
}

public struct Style: Sendable {
    public var color: Bool
    public init(color: Bool) { self.color = color }
}

enum Color: String {
    case bold = "1", dim = "2", red = "31", green = "32", yellow = "33", magenta = "35", cyan = "36", gray = "90"
}

func paint(_ s: Style, _ color: Color, _ text: String) -> String {
    s.color ? "\u{1b}[\(color.rawValue)m\(text)\u{1b}[0m" : text
}

/// Display width the way the original (JS) renderer measured it: UTF-16 units, ANSI codes excluded.
func visibleLength(_ s: String) -> Int {
    var n = 0
    var inEscape = false
    for u in s.utf16 {
        if inEscape {
            if u == UInt16(UInt8(ascii: "m")) { inEscape = false }
            continue
        }
        if u == 0x1b { inEscape = true; continue }
        n += 1
    }
    return n
}

func pad(_ s: String, _ w: Int) -> String {
    s + String(repeating: " ", count: max(0, w - visibleLength(s)))
}

// MARK: - JSON

/// Minimal JSON with ordered keys, written exactly like `JSON.stringify`.
indirect enum JSON {
    case string(String)
    case int(Int)
    case bool(Bool)
    case array([JSON])
    case object([(String, JSON)])

    /// Builds an object, dropping nil/false/empty-array values so output stays small.
    static func compact(_ pairs: [(String, JSON?)]) -> JSON {
        .object(pairs.compactMap { k, v in
            switch v {
            case nil, .bool(false)?: return nil
            case let .array(a)? where a.isEmpty: return nil
            case let v?: return (k, v)
            }
        })
    }

    func render(pretty: Bool) -> String {
        var out = ""
        write(into: &out, pretty: pretty, indent: "")
        return out
    }

    private func write(into out: inout String, pretty: Bool, indent: String) {
        switch self {
        case let .string(s): JSON.quote(s, into: &out)
        case let .int(i): out += String(i)
        case let .bool(b): out += b ? "true" : "false"
        case let .array(items):
            guard !items.isEmpty else { out += "[]"; return }
            let inner = indent + "  "
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                if pretty { out += "\n" + inner }
                item.write(into: &out, pretty: pretty, indent: inner)
            }
            if pretty { out += "\n" + indent }
            out += "]"
        case let .object(pairs):
            guard !pairs.isEmpty else { out += "{}"; return }
            let inner = indent + "  "
            out += "{"
            for (i, (k, v)) in pairs.enumerated() {
                if i > 0 { out += "," }
                if pretty { out += "\n" + inner }
                JSON.quote(k, into: &out)
                out += pretty ? ": " : ":"
                v.write(into: &out, pretty: pretty, indent: inner)
            }
            if pretty { out += "\n" + indent }
            out += "}"
        }
    }

    private static func quote(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case let c where c.value < 0x20:
                let hex = String(c.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default: out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }
}

// MARK: - check

public struct CheckOptions {
    public var format: Format
    public var style: Style
    public var pretty: Bool
    /// Max versions to list per dependency (0 = omit).
    public var versions: Int
    public var urls: Bool
}

public struct Summary {
    public var total = 0, outdated = 0, major = 0, minor = 0, patch = 0, pinned = 0, error = 0
}

public func summarize(_ checked: [CheckedDep]) -> Summary {
    var s = Summary()
    s.total = checked.count
    for c in checked {
        switch c.a.status {
        case .outdated:
            s.outdated += 1
            switch c.a.update {
            case .major: s.major += 1
            case .minor: s.minor += 1
            case .patch: s.patch += 1
            case .none: break
            }
        case .pinned: s.pinned += 1
        case .error, .registry: s.error += 1
        default: break
        }
    }
    return s
}

/// Short status token shared by the TSV and plain-table formats.
private func statusToken(_ a: Analysis) -> String {
    switch a.status {
    case .outdated: return a.update.rawValue
    case .upToDate: return "ok"
    case .error, .registry: return "error: \(a.err ?? "undefined")"
    default: return a.status.rawValue
    }
}

public func renderCheck(root: String, manifests: [Manifest], all: [CheckedDep], shown: [CheckedDep], _ o: CheckOptions) -> String {
    let summary = summarize(all)
    // Machine formats list only the manifests that have rows (renumbered), so scanning a repo
    // full of fixtures doesn't cost a line per manifest. The scanned count goes in the summary.
    let used = Array(Set(shown.map(\.m))).sorted()
    let remap = Dictionary(uniqueKeysWithValues: used.enumerated().map { ($1, $0) })
    let listed = used.map { manifests[$0] }
    let rows = shown.map { c -> CheckedDep in var c = c; c.m = remap[c.m]!; return c }

    switch o.format {
    case .json:
        func optInt(_ n: Int) -> JSON? { n > 0 ? .int(n) : nil }
        let doc = JSON.object([
            ("v", .int(1)),
            ("root", .string(root)),
            ("manifests", .array(listed.map { m in
                JSON.compact([
                    ("path", .string(m.label)),
                    ("type", .string(m.type.rawValue)),
                    ("resolved", m.resolvedPath.map { .string(Path.relative(root, $0)) }),
                ])
            })),
            ("deps", .array(rows.map { c in
                let a = c.a, dep = c.dep
                return JSON.compact([
                    ("m", .int(c.m)),
                    ("name", .string(dep.name)),
                    ("url", dep.url.map(JSON.string)),
                    ("req", .string(formatRequirement(dep.req))),
                    ("resolved", a.resolved.map(JSON.string)),
                    ("status", .string(a.status.rawValue)),
                    ("update", a.update == .none ? nil : .string(a.update.rawValue)),
                    ("patch", a.patch.map(JSON.string)),
                    ("minor", a.minor.map(JSON.string)),
                    ("major", a.major.map(JSON.string)),
                    ("latest", a.status == .pinned ? a.latest.map(JSON.string) : nil),
                    ("inRange", a.status == .outdated ? a.inRange.map(JSON.bool) : nil),
                    ("err", a.err.map(JSON.string)),
                    ("versions", o.versions > 0 ? .array(a.newer.prefix(o.versions).map(JSON.string)) : nil),
                ])
            })),
            ("summary", JSON.compact([
                ("manifests", .int(manifests.count)),
                ("total", .int(summary.total)),
                ("outdated", .int(summary.outdated)),
                ("major", optInt(summary.major)),
                ("minor", optInt(summary.minor)),
                ("patch", optInt(summary.patch)),
                ("pinned", optInt(summary.pinned)),
                ("error", optInt(summary.error)),
            ])),
        ])
        return doc.render(pretty: o.pretty)
    case .tsv:
        return renderCheckTsv(listed, rows, o)
    case .table:
        return renderCheckTable(manifests, shown, summary, o)
    }
}

private func renderCheckTsv(_ manifests: [Manifest], _ shown: [CheckedDep], _ o: CheckOptions) -> String {
    var lines: [String] = []
    if !manifests.isEmpty { lines.append(manifests.enumerated().map { "#\($0) \($1.label)" }.joined(separator: "\t")) }
    var head = ["m", "pkg", "req", "resolved", "patch", "minor", "major", "status"]
    if o.urls { head.append("url") }
    if o.versions > 0 { head.append("versions") }
    lines.append(head.joined(separator: "\t"))
    for c in shown {
        let a = c.a, dep = c.dep
        var row = [
            String(c.m), dep.name, formatRequirement(dep.req), a.resolved ?? "-", a.patch ?? "-", a.minor ?? "-",
            (a.status == .pinned ? a.latest : a.major) ?? "-", statusToken(a),
        ]
        if o.urls { row.append(dep.url ?? "-") }
        if o.versions > 0 {
            let v = a.newer.prefix(o.versions).joined(separator: ",")
            row.append(v.isEmpty ? "-" : v)
        }
        lines.append(row.joined(separator: "\t"))
    }
    return lines.joined(separator: "\n")
}

private func renderCheckTable(_ manifests: [Manifest], _ shown: [CheckedDep], _ summary: Summary, _ o: CheckOptions) -> String {
    let s = o.style
    let fancy = s.color
    let empty = fancy ? paint(s, .gray, "—") : "-"
    var out: [String] = []

    func statusCell(_ a: Analysis) -> String {
        switch a.status {
        case .outdated:
            return paint(s, a.update == .major ? .red : a.update == .minor ? .yellow : .cyan, "\(a.update.rawValue) update")
        case .upToDate: return paint(s, .green, "up to date")
        case .pinned: return paint(s, .magenta, "pinned\(a.latest.map { " (latest \($0))" } ?? "")")
        case .local: return paint(s, .gray, "local")
        default: return paint(s, .red, "\(a.status == .registry ? "unsupported" : "error"): \(a.err ?? "unknown")")
        }
    }

    for (mi, m) in manifests.enumerated() {
        let rows = shown.filter { $0.m == mi }
        if rows.isEmpty { continue }
        var header = ["Package", "Requirement", "Resolved", "Patch", "Minor", "Major", "Status"]
        if o.urls { header.append("URL") }
        let cells: [[String]] = rows.map { c in
            let a = c.a, dep = c.dep
            var row = [
                paint(s, .bold, dep.name),
                formatRequirement(dep.req),
                a.resolved ?? empty,
                a.patch.map { paint(s, .cyan, $0) } ?? empty,
                a.minor.map { paint(s, .yellow, $0) } ?? empty,
                a.major.map { paint(s, .red, $0) } ?? empty,
                statusCell(a),
            ]
            if o.urls { row.append(dep.url ?? empty) }
            return row
        }
        let widths = header.indices.map { i in ([header[i].utf16.count] + cells.map { visibleLength($0[i]) }).max()! }
        let sep = fancy ? paint(s, .gray, " │ ") : "  "
        func line(_ r: [String]) -> String {
            (fancy ? " " : "") + r.enumerated().map { i, v in i == r.count - 1 ? v : pad(v, widths[i]) }.joined(separator: sep)
        }
        let total = widths.reduce(0, +) + (widths.count - 1) * (fancy ? 3 : 2) + (fancy ? 2 : 0)
        let rule = paint(s, .gray, String(repeating: "─", count: total))

        if !out.isEmpty { out.append("") }
        out.append(fancy ? paint(s, .cyan, paint(s, .bold, m.label)) : "# \(m.label)")
        if fancy { out.append(rule) }
        out.append(line(header.map { paint(s, .bold, $0) }))
        if fancy { out.append(rule) }
        for r in cells { out.append(line(r)) }
        if fancy { out.append(rule) }
    }

    if shown.isEmpty, summary.outdated == 0 {
        out.append(fancy ? paint(s, .green, "✓ All packages are up to date.") : "all packages up to date")
        return out.joined(separator: "\n")
    }
    out.append("")
    out.append(contentsOf: footer(shown, summary, s))
    return out.joined(separator: "\n")
}

private func footer(_ shown: [CheckedDep], _ summary: Summary, _ s: Style) -> [String] {
    let fancy = s.color
    var lines: [String] = []
    let parts = [("major", summary.major), ("minor", summary.minor), ("patch", summary.patch)].filter { $0.1 > 0 }.map { "\($0.1) \($0.0)" }
    if summary.outdated == 0 {
        lines.append(fancy ? paint(s, .green, "✓ All packages are up to date.") : "all packages up to date")
    } else {
        let head = "\(summary.outdated) outdated\(parts.isEmpty ? "" : " (\(parts.joined(separator: ", ")))")"
        lines.append(fancy ? paint(s, .yellow, paint(s, .bold, head)) : head)
    }
    if summary.pinned > 0 {
        lines.append(fancy ? paint(s, .magenta, "\(summary.pinned) pinned to a branch/revision") : "\(summary.pinned) pinned")
    }
    if summary.error > 0 {
        lines.append(fancy ? paint(s, .red, "\(summary.error) could not be checked") : "\(summary.error) error\(summary.error == 1 ? "" : "s")")
    }
    if summary.outdated > 0 {
        var majors: [String] = []
        for c in shown where c.a.update == .major && !majors.contains(c.dep.name) { majors.append(c.dep.name) }
        var cmds: [(String, String)] = []
        if summary.minor + summary.patch > 0 || majors.count < summary.outdated {
            cmds.append(("spm-update update --level minor", "apply non-breaking updates"))
        }
        if !majors.isEmpty {
            cmds.append(("spm-update apply \(majors.map { "\($0)@major" }.joined(separator: " "))", "apply breaking updates"))
        }
        if fancy {
            cmds.append(("spm-update -i", "choose interactively"))
            lines.append("")
            lines.append(paint(s, .dim, "Next steps:"))
            let w = cmds.map { $0.0.utf16.count }.max() ?? 0
            for (cmd, why) in cmds { lines.append("  \(paint(s, .cyan, pad(cmd, w)))  \(paint(s, .dim, "# \(why)"))") }
            lines.append("")
            lines.append(paint(s, .dim, "Requirement = what the manifest allows; Resolved = version locked in Package.resolved."))
        } else {
            lines.append("next: \(cmds.map(\.0).joined(separator: " | "))")
        }
    }
    return lines
}

// MARK: - apply / update

public struct PlanOptions {
    public var format: Format
    public var style: Style
    public var pretty: Bool
    public var dryRun: Bool
    public var quiet: Bool
    public var next: String?
    /// Print the per-change lines.
    public var list = true
    /// Print the closing summary line.
    public var footer = true
}

public func renderPlan(_ plan: Plan, _ manifests: [Manifest], _ o: PlanOptions) -> String {
    if o.format == .json {
        return JSON.compact([
            ("v", .int(1)),
            ("dryRun", .bool(o.dryRun)),
            ("changes", .array(plan.changes.map { c in
                .object([("m", .int(c.m)), ("name", .string(c.name)), ("from", .string(formatRequirement(c.from))),
                         ("to", .string(formatRequirement(c.to)))])
            })),
            ("skipped", .array(plan.skipped.map { k in
                .object([("m", .int(k.m)), ("name", .string(k.name)), ("reason", .string(k.reason))])
            })),
            ("errors", .array(plan.errors.map(JSON.string))),
            ("next", plan.errors.isEmpty && !o.dryRun ? o.next.map(JSON.string) : nil),
        ]).render(pretty: o.pretty)
    }
    let s = o.style
    let fancy = s.color && o.format == .table
    let multi = Set(plan.changes.map(\.m)).count > 1 || manifests.count > 1
    func whereText(_ m: Int) -> String {
        guard multi else { return "" }
        let label = "(\(manifests[m].label))"
        return "  " + (fancy ? paint(s, .gray, label) : label)
    }
    var lines: [String] = []
    for e in plan.errors { lines.append(fancy ? paint(s, .red, "✗ \(e)") : "error: \(e)") }
    if o.quiet { return lines.joined(separator: "\n") }

    if plan.errors.isEmpty, o.list {
        let nameW = plan.changes.map { $0.name.utf16.count }.max() ?? 0
        let fromW = plan.changes.map { formatRequirement($0.from).utf16.count }.max() ?? 0
        for c in plan.changes {
            let from = formatRequirement(c.from), to = formatRequirement(c.to)
            if fancy {
                let mark = o.dryRun ? paint(s, .yellow, "~") : paint(s, .green, "✓")
                lines.append("\(mark) \(paint(s, .bold, pad(c.name, nameW)))  \(pad(from, fromW)) → \(paint(s, .green, to))\(whereText(c.m))")
            } else {
                lines.append("\(c.name)\t\(from) -> \(to)\(whereText(c.m))")
            }
        }
        for k in plan.skipped {
            lines.append(fancy ? paint(s, .gray, "- \(k.name): \(k.reason)") : "skip \(k.name): \(k.reason)")
        }
    }

    if !o.footer { return lines.joined(separator: "\n") }
    let n = plan.changes.count
    let noun = "\(n) change\(n == 1 ? "" : "s")"
    if !plan.errors.isEmpty {
        lines.append(fancy ? paint(s, .red, "Nothing written.") : "nothing written")
    } else if n == 0 {
        lines.append(fancy ? paint(s, .green, "Nothing to change.") : "nothing to change")
    } else if o.dryRun {
        lines.append(fancy ? paint(s, .yellow, "Dry run: \(noun), nothing written.") : "dry run: \(noun), nothing written")
    } else {
        lines.append(fancy ? paint(s, .green, "Wrote \(noun).") : "wrote \(noun)")
        if let next = o.next {
            lines.append(fancy ? "\(paint(s, .dim, "Refresh Package.resolved:")) \(paint(s, .cyan, next))" : "next: \(next)")
        }
    }
    return lines.joined(separator: "\n")
}
