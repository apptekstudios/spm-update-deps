import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, cachedFetcher, parseLsRefsResponse, parseLsRemote, tagFetcher, targetVersion } from "../src/versions.ts";
import { bumpRequirement, formatRequirement, sameRequirement, satisfies } from "../src/requirement.ts";
import type { Dependency, Requirement } from "../src/types.ts";

const LS_REMOTE = [
  "a\trefs/tags/1.0.0",
  "b\trefs/tags/v1.0.1",
  "c\trefs/tags/1.1.0",
  "d\trefs/tags/1.2",
  "e\trefs/tags/1.2.3",
  "f\trefs/tags/2.0.0-beta.1",
  "g\trefs/tags/2.0.0",
  "h\trefs/tags/2.1.0",
  "i\trefs/tags/some-release-branch",
  "j\trefs/tags/1.1.0^{}",
].join("\n");

const versions = parseLsRemote(LS_REMOTE);
const dep = (req: Requirement): Dependency => ({
  name: "Pkg",
  identity: "pkg",
  source: "remote",
  url: "https://example.com/Pkg.git",
  req,
  handle: null,
});

describe("parseLsRemote", () => {
  test("normalizes v-prefixed and two-part tags, drops junk, sorts newest first", () => {
    expect(versions).toEqual(["2.1.0", "2.0.0", "2.0.0-beta.1", "1.2.3", "1.2.0", "1.1.0", "1.0.1", "1.0.0"]);
  });

  test("reads zero-padded calendar versions like SwiftPM", () => {
    expect(parseLsRemote("a\trefs/tags/26.09.25\nb\trefs/tags/26.10.02")).toEqual(["26.10.2", "26.9.25"]);
    const a = analyze(dep({ kind: "exact", version: "26.09.25" }), { version: "26.09.25" }, { versions: ["26.10.2", "26.9.25"] });
    expect(a).toMatchObject({ status: "outdated", baseline: "26.9.25", minor: "26.10.2" });
  });
});

describe("analyze", () => {
  test("reports patch, minor and major steps from the requirement floor", () => {
    const a = analyze(dep({ kind: "upToNextMajor", version: "1.0.0" }), undefined, { versions });
    expect(a).toMatchObject({ status: "outdated", update: "major", patch: "1.0.1", minor: "1.2.3", major: "2.1.0", inRange: true });
    expect(a.newer).not.toContain("2.0.0-beta.1");
  });

  test("uses the resolved version as baseline", () => {
    const a = analyze(dep({ kind: "upToNextMajor", version: "1.0.0" }), { version: "1.2.3" }, { versions });
    expect(a).toMatchObject({ baseline: "1.2.3", patch: undefined, minor: undefined, major: "2.1.0", update: "major" });
  });

  test("ignores a stale resolved version outside the requirement", () => {
    const a = analyze(dep({ kind: "upToNextMajor", version: "2.0.0" }), { version: "1.0.0" }, { versions });
    expect(a.baseline).toBe("2.0.0");
    expect(a.resolved).toBe("1.0.0");
  });

  test("up to date", () => {
    const a = analyze(dep({ kind: "exact", version: "2.1.0" }), undefined, { versions });
    expect(a).toMatchObject({ status: "up-to-date", update: "none" });
  });

  test("inRange is false when the requirement excludes the newest minor", () => {
    const a = analyze(dep({ kind: "upToNextMinor", version: "1.0.0" }), undefined, { versions });
    expect(a.inRange).toBe(false);
  });

  test("prereleases are opt-in", () => {
    const tags = { versions: ["3.0.0-rc.1", ...versions] };
    expect(analyze(dep({ kind: "upToNextMajor", version: "2.1.0" }), undefined, tags).status).toBe("up-to-date");
    expect(analyze(dep({ kind: "upToNextMajor", version: "2.1.0" }), undefined, tags, true).major).toBe("3.0.0-rc.1");
  });

  test("a prerelease baseline sees later prereleases of the same version", () => {
    const tags = { versions: ["5.1.0-alpha.1", "5.0.0-beta.3", "5.0.0-beta.1", "4.9.3"] };
    const a = analyze(dep({ kind: "upToNextMajor", version: "5.0.0-beta" }), undefined, tags);
    expect(a).toMatchObject({ status: "outdated", update: "patch", patch: "5.0.0-beta.3" });
    expect(a.newer).toEqual(["5.0.0-beta.3", "5.0.0-beta.1"]);
  });

  describe("prerelease → release", () => {
    const req = { kind: "upToNextMajor", version: "5.0.0-beta" } as const;

    test("flags the release even when Package.resolved already has it", () => {
      const a = analyze(dep(req), { version: "5.0.0" }, { versions: ["5.0.1", "5.0.0", "5.0.0-beta.3", "5.0.0-beta"] });
      expect(a).toMatchObject({ status: "outdated", update: "patch", baseline: "5.0.0-beta", patch: "5.0.1" });
      expect(targetVersion(a, "patch")).toBe("5.0.1");
    });

    test("prefers the release over a later rc of the same version", () => {
      const a = analyze(dep(req), { version: "5.0.0-rc.1" }, { versions: ["5.0.0", "5.0.0-rc.2", "5.0.0-rc.1"] });
      expect(a).toMatchObject({ status: "outdated", baseline: "5.0.0-beta", patch: "5.0.0" });
    });

    test("stays on prereleases until a release exists", () => {
      const a = analyze(dep(req), { version: "5.0.0-beta.2" }, { versions: ["5.0.0-rc.1", "5.0.0-beta.2", "4.9.0"] });
      expect(a).toMatchObject({ baseline: "5.0.0-beta.2", patch: "5.0.0-rc.1" });
    });

    test("with --include-prerelease, a release beats its own rc", () => {
      const a = analyze(dep({ kind: "upToNextMajor", version: "1.0.0" }), undefined, { versions: ["1.1.0", "1.1.0-rc.1"] }, true);
      expect(a.minor).toBe("1.1.0");
    });
  });

  test("branch pins report the latest release", () => {
    const a = analyze(dep({ kind: "branch", ref: "main" }), undefined, { versions });
    expect(a).toMatchObject({ status: "pinned", latest: "2.1.0" });
  });

  test("fetch errors are surfaced", () => {
    expect(analyze(dep({ kind: "exact", version: "1.0.0" }), undefined, { error: "boom" })).toMatchObject({ status: "error", err: "boom" });
  });

  test("targetVersion picks the newest version at each level", () => {
    const a = analyze(dep({ kind: "upToNextMajor", version: "1.0.0" }), undefined, { versions });
    expect([targetVersion(a, "patch"), targetVersion(a, "minor"), targetVersion(a, "major")]).toEqual(["1.0.1", "1.2.3", "2.1.0"]);
  });
});

describe("requirements", () => {
  test("satisfies", () => {
    expect(satisfies({ kind: "upToNextMajor", version: "1.0.0" }, "1.9.0")).toBe(true);
    expect(satisfies({ kind: "upToNextMajor", version: "1.0.0" }, "2.0.0")).toBe(false);
    expect(satisfies({ kind: "upToNextMinor", version: "1.2.0" }, "1.3.0")).toBe(false);
    expect(satisfies({ kind: "range", lower: "1.0.0", upper: "2.0.0", closed: false }, "2.0.0")).toBe(false);
    expect(satisfies({ kind: "range", lower: "1.0.0", upper: "2.0.0", closed: true }, "2.0.0")).toBe(true);
  });

  test("sameRequirement ignores spelling differences", () => {
    expect(sameRequirement({ kind: "exact", version: "1.2" }, { kind: "exact", version: "1.2.0" })).toBe(true);
    expect(sameRequirement({ kind: "exact", version: "26.09.25" }, { kind: "exact", version: "26.9.25" })).toBe(true);
    expect(sameRequirement({ kind: "exact", version: "1.2.0" }, { kind: "upToNextMajor", version: "1.2.0" })).toBe(false);
  });

  test("bumpRequirement keeps the kind", () => {
    const fmt = (r: Requirement, v: string) => formatRequirement(bumpRequirement(r, v));
    expect(fmt({ kind: "upToNextMinor", version: "1.0.0" }, "1.4.0")).toBe("~1.4.0");
    expect(fmt({ kind: "exact", version: "1.0.0" }, "1.4.0")).toBe("=1.4.0");
    expect(fmt({ kind: "range", lower: "1.0.0", upper: "2.0.0", closed: false }, "1.4.0")).toBe(">=1.4.0 <2.0.0");
    expect(fmt({ kind: "range", lower: "1.0.0", upper: "2.0.0", closed: false }, "2.1.0")).toBe(">=2.1.0 <3.0.0");
    expect(fmt({ kind: "branch", ref: "main" }, "1.4.0")).toBe("^1.4.0");
    expect(formatRequirement(bumpRequirement({ kind: "upToNextMajor", version: "1.0.0" }, "1.4.0", "exact"))).toBe("=1.4.0");
  });
});

describe("protocol v2 ls-refs", () => {
  const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
  const oid = "a".repeat(40);

  test("parses pkt-lines and rejects server errors", () => {
    expect(parseLsRefsResponse(pkt(`${oid} refs/tags/1.0.0\n`) + pkt(`${oid} refs/tags/v1.1.0\n`) + "0000")).toEqual([
      `${oid} refs/tags/1.0.0`,
      `${oid} refs/tags/v1.1.0`,
    ]);
    expect(parseLsRefsResponse(pkt("ERR upload-pack: not our ref\n") + "0000")).toBeNull();
    expect(parseLsRefsResponse("<html>")).toBeNull();
  });

  test("fetches tags over HTTP and falls back to git on 401", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.pathname} ${req.headers.get("git-protocol")} ${(await req.text()).includes("ref-prefix refs/tags/")}`);
        if (url.pathname.startsWith("/private")) return new Response("auth", { status: 401 });
        const body = pkt(`${oid} refs/tags/1.0.0\n`) + pkt(`${oid} refs/tags/2.0.0\n`) + "0000";
        return new Response(body, { headers: { "content-type": "application/x-git-upload-pack-result" } });
      },
    });
    try {
      const fetcher = tagFetcher(5);
      expect(await fetcher(`http://localhost:${server.port}/acme/Pkg.git`)).toEqual({ versions: ["2.0.0", "1.0.0"] });
      expect(seen[0]).toBe("POST /acme/Pkg.git/git-upload-pack version=2 true");
      // 401 → git ls-remote (which can use credential helpers); here git fails too and reports why.
      const r = await fetcher(`http://localhost:${server.port}/private/Repo.git`);
      expect("error" in r).toBe(true);
      expect(seen.some((s) => s.startsWith("GET /private/Repo.git/info/refs"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("cache", () => {
  test("caches versions and definite failures, not timeouts", async () => {
    process.env.SPM_UPDATE_CACHE_DIR = mkdtempSync(join(tmpdir(), "spm-cache-"));
    const calls: string[] = [];
    const inner = async (url: string) => {
      calls.push(url);
      if (url === "ok") return { versions: ["1.0.0"] };
      if (url === "gone") return { error: "repository not found" };
      return { error: "timed out after 30s" };
    };
    const first = cachedFetcher(inner, 600);
    for (const u of ["ok", "gone", "slow"]) await first(u);
    first.flush();
    const second = cachedFetcher(inner, 600);
    expect(await second("ok")).toEqual({ versions: ["1.0.0"] });
    expect(await second("gone")).toEqual({ error: "repository not found" });
    await second("slow");
    expect(calls).toEqual(["ok", "gone", "slow", "slow"]);
    delete process.env.SPM_UPDATE_CACHE_DIR;
  });
});
