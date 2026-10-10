import { relative } from "node:path";
import type { CheckedDep, Manifest } from "./types.ts";
import type { Plan } from "./apply.ts";
import { formatRequirement } from "./requirement.ts";

export type Format = "table" | "tsv" | "json";

export interface Style {
  color: boolean;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;
type Color = keyof typeof ANSI;

function paint(s: Style, color: Color, text: string): string {
  return s.color ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string) => s.replace(ANSI_RE, "").length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleLength(s)));

/** Drops undefined/false/empty values so JSON stays small. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

function json(value: unknown, pretty: boolean): string {
  return JSON.stringify(value, null, pretty ? 2 : undefined);
}

// --- check -----------------------------------------------------------------

export interface CheckOptions {
  format: Format;
  style: Style;
  pretty: boolean;
  /** Max versions to list per dependency (0 = omit). */
  versions: number;
  urls: boolean;
}

export interface Summary {
  total: number;
  outdated: number;
  major: number;
  minor: number;
  patch: number;
  pinned: number;
  error: number;
}

export function summarize(checked: CheckedDep[]): Summary {
  const s: Summary = { total: checked.length, outdated: 0, major: 0, minor: 0, patch: 0, pinned: 0, error: 0 };
  for (const { a } of checked) {
    if (a.status === "outdated") {
      s.outdated++;
      if (a.update !== "none") s[a.update]++;
    } else if (a.status === "pinned") s.pinned++;
    else if (a.status === "error" || a.status === "registry") s.error++;
  }
  return s;
}

/** Short status token shared by the TSV and plain-table formats. */
function statusToken(c: CheckedDep): string {
  const { a } = c;
  switch (a.status) {
    case "outdated":
      return a.update;
    case "up-to-date":
      return "ok";
    case "error":
    case "registry":
      return `error: ${a.err}`;
    default:
      return a.status;
  }
}

export function renderCheck(root: string, manifests: Manifest[], all: CheckedDep[], shown: CheckedDep[], o: CheckOptions): string {
  const summary = summarize(all);
  if (o.format === "json") {
    return json(
      {
        v: 1,
        root,
        manifests: manifests.map((m) =>
          compact({ path: m.label, type: m.type, resolved: m.resolvedPath ? relative(root, m.resolvedPath) : undefined }),
        ),
        deps: shown.map(({ m, dep, a }) =>
          compact({
            m,
            name: dep.name,
            url: dep.url,
            req: formatRequirement(dep.req),
            resolved: a.resolved,
            status: a.status,
            update: a.update === "none" ? undefined : a.update,
            patch: a.patch,
            minor: a.minor,
            major: a.major,
            latest: a.status === "pinned" ? a.latest : undefined,
            inRange: a.status === "outdated" ? a.inRange : undefined,
            err: a.err,
            versions: o.versions > 0 ? a.newer.slice(0, o.versions) : undefined,
          }),
        ),
        summary: compact({ ...summary, major: summary.major || undefined, minor: summary.minor || undefined, patch: summary.patch || undefined, pinned: summary.pinned || undefined, error: summary.error || undefined }),
      },
      o.pretty,
    );
  }
  if (o.format === "tsv") return renderCheckTsv(manifests, shown, o);
  return renderCheckTable(manifests, shown, summary, o);
}

function renderCheckTsv(manifests: Manifest[], shown: CheckedDep[], o: CheckOptions): string {
  const lines: string[] = [];
  lines.push(manifests.map((m, i) => `#${i} ${m.label}`).join("\t"));
  const head = ["m", "pkg", "req", "resolved", "patch", "minor", "major", "status"];
  if (o.urls) head.push("url");
  if (o.versions > 0) head.push("versions");
  lines.push(head.join("\t"));
  for (const c of shown) {
    const { a, dep } = c;
    const row = [
      String(c.m),
      dep.name,
      formatRequirement(dep.req),
      a.resolved ?? "-",
      a.patch ?? "-",
      a.minor ?? "-",
      (a.status === "pinned" ? a.latest : a.major) ?? "-",
      statusToken(c),
    ];
    if (o.urls) row.push(dep.url ?? "-");
    if (o.versions > 0) row.push(a.newer.slice(0, o.versions).join(",") || "-");
    lines.push(row.join("\t"));
  }
  return lines.join("\n");
}

function renderCheckTable(manifests: Manifest[], shown: CheckedDep[], summary: Summary, o: CheckOptions): string {
  const s = o.style;
  const fancy = s.color;
  const empty = fancy ? paint(s, "gray", "—") : "-";
  const out: string[] = [];

  const statusCell = (c: CheckedDep): string => {
    const { a, dep } = c;
    switch (a.status) {
      case "outdated":
        return paint(s, a.update === "major" ? "red" : a.update === "minor" ? "yellow" : "cyan", `${a.update} update`);
      case "up-to-date":
        return paint(s, "green", "up to date");
      case "pinned":
        return paint(s, "magenta", `pinned${a.latest ? ` (latest ${a.latest})` : ""}`);
      case "local":
        return paint(s, "gray", "local");
      default:
        return paint(s, "red", `${a.status === "registry" ? "unsupported" : "error"}: ${a.err ?? "unknown"}`);
    }
  };

  for (let mi = 0; mi < manifests.length; mi++) {
    const rows = shown.filter((c) => c.m === mi);
    const m = manifests[mi]!;
    if (rows.length === 0) continue;
    const header = ["Package", "Requirement", "Resolved", "Patch", "Minor", "Major", "Status"];
    if (o.urls) header.push("URL");
    const cells = rows.map((c) => {
      const { a, dep } = c;
      const row = [
        paint(s, "bold", dep.name),
        formatRequirement(dep.req),
        a.resolved ?? empty,
        a.patch ? paint(s, "cyan", a.patch) : empty,
        a.minor ? paint(s, "yellow", a.minor) : empty,
        a.major ? paint(s, "red", a.major) : empty,
        statusCell(c),
      ];
      if (o.urls) row.push(dep.url ?? empty);
      return row;
    });
    const widths = header.map((h, i) => Math.max(h.length, ...cells.map((r) => visibleLength(r[i]!))));
    const sep = fancy ? paint(s, "gray", " │ ") : "  ";
    const line = (r: string[]) => (fancy ? " " : "") + r.map((v, i) => (i === r.length - 1 ? v : pad(v, widths[i]!))).join(sep);
    const total = widths.reduce((x, y) => x + y, 0) + (widths.length - 1) * (fancy ? 3 : 2) + (fancy ? 2 : 0);
    const rule = paint(s, "gray", "─".repeat(total));

    if (out.length) out.push("");
    out.push(fancy ? paint(s, "cyan", paint(s, "bold", m.label)) : `# ${m.label}`);
    if (fancy) out.push(rule);
    out.push(line(header.map((h) => paint(s, "bold", h))));
    if (fancy) out.push(rule);
    for (const r of cells) out.push(line(r));
    if (fancy) out.push(rule);
  }

  if (shown.length === 0 && summary.outdated === 0) {
    out.push(fancy ? paint(s, "green", "✓ All packages are up to date.") : "all packages up to date");
    return out.join("\n");
  }
  out.push("");
  out.push(...footer(shown, summary, s));
  return out.join("\n");
}

function footer(shown: CheckedDep[], summary: Summary, s: Style): string[] {
  const fancy = s.color;
  const lines: string[] = [];
  const parts = (["major", "minor", "patch"] as const).filter((k) => summary[k] > 0).map((k) => `${summary[k]} ${k}`);
  if (summary.outdated === 0) {
    lines.push(fancy ? paint(s, "green", "✓ All packages are up to date.") : "all packages up to date");
  } else {
    const head = `${summary.outdated} outdated${parts.length ? ` (${parts.join(", ")})` : ""}`;
    lines.push(fancy ? paint(s, "yellow", paint(s, "bold", head)) : head);
  }
  if (summary.pinned) lines.push(fancy ? paint(s, "magenta", `${summary.pinned} pinned to a branch/revision`) : `${summary.pinned} pinned`);
  if (summary.error) lines.push(fancy ? paint(s, "red", `${summary.error} could not be checked`) : `${summary.error} error${summary.error === 1 ? "" : "s"}`);

  if (summary.outdated > 0) {
    const majors = [...new Set(shown.filter((c) => c.a.update === "major").map((c) => c.dep.name))];
    const cmds: [string, string][] = [];
    if (summary.minor + summary.patch > 0 || majors.length < summary.outdated) {
      cmds.push(["spm-update update --level minor", "apply non-breaking updates"]);
    }
    if (majors.length) cmds.push([`spm-update apply ${majors.map((n) => `${n}@major`).join(" ")}`, "apply breaking updates"]);
    if (fancy) {
      cmds.push(["spm-update -i", "choose interactively"]);
      lines.push("");
      lines.push(paint(s, "dim", "Next steps:"));
      const w = Math.max(...cmds.map(([c]) => c.length));
      for (const [cmd, why] of cmds) lines.push(`  ${paint(s, "cyan", cmd.padEnd(w))}  ${paint(s, "dim", `# ${why}`)}`);
      lines.push("");
      lines.push(paint(s, "dim", "Requirement = what the manifest allows; Resolved = version locked in Package.resolved."));
    } else {
      lines.push(`next: ${cmds.map(([c]) => c).join(" | ")}`);
    }
  }
  return lines;
}

// --- apply / update ----------------------------------------------------------

export interface PlanOptions {
  format: Format;
  style: Style;
  pretty: boolean;
  dryRun: boolean;
  quiet: boolean;
  next?: string;
  /** Print the per-change lines (default true). */
  list?: boolean;
  /** Print the closing summary line (default true). */
  footer?: boolean;
}

export function renderPlan(plan: Plan, manifests: Manifest[], o: PlanOptions): string {
  if (o.format === "json") {
    return json(
      compact({
        v: 1,
        dryRun: o.dryRun,
        changes: plan.changes.map((c) => ({ m: c.m, name: c.name, from: formatRequirement(c.from), to: formatRequirement(c.to) })),
        skipped: plan.skipped.map((k) => ({ m: k.m, name: k.name, reason: k.reason })),
        errors: plan.errors,
        next: plan.errors.length === 0 && !o.dryRun ? o.next : undefined,
      }),
      o.pretty,
    );
  }
  const s = o.style;
  const fancy = s.color && o.format === "table";
  const multi = new Set(plan.changes.map((c) => c.m)).size > 1 || manifests.length > 1;
  const where = (m: number) => (multi ? `  ${fancy ? paint(s, "gray", `(${manifests[m]!.label})`) : `(${manifests[m]!.label})`}` : "");
  const lines: string[] = [];

  for (const e of plan.errors) lines.push(fancy ? paint(s, "red", `✗ ${e}`) : `error: ${e}`);
  if (o.quiet) return lines.join("\n");

  if (plan.errors.length === 0 && o.list !== false) {
    const nameW = Math.max(0, ...plan.changes.map((c) => c.name.length));
    const fromW = Math.max(0, ...plan.changes.map((c) => formatRequirement(c.from).length));
    for (const c of plan.changes) {
      const from = formatRequirement(c.from);
      const to = formatRequirement(c.to);
      if (fancy) {
        const mark = o.dryRun ? paint(s, "yellow", "~") : paint(s, "green", "✓");
        lines.push(`${mark} ${paint(s, "bold", c.name.padEnd(nameW))}  ${from.padEnd(fromW)} → ${paint(s, "green", to)}${where(c.m)}`);
      } else {
        lines.push(`${c.name}\t${from} -> ${to}${where(c.m)}`);
      }
    }
    for (const k of plan.skipped) {
      lines.push(fancy ? paint(s, "gray", `- ${k.name}: ${k.reason}`) : `skip ${k.name}: ${k.reason}`);
    }
  }

  if (o.footer === false) return lines.join("\n");
  const n = plan.changes.length;
  const noun = `${n} change${n === 1 ? "" : "s"}`;
  if (plan.errors.length) {
    lines.push(fancy ? paint(s, "red", "Nothing written.") : "nothing written");
  } else if (n === 0) {
    lines.push(fancy ? paint(s, "green", "Nothing to change.") : "nothing to change");
  } else if (o.dryRun) {
    lines.push(fancy ? paint(s, "yellow", `Dry run: ${noun}, nothing written.`) : `dry run: ${noun}, nothing written`);
  } else {
    lines.push(fancy ? paint(s, "green", `Wrote ${noun}.`) : `wrote ${noun}`);
    if (o.next) lines.push(fancy ? `${paint(s, "dim", "Refresh Package.resolved:")} ${paint(s, "cyan", o.next)}` : `next: ${o.next}`);
  }
  return lines.join("\n");
}

// --- progress ----------------------------------------------------------------

export function progressReporter(enabled: boolean): { update(done: number, total: number): void; clear(): void } {
  if (!enabled) return { update() {}, clear() {} };
  let shown = false;
  return {
    update(done, total) {
      shown = true;
      process.stderr.write(`\r\x1b[2KFetching versions ${done}/${total}…`);
    },
    clear() {
      if (shown) process.stderr.write("\r\x1b[2K");
    },
  };
}
