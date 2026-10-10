/**
 * End-to-end tests: real CLI process, real `git ls-remote`, against local git
 * repositories with tags (no network).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");
const FIXTURE_PBX = join(import.meta.dir, "fixtures/xcode/App.xcodeproj/project.pbxproj");
let tmp: string;
let repos: string;

function sh(cmd: string[], cwd: string) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
}

function makeRepo(name: string, tags: string[]): string {
  const dir = join(repos, `${name}.git`);
  mkdirSync(dir, { recursive: true });
  sh(["git", "init", "-q"], dir);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], dir);
  for (const t of tags) sh(["git", "tag", t], dir);
  return `file://${dir}`;
}

async function cli(args: string[], stdin?: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    env: { ...process.env, SPM_UPDATE_CACHE_DIR: join(tmp, "cache"), NO_COLOR: "1", SPM_UPDATE_FORMAT: "" },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: out.trim(), err: err.trim(), code };
}

let urls: Record<string, string>;
let project: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "spm-update-e2e-"));
  repos = join(tmp, "repos");
  urls = {
    Alpha: makeRepo("Alpha", ["1.0.0", "1.0.1", "1.1.0", "v2.0.0", "2.1.0-beta.1"]),
    Beta: makeRepo("Beta", ["0.9.0", "1.0.0", "1.0.5"]),
    Gamma: makeRepo("Gamma", ["3.0.0", "3.2.0"]),
  };
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function freshProject(): string {
  project = mkdtempSync(join(tmp, "proj-"));
  writeFileSync(
    join(project, "Package.swift"),
    `// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "P",
    dependencies: [
        .package(url: "${urls.Alpha}", .upToNextMajor(from: "1.0.0")),
        .package(url: "${urls.Beta}", exact: "1.0.0"),
        .package(url: "${urls.Gamma}", branch: "main"),
    ]
)
`,
  );
  writeFileSync(
    join(project, "Package.resolved"),
    JSON.stringify({ pins: [{ identity: "alpha", location: urls.Alpha, state: { version: "1.0.1" } }], version: 2 }),
  );
  return project;
}

describe("check", () => {
  test("tsv output", async () => {
    const r = await cli(["check", freshProject(), "--format", "tsv"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "#0 Package.swift",
        "m\tpkg\treq\tresolved\tpatch\tminor\tmajor\tstatus",
        "0\tAlpha\t^1.0.0\t1.0.1\t-\t1.1.0\t2.0.0\tmajor",
        "0\tBeta\t=1.0.0\t-\t1.0.5\t-\t-\tpatch",
        "0\tGamma\tbranch:main\t-\t-\t-\t3.2.0\tpinned",
      ].join("\n"),
    );
  });

  test("json output is compact and omits empty fields", async () => {
    const r = await cli([freshProject(), "--json", "--outdated", "--versions"]);
    expect(r.out.includes("\n")).toBe(false);
    const json = JSON.parse(r.out);
    expect(json.manifests).toEqual([{ path: "Package.swift", type: "package", resolved: "Package.resolved" }]);
    expect(json.deps.map((d: any) => d.name)).toEqual(["Alpha", "Beta"]);
    expect(json.deps[0]).toEqual({
      m: 0,
      name: "Alpha",
      url: urls.Alpha,
      req: "^1.0.0",
      resolved: "1.0.1",
      status: "outdated",
      update: "major",
      minor: "1.1.0",
      major: "2.0.0",
      inRange: true,
      versions: ["2.0.0", "1.1.0"],
    });
    expect(json.summary).toEqual({ total: 3, outdated: 2, major: 1, patch: 1, pinned: 1 });
  });

  test("plain table has no ANSI codes when piped", async () => {
    const r = await cli([freshProject()]);
    expect(r.out).not.toContain("\x1b[");
    expect(r.out).toContain("next: spm-update update --level minor | spm-update apply Alpha@major");
  });

  test("--fail-on-outdated exits 2", async () => {
    expect((await cli([freshProject(), "--fail-on-outdated", "--tsv"])).code).toBe(2);
  });
});

describe("apply", () => {
  test("dry run writes nothing", async () => {
    const dir = freshProject();
    const before = readFileSync(join(dir, "Package.swift"), "utf8");
    const r = await cli(["apply", dir, "Alpha@minor", "Beta@patch", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(["Alpha\t^1.0.0 -> ^1.1.0", "Beta\t=1.0.0 -> =1.0.5", "dry run: 2 changes, nothing written"].join("\n"));
    expect(readFileSync(join(dir, "Package.swift"), "utf8")).toBe(before);
  });

  test("writes decisions and keeps argument style", async () => {
    const dir = freshProject();
    const r = await cli(["apply", dir, "Alpha@major", "Beta@~1.0.5", "Gamma@3.2.0", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      v: 1,
      changes: [
        { m: 0, name: "Alpha", from: "^1.0.0", to: "^2.0.0" },
        { m: 0, name: "Beta", from: "=1.0.0", to: "~1.0.5" },
        { m: 0, name: "Gamma", from: "branch:main", to: "^3.2.0" },
      ],
      next: "swift package resolve",
    });
    const text = readFileSync(join(dir, "Package.swift"), "utf8");
    expect(text).toContain(`.package(url: "${urls.Alpha}", .upToNextMajor(from: "2.0.0")),`);
    expect(text).toContain(`.package(url: "${urls.Beta}", .upToNextMinor(from: "1.0.5")),`);
    expect(text).toContain(`.package(url: "${urls.Gamma}", from: "3.2.0"),`);
  });

  test("any invalid decision means nothing is written", async () => {
    const dir = freshProject();
    const before = readFileSync(join(dir, "Package.swift"), "utf8");
    const r = await cli(["apply", dir, "Alpha@minor", "Beta@7.0.0"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("error: Beta: no tag 7.0.0 (newest: 1.0.5)");
    expect(readFileSync(join(dir, "Package.swift"), "utf8")).toBe(before);
  });

  test("reads a plan from stdin", async () => {
    const dir = freshProject();
    const r = await cli(["apply", dir, "--plan", "-", "--tsv"], JSON.stringify({ decisions: [{ package: "beta", target: "patch" }] }));
    expect(r.code).toBe(0);
    expect(r.out).toBe(["Beta\t=1.0.0 -> =1.0.5", "wrote 1 change", "next: swift package resolve"].join("\n"));
  });

  test("usage errors exit 1 with a hint", async () => {
    const r = await cli(["apply", freshProject()]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("apply needs decisions");
  });
});

describe("update", () => {
  test("--level minor updates within the major and preserves pins", async () => {
    const dir = freshProject();
    const r = await cli(["update", dir, "--level", "minor"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "Alpha\t^1.0.0 -> ^1.1.0",
        "Beta\t=1.0.0 -> =1.0.5",
        "skip Gamma: pinned branch:main",
        "wrote 2 changes",
        "next: swift package resolve",
      ].join("\n"),
    );
  });

  test("legacy form: <path> update --skip", async () => {
    const dir = freshProject();
    const r = await cli([dir, "update", "--skip", "Beta", "-q"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(readFileSync(join(dir, "Package.swift"), "utf8")).toContain(`.upToNextMajor(from: "2.0.0")`);
    expect(readFileSync(join(dir, "Package.swift"), "utf8")).toContain(`exact: "1.0.0"`);
  });

  test("xcode projects are edited in place", async () => {
    const dir = mkdtempSync(join(tmp, "xc-"));
    mkdirSync(join(dir, "App.xcodeproj"));
    const pbx = readFileSync(FIXTURE_PBX, "utf8")
      .replace("https://github.com/Alamofire/Alamofire.git", urls.Alpha!)
      .replace("https://github.com/onevcat/Kingfisher", urls.Beta!)
      .replace("https://github.com/apple/swift-log.git", urls.Gamma!)
      .replace("minimumVersion = 1.4.0", "minimumVersion = 3.0.0")
      .replace("maximumVersion = 2.0.0", "maximumVersion = 4.0.0")
      .replace("version = 7.0.0", "version = 1.0.0");
    writeFileSync(join(dir, "App.xcodeproj/project.pbxproj"), pbx);
    const r = await cli(["update", dir, "--level", "minor", "--json"]);
    // Alpha's requirement (^5.0.0) is above every tag, so it is left alone.
    expect(JSON.parse(r.out).changes).toEqual([
      { m: 0, name: "Beta", from: "=1.0.0", to: "=1.0.5" },
      { m: 0, name: "Gamma", from: ">=3.0.0 <4.0.0", to: ">=3.2.0 <4.0.0" },
    ]);
    const after = readFileSync(join(dir, "App.xcodeproj/project.pbxproj"), "utf8");
    expect(after).toContain("version = 1.0.5;");
    expect(after).toContain("minimumVersion = 3.2.0;");
  });
});
