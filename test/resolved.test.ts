import { expect, test } from "bun:test";
import { parseResolved } from "../src/resolved.ts";

test("parses Package.resolved v1", () => {
  const pins = parseResolved(
    JSON.stringify({
      object: {
        pins: [
          { package: "Alamofire", repositoryURL: "https://github.com/Alamofire/Alamofire.git", state: { branch: null, revision: "x", version: "5.8.1" } },
          { package: "Foo", repositoryURL: "https://github.com/a/Foo", state: { branch: "main", revision: "y", version: null } },
        ],
      },
      version: 1,
    }),
  );
  expect(pins.get("alamofire")).toEqual({ version: "5.8.1", branch: undefined, revision: "x" });
  expect(pins.get("foo")?.branch).toBe("main");
});

test("parses Package.resolved v2/v3", () => {
  const pins = parseResolved(
    JSON.stringify({
      originHash: "abc",
      pins: [{ identity: "swift-log", kind: "remoteSourceControl", location: "https://github.com/apple/swift-log.git", state: { revision: "z", version: "1.5.4" } }],
      version: 3,
    }),
  );
  expect(pins.get("swift-log")?.version).toBe("1.5.4");
});

test("tolerates garbage", () => {
  expect(parseResolved("not json").size).toBe(0);
});
