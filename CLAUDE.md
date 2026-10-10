# SPM Update Script

A CLI tool for viewing and updating Swift Package Manager dependencies in Xcode projects (`.xcodeproj/project.pbxproj`) and `Package.swift` files. It is designed for both humans (tables, interactive mode) and agents (TSV/JSON output, bulk decisions).

## Project Structure

```
Package.swift                                  # no dependencies; library + executable + tests
Sources/spm-update/main.swift                  # entry point
Sources/SPMUpdateCore/CLI.swift                # arg parsing, command dispatch (check/apply/update/interactive), help
Sources/SPMUpdateCore/Model.swift              # shared types (Requirement, Dependency, Manifest, Analysis)
Sources/SPMUpdateCore/SemVer.swift             # SemVer 2.0 + SwiftPM-style tag normalization
Sources/SPMUpdateCore/Requirement.swift        # requirement formatting, satisfies(), bumpRequirement(), identity
Sources/SPMUpdateCore/PackageSwift.swift       # Package.swift scanner (comment/string aware, UTF-8 bytes) + span-based editor
Sources/SPMUpdateCore/Xcode.swift              # pbxproj: scans package-reference objects (no full parse) + surgical block edits
Sources/SPMUpdateCore/Discovery.swift          # finds manifests; Package.resolved (v1/v2/v3)
Sources/SPMUpdateCore/Versions.swift           # tag fetching (git v2 over HTTP, git ls-remote fallback), cache, analysis
Sources/SPMUpdateCore/Apply.swift              # decision parsing, validation (all-or-nothing), writing
Sources/SPMUpdateCore/Output.swift             # table / tsv / json renderers (JSON written by hand: ordered keys)
Sources/SPMUpdateCore/Interactive.swift        # termios prompts for -i and write confirmation
Tests/SPMUpdateCoreTests/                      # XCTest; EndToEndTests runs the binary against local git repos
.claude/skills/spm-update/SKILL.md             # how agents should use the CLI
```

## Commands

```bash
swift build                  # debug build
swift test                   # all tests (unit + end-to-end)
swift run spm-update [path]  # run in development
swift build -c release       # release binary: .build/release/spm-update
```

## Key Behaviors

- `check` (default) shows the newest patch/minor/major versions above the baseline. The baseline is the version in `Package.resolved` when it satisfies the requirement; otherwise it is the requirement's lower bound.
- `apply Pkg@target…` / `--plan` applies per-package decisions; `update --level` bulk-updates. Requirement kinds are preserved. Branch/revision pins change only when given an explicit version.
- Edits replace only the requirement text (Package.swift argument span / pbxproj `requirement = {}` block).
- Tags for http(s) URLs come from one git protocol v2 `ls-refs` request: URLSession on macOS, a `curl` process on Linux (swift-corelibs URLSession runs requests through one queue and was ~2x slower). On any HTTP failure (401 for private repos, old servers), and for ssh/file URLs, the tool falls back to `git ls-remote` with `GIT_TERMINAL_PROMPT=0`, so credential helpers still work. Blocking subprocesses run on dedicated threads, never the CPU-sized dispatch pool. `SPM_UPDATE_GIT_ONLY=1` forces git. Lookups run 16 at a time (`--jobs`) and are cached for 10 minutes, including "not found"/auth failures (`SPM_UPDATE_CACHE_DIR` overrides the location).
- Prerelease versions are excluded unless `--include-prerelease` is given, or the baseline is itself a prerelease (then later prereleases of that version count). A prerelease requirement (`from: "5.0.0-beta"`) whose release is out is always flagged, even if Package.resolved already has the release, so manifests move off beta/rc.
- Size and speed matter: the release binary is ~2 MB with no package dependencies, startup ~10ms, and lookups dominate. Keep it dependency-free; don't parse whole pbxproj files (that cost up to ~1s on large projects).
- Output is byte-for-byte stable (table/tsv/json); agents and scripts parse it. Change it deliberately and update tests.
- Non-TTY output never contains ANSI codes or prompts. Keep agent-facing output terse: it is optimized for token efficiency.

## Development

- Swift 5.9+ tools version, macOS 13+, no external packages. Code must build on macOS and Linux (`#if canImport(...)` where they differ).
- `swift test` before claiming anything works; the end-to-end tests drive the real binary.
