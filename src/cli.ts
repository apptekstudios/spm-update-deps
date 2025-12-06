#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

type ProjectFiles = {
  pbxproj: string | null;
  packageSwift: string | null;
};

function findProjectFiles(rootDir: string): ProjectFiles {
  const result: ProjectFiles = { pbxproj: null, packageSwift: null };
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "Package.swift") {
      result.packageSwift = resolve(rootDir, entry.name);
    }
    if (entry.isDirectory() && entry.name.endsWith(".xcodeproj")) {
      const candidate = resolve(rootDir, entry.name, "project.pbxproj");
      try {
        const stats = statSync(candidate);
        if (stats.isFile()) {
          result.pbxproj = candidate;
        }
      } catch {
        // ignore
      }
    }
  }
  return result;
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

function getSwiftPackagesFromXcode(project: XcodeProject): SwiftPackage[] {
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

type PackageSwiftDependency = {
  url: string;
  requirement: string;
  match: string;
  startIndex: number;
  endIndex: number;
};

function parsePackageSwiftDependencies(content: string): PackageSwiftDependency[] {
  const deps: PackageSwiftDependency[] = [];
  const seen = new Set<string>();

  // Match .package(url: "...", ...) patterns
  // Supports various version specifications:
  // - from: "1.0.0"
  // - .upToNextMajor(from: "1.0.0")
  // - .upToNextMinor(from: "1.0.0")
  // - exact: "1.0.0"
  // - .exact("1.0.0")
  // - branch: "main"
  // - .branch("main")
  // - revision: "abc123"
  // - .revision("abc123")
  // - "1.0.0"..<"2.0.0" or "1.0.0"..."2.0.0"
  const packageRegex = /\.package\s*\(\s*url\s*:\s*"([^"]+)"\s*,\s*([^)]+)\)/g;

  let match;
  while ((match = packageRegex.exec(content)) !== null) {
    const url = match[1];
    const versionSpec = match[2].trim();
    const requirement = parseVersionSpec(versionSpec);

    if (!seen.has(url)) {
      deps.push({
        url,
        requirement,
        match: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
      seen.add(url);
    }
  }

  return deps;
}

function parseVersionSpec(spec: string): string {
  // from: "X.Y.Z"
  let m = spec.match(/from\s*:\s*"([^"]+)"/);
  if (m) return `^${m[1]}`;

  // .upToNextMajor(from: "X.Y.Z")
  m = spec.match(/\.upToNextMajor\s*\(\s*from\s*:\s*"([^"]+)"\s*\)/);
  if (m) return `^${m[1]}`;

  // .upToNextMinor(from: "X.Y.Z")
  m = spec.match(/\.upToNextMinor\s*\(\s*from\s*:\s*"([^"]+)"\s*\)/);
  if (m) return `~${m[1]}`;

  // exact: "X.Y.Z"
  m = spec.match(/exact\s*:\s*"([^"]+)"/);
  if (m) return `exact ${m[1]}`;

  // .exact("X.Y.Z")
  m = spec.match(/\.exact\s*\(\s*"([^"]+)"\s*\)/);
  if (m) return `exact ${m[1]}`;

  // branch: "name"
  m = spec.match(/branch\s*:\s*"([^"]+)"/);
  if (m) return `branch ${m[1]}`;

  // .branch("name")
  m = spec.match(/\.branch\s*\(\s*"([^"]+)"\s*\)/);
  if (m) return `branch ${m[1]}`;

  // revision: "hash"
  m = spec.match(/revision\s*:\s*"([^"]+)"/);
  if (m) return `revision ${m[1]}`;

  // .revision("hash")
  m = spec.match(/\.revision\s*\(\s*"([^"]+)"\s*\)/);
  if (m) return `revision ${m[1]}`;

  // Range: "X.Y.Z"..<"A.B.C" or "X.Y.Z"..."A.B.C"
  m = spec.match(/"([^"]+)"\s*\.\.<?\.?\s*"([^"]+)"/);
  if (m) return `>=${m[1]} <${m[2]}`;

  return spec.trim();
}

function getSwiftPackagesFromPackageSwift(packageSwiftPath: string): SwiftPackage[] {
  const content = readFileSync(packageSwiftPath, "utf8");
  const deps = parsePackageSwiftDependencies(content);
  return deps.map((d) => ({ url: d.url, requirement: d.requirement }));
}

function updatePackageSwiftToLatest(
  packageSwiftPath: string,
  latestByUrl: Map<string, string>,
): UpdateChange[] {
  const content = readFileSync(packageSwiftPath, "utf8");
  const deps = parsePackageSwiftDependencies(content);
  const changes: UpdateChange[] = [];

  // Process in reverse order to maintain correct indices
  const sortedDeps = [...deps].sort((a, b) => b.startIndex - a.startIndex);
  let newContent = content;

  for (const dep of sortedDeps) {
    const latest = latestByUrl.get(dep.url) ?? null;
    const nextReq = latest ? `^${latest}` : null;
    const doUpdate = latest !== null && dep.requirement !== nextReq;

    if (doUpdate && latest) {
      const newMatch = `.package(url: "${dep.url}", from: "${latest}")`;
      newContent =
        newContent.slice(0, dep.startIndex) +
        newMatch +
        newContent.slice(dep.endIndex);
    }

    changes.push({
      url: dep.url,
      prev: dep.requirement,
      next: nextReq,
      latest,
      updated: doUpdate,
    });
  }

  const updatedCount = changes.filter((c) => c.updated).length;
  if (updatedCount > 0) {
    writeFileSync(packageSwiftPath, newContent, "utf8");
  }

  // Return in original order
  return changes.reverse();
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
      if (parsed && !semver.prerelease(parsed)) {
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

function printChanges(changes: UpdateChange[]): void {
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
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const shouldUpdate = hasUpdateArg(args);
  const targetDirectoryPath = getTargetDirectoryFromArgs(args);
  validateDirectoryPath(targetDirectoryPath);
  const projectFiles = findProjectFiles(targetDirectoryPath);

  if (!projectFiles.pbxproj && !projectFiles.packageSwift) {
    console.error(
      `Error: No .xcodeproj/project.pbxproj or Package.swift found under: ${targetDirectoryPath}`,
    );
    process.exit(1);
  }

  // Collect packages from all sources
  const allPackages: SwiftPackage[] = [];

  if (projectFiles.pbxproj) {
    const project = XcodeProject.open(projectFiles.pbxproj);
    const xcodePackages = getSwiftPackagesFromXcode(project);
    allPackages.push(...xcodePackages);
  }

  if (projectFiles.packageSwift) {
    const packageSwiftPackages = getSwiftPackagesFromPackageSwift(
      projectFiles.packageSwift,
    );
    allPackages.push(...packageSwiftPackages);
  }

  // Dedupe by URL for fetching latest versions
  const uniqueUrls = [...new Set(allPackages.map((p) => p.url))];

  if (uniqueUrls.length === 0) {
    console.log("No Swift Package dependencies found.");
    return;
  }

  const latestByUrl = await getLatestVersions(uniqueUrls);

  if (!shouldUpdate) {
    if (projectFiles.pbxproj) {
      console.log(`Xcode project: ${projectFiles.pbxproj}`);
      const project = XcodeProject.open(projectFiles.pbxproj);
      const packages = getSwiftPackagesFromXcode(project);
      for (const pkg of packages) {
        const latest = latestByUrl.get(pkg.url);
        const suffix = latest ? ` (latest: ${latest})` : " (latest: unknown)";
        console.log(`  ${pkg.url} \u2192 ${pkg.requirement}${suffix}`);
      }
    }
    if (projectFiles.packageSwift) {
      console.log(`Package.swift: ${projectFiles.packageSwift}`);
      const packages = getSwiftPackagesFromPackageSwift(projectFiles.packageSwift);
      for (const pkg of packages) {
        const latest = latestByUrl.get(pkg.url);
        const suffix = latest ? ` (latest: ${latest})` : " (latest: unknown)";
        console.log(`  ${pkg.url} \u2192 ${pkg.requirement}${suffix}`);
      }
    }
    return;
  }

  let totalUpdated = 0;

  // Update Xcode project
  if (projectFiles.pbxproj) {
    console.log(`Xcode project: ${projectFiles.pbxproj}`);
    const project = XcodeProject.open(projectFiles.pbxproj);
    const changes = updateProjectRequirementsToLatest(project, latestByUrl);
    const updatedCount = changes.filter((c) => c.updated).length;
    if (updatedCount > 0) {
      writeFileSync(project.filePath, build(project.toJSON()), "utf8");
    }
    printChanges(changes);
    totalUpdated += updatedCount;
  }

  // Update Package.swift
  if (projectFiles.packageSwift) {
    console.log(`Package.swift: ${projectFiles.packageSwift}`);
    const changes = updatePackageSwiftToLatest(projectFiles.packageSwift, latestByUrl);
    printChanges(changes);
    totalUpdated += changes.filter((c) => c.updated).length;
  }

  console.log(
    `Updated ${totalUpdated} package requirement${totalUpdated === 1 ? "" : "s"}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
