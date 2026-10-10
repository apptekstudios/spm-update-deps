# SPM Update Script

A CLI tool for viewing and updating Swift Package Manager dependencies in Xcode projects (`.xcodeproj/project.pbxproj`) and `Package.swift` files. It is designed for both humans (tables, interactive mode) and agents (TSV/JSON output, bulk decisions).

## Project Structure

```
src/cli.ts           # Arg parsing, command dispatch (check/apply/update/interactive), help
src/types.ts         # Shared types (Requirement, Dependency, Manifest, Analysis)
src/requirement.ts   # Requirement formatting, satisfies(), bumpRequirement()
src/packageSwift.ts  # Package.swift scanner (comment/string aware) + span-based editor
src/xcode.ts         # pbxproj: scans package-reference objects (no full parse) + surgical requirement-block edits
src/resolved.ts      # Package.resolved (v1/v2/v3) lookup and parsing
src/discovery.ts     # Finds manifests; UsageError
src/versions.ts      # tag fetching (git protocol v2 over HTTP, git ls-remote fallback), cache, analysis
src/apply.ts         # Decision parsing, validation (all-or-nothing), writing
src/output.ts        # table / tsv / json renderers
src/interactive.ts   # @clack/prompts flow
test/                # bun tests; e2e.test.ts uses local git repos as remotes
.claude/skills/spm-update/SKILL.md  # How agents should use the CLI
dist/                # Compiled standalone binary
```

## Commands

```bash
bun install                 # Install dependencies
bun run src/cli.ts [path]   # Run in development
bun test                    # Run tests
bun run typecheck           # tsc --noEmit
bun run build               # Build standalone executable
./dist/spm-update --help
```

## Key Behaviors

- `check` (default) shows the newest patch/minor/major versions above the baseline. The baseline is the version in `Package.resolved` when it satisfies the requirement; otherwise it is the requirement's lower bound.
- `apply Pkg@target…` / `--plan` applies per-package decisions; `update --level` bulk-updates. Requirement kinds are preserved. Branch/revision pins change only when given an explicit version.
- Edits replace only the requirement text (Package.swift argument span / pbxproj `requirement = {}` block).
- Tags for http(s) URLs come from one git protocol v2 `ls-refs` request (no `git` process). On any HTTP failure (401 for private repos, old servers), and for ssh/file URLs, the tool falls back to `git ls-remote` with `GIT_TERMINAL_PROMPT=0`, so credential helpers still work. `SPM_UPDATE_GIT_ONLY=1` forces git. Lookups run 16 at a time (`--jobs`) and are cached for 10 minutes, including "not found"/auth failures (`SPM_UPDATE_CACHE_DIR` overrides the location).
- Prerelease versions are excluded unless `--include-prerelease` is given, or the baseline is itself a prerelease (then later prereleases of that version count). A prerelease requirement (`from: "5.0.0-beta"`) whose release is out is always flagged, even if Package.resolved already has the release, so manifests move off beta/rc.
- Performance matters: startup is ~25ms and lookups dominate. Don't add heavy dependencies to the check path (the old pbxproj parser cost ~70ms of startup and up to ~1s per large project).
- Non-TTY output never contains ANSI codes or prompts. Keep agent-facing output terse: it is optimized for token efficiency.

## Development

Use Bun for all runtime operations:
- `bun <file>` instead of `node`
- `bun test` for tests
- `bun install` for dependencies
- `bun run <script>` for npm scripts

## Dependencies

- `semver` - Semantic version parsing and comparison
- `@clack/prompts` - Interactive mode prompts
