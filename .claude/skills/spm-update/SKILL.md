---
name: spm-update
description: Find outdated Swift Package Manager dependencies in Package.swift or .xcodeproj files and apply chosen version bumps in bulk. Use when asked to check, audit or update SPM/Swift package versions.
---

# spm-update

`spm-update` (or `bun run src/cli.ts` in this repo) reads `Package.swift` and `*.xcodeproj`
and compares each dependency's version to its git tags.

## Workflow
1. **Find what's outdated** (TSV uses the fewest tokens):
   `spm-update check <path> --tsv --outdated`
   ```
   #0 Package.swift
   m  pkg        req     resolved patch minor  major  status
   0  Alamofire  ^5.8.0  5.9.1    -     5.10.2 -      minor
   0  Kingfisher ~7.0.0  -        7.0.4 7.12.0 8.1.0  major
   ```
   - `m` is the manifest index from the `#` line. `req` is the requirement: `^` upToNextMajor,
     `~` upToNextMinor, `=` exact, `>=a <b` range, `branch:x`, `rev:x`.
   - `patch`/`minor`/`major` are the newest version at each step above the resolved
     version (or the requirement's floor). `-` means there is nothing newer.
   - `status`: `major|minor|patch` (the largest step available), `ok`, `pinned` (branch or
     revision; `major` then shows the newest release), `local`, or `error: <why>`.
   - Add `--urls` for repository URLs. Release notes for GitHub repos are at `<url>/releases`.
     Read them only for `major` bumps.
   - Use `--json` for structured output. Its fields: `inRange` = already allowed by `req`
     (a re-resolve is enough); `versions` (with `--versions`) = newer tags.
2. **Decide** per package: `patch` and `minor` are normally safe. A `major` needs a look at
   the changelog and at the call sites.
3. **Preview**, then **apply** in one call:
   `spm-update apply <path> Alamofire@minor Kingfisher@8.1.0 --dry-run`
   then the same command without `--dry-run`.
   - Targets: `latest|major|minor|patch|<version>`. Prefix `^`/`~`/`=` to change the
     requirement kind (`Foo@=1.2.3`). The existing kind is kept otherwise.
   - Branch/revision pins need an explicit version (`Foo@1.2.3`).
   - Many decisions: `--plan plan.json` or `--plan -` reading stdin, as
     `{"decisions":[{"package":"Foo","target":"minor","requirement":"exact"}]}`.
   - `--manifest <path>` limits the change to one manifest.
4. **Bulk alternative:** `spm-update update <path> --level minor` takes every non-breaking
   step and lists the majors it held back.
5. **Re-resolve** with the command printed as `next:` (`swift package resolve` or
   `xcodebuild -resolvePackageDependencies`), then build and test.

## Guarantees
- An apply is all-or-nothing: any bad decision (unknown package, missing tag, downgrade)
  means exit 1 and no files are written. Each error is one line and says how to fix it.
- Only the requirement text changes. Formatting, comments, and other arguments are
  preserved. `Package.resolved` is never edited.
- Non-TTY output has no colors and no prompts. Version lookups are cached for 10 minutes
  (`--no-cache` to bypass).
- Exit codes: 0 ok, 1 error, 2 outdated (only with `--fail-on-outdated`).
