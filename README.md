# spm-update

Check and update Swift Package Manager dependencies in `Package.swift` manifests and Xcode
projects (`.xcodeproj`). It works well for people at a terminal and for coding agents.

## Features

- **Package.swift and Xcode projects:** finds every manifest in a folder, or in subfolders with `--recursive`.
- **Patch, minor and major steps:** every package lists the newest patch, minor and major version available. The non-breaking and breaking options are visible side by side.
- **Resolved versions:** reads `Package.resolved`, so "outdated" is measured against the version you actually build with.
- **Per-package decisions in one command:** `spm-update apply Alamofire@minor Kingfisher@8.1.0`, or a JSON plan file. Every decision is validated first, so a bad one means nothing is written.
- **Minimal edits:** only the requirement text changes. Your formatting, comments, extra arguments such as `traits:`, and the requirement style (`from:` vs `.upToNextMajor(from:)`) are kept. Xcode projects get a few-line diff, not a re-serialized file.
- **Requirement kinds are preserved:** an exact pin stays exact, a range stays a range, and branch/revision pins are never changed without an explicit version.
- **Output formats:** a colored table and interactive mode for people; compact TSV and JSON for agents and scripts.
- **Robust lookups:** git lookups run in parallel with a timeout, never hang on credential prompts, and are cached for 10 minutes.

## Installation

Requires [Bun](https://bun.sh) to build and `git` at runtime.

```bash
bun install
bun run build                           # creates ./dist/spm-update
mv ./dist/spm-update /usr/local/bin/    # optional
```

Or run it from source: `bun run src/cli.ts [command] [path] [options]`.

## Usage

### Check

```bash
spm-update                    # current directory
spm-update path/to/project
spm-update -r .               # also search subfolders
```

```
Package.swift
──────────────────────────────────────────────────────────────────────────────────────
 Package               │ Requirement │ Resolved │ Patch │ Minor  │ Major  │ Status
──────────────────────────────────────────────────────────────────────────────────────
 Alamofire             │ ^5.0.0      │ 5.8.1    │ —     │ 5.12.2 │ —      │ minor update
 Kingfisher            │ ~7.0.0      │ —        │ —     │ 7.12.0 │ 8.13.0 │ major update
 swift-log             │ ^1.4.0      │ —        │ 1.4.4 │ 1.16.1 │ —      │ minor update
 swift-argument-parser │ branch:main │ —        │ —     │ —      │ —      │ pinned (latest 1.8.2)
──────────────────────────────────────────────────────────────────────────────────────

3 outdated (1 major, 2 minor)
1 pinned to a branch/revision

Next steps:
  spm-update update --level minor    # apply non-breaking updates
  spm-update apply Kingfisher@major  # apply breaking updates
  spm-update -i                      # choose interactively
```

- **Requirement**: what the manifest allows. `^` is upToNextMajor, `~` upToNextMinor and `=` exact; ranges show as `>=a <b`, and pins as `branch:x` or `rev:x`.
- **Resolved**: the version locked in `Package.resolved`, if there is one.
- **Patch / Minor / Major**: the newest version at each step above the resolved version (or above the requirement's lower bound).

Options: `--outdated` (only the rows that need attention), `--versions[=N]` (list newer versions), `--urls`, `--include-prerelease`, `--fail-on-outdated` (exit 2, for CI).

### Interactive

```bash
spm-update -i
```

Steps through each outdated package and lets you pick Patch, Minor, Major or Skip. It shows the planned changes and asks before writing.

### Apply decisions

```bash
spm-update apply Alamofire@minor Kingfisher@major swift-log@1.6.0
spm-update apply Kingfisher@=8.1.0          # ^ ~ = prefix changes the requirement kind
spm-update apply swift-argument-parser@1.5.0  # replace a branch pin with ^1.5.0
spm-update apply --plan decisions.json --dry-run
```

| Target | Meaning |
|--------|---------|
| `patch` | newest version in the current minor (`1.2.x`) |
| `minor` | newest version in the current major (`1.x`) |
| `major`, `latest` | newest version overall |
| `1.4.2` | that exact tag (`--force` allows untagged versions and downgrades) |

Packages are matched by name, by identity (case-insensitive) or by repository URL. A decision applies to every manifest that contains the package, unless you pass `--manifest <path>`.

The plan file format (also read from stdin with `--plan -`):

```json
{ "decisions": [
    { "package": "Alamofire", "target": "minor" },
    { "package": "Kingfisher", "target": "8.1.0", "requirement": "exact", "manifest": "App.xcodeproj" }
] }
```

### Bulk update

```bash
spm-update update                  # everything to the latest version (the original behavior)
spm-update update --level minor    # only non-breaking steps; held-back majors are listed
spm-update update --skip SomePackage --only Alamofire,Kingfisher
spm-update . update --skip Foo     # the older argument order still works
```

In a terminal, `apply` and `update` show the changes and ask before writing. Pass `-y` to skip the prompt. Use `--dry-run` to preview without writing. `Package.resolved` is never edited; run the printed `swift package resolve` / `xcodebuild -resolvePackageDependencies` afterwards.

## For agents and scripts

Piped output has no colors, progress output or prompts. Two machine formats are available:

```bash
spm-update check --tsv --outdated     # compact, the cheapest for an LLM to read
spm-update check --json [--pretty]    # structured; empty fields are omitted
export SPM_UPDATE_FORMAT=tsv          # set a default format
```

```
#0 Package.swift
m	pkg	req	resolved	patch	minor	major	status
0	Alamofire	^5.0.0	5.8.1	-	5.12.2	-	minor
0	Kingfisher	~7.0.0	-	-	7.12.0	8.13.0	major
```

A JSON dependency looks like this. The `inRange` field means the current requirement already allows the update, so a re-resolve is enough.

```json
{"m":0,"name":"Alamofire","url":"https://github.com/Alamofire/Alamofire.git","req":"^5.0.0",
 "resolved":"5.8.1","status":"outdated","update":"minor","minor":"5.12.2","inRange":true}
```

`apply`/`update` print only what changed, plus a `next:` line. With `--json` they return `{v, dryRun?, changes:[{m,name,from,to}], skipped?, errors?, next?}`.

| Exit code | Meaning |
|-----------|---------|
| 0 | success |
| 1 | usage or validation error; nothing was written |
| 2 | outdated dependencies found (only with `--fail-on-outdated`) |

[`.claude/skills/spm-update/SKILL.md`](.claude/skills/spm-update/SKILL.md) gives agents the full check → decide → apply recipe.

## Development

```bash
bun install
bun test           # unit and end-to-end tests (e2e uses local git repos, no network)
bun run typecheck
bun run src/cli.ts --help
```

## License

MIT
