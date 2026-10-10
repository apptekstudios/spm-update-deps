import Foundation

/// A semantic version (SemVer 2.0). Build metadata is accepted when parsing but dropped,
/// so `description` is `major.minor.patch[-prerelease]`.
public struct SemVer: Comparable, Hashable, CustomStringConvertible, Sendable {
    public let major: Int
    public let minor: Int
    public let patch: Int
    public let prerelease: [String]

    public init(_ major: Int, _ minor: Int, _ patch: Int, prerelease: [String] = []) {
        self.major = major
        self.minor = minor
        self.patch = patch
        self.prerelease = prerelease
    }

    /// Strict SemVer 2.0 parsing (no leading zeros, no `v` prefix).
    public init?(strict text: String) {
        var s = Substring(text)
        if let plus = s.firstIndex(of: "+") {
            let build = s[s.index(after: plus)...]
            guard !build.isEmpty, build.split(separator: ".", omittingEmptySubsequences: false).allSatisfy(Self.isBuildIdentifier) else { return nil }
            s = s[..<plus]
        }
        var pre: [String] = []
        if let dash = s.firstIndex(of: "-") {
            let ids = s[s.index(after: dash)...].split(separator: ".", omittingEmptySubsequences: false)
            guard !ids.isEmpty, ids.allSatisfy(Self.isPrereleaseIdentifier) else { return nil }
            pre = ids.map(String.init)
            s = s[..<dash]
        }
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, let a = Self.numeric(parts[0]), let b = Self.numeric(parts[1]), let c = Self.numeric(parts[2]) else { return nil }
        self.init(a, b, c, prerelease: pre)
    }

    public var isPrerelease: Bool { !prerelease.isEmpty }

    /// `5.0.0-beta.2` → `5.0.0`.
    public var release: SemVer { SemVer(major, minor, patch) }

    public var description: String {
        let core = "\(major).\(minor).\(patch)"
        return prerelease.isEmpty ? core : core + "-" + prerelease.joined(separator: ".")
    }

    public static func < (a: SemVer, b: SemVer) -> Bool {
        if a.major != b.major { return a.major < b.major }
        if a.minor != b.minor { return a.minor < b.minor }
        if a.patch != b.patch { return a.patch < b.patch }
        switch (a.prerelease.isEmpty, b.prerelease.isEmpty) {
        case (true, true), (true, false): return false
        case (false, true): return true
        case (false, false): break
        }
        for (x, y) in zip(a.prerelease, b.prerelease) where x != y {
            switch (Int(x), Int(y)) {
            case let (i?, j?): return i < j
            case (_?, nil): return true
            case (nil, _?): return false
            case (nil, nil): return x < y
            }
        }
        return a.prerelease.count < b.prerelease.count
    }

    private static func numeric(_ s: Substring) -> Int? {
        guard !s.isEmpty, s.allSatisfy(\.isASCIIDigit), s == "0" || s.first != "0" else { return nil }
        return Int(s)
    }

    private static func isPrereleaseIdentifier(_ s: Substring) -> Bool {
        guard !s.isEmpty, s.allSatisfy({ $0.isASCIIDigit || $0.isASCIILetter || $0 == "-" }) else { return false }
        if s.allSatisfy(\.isASCIIDigit) { return s == "0" || s.first != "0" }
        return true
    }

    private static func isBuildIdentifier(_ s: Substring) -> Bool {
        !s.isEmpty && s.allSatisfy { $0.isASCIIDigit || $0.isASCIILetter || $0 == "-" }
    }
}

extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
    var isASCIILetter: Bool { isASCII && isLetter }
}

/// Normalizes a version string the way SwiftPM reads tags: optional `v` prefix, `1.2` → `1.2.0`,
/// and numeric components read as integers (`26.09.25` → `26.9.25`, used by calendar versioning).
public func normalizeVersion(_ raw: String) -> String? {
    parseVersion(raw)?.description
}

public func parseVersion(_ raw: String) -> SemVer? {
    var s = Substring(raw.trimmingCharacters(in: .whitespaces))
    if s.first == "v" || s.first == "V" { s = s.dropFirst() }
    // Numeric core, then an optional `-prerelease` / `+build` suffix validated strictly.
    var nums: [Int] = []
    var i = s.startIndex
    while nums.count < 3 {
        let start = i
        while i < s.endIndex, s[i].isASCIIDigit { i = s.index(after: i) }
        guard start < i, let n = Int(s[start..<i]) else { return nil }
        nums.append(n)
        if i < s.endIndex, s[i] == ".", nums.count < 3 { i = s.index(after: i); continue }
        break
    }
    guard nums.count >= 2 else { return nil }
    let suffix = s[i...]
    guard suffix.isEmpty || suffix.first == "-" || suffix.first == "+" else { return nil }
    return SemVer(strict: "\(nums[0]).\(nums[1]).\(nums.count > 2 ? nums[2] : 0)\(suffix)")
}
