import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editXcodeProject, parseXcodeProject, type XcodeHandle } from "../src/xcode.ts";
import { formatRequirement } from "../src/requirement.ts";

const PBX = readFileSync(join(import.meta.dir, "fixtures/xcode/App.xcodeproj/project.pbxproj"), "utf8");

describe("xcode", () => {
  const deps = parseXcodeProject(PBX);
  const byName = (n: string) => deps.find((d) => d.name === n)!;

  test("reads remote and local package references", () => {
    expect(deps.map((d) => [d.name, formatRequirement(d.req)])).toEqual([
      ["Alamofire", "^5.0.0"],
      ["Core", "path:Packages/Core"],
      ["Kingfisher", "=7.0.0"],
      ["swift-argument-parser", "branch:main"],
      ["swift-log", ">=1.4.0 <2.0.0"],
    ]);
    expect(byName("Core").source).toBe("local");
  });

  test("edits only the requirement block", () => {
    const out = editXcodeProject(PBX, [
      { handle: byName("Alamofire").handle as XcodeHandle, name: "Alamofire", next: { kind: "upToNextMajor", version: "5.9.0" } },
      { handle: byName("swift-log").handle as XcodeHandle, name: "swift-log", next: { kind: "range", lower: "1.5.0", upper: "2.0.0", closed: false } },
      { handle: byName("swift-argument-parser").handle as XcodeHandle, name: "swift-argument-parser", next: { kind: "upToNextMinor", version: "1.3.0" } },
    ]);
    const before = PBX.split("\n");
    const after = out.split("\n");
    const changed = after.filter((l, i) => l !== before[i]);
    expect(changed).toEqual([
      "\t\t\t\tminimumVersion = 5.9.0;",
      "\t\t\t\tminimumVersion = 1.5.0;",
      "\t\t\t\tkind = upToNextMinorVersion;",
      "\t\t\t\tminimumVersion = 1.3.0;",
    ]);
    const reparsed = parseXcodeProject(out);
    expect(formatRequirement(reparsed.find((d) => d.name === "swift-argument-parser")!.req)).toBe("~1.3.0");
    expect(formatRequirement(reparsed.find((d) => d.name === "swift-log")!.req)).toBe(">=1.5.0 <2.0.0");
  });

  test("quotes values that need it", () => {
    const out = editXcodeProject(PBX, [
      { handle: byName("Alamofire").handle as XcodeHandle, name: "Alamofire", next: { kind: "branch", ref: "feature-x" } },
    ]);
    expect(out).toContain('branch = "feature-x";');
    expect(formatRequirement(parseXcodeProject(out).find((d) => d.name === "Alamofire")!.req)).toBe("branch:feature-x");
  });

  test("keeps numeric-looking versions as written (1.10 is not 1.1)", () => {
    // Real projects contain unquoted `version = 1.2;`, which a JSON parser reads as a number.
    const pbx = PBX.replace("version = 7.0.0;", "version = 1.10;").replace("minimumVersion = 5.0.0;", "minimumVersion = 2.0;");
    const parsed = parseXcodeProject(pbx);
    expect(formatRequirement(parsed.find((d) => d.name === "Kingfisher")!.req)).toBe("=1.10");
    expect(formatRequirement(parsed.find((d) => d.name === "Alamofire")!.req)).toBe("^2.0");
  });

  test("unlocatable blocks throw instead of re-serializing", () => {
    expect(() =>
      editXcodeProject(PBX, [{ handle: { id: "DOESNOTEXIST" }, name: "Ghost", next: { kind: "exact", version: "1.0.0" } }]),
    ).toThrow("can't locate the requirement block for Ghost");
  });
});
