#!/usr/bin/env bun

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { XcodeProject } from "@bacons/xcode";
import { $ } from "bun";
import semver from "semver";
import { build } from "@bacons/xcode/json";

function hasUpdateArg(argv: string[]): boolean {
  return argv.includes("update");
}

function getTargetDirectoryFromArgs(argv: string[]): string {
  const positionalPath = argv.find(
    (arg) => arg !== "update" && !arg.startsWith("-"),
  );
  const rawPath = positionalPath ?? ".";
  return isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
}

function validateDirectoryPath(directoryPath: string): void {
  let stats;
  try {
    stats = statSync(directoryPath);
  } catch {
    console.error(`Error: Path does not exist: ${directoryPath}`);
    process.exit(1);
  }
  if (!stats.isDirectory()) {
    console.error(`Error: Path is not a directory: ${directoryPath}`);
    process.exit(1);
  }
}

function findPbxprojFilePath(rootDir: string): string | null {
  const stack: string[] = [rootDir];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        if (entry.name.endsWith(".xcodeproj")) {
          const candidate = resolve(dir, entry.name, "project.pbxproj");
          try {
            const stats = statSync(candidate);
            if (stats.isFile()) return candidate;
          } catch {
            // ignore
          }
        }
        stack.push(resolve(dir, entry.name));
      }
    }
  }
  return null;
}

type SwiftPackage = {
  url: string;
  requirement: string;
};

function formatRequirement(requirement: any): string {
  if (!requirement || typeof requirement !== "object") return "unknown";
  const kind = requirement.kind ?? requirement.requirement;
  switch (kind) {
    case "branch":
      return `branch ${requirement.branch ?? requirement.identifier ?? "unknown"}`;
    case "revision":
      return `revision ${requirement.revision ?? requirement.identifier ?? "unknown"}`;
    case "exactVersion":
    case "exact":
      return `exact ${requirement.version ?? requirement.identifier ?? "unknown"}`;
    case "upToNextMajorVersion":
    case "upToNextMajor":
      return `^${requirement.minimumVersion ?? requirement.minVersion ?? "unknown"}`;
    case "upToNextMinorVersion":
    case "upToNextMinor":
      return `~${requirement.minimumVersion ?? requirement.minVersion ?? "unknown"}`;
    case "versionRange": {
      const min = requirement.minimumVersion ?? requirement.minVersion ?? "?";
      const max = requirement.maximumVersion ?? requirement.maxVersion ?? "?";
      return `>=${min} <=${max}`;
    }
    default:
      return kind ?? "unknown";
  }
}

function getSwiftPackages(project: XcodeProject): SwiftPackage[] {
  const packages: SwiftPackage[] = [];
  const seen = new Set<string>();
  for (const [, obj] of project.entries()) {
    // High-level API objects expose isa and props
    if ((obj as any).isa === "XCRemoteSwiftPackageReference") {
      const url: string | undefined =
        (obj as any).props?.repositoryURL ?? (obj as any).props?.repositoryUrl;
      const requirement = (obj as any).props?.requirement;
      if (url && !seen.has(url)) {
        packages.push({ url, requirement: formatRequirement(requirement) });
        seen.add(url);
      }
    }
  }
  return packages;
}

async function getLatestVersionFromGit(url: string): Promise<string | null> {
  try {
    const { stdout } = await $`git ls-remote --tags --refs ${url}`.quiet();
    const lines = stdout.toString().split("\n");
    const versions: string[] = [];
    for (const line of lines) {
      if (!line) continue;
      const [, ref] = line.split("\t");
      if (!ref || !ref.startsWith("refs/tags/")) continue;
      const tagName = ref.replace("refs/tags/", "");
      if (tagName.endsWith("^{}")) continue;
      const clean = tagName.startsWith("v") ? tagName.slice(1) : tagName;
      // Only accept tags that look like semantic versions (x.y.z with optional pre-release/build metadata)
      // This filters out non-version tags like "paul-rn-1020-podspecs"
      const parsed = semver.valid(clean);
      if (parsed) {
        versions.push(parsed);
      }
    }
    if (versions.length === 0) return null;
    versions.sort(semver.rcompare);
    return versions[0] ?? null;
  } catch {
    return null;
  }
}

async function getLatestVersions(urls: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(urls));
  const results = await Promise.all(
    unique.map(async (url) => ({
      url,
      latest: await getLatestVersionFromGit(url),
    })),
  );
  const map = new Map<string, string>();
  for (const r of results) {
    if (r.latest) map.set(r.url, r.latest);
  }
  return map;
}

type UpdateChange = {
  url: string;
  prev: string;
  next: string | null;
  latest: string | null;
  updated: boolean;
};

function updateProjectRequirementsToLatest(
  project: XcodeProject,
  latestByUrl: Map<string, string>,
): UpdateChange[] {
  const changes: UpdateChange[] = [];
  for (const [, obj] of project.entries()) {
    if ((obj as any).isa === "XCRemoteSwiftPackageReference") {
      const url: string | undefined =
        (obj as any).props?.repositoryURL ?? (obj as any).props?.repositoryUrl;
      if (!url) continue;
      const prev = (obj as any).props?.requirement;
      const prevText = formatRequirement(prev);
      const latest = latestByUrl.get(url) ?? null;
      if (!latest) {
        changes.push({
          url,
          prev: prevText,
          next: null,
          latest: null,
          updated: false,
        });
        continue;
      }
      const nextRequirement = {
        kind: "upToNextMajorVersion",
        minimumVersion: latest,
      } as any;
      const nextText = formatRequirement(nextRequirement);
      const doUpdate = prevText !== nextText;
      if (doUpdate) {
        (obj as any).props = {
          ...(obj as any).props,
          requirement: nextRequirement,
        };
      }
      changes.push({
        url,
        prev: prevText,
        next: nextText,
        latest,
        updated: doUpdate,
      });
    }
  }
  return changes;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const shouldUpdate = hasUpdateArg(args);
  const targetDirectoryPath = getTargetDirectoryFromArgs(args);
  validateDirectoryPath(targetDirectoryPath);
  const pbxprojPath = findPbxprojFilePath(targetDirectoryPath);
  if (!pbxprojPath) {
    console.error(
      `Error: No .xcodeproj/project.pbxproj found under: ${targetDirectoryPath}`,
    );
    process.exit(1);
  }
  const project = XcodeProject.open(pbxprojPath);
  const packages = getSwiftPackages(project);
  if (packages.length === 0) {
    console.log("No Swift Package dependencies found.");
    return;
  }
  const latestByUrl = await getLatestVersions(packages.map((p) => p.url));
  if (!shouldUpdate) {
    for (const pkg of packages) {
      const latest = latestByUrl.get(pkg.url);
      const suffix = latest ? ` (latest: ${latest})` : " (latest: unknown)";
      console.log(`${pkg.url} \u2192 ${pkg.requirement}${suffix}`);
    }
    return;
  }
  const changes = updateProjectRequirementsToLatest(project, latestByUrl);
  const updatedCount = changes.filter((c) => c.updated).length;
  if (updatedCount > 0) {
    writeFileSync(project.filePath, build(project.toJSON()), "utf8");
  }
  for (const c of changes) {
    if (c.updated && c.next) {
      console.log(
        `${c.url} \u2192 ${c.prev} => ${c.next} (latest: ${c.latest})`,
      );
    } else if (c.latest) {
      console.log(
        `${c.url} \u2192 ${c.prev} (latest: ${c.latest}) [no change]`,
      );
    } else {
      console.log(`${c.url} \u2192 ${c.prev} (latest: unknown) [no change]`);
    }
  }
  console.log(
    `Updated ${updatedCount} package requirement${updatedCount === 1 ? "" : "s"} to upToNextMajorVersion.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
