export type VersionKind = "upToNextMajor" | "upToNextMinor" | "exact";

export type Requirement =
  | { kind: VersionKind; version: string }
  | { kind: "range"; lower: string; upper: string; closed: boolean }
  | { kind: "branch"; ref: string }
  | { kind: "revision"; ref: string }
  | { kind: "unknown"; raw: string };

export type ManifestType = "package" | "xcodeproj";

/** Where a dependency comes from. Only `remote` dependencies can be checked/updated. */
export type SourceKind = "remote" | "local" | "registry";

export interface Dependency {
  /** Display name (URL basename, or the `name:` argument). */
  name: string;
  /** SPM package identity: lowercased URL basename without `.git`. */
  identity: string;
  source: SourceKind;
  url?: string;
  /** Where to fetch tags from, when it differs from `url` (relative git URLs). */
  fetchUrl?: string;
  req: Requirement;
  /** Opaque locator used by the manifest writer. */
  handle: unknown;
}

export interface Manifest {
  /** Absolute path to `Package.swift` or `project.pbxproj`. */
  path: string;
  /** Path shown to users: the `.xcodeproj` dir or `Package.swift`, relative to root. */
  label: string;
  type: ManifestType;
  resolvedPath?: string;
  deps: Dependency[];
}

export type Status = "up-to-date" | "outdated" | "pinned" | "local" | "registry" | "error";
export type UpdateType = "none" | "patch" | "minor" | "major";
export type Level = "patch" | "minor" | "major";

export interface Analysis {
  status: Status;
  update: UpdateType;
  baseline?: string;
  resolved?: string;
  /** Newest version with the same major.minor as the baseline (if newer). */
  patch?: string;
  /** Newest version with the same major, when its minor is higher than the baseline's. */
  minor?: string;
  /** Newest version overall, when its major is higher than the baseline's. */
  major?: string;
  /** Newest version overall. */
  latest?: string;
  /** The newest non-breaking version already satisfies the current requirement. */
  inRange?: boolean;
  /** Versions newer than the baseline, newest first. */
  newer: string[];
  /** All known versions (for validating explicit targets). */
  all: string[];
  err?: string;
}

export interface CheckedDep {
  m: number;
  dep: Dependency;
  a: Analysis;
}
