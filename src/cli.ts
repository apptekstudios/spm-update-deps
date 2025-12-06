#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { XcodeProject } from "@bacons/xcode";
import { $ } from "bun";
import semver from "semver";
import { build } from "@bacons/xcode/json";

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function extractPackageName(url: string): string {
  const match = url.match(/\/([^/]+?)(\.git)?$/);
  return match?.[1] ?? url;
}

type TableRow = {
  package: string;
  current: string;
  latest: string;
  status: "up-to-date" | "update-available" | "unknown" | "updated" | "skipped";
};

function printTable(rows: TableRow[], title: string): void {
  if (rows.length === 0) return;

  // Calculate column widths
  const headers = ["Package", "Current", "Latest", "Status"];
  const colWidths = [
    Math.max(headers[0].length, ...rows.map((r) => r.package.length)),
    Math.max(headers[1].length, ...rows.map((r) => r.current.length)),
    Math.max(headers[2].length, ...rows.map((r) => r.latest.length)),
    Math.max(headers[3].length, 16), // "Update Available" is 16 chars
  ];

  const totalWidth = colWidths.reduce((a, b) => a + b, 0) + colWidths.length * 3 + 1;
  const horizontalLine = colors.gray + "─".repeat(totalWidth) + colors.reset;

  // Print title
  console.log();
  console.log(`${colors.bold}${colors.cyan}${title}${colors.reset}`);
  console.log(horizontalLine);

  // Print header
  const header = headers
    .map((h, i) => `${colors.bold}${h.padEnd(colWidths[i])}${colors.reset}`)
    .join(` ${colors.gray}│${colors.reset} `);
  console.log(` ${header}`);
  console.log(horizontalLine);

  // Print rows
  for (const row of rows) {
    const statusColor =
      row.status === "up-to-date"
        ? colors.green
        : row.status === "updated"
          ? colors.green
          : row.status === "update-available"
            ? colors.yellow
            : row.status === "skipped"
              ? colors.magenta
              : colors.gray;

    const statusText =
      row.status === "up-to-date"
        ? "Up to date"
        : row.status === "updated"
          ? "Updated"
          : row.status === "update-available"
            ? "Update Available"
            : row.status === "skipped"
              ? "Skipped"
              : "Unknown";

    const latestColor =
      row.status === "update-available" || row.status === "updated"
        ? colors.green
        : row.status === "unknown"
          ? colors.gray
          : colors.reset;

    const rowStr = [
      `${colors.blue}${row.package.padEnd(colWidths[0])}${colors.reset}`,
      `${row.current.padEnd(colWidths[1])}`,
      `${latestColor}${row.latest.padEnd(colWidths[2])}${colors.reset}`,
      `${statusColor}${statusText.padEnd(colWidths[3])}${colors.reset}`,
    ].join(` ${colors.gray}│${colors.reset} `);

    console.log(` ${rowStr}`);
  }

  console.log(horizontalLine);
}

function hasUpdateArg(argv: string[]): boolean {
  return argv.includes("update");
}

function getSkipPackages(argv: string[]): Set<string> {
  const skipPackages = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip" || arg === "-s") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        skipPackages.add(next.toLowerCase());
        i++;
      }
    } else if (arg.startsWith("--skip=")) {
      const value = arg.slice("--skip=".length);
      if (value) {
        skipPackages.add(value.toLowerCase());
      }
    }
  }
  return skipPackages;
}

function shouldSkipPackage(url: string, skipPackages: Set<string>): boolean {
  if (skipPackages.size === 0) return false;
  const packageName = extractPackageName(url).toLowerCase();
  return skipPackages.has(packageName);
}

function getTargetDirectoryFromArgs(argv: string[]): string {
  const positionalPath = argv.find((arg, i) => {
    if (arg === "update" || arg.startsWith("-")) return false;
    // Check if this arg is a value for --skip
    const prevArg = argv[i - 1];
    if (prevArg === "--skip" || prevArg === "-s") return false;
    return true;
  });
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

type RequirementKind = "upToNextMajor" | "upToNextMinor" | "exact" | "branch" | "revision" | "range" | "unknown";

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

function getRequirementKind(requirement: string): RequirementKind {
  if (requirement.startsWith("^")) return "upToNextMajor";
  if (requirement.startsWith("~")) return "upToNextMinor";
  if (requirement.startsWith("exact ")) return "exact";
  if (requirement.startsWith("branch ")) return "branch";
  if (requirement.startsWith("revision ")) return "revision";
  if (requirement.startsWith(">=")) return "range";
  return "unknown";
}

function formatUpdatedRequirement(currentReq: string, latestVersion: string): string {
  const kind = getRequirementKind(currentReq);
  switch (kind) {
    case "exact":
      return `exact ${latestVersion}`;
    case "upToNextMinor":
      return `~${latestVersion}`;
    case "upToNextMajor":
    default:
      return `^${latestVersion}`;
  }
}

function generatePackageSwiftSpec(currentReq: string, latestVersion: string): string {
  const kind = getRequirementKind(currentReq);
  switch (kind) {
    case "exact":
      return `.exact("${latestVersion}")`;
    case "upToNextMinor":
      return `.upToNextMinor(from: "${latestVersion}")`;
    case "upToNextMajor":
    default:
      return `from: "${latestVersion}"`;
  }
}

function getSwiftPackagesFromPackageSwift(packageSwiftPath: string): SwiftPackage[] {
  const content = readFileSync(packageSwiftPath, "utf8");
  const deps = parsePackageSwiftDependencies(content);
  return deps.map((d) => ({ url: d.url, requirement: d.requirement }));
}

function updatePackageSwiftToLatest(
  packageSwiftPath: string,
  latestByUrl: Map<string, string>,
  skipPackages: Set<string>,
): UpdateChange[] {
  const content = readFileSync(packageSwiftPath, "utf8");
  const deps = parsePackageSwiftDependencies(content);
  const changes: UpdateChange[] = [];

  // Process in reverse order to maintain correct indices
  const sortedDeps = [...deps].sort((a, b) => b.startIndex - a.startIndex);
  let newContent = content;

  for (const dep of sortedDeps) {
    const isSkipped = shouldSkipPackage(dep.url, skipPackages);
    const latest = latestByUrl.get(dep.url) ?? null;
    const nextReq = latest ? formatUpdatedRequirement(dep.requirement, latest) : null;
    const doUpdate = !isSkipped && latest !== null && dep.requirement !== nextReq;

    if (doUpdate && latest) {
      const versionSpec = generatePackageSwiftSpec(dep.requirement, latest);
      const newMatch = `.package(url: "${dep.url}", ${versionSpec})`;
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
      skipped: isSkipped,
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
  skipped?: boolean;
};

function createXcodeRequirement(prevRequirement: any, latestVersion: string): any {
  const kind = prevRequirement?.kind ?? prevRequirement?.requirement;
  switch (kind) {
    case "exactVersion":
    case "exact":
      return {
        kind: "exactVersion",
        version: latestVersion,
      };
    case "upToNextMinorVersion":
    case "upToNextMinor":
      return {
        kind: "upToNextMinorVersion",
        minimumVersion: latestVersion,
      };
    case "upToNextMajorVersion":
    case "upToNextMajor":
    default:
      return {
        kind: "upToNextMajorVersion",
        minimumVersion: latestVersion,
      };
  }
}

function updateProjectRequirementsToLatest(
  project: XcodeProject,
  latestByUrl: Map<string, string>,
  skipPackages: Set<string>,
): UpdateChange[] {
  const changes: UpdateChange[] = [];
  for (const [, obj] of project.entries()) {
    if ((obj as any).isa === "XCRemoteSwiftPackageReference") {
      const url: string | undefined =
        (obj as any).props?.repositoryURL ?? (obj as any).props?.repositoryUrl;
      if (!url) continue;
      const isSkipped = shouldSkipPackage(url, skipPackages);
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
          skipped: isSkipped,
        });
        continue;
      }
      const nextRequirement = createXcodeRequirement(prev, latest);
      const nextText = formatRequirement(nextRequirement);
      const doUpdate = !isSkipped && prevText !== nextText;
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
        skipped: isSkipped,
      });
    }
  }
  return changes;
}

function isRequirementUpToDate(requirement: string, latest: string): boolean {
  const kind = getRequirementKind(requirement);
  switch (kind) {
    case "exact":
      return requirement === `exact ${latest}`;
    case "upToNextMinor":
      return requirement === `~${latest}`;
    case "upToNextMajor":
      return requirement === `^${latest}`;
    default:
      return false;
  }
}

function changesToTableRows(changes: UpdateChange[], isUpdateMode: boolean): TableRow[] {
  return changes.map((c) => {
    let status: TableRow["status"];
    if (c.skipped) {
      status = "skipped";
    } else if (c.updated) {
      status = "updated";
    } else if (!c.latest) {
      status = "unknown";
    } else if (isRequirementUpToDate(c.prev, c.latest)) {
      status = "up-to-date";
    } else {
      status = isUpdateMode ? "up-to-date" : "update-available";
    }

    return {
      package: extractPackageName(c.url),
      current: c.prev,
      latest: c.latest ?? "—",
      status,
    };
  });
}

function packagesToTableRows(
  packages: SwiftPackage[],
  latestByUrl: Map<string, string>,
): TableRow[] {
  return packages.map((pkg) => {
    const latest = latestByUrl.get(pkg.url);
    let status: TableRow["status"];
    if (!latest) {
      status = "unknown";
    } else if (isRequirementUpToDate(pkg.requirement, latest)) {
      status = "up-to-date";
    } else {
      status = "update-available";
    }

    return {
      package: extractPackageName(pkg.url),
      current: pkg.requirement,
      latest: latest ?? "—",
      status,
    };
  });
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const shouldUpdate = hasUpdateArg(args);
  const skipPackages = getSkipPackages(args);
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
    console.log();
    console.log(`${colors.yellow}No Swift Package dependencies found.${colors.reset}`);
    console.log();
    return;
  }

  const latestByUrl = await getLatestVersions(uniqueUrls);

  if (!shouldUpdate) {
    let totalUpdatesAvailable = 0;

    if (projectFiles.pbxproj) {
      const project = XcodeProject.open(projectFiles.pbxproj);
      const packages = getSwiftPackagesFromXcode(project);
      const rows = packagesToTableRows(packages, latestByUrl);
      printTable(rows, `Xcode Project`);
      totalUpdatesAvailable += rows.filter((r) => r.status === "update-available").length;
    }

    if (projectFiles.packageSwift) {
      const packages = getSwiftPackagesFromPackageSwift(projectFiles.packageSwift);
      const rows = packagesToTableRows(packages, latestByUrl);
      printTable(rows, `Package.swift`);
      totalUpdatesAvailable += rows.filter((r) => r.status === "update-available").length;
    }

    console.log();
    if (totalUpdatesAvailable > 0) {
      console.log(
        `${colors.yellow}${totalUpdatesAvailable} update${totalUpdatesAvailable === 1 ? "" : "s"} available.${colors.reset} ` +
        `Run with ${colors.cyan}update${colors.reset} to apply changes.`
      );
    } else {
      console.log(`${colors.green}All packages are up to date.${colors.reset}`);
    }
    console.log();
    return;
  }

  let totalUpdated = 0;

  // Update Xcode project
  if (projectFiles.pbxproj) {
    const project = XcodeProject.open(projectFiles.pbxproj);
    const changes = updateProjectRequirementsToLatest(project, latestByUrl, skipPackages);
    const updatedCount = changes.filter((c) => c.updated).length;
    if (updatedCount > 0) {
      writeFileSync(project.filePath, build(project.toJSON()), "utf8");
    }
    const rows = changesToTableRows(changes, true);
    printTable(rows, `Xcode Project`);
    totalUpdated += updatedCount;
  }

  // Update Package.swift
  if (projectFiles.packageSwift) {
    const changes = updatePackageSwiftToLatest(projectFiles.packageSwift, latestByUrl, skipPackages);
    const rows = changesToTableRows(changes, true);
    printTable(rows, `Package.swift`);
    totalUpdated += changes.filter((c) => c.updated).length;
  }

  console.log();
  if (totalUpdated > 0) {
    console.log(
      `${colors.green}✓ Successfully updated ${totalUpdated} package${totalUpdated === 1 ? "" : "s"}.${colors.reset}`
    );
  } else {
    console.log(`${colors.green}All packages are already up to date.${colors.reset}`);
  }
  console.log();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
