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

const PBX_VALUE = String.raw`("(?:[^"\\]|\\.)*"|[^;\s]+)`;

function pbxUnquote(v: string): string {
  return v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v;
}

function pbxField(body: string, key: string): string | undefined {
  const m = new RegExp(String.raw`(?:^|[\s{;])${key}\s*=\s*${PBX_VALUE}\s*;`).exec(body);
  return m ? pbxUnquote(m[1]!) : undefined;
}

/**
 * Finds Swift package reference objects by scanning the text rather than parsing the whole
 * project: a full parse of a large project.pbxproj (~1MB) takes most of a second, and only
 * these few objects matter. Keys are sorted in pbxproj files, so `isa` precedes any nested `{`.
 */
function scanPackageObjects(text: string): { id: string; isa: string; body: string }[] {
  const out: { id: string; isa: string; body: string }[] = [];
  const isaRe = /\bisa\s*=\s*"?(XCRemoteSwiftPackageReference|XCLocalSwiftPackageReference)"?\s*;/g;
  for (const m of text.matchAll(isaRe)) {
    const open = text.lastIndexOf("{", m.index);
    const lineStart = text.lastIndexOf("\n", open) + 1;
    const header = /^([ \t]*)"?([A-Za-z0-9_]+)"?/.exec(text.slice(lineStart, open));
    if (!header) continue;
    const close = text.indexOf(`\n${header[1]}};`, open);
    out.push({ id: header[2]!, isa: m[1]!, body: text.slice(open + 1, close === -1 ? undefined : close) });
  }
  return out;
}

export function parseXcodeProject(text: string): Dependency[] {
  const deps: Dependency[] = [];
  for (const { id, isa, body } of scanPackageObjects(text)) {
    if (isa === "XCRemoteSwiftPackageReference") {
      const url = pbxField(body, "repositoryURL");
      if (!url) continue;
      deps.push({
        name: nameFromUrl(url),
        identity: identityFromUrl(url),
        source: "remote",
        url,
        req: requirementFromPbx(readRequirementBlock(text, id) ?? undefined),
        handle: { id } satisfies XcodeHandle,
      });
    } else {
      const path = pbxField(body, "relativePath") ?? pbxField(body, "path") ?? "";
      const name = nameFromUrl(path);
      deps.push({ name, identity: name.toLowerCase(), source: "local", req: { kind: "unknown", raw: `path:${path}` }, handle: null });
    }
  }
  return deps.sort((a, b) => a.name.localeCompare(b.name));
}

/** Quotes values the way Xcode does: bare words for [A-Za-z0-9_$/:.], quoted otherwise. */
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
  for (const m of text.slice(loc.open, loc.close).matchAll(new RegExp(String.raw`(\w+)\s*=\s*${PBX_VALUE}\s*;`, "g"))) {
    out[m[1]!] = pbxUnquote(m[2]!);
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
