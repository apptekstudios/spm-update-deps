import { parse } from "@bacons/xcode/json";
import type { Dependency, Requirement } from "./types.ts";
import { identityFromUrl, nameFromUrl } from "./identity.ts";

export interface XcodeHandle {
  /** Object ID of the XCRemoteSwiftPackageReference. */
  id: string;
}

type PbxRequirement = Record<string, string | undefined>;

export function requirementFromPbx(r: PbxRequirement | undefined): Requirement {
  if (!r || typeof r !== "object") return { kind: "unknown", raw: "none" };
  const min = r.minimumVersion ?? "";
  switch (r.kind) {
    case "upToNextMajorVersion":
      return { kind: "upToNextMajor", version: min };
    case "upToNextMinorVersion":
      return { kind: "upToNextMinor", version: min };
    case "exactVersion":
      return { kind: "exact", version: r.version ?? "" };
    case "versionRange":
      // Xcode's "Range of Versions" is half-open: min ..< max.
      return { kind: "range", lower: min, upper: r.maximumVersion ?? "", closed: false };
    case "branch":
      return { kind: "branch", ref: r.branch ?? "" };
    case "revision":
      return { kind: "revision", ref: r.revision ?? "" };
    default:
      return { kind: "unknown", raw: String(r.kind ?? "unknown") };
  }
}

export function requirementToPbx(req: Requirement): [string, string][] {
  switch (req.kind) {
    case "upToNextMajor":
      return [["kind", "upToNextMajorVersion"], ["minimumVersion", req.version]];
    case "upToNextMinor":
      return [["kind", "upToNextMinorVersion"], ["minimumVersion", req.version]];
    case "exact":
      return [["kind", "exactVersion"], ["version", req.version]];
    case "range":
      return [["kind", "versionRange"], ["maximumVersion", req.upper], ["minimumVersion", req.lower]];
    case "branch":
      return [["branch", req.ref], ["kind", "branch"]];
    case "revision":
      return [["kind", "revision"], ["revision", req.ref]];
    case "unknown":
      throw new Error(`cannot write unknown requirement '${req.raw}'`);
  }
}

export function parseXcodeProject(text: string): Dependency[] {
  const json = parse(text) as { objects?: Record<string, any> };
  const deps: Dependency[] = [];
  for (const [id, obj] of Object.entries(json.objects ?? {})) {
    if (obj?.isa === "XCRemoteSwiftPackageReference") {
      const url: string | undefined = obj.repositoryURL;
      if (!url) continue;
      deps.push({
        name: nameFromUrl(url),
        identity: identityFromUrl(url),
        source: "remote",
        url,
        req: requirementFromPbx(readRequirementBlock(text, id) ?? stringify(obj.requirement)),
        handle: { id } satisfies XcodeHandle,
      });
    } else if (obj?.isa === "XCLocalSwiftPackageReference") {
      const path: string = obj.relativePath ?? obj.path ?? "";
      const name = nameFromUrl(path);
      deps.push({ name, identity: name.toLowerCase(), source: "local", req: { kind: "unknown", raw: `path:${path}` }, handle: null });
    }
  }
  return deps.sort((a, b) => a.name.localeCompare(b.name));
}

function stringify(r: Record<string, unknown> | undefined): PbxRequirement | undefined {
  if (!r || typeof r !== "object") return undefined;
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? undefined : String(v)]));
}

/** Same quoting rule as @bacons/xcode's writer. */
function pbxValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return /^[\w$/:.]+$/.test(escaped) ? escaped : `"${escaped}"`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface BlockLocation {
  /** Index just after `requirement = {`. */
  open: number;
  /** Index of the closing `}`. */
  close: number;
  indent: string;
}

/** Finds the `requirement = { ... };` block of one package reference by object ID. */
function locateRequirementBlock(text: string, id: string): BlockLocation | null {
  const head = new RegExp(`^([ \\t]*)${escapeRegExp(id)}\\b[^\\n]*=\\s*\\{`, "m").exec(text);
  if (!head) return null;
  const objStart = head.index + head[0].length;
  const objEnd = text.indexOf("\n" + head[1] + "};", objStart);
  if (objEnd === -1) return null;
  const reqHead = /^([ \t]*)requirement\s*=\s*\{/m.exec(text.slice(objStart, objEnd));
  if (!reqHead) return null;
  const open = objStart + reqHead.index + reqHead[0].length;
  const close = text.indexOf("}", open);
  if (close === -1 || close > objEnd) return null;
  return { open, close, indent: reqHead[1]! };
}

/**
 * Reads requirement fields as raw text. The JSON parser turns unquoted values that look
 * like numbers into numbers (`version = 1.10;` → 1.1), which corrupts versions.
 */
function readRequirementBlock(text: string, id: string): PbxRequirement | null {
  const loc = locateRequirementBlock(text, id);
  if (!loc) return null;
  const out: PbxRequirement = {};
  for (const m of text.slice(loc.open, loc.close).matchAll(/(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;\s]+)\s*;/g)) {
    const v = m[2]!;
    out[m[1]!] = v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v;
  }
  return out;
}

export interface XcodeEdit {
  handle: XcodeHandle;
  name: string;
  next: Requirement;
}

/**
 * Rewrites each edited `requirement = { ... };` block in place, leaving the rest of the file
 * byte-for-byte unchanged. Throws (before anything is written) if a block can't be located;
 * re-serializing the whole project would mangle unrelated numeric-looking values.
 */
export function editXcodeProject(text: string, edits: XcodeEdit[]): string {
  let out = text;
  for (const e of edits) {
    const loc = locateRequirementBlock(out, e.handle.id);
    if (!loc) throw new Error(`can't locate the requirement block for ${e.name} in project.pbxproj; edit it in Xcode`);
    const inner = loc.indent.includes("\t") ? `${loc.indent}\t` : `${loc.indent}  `;
    const body = requirementToPbx(e.next)
      .map(([k, v]) => `\n${inner}${k} = ${pbxValue(v)};`)
      .join("");
    out = out.slice(0, loc.open) + body + "\n" + loc.indent + out.slice(loc.close);
  }
  return out;
}
