import type { Dependency, Requirement } from "./types.ts";
import { identityFromUrl, nameFromUrl } from "./identity.ts";

/** How a requirement was spelled, so edits keep the author's style. */
export type ReqStyle = "label" | "method" | "range";

export interface PackageSwiftHandle {
  /** Span of the requirement argument within the file. */
  start: number;
  end: number;
  style: ReqStyle;
}

interface Arg {
  start: number;
  end: number;
  text: string;
  label?: string;
}

/** If `src[i]` starts a comment or string literal, returns the index just past it; otherwise `i`. */
function skipTrivia(src: string, i: number): number {
  if (src.startsWith("//", i)) {
    const nl = src.indexOf("\n", i);
    return nl === -1 ? src.length : nl;
  }
  if (src.startsWith("/*", i)) {
    // Swift block comments nest.
    let depth = 1;
    let j = i + 2;
    while (j < src.length && depth > 0) {
      if (src.startsWith("/*", j)) {
        depth++;
        j += 2;
      } else if (src.startsWith("*/", j)) {
        depth--;
        j += 2;
      } else j++;
    }
    return j;
  }
  if (src.startsWith('"""', i)) {
    const close = src.indexOf('"""', i + 3);
    return close === -1 ? src.length : close + 3;
  }
  if (src[i] === '"') {
    let j = i + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") j += 2;
      else if (c === '"') return j + 1;
      else if (c === "\n") return j;
      else j++;
    }
    return j;
  }
  return i;
}

function isIdentChar(c: string | undefined): boolean {
  return !!c && /[A-Za-z0-9_]/.test(c);
}

/** Splits the arguments of a call whose `(` is at `open`. Returns args and the index of the closing `)`. */
function splitArgs(src: string, open: number): { args: Arg[]; close: number } | null {
  const args: Arg[] = [];
  let depth = 0;
  let argStart = open + 1;
  let i = open + 1;
  const push = (end: number) => {
    const raw = src.slice(argStart, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!text) return;
    const start = argStart + lead;
    const label = text.match(/^([A-Za-z_]\w*)\s*:/)?.[1];
    args.push({ start, end: start + text.length, text, label });
  };
  while (i < src.length) {
    const j = skipTrivia(src, i);
    if (j !== i) {
      i = j;
      continue;
    }
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        if (c !== ")") return null;
        push(i);
        return { args, close: i };
      }
      depth--;
    } else if (c === "," && depth === 0) {
      push(i);
      argStart = i + 1;
    }
    i++;
  }
  return null;
}

const STR = `"([^"\\\\]*)"`;

/** Parses the text of a single requirement argument. */
export function parseRequirementArg(text: string): { req: Requirement; style: ReqStyle } {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(new RegExp(`^from\\s*:\\s*${STR}$`)))) return { req: { kind: "upToNextMajor", version: m[1]! }, style: "label" };
  if ((m = t.match(new RegExp(`^\\.upToNextMajor\\s*\\(\\s*from\\s*:\\s*${STR}\\s*\\)$`))))
    return { req: { kind: "upToNextMajor", version: m[1]! }, style: "method" };
  if ((m = t.match(new RegExp(`^\\.upToNextMinor\\s*\\(\\s*from\\s*:\\s*${STR}\\s*\\)$`))))
    return { req: { kind: "upToNextMinor", version: m[1]! }, style: "method" };
  if ((m = t.match(new RegExp(`^exact\\s*:\\s*${STR}$`)))) return { req: { kind: "exact", version: m[1]! }, style: "label" };
  if ((m = t.match(new RegExp(`^\\.exact\\s*\\(\\s*${STR}\\s*\\)$`)))) return { req: { kind: "exact", version: m[1]! }, style: "method" };
  if ((m = t.match(new RegExp(`^branch\\s*:\\s*${STR}$`)))) return { req: { kind: "branch", ref: m[1]! }, style: "label" };
  if ((m = t.match(new RegExp(`^\\.branch\\s*\\(\\s*${STR}\\s*\\)$`)))) return { req: { kind: "branch", ref: m[1]! }, style: "method" };
  if ((m = t.match(new RegExp(`^revision\\s*:\\s*${STR}$`)))) return { req: { kind: "revision", ref: m[1]! }, style: "label" };
  if ((m = t.match(new RegExp(`^\\.revision\\s*\\(\\s*${STR}\\s*\\)$`)))) return { req: { kind: "revision", ref: m[1]! }, style: "method" };
  if ((m = t.match(new RegExp(`^${STR}\\s*(\\.\\.<|\\.\\.\\.)\\s*${STR}$`))))
    return { req: { kind: "range", lower: m[1]!, upper: m[3]!, closed: m[2] === "..." }, style: "range" };
  return { req: { kind: "unknown", raw: t }, style: "label" };
}

/** Renders a requirement argument, keeping `style` when the kind is unchanged. */
export function renderRequirementArg(req: Requirement, style: ReqStyle, prevKind: Requirement["kind"]): string {
  const keep = req.kind === prevKind;
  switch (req.kind) {
    case "upToNextMajor":
      return keep && style === "method" ? `.upToNextMajor(from: "${req.version}")` : `from: "${req.version}"`;
    case "upToNextMinor":
      return `.upToNextMinor(from: "${req.version}")`;
    case "exact":
      return keep && style === "method" ? `.exact("${req.version}")` : `exact: "${req.version}"`;
    case "range":
      return `"${req.lower}"${req.closed ? "..." : "..<"}"${req.upper}"`;
    case "branch":
      return keep && style === "method" ? `.branch("${req.ref}")` : `branch: "${req.ref}"`;
    case "revision":
      return keep && style === "method" ? `.revision("${req.ref}")` : `revision: "${req.ref}"`;
    case "unknown":
      return req.raw;
  }
}

function stringLiteral(text: string): string | null {
  return text.match(new RegExp(`^${STR}$`))?.[1] ?? null;
}

export function parsePackageSwift(src: string): Dependency[] {
  const deps: Dependency[] = [];
  let i = 0;
  while (i < src.length) {
    const j = skipTrivia(src, i);
    if (j !== i) {
      i = j;
      continue;
    }
    if (src.startsWith(".package", i) && !isIdentChar(src[i + 8])) {
      let k = i + 8;
      while (/\s/.test(src[k] ?? "")) k++;
      if (src[k] === "(") {
        const call = splitArgs(src, k);
        if (call) {
          const dep = depFromArgs(call.args);
          if (dep) deps.push(dep);
          i = call.close + 1;
          continue;
        }
      }
    }
    i++;
  }
  return deps;
}

function argValue(arg: Arg): string {
  return arg.text.slice(arg.text.indexOf(":") + 1).trim();
}

function depFromArgs(args: Arg[]): Dependency | null {
  const byLabel = (l: string) => args.findIndex((a) => a.label === l);
  const nameArg = args[byLabel("name")];
  const explicitName = nameArg ? stringLiteral(argValue(nameArg)) : null;

  const pathIdx = byLabel("path");
  if (pathIdx !== -1) {
    const path = stringLiteral(argValue(args[pathIdx]!)) ?? argValue(args[pathIdx]!);
    const name = explicitName ?? nameFromUrl(path);
    return { name, identity: name.toLowerCase(), source: "local", req: { kind: "unknown", raw: `path:${path}` }, handle: null };
  }

  const idIdx = byLabel("id");
  const urlIdx = byLabel("url");
  const keyIdx = urlIdx !== -1 ? urlIdx : idIdx;
  if (keyIdx === -1) return null;
  const keyValue = stringLiteral(argValue(args[keyIdx]!));
  if (!keyValue) return null;

  const reqArg = args[keyIdx + 1];
  const { req, style } = reqArg ? parseRequirementArg(reqArg.text) : { req: { kind: "unknown", raw: "" } as Requirement, style: "label" as ReqStyle };
  const handle: PackageSwiftHandle | null = reqArg ? { start: reqArg.start, end: reqArg.end, style } : null;

  if (urlIdx === -1) {
    // Registry dependency: `.package(id: "scope.name", from: "1.0.0")`
    const name = keyValue.split(".").pop() ?? keyValue;
    return { name: explicitName ?? name, identity: keyValue.toLowerCase(), source: "registry", req, handle };
  }
  return {
    name: explicitName ?? nameFromUrl(keyValue),
    identity: identityFromUrl(keyValue),
    source: "remote",
    url: keyValue,
    req,
    handle,
  };
}

export interface PackageSwiftEdit {
  handle: PackageSwiftHandle;
  prev: Requirement;
  next: Requirement;
}

/** Applies requirement edits, touching only each requirement argument's text. */
export function editPackageSwift(src: string, edits: PackageSwiftEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.handle.start - a.handle.start);
  let out = src;
  for (const e of sorted) {
    const text = renderRequirementArg(e.next, e.handle.style, e.prev.kind);
    out = out.slice(0, e.handle.start) + text + out.slice(e.handle.end);
  }
  return out;
}
