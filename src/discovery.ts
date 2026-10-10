import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Manifest, ManifestType } from "./types.ts";
import { parsePackageSwift } from "./packageSwift.ts";
import { parseXcodeProject } from "./xcode.ts";
import { findResolvedFile } from "./resolved.ts";

const IGNORED_DIRS = new Set([
  ".build",
  ".git",
  ".swiftpm",
  "Pods",
  "Carthage",
  "DerivedData",
  "node_modules",
  "SourcePackages",
  "checkouts",
]);

export class UsageError extends Error {}

interface Found {
  path: string;
  type: ManifestType;
}

function scanDir(dir: string, recursive: boolean, depth: number, out: Found[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile() && e.name === "Package.swift") {
      out.push({ path: full, type: "package" });
    } else if (e.isDirectory() && e.name.endsWith(".xcodeproj")) {
      const pbx = join(full, "project.pbxproj");
      if (existsSync(pbx)) out.push({ path: pbx, type: "xcodeproj" });
    } else if (
      recursive &&
      depth < 6 &&
      e.isDirectory() &&
      !IGNORED_DIRS.has(e.name) &&
      !e.name.startsWith(".") &&
      !e.name.endsWith(".xcworkspace")
    ) {
      scanDir(full, recursive, depth + 1, out);
    }
  }
}

/** Resolves the target path to a root directory and the manifest files to inspect. */
export function findManifestFiles(target: string, recursive: boolean): { root: string; files: Found[] } {
  const abs = resolve(target);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new UsageError(`path not found: ${target}`);
  }
  if (st.isFile()) {
    const name = basename(abs);
    if (name === "Package.swift") return { root: dirname(abs), files: [{ path: abs, type: "package" }] };
    if (name === "project.pbxproj") return { root: dirname(dirname(abs)), files: [{ path: abs, type: "xcodeproj" }] };
    throw new UsageError(`not a Package.swift or project.pbxproj: ${target}`);
  }
  if (abs.endsWith(".xcodeproj")) {
    const pbx = join(abs, "project.pbxproj");
    if (!existsSync(pbx)) throw new UsageError(`no project.pbxproj in ${target}`);
    return { root: dirname(abs), files: [{ path: pbx, type: "xcodeproj" }] };
  }
  const files: Found[] = [];
  scanDir(abs, recursive, 0, files);
  if (files.length === 0) {
    throw new UsageError(
      `no Package.swift or .xcodeproj in ${target}${recursive ? "" : " (try --recursive)"}`,
    );
  }
  return { root: abs, files };
}

export function loadManifest(root: string, f: Found): Manifest {
  const text = readFileSync(f.path, "utf8");
  const deps = f.type === "package" ? parsePackageSwift(text) : parseXcodeProject(text);
  const labelPath = f.type === "xcodeproj" ? dirname(f.path) : f.path;
  return {
    path: f.path,
    label: relative(root, labelPath) || basename(labelPath),
    type: f.type,
    resolvedPath: findResolvedFile(f.path, f.type),
    deps,
  };
}

export function loadManifests(target: string, recursive: boolean): { root: string; manifests: Manifest[] } {
  const { root, files } = findManifestFiles(target, recursive);
  return { root, manifests: files.map((f) => loadManifest(root, f)) };
}
