import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import type { Analysis, Dependency } from "./types.ts";
import { normalizeVersion, requirementFloor, satisfies } from "./requirement.ts";
import type { Pin } from "./resolved.ts";

export type TagResult = { versions: string[] } | { error: string };
export type TagFetcher = (url: string) => Promise<TagResult>;

/** Extracts SwiftPM-compatible versions from tag refs (`<oid> refs/tags/<name>` lines, tab or space separated). */
export function versionsFromRefs(refs: string[]): string[] {
  const out = new Set<string>();
  for (const line of refs) {
    const ref = line.split(/[\t ]/)[1];
    if (!ref?.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
    const v = normalizeVersion(ref.slice("refs/tags/".length));
    if (v) out.add(v);
  }
  return [...out].sort(semver.rcompare);
}

/** Extracts SwiftPM-compatible versions from `git ls-remote --tags` output. */
export function parseLsRemote(stdout: string): string[] {
  return versionsFromRefs(stdout.split("\n"));
}

// --- git protocol v2 over HTTP ------------------------------------------------

const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
const LS_REFS_BODY =
  pkt("command=ls-refs\n") + pkt("agent=spm-update\n") + pkt("object-format=sha1\n") + "0001" + pkt("ref-prefix refs/tags/\n") + "0000";

/** Splits a pkt-line stream into its data lines; returns null if it isn't a clean ref listing. */
export function parseLsRefsResponse(body: string): string[] | null {
  const refs: string[] = [];
  let i = 0;
  while (i < body.length) {
    const len = parseInt(body.slice(i, i + 4), 16);
    if (Number.isNaN(len)) return null;
    if (len < 4) {
      i += 4; // flush (0000) / delimiter (0001) / response-end (0002)
      continue;
    }
    const line = body.slice(i + 4, i + len).replace(/\n$/, "");
    if (!/^[0-9a-f]{40,64} refs\/tags\//.test(line)) return null; // e.g. "ERR ..." from the server
    refs.push(line);
    i += len;
  }
  return refs;
}

type HttpResult = TagResult | { fallback: string };

/**
 * Lists tags with a single `ls-refs` request (git protocol v2 over smart HTTP), skipping the
 * `git` process and the capability round trip. Anything unexpected (auth, old servers, odd
 * responses) is reported as `fallback` so the caller can retry with `git ls-remote`.
 */
async function httpLsRefs(url: string, timeoutSec: number): Promise<HttpResult> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/git-upload-pack`, {
      method: "POST",
      body: LS_REFS_BODY,
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        Accept: "application/x-git-upload-pack-result",
        "Git-Protocol": "version=2",
      },
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    if (res.status !== 200 || !res.headers.get("content-type")?.includes("git-upload-pack-result")) {
      await res.body?.cancel();
      return { fallback: `http ${res.status}` };
    }
    const refs = parseLsRefsResponse(await res.text());
    return refs ? { versions: versionsFromRefs(refs) } : { fallback: "unexpected response" };
  } catch (e) {
    if ((e as Error).name === "TimeoutError") return { error: `timed out after ${timeoutSec}s` };
    return { fallback: (e as Error).message };
  }
}

/** HTTP(S) URLs use a direct `ls-refs` request; everything else, and any HTTP failure, uses `git ls-remote`. */
export function tagFetcher(timeoutSec: number): TagFetcher {
  const git = gitTagFetcher(timeoutSec);
  return async (url) => {
    if (/^https?:\/\//i.test(url) && !process.env.SPM_UPDATE_GIT_ONLY) {
      const r = await httpLsRefs(url, timeoutSec);
      if (!("fallback" in r)) return r;
    }
    return git(url);
  };
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

type CacheFile = Record<string, { t: number; v?: string[]; e?: string }>;

/** Failures that won't change in the next few minutes; timeouts and network errors are retried. */
const STABLE_ERRORS = new Set(["repository not found", "auth required or repo not found"]);

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
    if (hit && now - hit.t < ttlSec * 1000) return hit.v ? { versions: hit.v } : { error: hit.e ?? "error" };
    const res = await inner(url);
    if ("versions" in res) {
      cache[url] = { t: Date.now(), v: res.versions };
      dirty = true;
    } else if (STABLE_ERRORS.has(res.error)) {
      cache[url] = { t: Date.now(), e: res.error };
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
  concurrency = 16,
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

/** `5.0.0-beta.2` → `5.0.0`. */
function releaseOf(version: string): string {
  const v = semver.parse(version)!;
  return `${v.major}.${v.minor}.${v.patch}`;
}

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
  const pinned = dep.req.kind === "branch" || dep.req.kind === "revision";
  // A resolved version outside the requirement means Package.resolved is stale; use the floor then.
  const floor = requirementFloor(dep.req) ?? undefined;
  // A requirement still on a prerelease (`from: "5.0.0-beta"`) whose release is out is compared from
  // that floor, even if Package.resolved already picked the release up, so the move off beta/rc is flagged.
  const floorAwaitsRelease =
    !!floor && !!semver.prerelease(floor) && all.some((v) => !semver.prerelease(v) && semver.gte(v, releaseOf(floor)));
  const baseline = pinned
    ? undefined
    : !floorAwaitsRelease && resolved && satisfies(dep.req, resolved)
      ? resolved
      : floor;
  // Prereleases are opt-in, except that a prerelease baseline (`from: "5.0.0-beta"`) already
  // opts into later prereleases of that same version, as SwiftPM does.
  const pre = baseline ? semver.parse(baseline) : null;
  const candidates = all.filter((v) => {
    if (includePrerelease || !semver.prerelease(v)) return true;
    const p = semver.parse(v)!;
    return !!pre?.prerelease.length && p.major === pre.major && p.minor === pre.minor && p.patch === pre.patch;
  });
  const latest = candidates[0];

  if (!baseline) {
    return { ...base, all, resolved, latest, status: pinned ? "pinned" : "error", err: pinned ? undefined : "requirement uses a variable or unsupported syntax" };
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
