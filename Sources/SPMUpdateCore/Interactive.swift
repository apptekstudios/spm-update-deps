import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

// A small terminal prompt: arrow keys (or j/k) to move, Enter to choose, Ctrl-C / Esc to cancel.

private enum Key {
    case up, down, left, right, enter, cancel, char(Character)
}

private struct RawMode {
    private var saved = termios()
    private let active: Bool

    init() {
        guard tcgetattr(STDIN_FILENO, &saved) == 0 else { active = false; return }
        var raw = saved
        raw.c_lflag &= ~tcflag_t(ECHO | ICANON | ISIG)
        withUnsafeMutableBytes(of: &raw.c_cc) { cc in
            cc[Int(VMIN)] = 1
            cc[Int(VTIME)] = 0
        }
        active = tcsetattr(STDIN_FILENO, TCSAFLUSH, &raw) == 0
    }

    func restore() {
        guard active else { return }
        var t = saved
        tcsetattr(STDIN_FILENO, TCSAFLUSH, &t)
    }
}

private func readByte() -> UInt8? {
    var b: UInt8 = 0
    return read(STDIN_FILENO, &b, 1) == 1 ? b : nil
}

private func readKey() -> Key {
    guard let b = readByte() else { return .cancel }
    switch b {
    case 3, 4: return .cancel // Ctrl-C, Ctrl-D
    case 10, 13: return .enter
    case 27:
        // Arrow keys arrive as ESC [ A..D; a lone ESC cancels.
        var fds = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
        guard poll(&fds, 1, 30) > 0, readByte() == UInt8(ascii: "["), let c = readByte() else { return .cancel }
        switch c {
        case UInt8(ascii: "A"): return .up
        case UInt8(ascii: "B"): return .down
        case UInt8(ascii: "C"): return .right
        case UInt8(ascii: "D"): return .left
        default: return .char("?")
        }
    default:
        return .char(Character(UnicodeScalar(b)))
    }
}

private func out(_ s: String) {
    fputs(s, stdout)
    fflush(stdout)
}

private let gray = "\u{1b}[90m", cyan = "\u{1b}[36m", green = "\u{1b}[32m", dim = "\u{1b}[2m", reset = "\u{1b}[0m"
private let bar = "\(gray)│\(reset)"

struct Option {
    var value: String
    var label: String
    var hint: String?
}

/// Shows a vertical list; returns the chosen value, or nil if cancelled.
func promptSelect(_ message: String, _ options: [Option], initial: String) -> String? {
    var index = options.firstIndex { $0.value == initial } ?? 0
    var drawn = 0
    func draw() {
        if drawn > 0 { out("\u{1b}[\(drawn)A\u{1b}[J") }
        var lines = ["\(cyan)◆\(reset)  \(message)"]
        for (i, o) in options.enumerated() {
            let hint = o.hint.map { " \(dim)(\($0))\(reset)" } ?? ""
            lines.append(i == index ? "\(bar)  \(green)●\(reset) \(o.label)\(hint)" : "\(bar)  \(dim)○ \(o.label)\(reset)")
        }
        lines.append("\(gray)└\(reset)")
        out(lines.joined(separator: "\n") + "\n")
        drawn = lines.count
    }
    let mode = RawMode()
    defer { mode.restore() }
    out("\u{1b}[?25l")
    defer { out("\u{1b}[?25h") }
    draw()
    while true {
        switch readKey() {
        case .up, .left, .char("k"): index = (index + options.count - 1) % options.count
        case .down, .right, .char("j"): index = (index + 1) % options.count
        case .enter:
            out("\u{1b}[\(drawn)A\u{1b}[J\(gray)◇\(reset)  \(message)\n\(bar)  \(dim)\(options[index].label)\(reset)\n")
            return options[index].value
        case .cancel:
            out("\u{1b}[\(drawn)A\u{1b}[J\(gray)■\(reset)  \(message)\n")
            return nil
        default: break
        }
        draw()
    }
}

/// Yes/No prompt (Enter accepts the highlighted answer; y/n answer directly).
public func confirmWrite(_ count: Int) -> Bool {
    let message = "Apply \(count) change\(count == 1 ? "" : "s")?"
    var yes = true
    var drawn = false
    func draw() {
        if drawn { out("\u{1b}[2A\u{1b}[J") }
        let y = yes ? "\(green)●\(reset) Yes" : "\(dim)○ Yes\(reset)"
        let n = yes ? "\(dim)○ No\(reset)" : "\(green)●\(reset) No"
        out("\(cyan)◆\(reset)  \(message)\n\(bar)  \(y) / \(n)\n")
        drawn = true
    }
    let mode = RawMode()
    defer { mode.restore() }
    draw()
    while true {
        switch readKey() {
        case .left, .right, .up, .down: yes.toggle()
        case .char("y"), .char("Y"): yes = true; fallthrough
        case .enter:
            out("\u{1b}[2A\u{1b}[J\(gray)◇\(reset)  \(message)\n\(bar)  \(dim)\(yes ? "Yes" : "No")\(reset)\n")
            return yes
        case .char("n"), .char("N"), .cancel:
            out("\u{1b}[2A\u{1b}[J\(gray)◇\(reset)  \(message)\n\(bar)  \(dim)No\(reset)\n")
            return false
        default: break
        }
        draw()
    }
}

private func releasesUrl(_ url: String?) -> String? {
    guard let url, let r = url.range(of: "github.com") else { return nil }
    var rest = url[r.upperBound...]
    guard rest.first == "/" || rest.first == ":" else { return nil }
    rest = rest.dropFirst()
    while rest.last == "/" { rest = rest.dropLast() }
    if rest.hasSuffix(".git") { rest = rest.dropLast(4) }
    let parts = rest.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
    return "https://github.com/\(parts[0])/\(parts[1])/releases"
}

/// Walks the user through each outdated dependency. Returns nil if cancelled.
public func chooseInteractively(_ checked: [CheckedDep], _ manifests: [Manifest]) -> [Decision]? {
    let candidates = checked.filter { $0.a.status == .outdated || ($0.a.status == .pinned && $0.a.latest != nil) }
    out("\(gray)┌\(reset)  spm-update\n\(bar)\n")
    if candidates.isEmpty {
        out("\(gray)└\(reset)  All packages are up to date.\n")
        return []
    }
    let multi = manifests.count > 1
    var decisions: [Decision] = []
    for (i, c) in candidates.enumerated() {
        let dep = c.dep, a = c.a
        var options: [Option] = []
        let notes = releasesUrl(dep.url)
        if a.status == .pinned, let latest = a.latest {
            options.append(Option(value: latest, label: "Switch to ^\(latest)", hint: "replaces the branch/revision pin"))
        } else {
            if let p = a.patch { options.append(Option(value: p, label: "Patch → \(p)", hint: "bug fixes")) }
            if let m = a.minor { options.append(Option(value: m, label: "Minor → \(m)", hint: "new features, non-breaking")) }
            if let m = a.major { options.append(Option(value: m, label: "Major → \(m)", hint: "breaking\(notes.map { " · \($0)" } ?? "")")) }
        }
        options.append(Option(value: "skip", label: "Skip"))
        let resolved = a.resolved.map { ", resolved \($0)" } ?? ""
        let whereText = multi ? " in \(manifests[c.m].label)" : ""
        let message = "[\(i + 1)/\(candidates.count)] \(dep.name) (\(formatRequirement(dep.req))\(resolved))\(whereText)"
        guard let choice = promptSelect(message, options, initial: a.minor ?? a.patch ?? "skip") else {
            out("\(gray)└\(reset)  Cancelled. Nothing written.\n")
            return nil
        }
        if choice != "skip" {
            decisions.append(Decision(selector: dep.url ?? dep.name, target: choice, manifest: manifests[c.m].label))
        }
    }
    return decisions
}
