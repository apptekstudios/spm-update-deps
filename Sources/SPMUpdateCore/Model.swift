public enum VersionKind: String, Sendable {
    case upToNextMajor, upToNextMinor, exact
}

public enum Requirement: Equatable, Sendable {
    case version(VersionKind, String)
    case range(lower: String, upper: String, closed: Bool)
    case branch(String)
    case revision(String)
    case unknown(String)

    /// Same-shape comparison used to decide whether an edit can keep the author's spelling.
    var kindTag: String {
        switch self {
        case let .version(kind, _): return kind.rawValue
        case .range: return "range"
        case .branch: return "branch"
        case .revision: return "revision"
        case .unknown: return "unknown"
        }
    }
}

public enum ManifestType: String, Sendable {
    case package, xcodeproj
}

/// Where a dependency comes from. Only `remote` dependencies can be checked/updated.
public enum SourceKind: String, Sendable {
    case remote, local, registry
}

/// Locates a requirement inside its manifest so it can be rewritten.
public enum Handle: Equatable, Sendable {
    case none
    /// Byte span of the requirement argument in Package.swift, and how it was spelled.
    case packageSwift(start: Int, end: Int, style: ReqStyle)
    /// Object ID of the XCRemoteSwiftPackageReference in project.pbxproj.
    case xcode(id: String)
}

public struct Dependency: Sendable {
    /// Display name (URL basename, or the `name:` argument).
    public var name: String
    /// SPM package identity: lowercased URL basename without `.git`.
    public var identity: String
    public var source: SourceKind
    public var url: String?
    /// Where to fetch tags from, when it differs from `url` (relative git URLs).
    public var fetchUrl: String?
    public var req: Requirement
    public var handle: Handle
}

public struct Manifest: Sendable {
    /// Absolute path to `Package.swift` or `project.pbxproj`.
    public var path: String
    /// Path shown to users: the `.xcodeproj` dir or `Package.swift`, relative to root.
    public var label: String
    public var type: ManifestType
    public var resolvedPath: String?
    public var deps: [Dependency]
}

public enum Status: String, Sendable {
    case upToDate = "up-to-date", outdated, pinned, local, registry, error
}

public enum UpdateType: String, Sendable {
    case none, patch, minor, major
}

public enum Level: String, Sendable {
    case patch, minor, major
}

public struct Analysis: Sendable {
    public var status: Status = .upToDate
    public var update: UpdateType = .none
    public var baseline: String?
    public var resolved: String?
    /// Newest version with the same major.minor as the baseline (if newer).
    public var patch: String?
    /// Newest version with the same major, when its minor is higher than the baseline's.
    public var minor: String?
    /// Newest version overall, when its major is higher than the baseline's.
    public var major: String?
    /// Newest version overall.
    public var latest: String?
    /// The newest non-breaking version already satisfies the current requirement.
    public var inRange: Bool?
    /// Versions newer than the baseline, newest first.
    public var newer: [String] = []
    /// All known versions, newest first (for validating explicit targets).
    public var all: [SemVer] = []
    public var err: String?
}

public struct CheckedDep: Sendable {
    public var m: Int
    public var dep: Dependency
    public var a: Analysis
}

/// Bad input from the user: printed with a pointer to `--help`, exit code 1.
public struct UsageError: Error, CustomStringConvertible {
    public let description: String
    public init(_ message: String) { description = message }
}

/// Any other failure: printed as `error: <message>`, exit code 1.
public struct ToolError: Error, CustomStringConvertible {
    public let description: String
    public init(_ message: String) { description = message }
}
