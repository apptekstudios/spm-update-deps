import Foundation

public let toolVersion = "1.0.0"

enum Command: String, CaseIterable {
    case check, apply, update, interactive
}

let helpText = """
spm-update \(toolVersion) - check and update Swift Package Manager dependencies
in Package.swift and .xcodeproj files.

Usage:
  spm-update [check] [path]               list dependencies and available updates
  spm-update apply [path] <pkg>@<target>… apply per-package decisions
  spm-update update [path]                bulk-update every package
  spm-update -i [path]                    choose updates interactively

Targets: latest | major | minor | patch | <version>
  Prefix with ^ (upToNextMajor), ~ (upToNextMinor) or = (exact) to change the
  requirement kind; otherwise the existing kind is kept. e.g. Alamofire@minor,
  Kingfisher@=8.1.0, swift-log@^1.6.0

Common options:
  --format table|tsv|json   output format (default: table, or $SPM_UPDATE_FORMAT)
  --json                    same as --format json  (--pretty to indent)
  -r, --recursive           search subfolders for manifests
  --no-cache                don't reuse version lookups from the last 10 minutes
  --timeout <s>             per-repository lookup timeout (default 30)
  -j, --jobs <n>            repositories looked up in parallel (default 16)

check:  --outdated  --versions[=N]  --urls  --include-prerelease  --fail-on-outdated
apply:  --plan <file|->  --manifest <path>  --dry-run  --force  -y  -q
update: --level patch|minor|major (default major)  --only <pkg>  --skip <pkg>
        --dry-run  -y  -q

Exit codes: 0 ok, 1 error (nothing written), 2 outdated (with --fail-on-outdated)
Run 'spm-update help <command>' for details.
"""

let commandHelp: [Command: String] = [
    .check: """
    spm-update check [path] [options]

    Lists every dependency with the newest patch, minor and major version above the
    resolved version (from Package.resolved, else the requirement's lower bound).

      --format tsv          compact tab-separated output (cheapest for agents)
      --json [--pretty]     structured output for scripts
      --outdated            only rows that need attention (outdated or error)
      --versions[=N]        list up to N (default 20) newer versions per package
      --urls                add the repository URL column (always present in JSON)
      --include-prerelease  consider prerelease tags (alpha, beta, rc)
      --fail-on-outdated    exit 2 when any dependency is outdated

    Status: major|minor|patch (largest update available), ok, pinned (branch or
    revision; the major column then shows the newest release), local, error: <why>.
    """,
    .apply: """
    spm-update apply [path] <pkg>@<target>… [options]

      <pkg>      package name, identity (case-insensitive) or repository URL
      <target>   latest|major, minor (newest in current major), patch (newest in
                 current minor), or an explicit version. Prefix ^ ~ = to set the
                 requirement kind. Branch/revision pins need an explicit version.
      --plan <file|->   read decisions from JSON: {"decisions":[{"package":"Alamofire",
                        "target":"minor","requirement":"exact","manifest":"Package.swift"}]}
      --manifest <path> only touch this manifest
      --dry-run         show the changes without writing
      --force           allow versions without a tag, and downgrades
      -y, --yes         don't ask for confirmation in a terminal
      -q, --quiet       print errors only

    All decisions are validated first; if any fails, nothing is written (exit 1).
    """,
    .update: """
    spm-update update [path] [options]

    Bulk-updates every remote package, keeping each requirement's kind.
      --level patch|minor|major   largest step to take (default: major = latest)
      --only <pkg>                limit to these packages (repeatable, comma-separated)
      -s, --skip <pkg>            leave these packages alone (repeatable)
      --dry-run  -y  -q           as for apply
    Branch/revision pins are never changed by update; use apply with a version.
    """,
    .interactive: """
    spm-update -i [path]

    Steps through each outdated package and lets you pick patch, minor, major or skip,
    then confirms before writing. Needs a terminal.
    """,
]

struct Args {
    var command: Command = .check
    var path = "."
    var decisions: [Decision] = []
    var format: Format = .table
    var pretty = false
    var recursive = false
    var cache = true
    var timeout: Double = 30
    var jobs = 16
    var outdated = false
    var versions = 0
    var urls = false
    var prerelease = false
    var failOnOutdated = false
    var plan: String?
    var manifest: String?
    var dryRun = false
    var force = false
    var yes = false
    var quiet = false
    var level: Level = .major
    var only = Set<String>()
    var skip = Set<String>()
    var help = false
    var helpTopic: Command?
    var version = false
}

private func parseFormat(_ v: String) throws -> Format {
    guard let f = Format(rawValue: v) else { throw UsageError("invalid --format '\(v)' (use table, tsv or json)") }
    return f
}

private func addNames(_ set: inout Set<String>, _ v: String) {
    for n in v.split(separator: ",", omittingEmptySubsequences: false) {
        let t = n.trimmingCharacters(in: .whitespaces)
        if !t.isEmpty { set.insert(t.lowercased()) }
    }
}

func parseArgs(_ argv: [String], env: [String: String]) throws -> Args {
    var a = Args()
    if let f = env["SPM_UPDATE_FORMAT"], !f.isEmpty { a.format = try parseFormat(f) }
    var positionals: [String] = []
    var levelGiven = false
    var i = 0
    while i < argv.count {
        let raw = argv[i]
        var flag = raw
        var inline: String?
        if raw.hasPrefix("--"), let eq = raw.firstIndex(of: "="), eq != raw.startIndex {
            flag = String(raw[..<eq])
            inline = String(raw[raw.index(after: eq)...])
        }
        func value() throws -> String {
            if let inline { return inline }
            guard i + 1 < argv.count, !argv[i + 1].hasPrefix("-") || argv[i + 1] == "-" else {
                throw UsageError("\(flag) needs a value")
            }
            i += 1
            return argv[i]
        }
        switch flag {
        case "-h", "--help": a.help = true
        case "-V", "--version": a.version = true
        case "--format": a.format = try parseFormat(try value())
        case "--json": a.format = .json
        case "--tsv": a.format = .tsv
        case "--pretty": a.pretty = true
        case "-r", "--recursive": a.recursive = true
        case "--no-cache": a.cache = false
        case "--timeout":
            guard let n = Double(try value()), n > 0 else { throw UsageError("--timeout must be a positive number of seconds") }
            a.timeout = n
        case "-j", "--jobs":
            guard let n = Double(try value()), n >= 1, n == n.rounded() else {
                throw UsageError("--jobs must be a whole number of at least 1")
            }
            a.jobs = Int(n)
        case "--outdated": a.outdated = true
        case "--versions":
            guard let n = inline.map({ Double($0) }) ?? 20, n >= 0, n == n.rounded() else {
                throw UsageError("--versions=N needs a whole number")
            }
            a.versions = Int(n)
        case "--urls": a.urls = true
        case "--include-prerelease": a.prerelease = true
        case "--fail-on-outdated": a.failOnOutdated = true
        case "--plan": a.plan = try value()
        case "--manifest": a.manifest = try value()
        case "-n", "--dry-run": a.dryRun = true
        case "--force": a.force = true
        case "-y", "--yes": a.yes = true
        case "-q", "--quiet": a.quiet = true
        case "--level":
            let v = try value()
            guard let l = Level(rawValue: v) else { throw UsageError("invalid --level '\(v)' (use patch, minor or major)") }
            a.level = l
            levelGiven = true
        case "--only": addNames(&a.only, try value())
        case "-s", "--skip": addNames(&a.skip, try value())
        case "-i", "--interactive": a.command = .interactive
        default:
            if raw.hasPrefix("-"), raw != "-" { throw UsageError("unknown option '\(raw)'") }
            positionals.append(raw)
        }
        i += 1
    }
    if a.version { return a }

    // Command: first positional if it names one; legacy `spm-update <path> update` also works.
    if positionals.first == "help" {
        a.help = true
        if positionals.count > 1 { a.helpTopic = Command(rawValue: positionals[1]) }
        return a
    }
    if a.command != .interactive,
       let idx = positionals.firstIndex(where: { Command(rawValue: $0) != nil && !Path.exists($0) }) {
        a.command = Command(rawValue: positionals.remove(at: idx))!
    }
    if a.help {
        if a.command != .check || !positionals.isEmpty { a.helpTopic = a.command }
        return a
    }

    var paths: [String] = []
    for p in positionals {
        if a.command == .apply, p.contains("@"), !Path.exists(p) {
            a.decisions.append(try parseDecisionArg(p))
        } else {
            paths.append(p)
        }
    }
    if paths.count > 1 { throw UsageError("unexpected argument '\(paths[1])'") }
    a.path = paths.first ?? "."
    if levelGiven, a.command != .update { throw UsageError("--level is only valid with update") }
    if a.command == .apply, a.decisions.isEmpty, a.plan == nil {
        throw UsageError("apply needs decisions (<pkg>@<target>) or --plan <file>")
    }
    if let m = a.manifest { for k in a.decisions.indices where a.decisions[k].manifest == nil { a.decisions[k].manifest = m } }
    return a
}

// MARK: - I/O

/// Writes a line to stdout synchronously, so large output is never cut short.
func emit(_ text: String) {
    FileHandle.standardOutput.write(Data((text + "\n").utf8))
}

func emitError(_ text: String) {
    FileHandle.standardError.write(Data((text + "\n").utf8))
}

private func isTTY(_ fd: Int32) -> Bool { isatty(fd) == 1 }

private final class Progress: @unchecked Sendable {
    let enabled: Bool
    private var shown = false
    private let lock = NSLock()
    init(enabled: Bool) { self.enabled = enabled }
    func update(_ done: Int, _ total: Int) {
        guard enabled else { return }
        lock.lock(); defer { lock.unlock() }
        shown = true
        FileHandle.standardError.write(Data("\r\u{1b}[2KFetching versions \(done)/\(total)…".utf8))
    }
    func clear() {
        if shown { FileHandle.standardError.write(Data("\r\u{1b}[2K".utf8)) }
    }
}

private func checkAll(_ manifests: [Manifest], _ args: Args, _ fetcher: TagFetcher) async -> [CheckedDep] {
    let urls = manifests.flatMap { m in m.deps.compactMap { d in d.source == .remote && d.url != nil ? (d.fetchUrl ?? d.url) : nil } }
    let progress = Progress(enabled: isTTY(2) && args.format == .table && !args.quiet)
    let tags = await fetchAll(urls, fetcher: fetcher, concurrency: args.jobs) { progress.update($0, $1) }
    progress.clear()
    var checked: [CheckedDep] = []
    for (m, man) in manifests.enumerated() {
        let pins = readResolved(man.resolvedPath)
        for dep in man.deps {
            let a = analyze(dep, pin: pins[dep.identity], tags: dep.url.flatMap { tags[dep.fetchUrl ?? $0] },
                            includePrerelease: args.prerelease)
            checked.append(CheckedDep(m: m, dep: dep, a: a))
        }
    }
    return checked
}

private func readPlanInput(_ src: String) throws -> Data {
    if src == "-" { return FileHandle.standardInput.readDataToEndOfFile() }
    guard let data = FileManager.default.contents(atPath: src) else { throw UsageError("can't read plan '\(src)'") }
    return data
}

private func finishPlan(_ plan: Plan, _ checked: [CheckedDep], _ manifests: [Manifest], _ args: Args, _ style: Style) throws -> Int32 {
    var o = PlanOptions(format: args.format, style: style, pretty: args.pretty, dryRun: args.dryRun, quiet: args.quiet,
                        next: resolveHint(plan, manifests))
    let interactiveTerm = isTTY(1) && isTTY(0) && args.format == .table
    let canWrite = plan.errors.isEmpty && !plan.changes.isEmpty

    if canWrite, !args.dryRun, interactiveTerm, !args.yes {
        var preview = o
        preview.dryRun = true
        preview.footer = false
        emit(renderPlan(plan, manifests, preview))
        guard confirmWrite(plan.changes.count) else {
            emit("Nothing written.")
            return 0
        }
        try writeChanges(plan, checked, manifests)
        o.list = false
        emit(renderPlan(plan, manifests, o))
        return 0
    }

    if canWrite, !args.dryRun { try writeChanges(plan, checked, manifests) }
    let text = renderPlan(plan, manifests, o)
    if !text.isEmpty { emit(text) }
    return plan.errors.isEmpty ? 0 : 1
}

public func run(_ argv: [String]) async throws -> Int32 {
    let env = ProcessInfo.processInfo.environment
    let args = try parseArgs(argv, env: env)
    if args.version { emit(toolVersion); return 0 }
    if args.help {
        emit(args.helpTopic.flatMap { commandHelp[$0] } ?? helpText)
        return 0
    }
    let style = Style(color: isTTY(1) && env["NO_COLOR"] == nil && args.format == .table)

    var decisions = args.decisions
    if let plan = args.plan {
        var fromPlan = try parsePlanFile(try readPlanInput(plan))
        if let m = args.manifest { for k in fromPlan.indices where fromPlan[k].manifest == nil { fromPlan[k].manifest = m } }
        decisions += fromPlan
    }
    if args.command == .interactive, !(isTTY(0) && isTTY(1)) {
        throw UsageError("interactive mode needs a terminal; use check and apply instead")
    }

    let (root, manifests) = try loadManifests(args.path, recursive: args.recursive)
    let live = LiveTagFetcher(timeout: args.timeout)
    let cached = args.cache ? CachedTagFetcher(live, ttlSeconds: 600) : nil
    let checked = await checkAll(manifests, args, cached ?? live)
    cached?.flush()

    switch args.command {
    case .check:
        let shown = args.outdated ? checked.filter { $0.a.status == .outdated || $0.a.status == .error } : checked
        emit(renderCheck(root: root, manifests: manifests, all: checked, shown: shown,
                         CheckOptions(format: args.format, style: style, pretty: args.pretty, versions: args.versions,
                                      urls: args.urls)))
        return args.failOnOutdated && summarize(checked).outdated > 0 ? 2 : 0
    case .apply:
        return try finishPlan(planDecisions(checked, manifests, decisions, force: args.force), checked, manifests, args, style)
    case .update:
        return try finishPlan(planBulk(checked, level: args.level, only: args.only, skip: args.skip), checked, manifests, args, style)
    case .interactive:
        guard let chosen = chooseInteractively(checked, manifests), !chosen.isEmpty else { return 0 }
        return try finishPlan(planDecisions(checked, manifests, chosen, force: false), checked, manifests, args, style)
    }
}

/// Runs the CLI and returns the process exit code, printing errors to stderr.
public func main(_ argv: [String]) async -> Int32 {
    do {
        return try await run(argv)
    } catch let e as UsageError {
        emitError("error: \(e.description)")
        emitError("run 'spm-update --help' for usage")
    } catch {
        emitError("error: \(error)")
    }
    return 1
}
