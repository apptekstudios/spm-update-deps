import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { identityFromUrl } from "./identity.ts";

export interface Pin {
  version?: string;
  branch?: string;
  revision?: string;
}

/** Parses Package.resolved (format v1, v2 or v3) into identity → pin. */
export function parseResolved(text: string): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return pins;
  }
  const list: any[] = json?.pins ?? json?.object?.pins ?? [];
  for (const p of list) {
    const location: string | undefined = p.location ?? p.repositoryURL;
    const identity: string | undefined = p.identity ?? (location ? identityFromUrl(location) : p.package?.toLowerCase());
    if (!identity) continue;
    const s = p.state ?? {};
    pins.set(identity.toLowerCase(), {
      version: s.version ?? undefined,
      branch: s.branch ?? undefined,
      revision: s.revision ?? undefined,
    });
  }
  return pins;
}

const SWIFTPM_RESOLVED = join("xcshareddata", "swiftpm", "Package.resolved");

/** Finds the Package.resolved that belongs to a manifest. */
export function findResolvedFile(manifestPath: string, type: "package" | "xcodeproj"): string | undefined {
  if (type === "package") {
    const p = join(dirname(manifestPath), "Package.resolved");
    return existsSync(p) ? p : undefined;
  }
  const xcodeproj = dirname(manifestPath);
  const embedded = join(xcodeproj, "project.xcworkspace", SWIFTPM_RESOLVED);
  if (existsSync(embedded)) return embedded;
  // A sibling workspace (e.g. App.xcworkspace next to App.xcodeproj) owns resolution when present.
  const parent = dirname(xcodeproj);
  const stem = basename(xcodeproj, ".xcodeproj");
  let workspaces: string[] = [];
  try {
    workspaces = readdirSync(parent).filter((n) => n.endsWith(".xcworkspace"));
  } catch {
    return undefined;
  }
  workspaces.sort((a, b) => Number(b === `${stem}.xcworkspace`) - Number(a === `${stem}.xcworkspace`));
  for (const ws of workspaces) {
    const p = join(parent, ws, SWIFTPM_RESOLVED);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function readResolved(path: string | undefined): Map<string, Pin> {
  if (!path) return new Map();
  try {
    return parseResolved(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}
