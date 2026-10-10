import * as p from "@clack/prompts";
import type { CheckedDep, Manifest } from "./types.ts";
import type { Decision } from "./apply.ts";
import { formatRequirement } from "./requirement.ts";

function releasesUrl(url: string | undefined): string | undefined {
  const m = url?.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/releases` : undefined;
}

/** Walks the user through each outdated dependency. Returns null if cancelled. */
export async function chooseInteractively(checked: CheckedDep[], manifests: Manifest[]): Promise<Decision[] | null> {
  const candidates = checked.filter((c) => c.a.status === "outdated" || (c.a.status === "pinned" && c.a.latest));
  p.intro("spm-update");
  if (candidates.length === 0) {
    p.outro("All packages are up to date.");
    return [];
  }
  const multi = manifests.length > 1;
  const decisions: Decision[] = [];
  for (const [i, c] of candidates.entries()) {
    const { dep, a } = c;
    type Choice = "skip" | string;
    const options: { value: Choice; label: string; hint?: string }[] = [];
    const notes = releasesUrl(dep.url);
    if (a.status === "pinned") {
      options.push({ value: a.latest!, label: `Switch to ^${a.latest}`, hint: "replaces the branch/revision pin" });
    } else {
      if (a.patch) options.push({ value: a.patch, label: `Patch → ${a.patch}`, hint: "bug fixes" });
      if (a.minor) options.push({ value: a.minor, label: `Minor → ${a.minor}`, hint: "new features, non-breaking" });
      if (a.major) options.push({ value: a.major, label: `Major → ${a.major}`, hint: `breaking${notes ? ` · ${notes}` : ""}` });
    }
    options.push({ value: "skip", label: "Skip" });
    const initial = a.minor ?? a.patch ?? "skip";
    const resolved = a.resolved ? `, resolved ${a.resolved}` : "";
    const where = multi ? ` in ${manifests[c.m]!.label}` : "";
    const choice = await p.select<Choice>({
      message: `[${i + 1}/${candidates.length}] ${dep.name} (${formatRequirement(dep.req)}${resolved})${where}`,
      options,
      initialValue: initial,
    });
    if (p.isCancel(choice)) {
      p.cancel("Cancelled. Nothing written.");
      return null;
    }
    if (choice !== "skip") {
      decisions.push({ selector: dep.url ?? dep.name, target: choice, manifest: manifests[c.m]!.label });
    }
  }
  return decisions;
}

export async function confirmWrite(count: number): Promise<boolean> {
  const ok = await p.confirm({ message: `Apply ${count} change${count === 1 ? "" : "s"}?`, initialValue: true });
  return !p.isCancel(ok) && ok === true;
}
