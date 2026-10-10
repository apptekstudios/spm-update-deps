import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import type { Analysis, Dependency } from "./types.ts";
import { normalizeVersion, requirementFloor, satisfies } from "./requirement.ts";
import type { Pin } from "./resolved.ts";

export type TagResult = { versions: string[] } | { error: string };
export type TagFetcher = (url: string) => Promise<TagResult>;

/** Extracts SwiftPM-compatible versions from `git ls-remote --tags` output. */
export function parseLsRemote(stdout: string): string[] {
  const out = new Set<string>();
  for (const line of stdout.split("\n")) {
    const ref = line.split("\t")[1];
    if (!ref?.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
    const v = normalizeVersion(ref.slice("refs/tags/".length));
    if (v) out.add(v);
  }
  return [...out].sort(semver.rcompare);
}

function summarizeGitError(stderr: string, code: number | null): string {
  const s = stderr.toLowerCase();
  if (s.includes("could not read username") || s.includes("authentication") || s.includes("terminal prompts disabled"))
    return "auth required or repo not found";
  if (s.includes("not found") || s.includes("does not appear to be a git repository")) return "repository not found";
  if (s.includes("could not resolve host")) return "network unreachable";
  const line = stderr.trim().split("\n").pop()?.replace(/^fatal:\s*/, "");
  return line || `git exited with ${code}`;
}

export function gitTagFetcher(timeoutSec: number): TagFetcher {
  return async (url) => {
    const proc = Bun.spawn(["git", "ls-remote", "--tags", "--refs", url], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        // Never block on SSH passphrase/host-key prompts.
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
      },
    });
    const timer = setTimeout(() => proc.kill(), timeoutSec * 1000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (proc.signalCode) return { error: `timed out after ${timeoutSec}s` };
    if (code !== 0) return { error: summarizeGitError(stderr, code) };
    return { versions: parseLsRemote(stdout) };
  };
}

// --- cache -----------------------------------------------------------------

type CacheFile = Record<string, { t: number; v: string[] }>;

export function cacheDir(): string {
  return (
    process.env.SPM_UPDATE_CACHE_DIR ??
    join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "spm-update")
  );
}

/** Wraps a fetcher with a small on-disk cache so check → apply loops hit the network once. */
export function cachedFetcher(inner: TagFetcher, ttlSec: number): TagFetcher & { flush(): void } {
  const file = join(cacheDir(), "tags.json");
  let cache: CacheFile = {};
  try {
    cache = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  let dirty = false;
  const now = Date.now();
  const fetcher = (async (url: string) => {
    const hit = cache[url];
    if (hit && now - hit.t < ttlSec * 1000) return { versions: hit.v };
    const res = await inner(url);
    if ("versions" in res) {
      cache[url] = { t: Date.now(), v: res.versions };
      dirty = true;
    }
    return res;
  }) as TagFetcher & { flush(): void };
  fetcher.flush = () => {
    if (!dirty) return;
    try {
      mkdirSync(cacheDir(), { recursive: true });
      for (const [k, e] of Object.entries(cache)) if (now - e.t > 86400_000) delete cache[k];
      const tmp = `${file}.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(cache));
      renameSync(tmp, file);
    } catch {
      // Cache is best-effort.
    }
  };
  return fetcher;
}

/** Fetches tags for many URLs with bounded concurrency. */
export async function fetchAll(
  urls: string[],
  fetcher: TagFetcher,
  concurrency = 8,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, TagResult>> {
  const unique = [...new Set(urls)];
  const results = new Map<string, TagResult>();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < unique.length) {
      const url = unique[next++]!;
      try {
        results.set(url, await fetcher(url));
      } catch (e) {
        results.set(url, { error: (e as Error).message });
      }
      onProgress?.(++done, unique.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return results;
}

// --- analysis --------------------------------------------------------------

function newestWhere(versions: string[], pred: (v: semver.SemVer) => boolean): string | undefined {
  // `versions` is sorted newest first.
  return versions.find((v) => pred(semver.parse(v)!));
}

export function analyze(
  dep: Dependency,
  pin: Pin | undefined,
  tags: TagResult | undefined,
  includePrerelease = false,
): Analysis {
  const base: Analysis = { status: "up-to-date", update: "none", newer: [], all: [] };
  if (dep.source === "local") return { ...base, status: "local" };
  if (dep.source === "registry") return { ...base, status: "registry", err: "registry packages are not supported" };
  const resolved = pin?.version ? normalizeVersion(pin.version) ?? undefined : undefined;
  if (!tags) return { ...base, resolved, status: "error", err: "not fetched" };
  if ("error" in tags) return { ...base, resolved, status: "error", err: tags.error };

  const all = tags.versions;
  const candidates = includePrerelease ? all : all.filter((v) => !semver.prerelease(v));
  const latest = candidates[0];
  const pinned = dep.req.kind === "branch" || dep.req.kind === "revision";
  // A resolved version outside the requirement means Package.resolved is stale; use the floor then.
  const floor = requirementFloor(dep.req) ?? undefined;
  const baseline = pinned ? undefined : resolved && satisfies(dep.req, resolved) ? resolved : floor;

  if (!baseline) {
    return { ...base, all, resolved, latest, status: pinned ? "pinned" : "error", err: pinned ? undefined : "unrecognized requirement" };
  }

  const b = semver.parse(baseline)!;
  const newer = candidates.filter((v) => semver.gt(v, b));
  const patch = newestWhere(newer, (v) => v.major === b.major && v.minor === b.minor);
  const sameMajor = newestWhere(newer, (v) => v.major === b.major);
  const minor = sameMajor && semver.minor(sameMajor) > b.minor ? sameMajor : undefined;
  const major = latest && semver.major(latest) > b.major ? latest : undefined;
  const update = major ? "major" : minor ? "minor" : patch ? "patch" : "none";
  const nonBreaking = sameMajor;
  return {
    status: update === "none" ? "up-to-date" : "outdated",
    update,
    baseline,
    resolved,
    patch,
    minor,
    major,
    latest,
    inRange: nonBreaking ? satisfies(dep.req, nonBreaking) : undefined,
    newer,
    all,
  };
}

/** The version a `patch` / `minor` / `major` (= `latest`) target points to, relative to the baseline. */
export function targetVersion(a: Analysis, level: "patch" | "minor" | "major"): string | undefined {
  if (level === "patch") return a.patch;
  if (level === "minor") return a.minor ?? a.patch;
  return a.major ?? a.minor ?? a.patch;
}
