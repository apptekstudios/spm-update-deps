import { build, parse } from "@bacons/xcode/json";
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
        req: requirementFromPbx(obj.requirement),
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

/** Same quoting rule as @bacons/xcode's writer. */
function pbxValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return /^[\w$/:.]+$/.test(escaped) ? escaped : `"${escaped}"`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites the `requirement = { ... };` block of one package reference in place,
 * leaving the rest of the file byte-for-byte unchanged. Returns null if the block can't be located.
 */
function replaceRequirementBlock(text: string, id: string, req: Requirement): string | null {
  const head = new RegExp(`^([ \\t]*)${escapeRegExp(id)}\\b[^\\n]*=\\s*\\{`, "m").exec(text);
  if (!head) return null;
  const objStart = head.index + head[0].length;
  const objEnd = text.indexOf("\n" + head[1] + "};", objStart);
  if (objEnd === -1) return null;
  const reqHead = /^([ \t]*)requirement\s*=\s*\{/m.exec(text.slice(objStart, objEnd));
  if (!reqHead) return null;
  const blockOpen = objStart + reqHead.index + reqHead[0].length;
  const blockClose = text.indexOf("}", blockOpen);
  if (blockClose === -1 || blockClose > objEnd) return null;
  const indent = reqHead[1]!;
  const inner = indent.includes("\t") ? `${indent}\t` : `${indent}  `;
  const body = requirementToPbx(req)
    .map(([k, v]) => `\n${inner}${k} = ${pbxValue(v)};`)
    .join("");
  return text.slice(0, blockOpen) + body + "\n" + indent + text.slice(blockClose);
}

export interface XcodeEdit {
  handle: XcodeHandle;
  next: Requirement;
}

export function editXcodeProject(text: string, edits: XcodeEdit[]): string {
  let out: string | null = text;
  for (const e of edits) {
    out = out && replaceRequirementBlock(out, e.handle.id, e.next);
  }
  if (out !== null) return out;
  // Fallback: full re-serialization (may reformat the file, but stays valid).
  const json = parse(text) as { objects: Record<string, any> };
  for (const e of edits) {
    const obj = json.objects[e.handle.id];
    if (obj) obj.requirement = Object.fromEntries(requirementToPbx(e.next));
  }
  return build(json);
}
