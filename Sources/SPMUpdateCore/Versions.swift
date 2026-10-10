import Foundation

public enum TagResult: Sendable, Equatable {
    case versions([SemVer])
    case error(String)
}

/// Extracts SwiftPM-compatible versions from tag refs (`<oid> refs/tags/<name>`, tab or space separated),
/// newest first, without duplicates.
public func versionsFromRefs<S: Sequence>(_ refs: S) -> [SemVer] where S.Element: StringProtocol {
    var out = Set<SemVer>()
    for line in refs {
        let fields = line.split(whereSeparator: { $0 == "\t" || $0 == " " })
        guard fields.count >= 2, fields[1].hasPrefix("refs/tags/"), !fields[1].hasSuffix("^{}") else { continue }
        if let v = parseVersion(String(fields[1].dropFirst("refs/tags/".count))) { out.insert(v) }
    }
    return out.sorted(by: >)
}

/// Extracts versions from `git ls-remote --tags` output.
public func parseLsRemote(_ stdout: String) -> [SemVer] {
    versionsFromRefs(stdout.split(separator: "\n"))
}

// MARK: - git protocol v2 over HTTP

private func pkt(_ s: String) -> String {
    let n = s.utf8.count + 4
    let hex = String(n, radix: 16)
    return String(repeating: "0", count: 4 - hex.count) + hex + s
}

private let lsRefsBody = pkt("command=ls-refs\n") + pkt("agent=spm-update\n") + pkt("object-format=sha1\n") + "0001"
    + pkt("ref-prefix refs/tags/\n") + "0000"

/// Splits a pkt-line stream into its data lines; returns nil if it isn't a clean ref listing.
public func parseLsRefsResponse(_ body: Data) -> [String]? {
    let b = [UInt8](body)
    var refs: [String] = []
    var i = 0
    while i < b.count {
        guard i + 4 <= b.count, let len = Int(String(decoding: b[i..<(i + 4)], as: UTF8.self), radix: 16) else { return nil }
        if len < 4 {
            i += 4 // flush (0000) / delimiter (0001) / response-end (0002)
            continue
        }
        guard i + len <= b.count else { return nil }
        var line = String(decoding: b[(i + 4)..<(i + len)], as: UTF8.self)
        if line.hasSuffix("\n") { line.removeLast() }
        // e.g. "ERR ..." from the server
        guard let space = line.firstIndex(of: " "), (40...64).contains(line.distance(from: line.startIndex, to: space)),
              line[..<space].allSatisfy(\.isHexDigit), line[line.index(after: space)...].hasPrefix("refs/tags/") else { return nil }
        refs.append(line)
        i += len
    }
    return refs
}

private enum HTTPOutcome {
    case done(TagResult)
    case fallback(String)
}

func formatSeconds(_ s: Double) -> String {
    s == s.rounded() ? String(Int(s)) : String(s)
}

private let lsRefsHeaders = [
    ("Content-Type", "application/x-git-upload-pack-request"),
    ("Accept", "application/x-git-upload-pack-result"),
    ("Git-Protocol", "version=2"),
]

private func uploadPackURL(_ url: String) -> String {
    var base = url
    while base.hasSuffix("/") { base.removeLast() }
    return base + "/git-upload-pack"
}

/// Turns a response into a result; anything but a clean git v2 ref listing means "try git instead".
private func interpret(status: Int, contentType: String, body: Data) -> HTTPOutcome {
    guard status == 200, contentType.contains("git-upload-pack-result") else { return .fallback("http \(status)") }
    guard let refs = parseLsRefsResponse(body) else { return .fallback("unexpected response") }
    return .done(.versions(versionsFromRefs(refs)))
}

#if canImport(FoundationNetworking)
// Linux: swift-corelibs URLSession runs every request through one internal queue, which made
// lookups ~2x slower than parallel `curl` processes. curl is on essentially every Linux system,
// honours the usual *_proxy variables, and keeps FoundationNetworking out of the binary.

/// Lists tags with a single `ls-refs` request (git protocol v2 over smart HTTP) made by `curl`.
/// Anything unexpected (auth, old servers, odd responses, no curl) is a `fallback` to `git ls-remote`.
private func httpLsRefs(_ url: String, timeout: Double) async -> HTTPOutcome {
    var args = ["curl", "-sS", "--max-time", formatSeconds(timeout), "-X", "POST", "--data-binary", lsRefsBody]
    for (k, v) in lsRefsHeaders { args += ["-H", "\(k): \(v)"] }
    args += ["-o", "-", "--write-out", "%{stderr}\n%{http_code} %{content_type}", uploadPackURL(url)]
    let r = await runProcess(args, timeout: timeout + 5)
    if r.status == 28 { return .done(.error("timed out after \(formatSeconds(timeout))s")) }
    guard r.status == 0, let last = String(decoding: r.stderr, as: UTF8.self).split(separator: "\n").last else {
        return .fallback("curl exited with \(r.status)")
    }
    let parts = last.split(separator: " ", maxSplits: 1)
    return interpret(status: Int(parts.first ?? "") ?? 0, contentType: parts.count > 1 ? String(parts[1]) : "", body: r.stdout)
}
#else
// macOS: the system URLSession is fast, multiplexes connections and honours system proxy settings.

private let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpMaximumConnectionsPerHost = 32
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: config)
}()

/// Lists tags with a single `ls-refs` request (git protocol v2 over smart HTTP), skipping the `git`
/// process and the capability round trip. Anything unexpected (auth, old servers, odd responses)
/// is a `fallback`, so the caller retries with `git ls-remote`.
private func httpLsRefs(_ url: String, timeout: Double) async -> HTTPOutcome {
    guard let endpoint = URL(string: uploadPackURL(url)) else { return .fallback("bad url") }
    var request = URLRequest(url: endpoint, timeoutInterval: timeout)
    request.httpMethod = "POST"
    request.httpBody = Data(lsRefsBody.utf8)
    for (k, v) in lsRefsHeaders { request.setValue(v, forHTTPHeaderField: k) }
    do {
        let (data, response) = try await session.data(for: request)
        let http = response as? HTTPURLResponse
        return interpret(status: http?.statusCode ?? 0, contentType: http?.value(forHTTPHeaderField: "Content-Type") ?? "", body: data)
    } catch let error as URLError where error.code == .timedOut {
        return .done(.error("timed out after \(formatSeconds(timeout))s"))
    } catch {
        return .fallback(error.localizedDescription)
    }
}
#endif

// MARK: - Processes

struct ProcessResult {
    var status: Int32
    var stdout: Data
    var stderr: Data
    var timedOut: Bool
}

/// Runs a command found on PATH on its own thread (these block for the whole lookup, and parking
/// them on the shared dispatch pool, sized to the CPU count, would serialize lookups).
func runProcess(_ args: [String], timeout: Double, env extra: [String: String] = [:]) async -> ProcessResult {
    await withCheckedContinuation { cont in
        Thread { cont.resume(returning: runProcessSync(args, timeout: timeout, env: extra)) }.start()
    }
}

private func runProcessSync(_ args: [String], timeout: Double, env extra: [String: String]) -> ProcessResult {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    proc.arguments = args
    proc.environment = ProcessInfo.processInfo.environment.merging(extra) { $1 }
    let out = Pipe(), err = Pipe()
    proc.standardOutput = out
    proc.standardError = err
    proc.standardInput = FileHandle.nullDevice
    do { try proc.run() } catch {
        return ProcessResult(status: 127, stdout: Data(), stderr: Data("\(error)".utf8), timedOut: false)
    }
    var timedOut = false
    let killer = DispatchWorkItem { timedOut = true; proc.terminate() }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
    // Drain both pipes concurrently so a chatty stderr can't block the process.
    var errData = Data()
    let errDone = DispatchSemaphore(value: 0)
    Thread { errData = err.fileHandleForReading.readDataToEndOfFile(); errDone.signal() }.start()
    let outData = out.fileHandleForReading.readDataToEndOfFile()
    errDone.wait()
    proc.waitUntilExit()
    killer.cancel()
    return ProcessResult(status: proc.terminationStatus, stdout: outData, stderr: errData, timedOut: timedOut)
}

// MARK: - git ls-remote

private func summarizeGitError(_ stderr: String, _ code: Int32) -> String {
    let s = stderr.lowercased()
    if s.contains("could not read username") || s.contains("authentication") || s.contains("terminal prompts disabled") {
        return "auth required or repo not found"
    }
    if s.contains("not found") || s.contains("does not appear to be a git repository") { return "repository not found" }
    if s.contains("could not resolve host") { return "network unreachable" }
    var line = stderr.split(separator: "\n").last.map(String.init) ?? ""
    line = line.trimmingCharacters(in: .whitespaces)
    if line.hasPrefix("fatal:") { line = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
    return line.isEmpty ? "git exited with \(code)" : line
}

/// Runs `git ls-remote --tags --refs` without ever prompting, killing it after `timeout` seconds.
func gitLsRemote(_ url: String, timeout: Double) async -> TagResult {
    var env = ["GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"]
    // Never block on SSH passphrase/host-key prompts.
    if ProcessInfo.processInfo.environment["GIT_SSH_COMMAND"] == nil { env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes" }
    let r = await runProcess(["git", "ls-remote", "--tags", "--refs", url], timeout: timeout, env: env)
    if r.timedOut { return .error("timed out after \(formatSeconds(timeout))s") }
    if r.status == 127, r.stdout.isEmpty { return .error("can't run git") }
    if r.status != 0 { return .error(summarizeGitError(String(decoding: r.stderr, as: UTF8.self), r.status)) }
    return .versions(parseLsRemote(String(decoding: r.stdout, as: UTF8.self)))
}

// MARK: - Fetchers

public protocol TagFetcher: Sendable {
    func fetch(_ url: String) async -> TagResult
}

/// HTTP(S) URLs use a direct `ls-refs` request; everything else, and any HTTP failure, uses `git ls-remote`.
public struct LiveTagFetcher: TagFetcher {
    let timeout: Double
    let gitOnly: Bool

    public init(timeout: Double) {
        self.timeout = timeout
        gitOnly = ProcessInfo.processInfo.environment["SPM_UPDATE_GIT_ONLY"].map { !$0.isEmpty } ?? false
    }

    public func fetch(_ url: String) async -> TagResult {
        let lower = url.lowercased()
        if !gitOnly, lower.hasPrefix("https://") || lower.hasPrefix("http://") {
            if case let .done(result) = await httpLsRefs(url, timeout: timeout) { return result }
        }
        return await gitLsRemote(url, timeout: timeout)
    }
}

public func cacheDir() -> String {
    let env = ProcessInfo.processInfo.environment
    if let dir = env["SPM_UPDATE_CACHE_DIR"] { return dir }
    let base = env["XDG_CACHE_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? Path.join(NSHomeDirectory(), ".cache")
    return Path.join(base, "spm-update")
}

/// Failures that won't change in the next few minutes; timeouts and network errors are retried.
private let stableErrors: Set<String> = ["repository not found", "auth required or repo not found"]

/// Wraps a fetcher with a small on-disk cache so check → apply loops hit the network once.
public final class CachedTagFetcher: TagFetcher, @unchecked Sendable {
    private let inner: TagFetcher
    private let ttl: Double
    private let file: String
    private let now = Date().timeIntervalSince1970 * 1000
    private let lock = NSLock()
    private var cache: [String: [String: Any]] = [:]
    private var dirty = false

    public init(_ inner: TagFetcher, ttlSeconds: Double) {
        self.inner = inner
        ttl = ttlSeconds
        file = Path.join(cacheDir(), "tags.json")
        if let data = FileManager.default.contents(atPath: file),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] {
            cache = json
        }
    }

    private func hit(_ url: String) -> TagResult? {
        lock.lock(); defer { lock.unlock() }
        guard let e = cache[url], let t = (e["t"] as? NSNumber)?.doubleValue, now - t < ttl * 1000 else { return nil }
        if let v = e["v"] as? [String] { return .versions(v.compactMap { SemVer(strict: $0) }) }
        return .error(e["e"] as? String ?? "error")
    }

    private func store(_ url: String, _ entry: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        cache[url] = entry
        dirty = true
    }

    public func fetch(_ url: String) async -> TagResult {
        if let cached = hit(url) { return cached }
        let res = await inner.fetch(url)
        let t = Date().timeIntervalSince1970 * 1000
        switch res {
        case let .versions(v): store(url, ["t": t, "v": v.map(\.description)])
        case let .error(e) where stableErrors.contains(e): store(url, ["t": t, "e": e])
        case .error: break
        }
        return res
    }

    /// Writes the cache (best-effort), dropping entries older than a day.
    public func flush() {
        lock.lock(); defer { lock.unlock() }
        guard dirty else { return }
        cache = cache.filter { (($0.value["t"] as? NSNumber)?.doubleValue ?? 0) > now - 86_400_000 }
        guard let data = try? JSONSerialization.data(withJSONObject: cache) else { return }
        try? FileManager.default.createDirectory(atPath: cacheDir(), withIntermediateDirectories: true)
        let tmp = "\(file).\(ProcessInfo.processInfo.processIdentifier)"
        if FileManager.default.createFile(atPath: tmp, contents: data) {
            _ = rename(tmp, file)
        }
    }
}

private actor WorkQueue {
    private var next = 0
    private var done = 0
    let items: [String]
    init(_ items: [String]) { self.items = items }
    func take() -> String? {
        guard next < items.count else { return nil }
        defer { next += 1 }
        return items[next]
    }
    func finish() -> Int { done += 1; return done }
}

/// Fetches tags for many URLs with bounded concurrency.
public func fetchAll(_ urls: [String], fetcher: TagFetcher, concurrency: Int,
                     progress: (@Sendable (Int, Int) -> Void)? = nil) async -> [String: TagResult] {
    var seen = Set<String>()
    let unique = urls.filter { seen.insert($0).inserted }
    let queue = WorkQueue(unique)
    return await withTaskGroup(of: [(String, TagResult)].self) { group in
        for _ in 0..<min(concurrency, unique.count) {
            group.addTask {
                var results: [(String, TagResult)] = []
                while let url = await queue.take() {
                    results.append((url, await fetcher.fetch(url)))
                    let done = await queue.finish()
                    progress?(done, unique.count)
                }
                return results
            }
        }
        var all: [String: TagResult] = [:]
        for await batch in group { for (url, r) in batch { all[url] = r } }
        return all
    }
}

// MARK: - Analysis

public func analyze(_ dep: Dependency, pin: Pin?, tags: TagResult?, includePrerelease: Bool = false) -> Analysis {
    var a = Analysis()
    if dep.source == .local { a.status = .local; return a }
    if dep.source == .registry { a.status = .registry; a.err = "registry packages are not supported"; return a }
    let resolved = pin?.version.flatMap(parseVersion)
    a.resolved = resolved?.description
    guard let tags else { a.status = .error; a.err = "not fetched"; return a }
    guard case let .versions(all) = tags else {
        if case let .error(e) = tags { a.err = e }
        a.status = .error
        return a
    }
    a.all = all

    let pinned: Bool
    switch dep.req { case .branch, .revision: pinned = true; default: pinned = false }
    // A resolved version outside the requirement means Package.resolved is stale; use the floor then.
    let floor = requirementFloor(dep.req)
    // A requirement still on a prerelease (`from: "5.0.0-beta"`) whose release is out is compared from
    // that floor, even if Package.resolved already picked the release up, so the move off beta/rc is flagged.
    let floorAwaitsRelease = floor.map { f in f.isPrerelease && all.contains { !$0.isPrerelease && $0 >= f.release } } ?? false
    let baseline: SemVer? = pinned ? nil
        : (!floorAwaitsRelease && resolved.map { satisfies(dep.req, $0) } == true) ? resolved : floor
    // Prereleases are opt-in, except that a prerelease baseline (`from: "5.0.0-beta"`) already
    // opts into later prereleases of that same version, as SwiftPM does.
    let candidates = all.filter { v in
        if includePrerelease || !v.isPrerelease { return true }
        guard let b = baseline, b.isPrerelease else { return false }
        return v.major == b.major && v.minor == b.minor && v.patch == b.patch
    }
    let latest = candidates.first
    a.latest = latest?.description

    guard let b = baseline else {
        a.status = pinned ? .pinned : .error
        if !pinned { a.err = "requirement uses a variable or unsupported syntax" }
        return a
    }
    let newer = candidates.filter { $0 > b } // newest first
    let patch = newer.first { $0.major == b.major && $0.minor == b.minor }
    let sameMajor = newer.first { $0.major == b.major }
    let minor = sameMajor.flatMap { $0.minor > b.minor ? $0 : nil }
    let major = latest.flatMap { $0.major > b.major ? $0 : nil }
    a.update = major != nil ? .major : minor != nil ? .minor : patch != nil ? .patch : .none
    a.status = a.update == .none ? .upToDate : .outdated
    a.baseline = b.description
    a.patch = patch?.description
    a.minor = minor?.description
    a.major = major?.description
    a.inRange = sameMajor.map { satisfies(dep.req, $0) }
    a.newer = newer.map(\.description)
    return a
}

/// The version a `patch` / `minor` / `major` (= `latest`) target points to, relative to the baseline.
public func targetVersion(_ a: Analysis, _ level: Level) -> String? {
    switch level {
    case .patch: return a.patch
    case .minor: return a.minor ?? a.patch
    case .major: return a.major ?? a.minor ?? a.patch
    }
}
