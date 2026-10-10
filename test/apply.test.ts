import { describe, expect, test } from "bun:test";
import { parseDecisionArg, parsePlanFile, planBulk, planDecisions } from "../src/apply.ts";
import { analyze } from "../src/versions.ts";
import { formatRequirement } from "../src/requirement.ts";
import type { CheckedDep, Manifest, Requirement } from "../src/types.ts";

const VERSIONS = ["3.0.0", "2.4.1", "2.4.0", "2.3.2", "2.3.1", "2.3.0"];

function checked(name: string, req: Requirement, opts: { m?: number; error?: string; source?: "remote" | "local" } = {}): CheckedDep {
  const dep = {
    name,
    identity: name.toLowerCase(),
    source: opts.source ?? "remote",
    url: `https://github.com/acme/${name}.git`,
    req,
    handle: null,
  } as const;
  const tags = opts.error ? { error: opts.error } : { versions: VERSIONS };
  return { m: opts.m ?? 0, dep: { ...dep }, a: analyze(dep, undefined, tags) };
}

const manifests: Manifest[] = [
  { path: "/x/Package.swift", label: "Package.swift", type: "package", deps: [] },
  { path: "/x/App.xcodeproj/project.pbxproj", label: "App.xcodeproj", type: "xcodeproj", deps: [] },
];

const fmtChanges = (plan: ReturnType<typeof planDecisions>) =>
  plan.changes.map((c) => `${c.name} ${formatRequirement(c.from)} -> ${formatRequirement(c.to)}`);

describe("parseDecisionArg", () => {
  test("parses targets and kind prefixes", () => {
    expect(parseDecisionArg("Alamofire@minor")).toEqual({ selector: "Alamofire", target: "minor", kind: undefined });
    expect(parseDecisionArg("Foo@~1.2.3")).toEqual({ selector: "Foo", target: "1.2.3", kind: "upToNextMinor" });
    expect(parseDecisionArg("Foo@=1.2.3")).toMatchObject({ kind: "exact" });
    expect(parseDecisionArg("git@github.com:a/b.git@1.0.0")).toMatchObject({ selector: "git@github.com:a/b.git", target: "1.0.0" });
    expect(() => parseDecisionArg("Foo")).toThrow();
  });

  test("parses plan files", () => {
    expect(parsePlanFile(`[{"package":"Foo","target":"1.0.0","requirement":"exact"}]`)).toEqual([
      { selector: "Foo", target: "1.0.0", kind: "exact", manifest: undefined },
    ]);
    expect(parsePlanFile(`{"decisions":[{"package":"Foo","target":"minor","manifest":"Package.swift"}]}`)[0]).toMatchObject({
      manifest: "Package.swift",
    });
    expect(() => parsePlanFile(`{"nope":1}`)).toThrow();
  });
});

describe("planDecisions", () => {
  const deps = [
    checked("Alpha", { kind: "upToNextMajor", version: "2.3.0" }),
    checked("Beta", { kind: "exact", version: "2.3.1" }),
    checked("Gamma", { kind: "branch", ref: "main" }),
    checked("Alpha", { kind: "upToNextMinor", version: "2.3.0" }, { m: 1 }),
  ];

  test("resolves level keywords per dependency, in every manifest", () => {
    const plan = planDecisions(deps, manifests, [parseDecisionArg("alpha@minor"), parseDecisionArg("Beta@patch")], false);
    expect(plan.errors).toEqual([]);
    expect(fmtChanges(plan)).toEqual(["Alpha ^2.3.0 -> ^2.4.1", "Alpha ~2.3.0 -> ~2.4.1", "Beta =2.3.1 -> =2.3.2"]);
  });

  test("manifest filter, kind override and explicit versions", () => {
    const plan = planDecisions(
      deps,
      manifests,
      [{ ...parseDecisionArg("Alpha@=3.0.0"), manifest: "App.xcodeproj" }, parseDecisionArg("Gamma@2.4.0")],
      false,
    );
    expect(fmtChanges(plan)).toEqual(["Alpha ~2.3.0 -> =3.0.0", "Gamma branch:main -> ^2.4.0"]);
  });

  test("collects every error and suggests names", () => {
    const plan = planDecisions(
      deps,
      manifests,
      [parseDecisionArg("Alpah@minor"), parseDecisionArg("Beta@9.9.9"), parseDecisionArg("Beta@1.0.0"), parseDecisionArg("Gamma@latest")],
      false,
    );
    expect(plan.changes).toEqual([]);
    expect(plan.errors).toEqual([
      "unknown package 'Alpah' (did you mean Alpha?)",
      "Beta: no tag 9.9.9 (newest: 3.0.0); pass --force to write anyway",
      "Beta: conflicting decisions '9.9.9' and '1.0.0'",
      "Gamma: pinned to branch:main; give an explicit version, e.g. Gamma@3.0.0",
    ]);
  });

  test("a manifest filter that excludes the package says where it is", () => {
    const plan = planDecisions(deps, manifests, [{ ...parseDecisionArg("Beta@patch"), manifest: "App.xcodeproj" }], false);
    expect(plan.errors).toEqual(["'Beta' is not in App.xcodeproj (found in Package.swift)"]);
  });

  test("--force allows unknown tags and downgrades", () => {
    const plan = planDecisions(deps, manifests, [parseDecisionArg("Beta@2.0.0")], true);
    expect(fmtChanges(plan)).toEqual(["Beta =2.3.1 -> =2.0.0"]);
    expect(planDecisions(deps, manifests, [parseDecisionArg("Beta@2.3.0")], false).errors[0]).toContain("downgrade");
  });

  test("no-op decisions are reported as skipped", () => {
    const plan = planDecisions([checked("Top", { kind: "upToNextMajor", version: "3.0.0" })], manifests, [parseDecisionArg("Top@latest")], false);
    expect(plan.changes).toEqual([]);
    expect(plan.skipped).toEqual([{ m: 0, name: "Top", reason: "unchanged" }]);
  });

  test("fetch errors block keyword targets", () => {
    const plan = planDecisions([checked("Err", { kind: "exact", version: "1.0.0" }, { error: "timed out" })], manifests, [parseDecisionArg("Err@minor")], false);
    expect(plan.errors).toEqual(["Err: can't resolve 'minor': timed out"]);
  });
});

describe("planBulk", () => {
  const deps = [
    checked("Alpha", { kind: "upToNextMajor", version: "2.3.0" }),
    checked("Beta", { kind: "upToNextMajor", version: "2.4.1" }),
    checked("Gamma", { kind: "branch", ref: "main" }),
    checked("Delta", { kind: "exact", version: "2.3.0" }),
  ];

  test("level minor stays within the major and reports held-back majors", () => {
    const plan = planBulk(deps, "minor", new Set(), new Set(["delta"]));
    expect(fmtChanges(plan)).toEqual(["Alpha ^2.3.0 -> ^2.4.1"]);
    expect(plan.skipped.map((s) => `${s.name}: ${s.reason}`)).toEqual([
      "Beta: major 3.0.0 available (use Beta@major)",
      "Gamma: pinned branch:main",
      "Delta: --skip",
    ]);
  });

  test("level major goes to latest; --only limits", () => {
    expect(fmtChanges(planBulk(deps, "major", new Set(["beta"]), new Set()))).toEqual(["Beta ^2.4.1 -> ^3.0.0"]);
  });
});
