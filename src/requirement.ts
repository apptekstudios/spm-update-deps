import semver from "semver";
import type { Requirement, VersionKind } from "./types.ts";

/** Compact, unambiguous text form: `^1.2.3`, `~1.2.3`, `=1.2.3`, `>=1.0.0 <2.0.0`, `branch:main`, `rev:abc123`. */
export function formatRequirement(req: Requirement): string {
  switch (req.kind) {
    case "upToNextMajor":
      return `^${req.version}`;
    case "upToNextMinor":
      return `~${req.version}`;
    case "exact":
      return `=${req.version}`;
    case "range":
      return `>=${req.lower} ${req.closed ? "<=" : "<"}${req.upper}`;
    case "branch":
      return `branch:${req.ref}`;
    case "revision":
      return `rev:${req.ref.slice(0, 12)}`;
    case "unknown":
      return req.raw.replace(/\s+/g, " ");
  }
}

/** Normalizes a version string the way SwiftPM reads tags (`v` prefix, `1.2` → `1.2.0`). */
export function normalizeVersion(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith("v") || s.startsWith("V")) s = s.slice(1);
  if (/^\d+\.\d+$/.test(s)) s = `${s}.0`;
  return semver.valid(s);
}

/** The version a requirement starts from, if any. */
export function requirementFloor(req: Requirement): string | null {
  switch (req.kind) {
    case "upToNextMajor":
    case "upToNextMinor":
    case "exact":
      return normalizeVersion(req.version);
    case "range":
      return normalizeVersion(req.lower);
    default:
      return null;
  }
}

export function satisfies(req: Requirement, version: string): boolean {
  const v = semver.parse(version);
  if (!v) return false;
  switch (req.kind) {
    case "upToNextMajor": {
      const min = normalizeVersion(req.version);
      return !!min && semver.gte(v, min) && v.major === semver.major(min);
    }
    case "upToNextMinor": {
      const min = normalizeVersion(req.version);
      return (
        !!min && semver.gte(v, min) && v.major === semver.major(min) && v.minor === semver.minor(min)
      );
    }
    case "exact": {
      const exact = normalizeVersion(req.version);
      return !!exact && semver.eq(v, exact);
    }
    case "range": {
      const lo = normalizeVersion(req.lower);
      const hi = normalizeVersion(req.upper);
      if (!lo || !hi) return false;
      return semver.gte(v, lo) && (req.closed ? semver.lte(v, hi) : semver.lt(v, hi));
    }
    default:
      return false;
  }
}

/**
 * Builds the requirement that moves `current` to `version`.
 * Keeps the existing kind unless `kind` is given; branch/revision pins become `^version`.
 */
export function bumpRequirement(current: Requirement, version: string, kind?: VersionKind): Requirement {
  if (kind) return { kind, version };
  switch (current.kind) {
    case "upToNextMajor":
    case "upToNextMinor":
    case "exact":
      return { kind: current.kind, version };
    case "range": {
      const hi = normalizeVersion(current.upper);
      const fits = hi && (current.closed ? semver.lte(version, hi) : semver.lt(version, hi));
      if (fits) return { ...current, lower: version };
      return { kind: "range", lower: version, upper: `${semver.major(version) + 1}.0.0`, closed: false };
    }
    default:
      return { kind: "upToNextMajor", version };
  }
}

export function sameRequirement(a: Requirement, b: Requirement): boolean {
  return formatRequirement(a) === formatRequirement(b);
}
