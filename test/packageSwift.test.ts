import { describe, expect, test } from "bun:test";
import { editPackageSwift, parsePackageSwift, type PackageSwiftHandle } from "../src/packageSwift.ts";
import { formatRequirement } from "../src/requirement.ts";
import type { Requirement } from "../src/types.ts";

const MANIFEST = `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Demo",
    dependencies: [
        .package(url: "https://github.com/a/From.git", from: "1.0.0"),
        .package(url: "https://github.com/a/Major.git", .upToNextMajor(from: "2.0.0")),
        .package(url: "https://github.com/a/Minor.git", .upToNextMinor(from: "3.1.0")),
        .package(url: "https://github.com/a/ExactLabel.git", exact: "4.0.0"),
        .package(url: "https://github.com/a/ExactMethod.git", .exact("5.0.0")),
        .package(url: "https://github.com/a/Branch.git", branch: "main"),
        .package(url: "https://github.com/a/Rev.git", revision: "0123456789abcdef0123"),
        .package(url: "https://github.com/a/Range.git", "1.0.0"..<"2.0.0"),
        .package(url: "https://github.com/a/Closed.git", "1.0.0"..."1.9.0"),
        // .package(url: "https://github.com/a/Commented.git", from: "1.0.0"),
        /* .package(url: "https://github.com/a/Block.git", from: "1.0.0"), */
        .package(
            name: "Named",
            url: "https://github.com/a/named-repo.git",
            .upToNextMajor(from: "1.2.0")
        ),
        .package(url: "https://github.com/a/Traits.git", from: "1.0.0", traits: ["Foo"]),
        .package(path: "../Local"),
        .package(id: "scope.Registry", from: "1.0.0"),
    ]
)
`;

describe("parsePackageSwift", () => {
  const deps = parsePackageSwift(MANIFEST);
  const req = (name: string) => formatRequirement(deps.find((d) => d.name === name)!.req);

  test("parses every requirement form", () => {
    expect(req("From")).toBe("^1.0.0");
    expect(req("Major")).toBe("^2.0.0");
    expect(req("Minor")).toBe("~3.1.0");
    expect(req("ExactLabel")).toBe("=4.0.0");
    expect(req("ExactMethod")).toBe("=5.0.0");
    expect(req("Branch")).toBe("branch:main");
    expect(req("Rev")).toBe("rev:0123456789ab");
    expect(req("Range")).toBe(">=1.0.0 <2.0.0");
    expect(req("Closed")).toBe(">=1.0.0 <=1.9.0");
    expect(req("Traits")).toBe("^1.0.0");
  });

  test("ignores commented-out dependencies", () => {
    expect(deps.map((d) => d.name)).not.toContain("Commented");
    expect(deps.map((d) => d.name)).not.toContain("Block");
  });

  test("handles multi-line calls with name:", () => {
    const named = deps.find((d) => d.name === "Named")!;
    expect(named.identity).toBe("named-repo");
    expect(formatRequirement(named.req)).toBe("^1.2.0");
  });

  test("classifies local and registry packages", () => {
    expect(deps.find((d) => d.name === "Local")!.source).toBe("local");
    expect(deps.find((d) => d.name === "Registry")!.source).toBe("registry");
  });
});

describe("editPackageSwift", () => {
  const deps = parsePackageSwift(MANIFEST);
  const edit = (name: string, next: Requirement) => {
    const d = deps.find((x) => x.name === name)!;
    return editPackageSwift(MANIFEST, [{ handle: d.handle as PackageSwiftHandle, prev: d.req, next }]);
  };

  test("keeps method style and doesn't leave a stray paren", () => {
    const out = edit("Major", { kind: "upToNextMajor", version: "2.5.0" });
    expect(out).toContain(`.package(url: "https://github.com/a/Major.git", .upToNextMajor(from: "2.5.0")),`);
    expect(parsePackageSwift(out)).toHaveLength(deps.length);
  });

  test("keeps label style", () => {
    expect(edit("From", { kind: "upToNextMajor", version: "1.4.0" })).toContain(`From.git", from: "1.4.0"),`);
    expect(edit("ExactLabel", { kind: "exact", version: "4.1.0" })).toContain(`ExactLabel.git", exact: "4.1.0"),`);
    expect(edit("ExactMethod", { kind: "exact", version: "5.1.0" })).toContain(`ExactMethod.git", .exact("5.1.0")),`);
  });

  test("keeps trailing arguments such as traits:", () => {
    expect(edit("Traits", { kind: "upToNextMajor", version: "1.1.0" })).toContain(
      `Traits.git", from: "1.1.0", traits: ["Foo"]),`,
    );
  });

  test("keeps multi-line formatting", () => {
    const out = edit("Named", { kind: "upToNextMajor", version: "1.3.0" });
    expect(out).toContain(`            url: "https://github.com/a/named-repo.git",\n            .upToNextMajor(from: "1.3.0")\n        ),`);
  });

  test("writes ranges and kind changes", () => {
    expect(edit("Closed", { kind: "range", lower: "1.5.0", upper: "1.9.0", closed: true })).toContain(`"1.5.0"..."1.9.0"`);
    expect(edit("Branch", { kind: "upToNextMajor", version: "1.0.0" })).toContain(`Branch.git", from: "1.0.0"),`);
    expect(edit("From", { kind: "upToNextMinor", version: "1.4.0" })).toContain(`From.git", .upToNextMinor(from: "1.4.0")),`);
  });

  test("applies several edits at once", () => {
    const a = deps.find((d) => d.name === "From")!;
    const b = deps.find((d) => d.name === "Minor")!;
    const out = editPackageSwift(MANIFEST, [
      { handle: a.handle as PackageSwiftHandle, prev: a.req, next: { kind: "upToNextMajor", version: "1.9.0" } },
      { handle: b.handle as PackageSwiftHandle, prev: b.req, next: { kind: "upToNextMinor", version: "3.1.4" } },
    ]);
    const reparsed = parsePackageSwift(out);
    expect(formatRequirement(reparsed.find((d) => d.name === "From")!.req)).toBe("^1.9.0");
    expect(formatRequirement(reparsed.find((d) => d.name === "Minor")!.req)).toBe("~3.1.4");
  });
});
