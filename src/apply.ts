import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import semver from "semver";
import type { CheckedDep, Level, Manifest, Requirement, VersionKind } from "./types.ts";
import { bumpRequirement, formatRequirement, normalizeVersion, requirementFloor, sameRequirement } from "./requirement.ts";
import { canonicalUrl } from "./identity.ts";
import { targetVersion } from "./versions.ts";
import { editPackageSwift, type PackageSwiftHandle } from "./packageSwift.ts";
import { editXcodeProject, type XcodeHandle } from "./xcode.ts";
import { UsageError } from "./discovery.ts";

export interface Decision {
  /** Package name, identity or URL. */
  selector: string;
  /** `latest` | `major` | `minor` | `patch` | explicit version. */
  target: string;
  kind?: VersionKind;
  /** Optional manifest filter (label or basename). */
  manifest?: string;
}

export interface Change {
  c: CheckedDep;
  m: number;
  name: string;
  from: Requirement;
  to: Requirement;
}

export interface Skip {
  m: number;
  name: string;
  reason: string;
}

export interface Plan {
  changes: Change[];
  skipped: Skip[];
  errors: string[];
}

const KIND_PREFIX: Record<string, VersionKind> = { "^": "upToNextMajor", "~": "upToNextMinor", "=": "exact" };
const KIND_NAMES: Record<string, VersionKind> = {
  ...KIND_PREFIX,
  upToNextMajor: "upToNextMajor",
  upToNextMinor: "upToNextMinor",
  exact: "exact",
};

export function parseKind(s: string | undefined): VersionKind | undefined {
  if (s === undefined) return undefined;
  const k = KIND_NAMES[s];
  if (!k) throw new UsageError(`invalid requirement kind '${s}' (use upToNextMajor|upToNextMinor|exact or ^|~|=)`);
  return k;
}

/** Parses `Name@target`, where target may carry a `^`/`~`/`=` prefix. */
export function parseDecisionArg(arg: string): Decision {
  const at = arg.lastIndexOf("@");
  if (at <= 0 || at === arg.length - 1) {
    throw new UsageError(`invalid decision '${arg}' (expected <package>@<latest|major|minor|patch|version>)`);
  }
  const selector = arg.slice(0, at);
  let target = arg.slice(at + 1);
  let kind: VersionKind | undefined;
  const prefix = KIND_PREFIX[target[0]!];
  if (prefix) {
    kind = prefix;
    target = target.slice(1);
  }
  return { selector, target, kind };
}

/** Accepts `{"decisions":[...]}` or a bare array of `{package, target, requirement?, manifest?}`. */
export function parsePlanFile(text: string): Decision[] {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`plan is not valid JSON: ${(e as Error).message}`);
  }
  const list = Array.isArray(json) ? json : json?.decisions;
  if (!Array.isArray(list)) throw new UsageError(`plan must be an array or {"decisions":[...]}`);
  return list.map((d: any, i: number) => {
    const selector = d?.package ?? d?.name;
    if (typeof selector !== "string" || typeof d?.target !== "string") {
      throw new UsageError(`plan entry ${i}: needs string "package" and "target"`);
    }
    const parsed = parseDecisionArg(`${selector}@${d.target}`);
    return { ...parsed, kind: parseKind(d.requirement) ?? parsed.kind, manifest: d.manifest };
  });
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

export function suggest(input: string, names: string[]): string | undefined {
  const lower = input.toLowerCase();
  let best: { name: string; d: number } | undefined;
  for (const n of new Set(names)) {
    const d = levenshtein(lower, n.toLowerCase());
    if (!best || d < best.d) best = { name: n, d };
  }
  return best && best.d <= Math.max(2, Math.floor(input.length / 3)) ? best.name : undefined;
}

function matches(c: CheckedDep, d: Decision, manifests: Manifest[]): boolean {
  const sel = d.selector.toLowerCase();
  const hit =
    c.dep.identity === sel ||
    c.dep.name.toLowerCase() === sel ||
    (!!c.dep.url && canonicalUrl(c.dep.url) === canonicalUrl(d.selector));
  if (!hit) return false;
  if (!d.manifest) return true;
  const m = manifests[c.m]!;
  const want = resolve(d.manifest);
  return (
    m.label === d.manifest ||
    basename(m.label) === d.manifest ||
    want === m.path ||
    (m.type === "xcodeproj" && want === dirname(m.path))
  );
}

const LEVELS = new Set(["latest", "major", "minor", "patch"]);

/** Resolves one decision against one dependency. */
function resolveOne(c: CheckedDep, d: Decision, force: boolean): Change | Skip | string {
  const { dep, a, m } = c;
  const name = dep.name;
  if (dep.source !== "remote") return `${name}: ${dep.source} packages can't be updated`;
  if (dep.req.kind === "unknown") return `${name}: unsupported requirement '${formatRequirement(dep.req)}'`;

  let version: string | undefined;
  const target = d.target.toLowerCase();
  if (LEVELS.has(target)) {
    if (a.status === "error") return `${name}: can't resolve '${d.target}': ${a.err}`;
    if (a.status === "pinned") {
      return `${name}: pinned to ${formatRequirement(dep.req)}; give an explicit version, e.g. ${name}@${a.latest ?? "1.0.0"}`;
    }
    const level: Level = target === "latest" ? "major" : (target as Level);
    version = targetVersion(a, level) ?? a.baseline;
  } else {
    version = normalizeVersion(d.target) ?? undefined;
    if (!version) return `${name}: invalid version '${d.target}'`;
    if (!force) {
      if (a.status === "error") return `${name}: can't verify ${version} exists (${a.err}); pass --force to write anyway`;
      if (!a.all.includes(version)) {
        return `${name}: no tag ${version}${a.latest ? ` (newest: ${a.latest})` : ""}; pass --force to write anyway`;
      }
      const floor = requirementFloor(dep.req);
      if (floor && semver.lt(version, floor)) {
        return `${name}: ${version} is a downgrade from ${formatRequirement(dep.req)}; pass --force to allow`;
      }
    }
  }
  if (!version) return { m, name, reason: "no version available" };
  const to = bumpRequirement(dep.req, version, d.kind);
  if (sameRequirement(dep.req, to)) return { m, name, reason: "unchanged" };
  return { c, m, name, from: dep.req, to };
}

export function planDecisions(checked: CheckedDep[], manifests: Manifest[], decisions: Decision[], force: boolean): Plan {
  const plan: Plan = { changes: [], skipped: [], errors: [] };
  const claimed = new Map<CheckedDep, Decision>();
  for (const d of decisions) {
    const hits = checked.filter((c) => matches(c, d, manifests));
    if (hits.length === 0) {
      const elsewhere = d.manifest ? checked.filter((c) => matches(c, { ...d, manifest: undefined }, manifests)) : [];
      if (elsewhere.length > 0) {
        const where = [...new Set(elsewhere.map((c) => manifests[c.m]!.label))].join(", ");
        plan.errors.push(`'${d.selector}' is not in ${d.manifest} (found in ${where})`);
        continue;
      }
      const hint = suggest(d.selector, checked.map((c) => c.dep.name));
      plan.errors.push(`unknown package '${d.selector}'${d.manifest ? ` in ${d.manifest}` : ""}${hint ? ` (did you mean ${hint}?)` : ""}`);
      continue;
    }
    for (const c of hits) {
      const prev = claimed.get(c);
      if (prev) {
        plan.errors.push(`${c.dep.name}: conflicting decisions '${prev.target}' and '${d.target}'`);
        continue;
      }
      claimed.set(c, d);
      const r = resolveOne(c, d, force);
      if (typeof r === "string") plan.errors.push(r);
      else if ("to" in r) plan.changes.push(r);
      else plan.skipped.push(r);
    }
  }
  return plan;
}

/** Plans a bulk update of every remote dependency to the newest version allowed by `level`. */
export function planBulk(
  checked: CheckedDep[],
  level: Level,
  only: Set<string>,
  skip: Set<string>,
): Plan {
  const plan: Plan = { changes: [], skipped: [], errors: [] };
  const sel = (c: CheckedDep, set: Set<string>) => set.has(c.dep.identity) || set.has(c.dep.name.toLowerCase());
  for (const c of checked) {
    const { dep, a, m } = c;
    if (dep.source !== "remote") continue;
    if (only.size > 0 && !sel(c, only)) continue;
    if (sel(c, skip)) {
      plan.skipped.push({ m, name: dep.name, reason: "--skip" });
      continue;
    }
    if (a.status === "pinned") {
      plan.skipped.push({ m, name: dep.name, reason: `pinned ${formatRequirement(dep.req)}` });
      continue;
    }
    if (a.status === "error") {
      plan.skipped.push({ m, name: dep.name, reason: a.err ?? "error" });
      continue;
    }
    if (dep.req.kind === "unknown") {
      plan.skipped.push({ m, name: dep.name, reason: `unsupported requirement '${formatRequirement(dep.req)}'` });
      continue;
    }
    const version = targetVersion(a, level) ?? a.baseline;
    if (!version) continue;
    const to = bumpRequirement(dep.req, version);
    if (!sameRequirement(dep.req, to)) {
      plan.changes.push({ c, m, name: dep.name, from: dep.req, to });
    } else if (level !== "major" && a.major) {
      plan.skipped.push({ m, name: dep.name, reason: `major ${a.major} available (use ${dep.name}@major)` });
    }
  }
  return plan;
}

/** Writes all changes. Every manifest is edited in memory first so a failure writes nothing. */
export function writeChanges(plan: Plan, manifests: Manifest[]): void {
  const byManifest = new Map<number, { c: CheckedDep; change: Change }[]>();
  for (const change of plan.changes) {
    const list = byManifest.get(change.m) ?? [];
    list.push({ c: change.c, change });
    byManifest.set(change.m, list);
  }
  const outputs: { path: string; text: string }[] = [];
  for (const [mi, items] of byManifest) {
    const man = manifests[mi]!;
    const text = readFileSync(man.path, "utf8");
    const next =
      man.type === "package"
        ? editPackageSwift(
            text,
            items.map(({ c, change }) => ({ handle: c.dep.handle as PackageSwiftHandle, prev: change.from, next: change.to })),
          )
        : editXcodeProject(
            text,
            items.map(({ c, change }) => ({ handle: c.dep.handle as XcodeHandle, name: change.name, next: change.to })),
          );
    outputs.push({ path: man.path, text: next });
  }
  for (const o of outputs) writeFileSync(o.path, o.text, "utf8");
}

/** The command that refreshes Package.resolved for the manifests that changed. */
export function resolveHint(plan: Plan, manifests: Manifest[]): string | undefined {
  const types = new Set(plan.changes.map((c) => manifests[c.m]!.type));
  const hints: string[] = [];
  if (types.has("package")) hints.push("swift package resolve");
  if (types.has("xcodeproj")) hints.push("xcodebuild -resolvePackageDependencies");
  return hints.length ? hints.join(" && ") : undefined;
}
