#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import pkg from "../package.json" with { type: "json" };
import type { CheckedDep, Level, Manifest } from "./types.ts";
import { loadManifests, UsageError } from "./discovery.ts";
import { readResolved } from "./resolved.ts";
import { analyze, cachedFetcher, fetchAll, gitTagFetcher, type TagFetcher } from "./versions.ts";
import {
  parseDecisionArg,
  parsePlanFile,
  planBulk,
  planDecisions,
  resolveHint,
  writeChanges,
  type Decision,
  type Plan,
} from "./apply.ts";
import { progressReporter, renderCheck, renderPlan, summarize, type Format, type Style } from "./output.ts";

const COMMANDS = ["check", "apply", "update", "interactive"] as const;
type Command = (typeof COMMANDS)[number];

const HELP = `spm-update ${pkg.version} - check and update Swift Package Manager dependencies
in Package.swift and .xcodeproj files.

Usage:
  spm-update [check] [path]               list dependencies and available updates
  spm-update apply [path] <pkg>@<target>… apply per-package decisions
  spm-update update [path]                bulk-update every package
  spm-update -i [path]                    choose updates interactively

Targets: latest | major | minor | patch | <version>
  Prefix with ^ (upToNextMajor), ~ (upToNextMinor) or = (exact) to change the
  requirement kind; otherwise the existing kind is kept. e.g. Alamofire@minor,
  Kingfisher@=8.1.0, swift-log@^1.6.0

Common options:
  --format table|tsv|json   output format (default: table, or $SPM_UPDATE_FORMAT)
  --json                    same as --format json  (--pretty to indent)
  -r, --recursive           search subfolders for manifests
  --no-cache                don't reuse version lookups from the last 10 minutes
  --timeout <s>             per-repository git timeout (default 30)

check:  --outdated  --versions[=N]  --urls  --include-prerelease  --fail-on-outdated
apply:  --plan <file|->  --manifest <path>  --dry-run  --force  -y  -q
update: --level patch|minor|major (default major)  --only <pkg>  --skip <pkg>
        --dry-run  -y  -q

Exit codes: 0 ok, 1 error (nothing written), 2 outdated (with --fail-on-outdated)
Run 'spm-update help <command>' for details.`;

const COMMAND_HELP: Record<Command, string> = {
  check: `spm-update check [path] [options]

Lists every dependency with the newest patch, minor and major version above the
resolved version (from Package.resolved, else the requirement's lower bound).

  --format tsv          compact tab-separated output (cheapest for agents)
  --json [--pretty]     structured output for scripts
  --outdated            only rows that need attention (outdated or error)
  --versions[=N]        list up to N (default 20) newer versions per package
  --urls                add the repository URL column (always present in JSON)
  --include-prerelease  consider prerelease tags (alpha, beta, rc)
  --fail-on-outdated    exit 2 when any dependency is outdated

Status: major|minor|patch (largest update available), ok, pinned (branch or
revision; the major column then shows the newest release), local, error: <why>.`,
  apply: `spm-update apply [path] <pkg>@<target>… [options]

  <pkg>      package name, identity (case-insensitive) or repository URL
  <target>   latest|major, minor (newest in current major), patch (newest in
             current minor), or an explicit version. Prefix ^ ~ = to set the
             requirement kind. Branch/revision pins need an explicit version.
  --plan <file|->   read decisions from JSON: {"decisions":[{"package":"Alamofire",
                    "target":"minor","requirement":"exact","manifest":"Package.swift"}]}
  --manifest <path> only touch this manifest
  --dry-run         show the changes without writing
  --force           allow versions without a tag, and downgrades
  -y, --yes         don't ask for confirmation in a terminal
  -q, --quiet       print errors only

All decisions are validated first; if any fails, nothing is written (exit 1).`,
  update: `spm-update update [path] [options]

Bulk-updates every remote package, keeping each requirement's kind.
  --level patch|minor|major   largest step to take (default: major = latest)
  --only <pkg>                limit to these packages (repeatable, comma-separated)
  -s, --skip <pkg>            leave these packages alone (repeatable)
  --dry-run  -y  -q           as for apply
Branch/revision pins are never changed by update; use apply with a version.`,
  interactive: `spm-update -i [path]

Steps through each outdated package and lets you pick patch, minor, major or skip,
then confirms before writing. Needs a terminal.`,
};

interface Args {
  command: Command;
  path: string;
  decisions: Decision[];
  format: Format;
  pretty: boolean;
  recursive: boolean;
  cache: boolean;
  timeout: number;
  outdated: boolean;
  versions: number;
  urls: boolean;
  prerelease: boolean;
  failOnOutdated: boolean;
  plan?: string;
  manifest?: string;
  dryRun: boolean;
  force: boolean;
  yes: boolean;
  quiet: boolean;
  level: Level;
  only: Set<string>;
  skip: Set<string>;
  help: boolean;
  helpTopic?: Command;
}

function parseFormat(v: string | undefined): Format {
  if (v === "table" || v === "tsv" || v === "json") return v;
  throw new UsageError(`invalid --format '${v}' (use table, tsv or json)`);
}

function addNames(set: Set<string>, v: string): void {
  for (const n of v.split(",")) if (n.trim()) set.add(n.trim().toLowerCase());
}

export function parseArgs(argv: string[]): Args {
  const envFormat = process.env.SPM_UPDATE_FORMAT;
  const a: Args = {
    command: "check",
    path: ".",
    decisions: [],
    format: envFormat ? parseFormat(envFormat) : "table",
    pretty: false,
    recursive: false,
    cache: true,
    timeout: 30,
    outdated: false,
    versions: 0,
    urls: false,
    prerelease: false,
    failOnOutdated: false,
    dryRun: false,
    force: false,
    yes: false,
    quiet: false,
    level: "major",
    only: new Set(),
    skip: new Set(),
    help: false,
  };
  const positionals: string[] = [];
  let levelGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new UsageError(`${flag} needs a value`);
      i++;
      return next;
    };
    switch (flag) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-V":
      case "--version":
        console.log(pkg.version);
        process.exit(0);
      case "--format":
        a.format = parseFormat(value());
        break;
      case "--json":
        a.format = "json";
        break;
      case "--tsv":
        a.format = "tsv";
        break;
      case "--pretty":
        a.pretty = true;
        break;
      case "-r":
      case "--recursive":
        a.recursive = true;
        break;
      case "--no-cache":
        a.cache = false;
        break;
      case "--timeout": {
        const n = Number(value());
        if (!(n > 0)) throw new UsageError("--timeout must be a positive number of seconds");
        a.timeout = n;
        break;
      }
      case "--outdated":
        a.outdated = true;
        break;
      case "--versions": {
        const n = inline === undefined ? 20 : Number(inline);
        if (!Number.isInteger(n) || n < 0) throw new UsageError("--versions=N needs a whole number");
        a.versions = n;
        break;
      }
      case "--urls":
        a.urls = true;
        break;
      case "--include-prerelease":
        a.prerelease = true;
        break;
      case "--fail-on-outdated":
        a.failOnOutdated = true;
        break;
      case "--plan":
        a.plan = value();
        break;
      case "--manifest":
        a.manifest = value();
        break;
      case "-n":
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--force":
        a.force = true;
        break;
      case "-y":
      case "--yes":
        a.yes = true;
        break;
      case "-q":
      case "--quiet":
        a.quiet = true;
        break;
      case "--level": {
        const v = value();
        if (v !== "patch" && v !== "minor" && v !== "major") throw new UsageError(`invalid --level '${v}' (use patch, minor or major)`);
        a.level = v;
        levelGiven = true;
        break;
      }
      case "--only":
        addNames(a.only, value());
        break;
      case "-s":
      case "--skip":
        addNames(a.skip, value());
        break;
      case "-i":
      case "--interactive":
        a.command = "interactive";
        break;
      default:
        if (raw.startsWith("-") && raw !== "-") throw new UsageError(`unknown option '${raw}'`);
        positionals.push(raw);
    }
  }

  // Command: first positional if it names one; legacy `spm-update <path> update` also works.
  if (positionals[0] === "help") {
    a.help = true;
    const topic = positionals[1];
    if (topic && (COMMANDS as readonly string[]).includes(topic)) a.helpTopic = topic as Command;
    return a;
  }
  if (a.command !== "interactive") {
    const idx = positionals.findIndex((p) => (COMMANDS as readonly string[]).includes(p) && !existsSync(p));
    if (idx !== -1) {
      a.command = positionals[idx] as Command;
      positionals.splice(idx, 1);
    }
  }
  if (a.help) {
    if (a.command !== "check" || positionals.length) a.helpTopic = a.command;
    return a;
  }

  const paths: string[] = [];
  for (const p of positionals) {
    if (a.command === "apply" && p.includes("@") && !existsSync(p)) a.decisions.push(parseDecisionArg(p));
    else paths.push(p);
  }
  if (paths.length > 1) throw new UsageError(`unexpected argument '${paths[1]}'`);
  a.path = paths[0] ?? ".";
  if (levelGiven && a.command !== "update") throw new UsageError("--level is only valid with update");
  if (a.command === "apply" && a.decisions.length === 0 && !a.plan) {
    throw new UsageError("apply needs decisions (<pkg>@<target>) or --plan <file>");
  }
  if (a.manifest) for (const d of a.decisions) d.manifest ??= a.manifest;
  return a;
}

async function checkAll(manifests: Manifest[], args: Args, fetcher: TagFetcher): Promise<CheckedDep[]> {
  const urls = manifests.flatMap((m) => m.deps.flatMap((d) => (d.source === "remote" && d.url ? [d.url] : [])));
  const progress = progressReporter(!!process.stderr.isTTY && args.format === "table" && !args.quiet);
  const tags = await fetchAll(urls, fetcher, 8, (done, total) => progress.update(done, total));
  progress.clear();
  const checked: CheckedDep[] = [];
  manifests.forEach((man, m) => {
    const pins = readResolved(man.resolvedPath);
    for (const dep of man.deps) {
      const a = analyze(dep, pins.get(dep.identity), dep.url ? tags.get(dep.url) : undefined, args.prerelease);
      checked.push({ m, dep, a });
    }
  });
  return checked;
}

function readPlanInput(src: string): string {
  try {
    return src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch {
    throw new UsageError(`can't read plan '${src}'`);
  }
}

async function finishPlan(plan: Plan, manifests: Manifest[], args: Args, style: Style): Promise<number> {
  const next = resolveHint(plan, manifests);
  const base = { format: args.format, style, pretty: args.pretty, quiet: args.quiet, next };
  const interactiveTerm = !!process.stdout.isTTY && !!process.stdin.isTTY && args.format === "table";
  const canWrite = plan.errors.length === 0 && plan.changes.length > 0;

  if (canWrite && !args.dryRun && interactiveTerm && !args.yes) {
    console.log(renderPlan(plan, manifests, { ...base, dryRun: true, footer: false }));
    const { confirmWrite } = await import("./interactive.ts");
    if (!(await confirmWrite(plan.changes.length))) {
      console.log("Nothing written.");
      return 0;
    }
    writeChanges(plan, manifests);
    console.log(renderPlan(plan, manifests, { ...base, dryRun: false, list: false }));
    return 0;
  }

  if (canWrite && !args.dryRun) writeChanges(plan, manifests);
  const text = renderPlan(plan, manifests, { ...base, dryRun: args.dryRun });
  if (text) console.log(text);
  return plan.errors.length ? 1 : 0;
}

async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(args.helpTopic ? COMMAND_HELP[args.helpTopic] : HELP);
    return 0;
  }
  const style: Style = { color: !!process.stdout.isTTY && !process.env.NO_COLOR && args.format === "table" };

  let decisions = args.decisions;
  if (args.plan) {
    const fromPlan = parsePlanFile(readPlanInput(args.plan));
    if (args.manifest) for (const d of fromPlan) d.manifest ??= args.manifest;
    decisions = [...decisions, ...fromPlan];
  }
  if (args.command === "interactive" && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new UsageError("interactive mode needs a terminal; use check and apply instead");
  }

  const { root, manifests } = loadManifests(args.path, args.recursive);
  const git = gitTagFetcher(args.timeout);
  const cached = args.cache ? cachedFetcher(git, 600) : undefined;
  let checked: CheckedDep[];
  try {
    checked = await checkAll(manifests, args, cached ?? git);
  } finally {
    cached?.flush();
  }

  switch (args.command) {
    case "check": {
      const shown = args.outdated ? checked.filter((c) => c.a.status === "outdated" || c.a.status === "error") : checked;
      console.log(
        renderCheck(root, manifests, checked, shown, {
          format: args.format,
          style,
          pretty: args.pretty,
          versions: args.versions,
          urls: args.urls,
        }),
      );
      return args.failOnOutdated && summarize(checked).outdated > 0 ? 2 : 0;
    }
    case "apply":
      return finishPlan(planDecisions(checked, manifests, decisions, args.force), manifests, args, style);
    case "update":
      return finishPlan(planBulk(checked, args.level, args.only, args.skip), manifests, args, style);
    case "interactive": {
      const { chooseInteractively } = await import("./interactive.ts");
      const chosen = await chooseInteractively(checked, manifests);
      if (!chosen || chosen.length === 0) return 0;
      return finishPlan(planDecisions(checked, manifests, chosen, false), manifests, args, style);
    }
  }
}

if (import.meta.main) {
  run(Bun.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof UsageError) {
        console.error(`error: ${err.message}`);
        console.error("run 'spm-update --help' for usage");
      } else {
        console.error(`error: ${(err as Error).message ?? err}`);
      }
      process.exit(1);
    },
  );
}
