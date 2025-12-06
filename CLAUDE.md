# SPM Update Script

A CLI tool for viewing and updating Swift Package Manager dependencies in Xcode projects (`.xcodeproj/project.pbxproj`) and `Package.swift` files.

## Project Structure

```
src/cli.ts    # Main CLI entry point with all logic
dist/         # Compiled standalone binary
```

## Commands

```bash
# Install dependencies
bun install

# Run in development
bun run src/cli.ts [path]

# Build standalone executable
bun run build

# Run built binary
./dist/spm-update [path] [update]
```

## Usage

- Without `update` flag: Lists all SPM dependencies and their latest versions
- With `update` flag: Updates all dependencies to latest versions using `^` (upToNextMajor) version requirement

## Key Behaviors

- Parses both `.xcodeproj/project.pbxproj` files (using `@bacons/xcode`) and `Package.swift` files (regex parsing)
- Fetches latest versions from git tags via `git ls-remote`
- Excludes prerelease versions when determining latest
- Uses semver for version comparison

## Development

Use Bun for all runtime operations:
- `bun <file>` instead of `node`
- `bun test` for tests
- `bun install` for dependencies
- `bun run <script>` for npm scripts
- Bun automatically loads `.env` files

## Dependencies

- `@bacons/xcode` - Xcode project parsing/serialization
- `semver` - Semantic version parsing and comparison
