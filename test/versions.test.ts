import { describe, expect, test } from "bun:test";
import { analyze, parseLsRemote, targetVersion } from "../src/versions.ts";
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
