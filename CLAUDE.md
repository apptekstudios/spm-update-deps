# SPM Update Script

A CLI tool for viewing and updating Swift Package Manager dependencies in Xcode projects (`.xcodeproj/project.pbxproj`) and `Package.swift` files. It is designed for both humans (tables, interactive mode) and agents (TSV/JSON output, bulk decisions).

## Project Structure

```
src/cli.ts           # Arg parsing, command dispatch (check/apply/update/interactive), help
src/types.ts         # Shared types (Requirement, Dependency, Manifest, Analysis)
src/requirement.ts   # Requirement formatting, satisfies(), bumpRequirement()
src/packageSwift.ts  # Package.swift scanner (comment/string aware) + span-based editor
src/xcode.ts         # pbxproj read (@bacons/xcode parse) + surgical requirement-block edits
src/resolved.ts      # Package.resolved (v1/v2/v3) lookup and parsing
src/discovery.ts     # Finds manifests; UsageError
src/versions.ts      # git ls-remote fetching, cache, patch/minor/major analysis
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
- Latest versions come from git tags via `git ls-remote`, which runs with `GIT_TERMINAL_PROMPT=0`, a timeout and a 10-minute cache (`SPM_UPDATE_CACHE_DIR` overrides the location). Prerelease versions are excluded unless `--include-prerelease` is given.
- Non-TTY output never contains ANSI codes or prompts. Keep agent-facing output terse: it is optimized for token efficiency.

## Development

Use Bun for all runtime operations:
- `bun <file>` instead of `node`
- `bun test` for tests
- `bun install` for dependencies
- `bun run <script>` for npm scripts

## Dependencies

- `@bacons/xcode` - pbxproj parsing (and fallback serialization)
- `semver` - Semantic version parsing and comparison
- `@clack/prompts` - Interactive mode prompts
