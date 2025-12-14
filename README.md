# spm-update

A CLI tool for viewing and updating Swift Package Manager dependencies in Xcode projects and Swift packages.

## Features

- **Dual Format Support**: Works with both `.xcodeproj` files and `Package.swift` manifests
- **Version Discovery**: Fetches latest versions directly from git tags
- **Smart Updates**: Preserves your version requirement type (exact, upToNextMajor, upToNextMinor)
- **Prerelease Filtering**: Automatically excludes prerelease versions
- **Selective Updates**: Skip specific packages with the `--skip` flag
- **Beautiful Output**: Color-coded table showing package status at a glance

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime (for building from source)
- Git (for fetching remote tags)

### From Source

```bash
# Clone the repository
git clone https://github.com/yourusername/spm-update.git
cd spm-update

# Install dependencies
bun install

# Build standalone binary
bun run build

# Optionally, move to your PATH
mv ./dist/spm-update /usr/local/bin/
```

### Using Bun Directly

```bash
bun run src/cli.ts [path] [options]
```

## Usage

### Check for Updates

Run without arguments to see the current state of all dependencies:

```bash
spm-update /path/to/your/project
```

This displays a table showing each package's current version requirement, the latest available version, and its status.

### Update Dependencies

Add the `update` argument to update all packages to their latest versions:

```bash
spm-update /path/to/your/project update
```

### Skip Specific Packages

Use `--skip` or `-s` to exclude packages from updates:

```bash
spm-update /path/to/your/project update --skip SomePackage --skip AnotherPackage
```

### Current Directory

If no path is provided, the current directory is used:

```bash
cd /path/to/your/project
spm-update        # Check for updates
spm-update update # Apply updates
```

## Output Example

```
Xcode Project
────────────────────────────────────────────────────────────────
 Package          │ Current   │ Latest    │ Status
────────────────────────────────────────────────────────────────
 Alamofire        │ ^5.8.0    │ 5.10.2    │ Update Available
 SwiftyJSON       │ ^5.0.1    │ 5.0.2     │ Update Available
 Kingfisher       │ ^7.10.0   │ 7.10.0    │ Up to date
────────────────────────────────────────────────────────────────

2 updates available. Run with update to apply changes.
```

## Supported Version Requirements

The tool recognizes and preserves these SPM version requirement types:

| Type | Syntax | Displayed As |
|------|--------|--------------|
| Up to Next Major | `from: "1.0.0"` or `.upToNextMajor(from:)` | `^1.0.0` |
| Up to Next Minor | `.upToNextMinor(from: "1.0.0")` | `~1.0.0` |
| Exact | `exact: "1.0.0"` or `.exact("1.0.0")` | `exact 1.0.0` |
| Branch | `branch: "main"` | `branch main` |
| Revision | `revision: "abc123"` | `revision abc123` |
| Range | `"1.0.0"..<"2.0.0"` | `>=1.0.0 <2.0.0` |

When updating, the tool maintains your original requirement type—if you're using exact versions, updates will use exact versions; if you're using upToNextMajor, updates will preserve that constraint.

## How It Works

1. **Discovery**: Scans the target directory for `.xcodeproj/project.pbxproj` and `Package.swift` files
2. **Parsing**: Extracts all Swift Package dependencies and their current version requirements
3. **Fetching**: Queries each package's git repository for available tags using `git ls-remote`
4. **Filtering**: Excludes prerelease versions (alpha, beta, rc, etc.) when determining the latest stable version
5. **Comparison**: Uses semantic versioning to compare current requirements against latest versions
6. **Updating**: When requested, modifies the project files in place with updated version requirements

## Development

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev [path] [options]

# Or directly
bun run src/cli.ts [path] [options]

# Build standalone executable
bun run build
```

## Dependencies

- [@bacons/xcode](https://github.com/EvanBacon/xcode) - Xcode project file parsing and serialization
- [semver](https://github.com/npm/node-semver) - Semantic version parsing and comparison

## License

MIT
