import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorage } from "../../src/lib/storage.js";

let dataDir: string;
let storage: ReturnType<typeof createStorage>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "storage-test-"));
  storage = createStorage(dataDir);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

async function stage(id: string, files: Record<string, string>): Promise<string> {
  const dir = await storage.createStagingDir(id);
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

describe("commit", () => {
  it("moves staged content into the live directory", async () => {
    const staged = await stage("id-1", { "index.html": "v1" });
    await storage.commit("id-1", staged);

    expect(readFileSync(join(storage.mockupDir("id-1"), "index.html"), "utf8")).toBe("v1");
  });

  it("replaces previous content entirely, leaving no stale files", async () => {
    await storage.commit("id-1", await stage("id-1", { "index.html": "v1", "old.js": "gone" }));
    await storage.commit("id-1", await stage("id-1", { "index.html": "v2" }));

    const live = storage.mockupDir("id-1");
    expect(readFileSync(join(live, "index.html"), "utf8")).toBe("v2");
    expect(existsSync(join(live, "old.js"))).toBe(false);
  });

  it("leaves no staging or backup directories behind", async () => {
    await storage.commit("id-1", await stage("id-1", { "index.html": "v1" }));
    const second = await stage("id-1", { "index.html": "v2" });
    await storage.commit("id-1", second);
    await storage.discardStaging(second);

    expect(readdirSync(join(dataDir, "tmp"))).toEqual([]);
  });
});

describe("remove", () => {
  it("deletes the live directory", async () => {
    await storage.commit("id-1", await stage("id-1", { "index.html": "v1" }));
    await storage.remove("id-1");
    expect(existsSync(storage.mockupDir("id-1"))).toBe(false);
  });

  it("is a no-op for a mockup that was never pushed", async () => {
    await expect(storage.remove("never")).resolves.toBeUndefined();
  });
});

describe("measure", () => {
  it("counts files and bytes recursively", async () => {
    const staged = await stage("id-1", { "index.html": "abc", "assets/a.js": "de" });
    await expect(storage.measure(staged)).resolves.toEqual({ fileCount: 2, sizeBytes: 5 });
  });
});

describe("resolveFile", () => {
  it("resolves a nested path inside the mockup", () => {
    expect(storage.resolveFile("id-1", "assets/a.js")).toBe(
      join(storage.mockupDir("id-1"), "assets/a.js"),
    );
  });

  it("refuses a traversal that escapes the mockup directory", () => {
    expect(storage.resolveFile("id-1", "../id-2/secret.js")).toBeNull();
    expect(storage.resolveFile("id-1", "../../db.sqlite")).toBeNull();
  });

  it("refuses an absolute path", () => {
    expect(storage.resolveFile("id-1", "/etc/passwd")).toBeNull();
  });

  it("refuses a path containing a null byte", () => {
    expect(storage.resolveFile("id-1", "assets/a\u0000.js")).toBeNull();
  });

  it("resolves the empty path to the directory itself", () => {
    expect(storage.resolveFile("id-1", "")).toBe(storage.mockupDir("id-1"));
  });
});
