import { describe, expect, it } from "vitest";
import { isRegularFileMode, validateEntryName } from "../../src/lib/zip-entry.js";

describe("validateEntryName", () => {
  it("accepts a plain nested file", () => {
    expect(validateEntryName("assets/index-abc123.js")).toEqual({
      ok: true,
      path: "assets/index-abc123.js",
      kind: "file",
    });
  });

  it("accepts a directory entry and strips the trailing slash", () => {
    expect(validateEntryName("assets/")).toEqual({
      ok: true,
      path: "assets",
      kind: "directory",
    });
  });

  it("normalizes redundant segments", () => {
    expect(validateEntryName("./assets/./app.css")).toEqual({
      ok: true,
      path: "assets/app.css",
      kind: "file",
    });
  });

  const hostile: Array<[string, string, RegExp]> = [
    ["parent traversal", "../evil.js", /traversal/],
    ["nested traversal", "a/../../evil.js", /traversal/],
    ["traversal that stays negative", "a/b/../../../evil.js", /traversal/],
    ["absolute posix path", "/etc/passwd", /absolute/],
    ["windows drive path", "C:\\Windows\\evil.dll", /backslash/],
    ["backslash separator", "assets\\app.js", /backslash/],
    ["null byte", "assets/app\u0000.js", /control character/],
    ["newline", "assets/ap\np.js", /control character/],
    ["empty name", "", /empty/],
    ["dot only", ".", /empty/],
  ];

  it.each(hostile)("rejects %s", (_label, name, reason) => {
    const result = validateEntryName(name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it("does not treat a filename merely containing dots as traversal", () => {
    expect(validateEntryName("assets/..hidden..js")).toEqual({
      ok: true,
      path: "assets/..hidden..js",
      kind: "file",
    });
  });
});

describe("isRegularFileMode", () => {
  const attrs = (unixMode: number) => unixMode << 16;

  it("accepts a regular file (0100644)", () => {
    expect(isRegularFileMode(attrs(0o100644))).toBe(true);
  });

  it("accepts mode 0, which many zip writers emit", () => {
    expect(isRegularFileMode(0)).toBe(true);
  });

  it("rejects a symlink (0120777)", () => {
    expect(isRegularFileMode(attrs(0o120777))).toBe(false);
  });

  it("rejects a character device (0020666)", () => {
    expect(isRegularFileMode(attrs(0o020666))).toBe(false);
  });

  it("rejects a fifo (0010644)", () => {
    expect(isRegularFileMode(attrs(0o010644))).toBe(false);
  });
});
