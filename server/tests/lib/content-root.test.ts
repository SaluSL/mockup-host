import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveContentRoot } from "../../src/lib/content-root.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "content-root-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveContentRoot", () => {
  it("returns the directory itself when index.html is at the top", async () => {
    writeFileSync(join(dir, "index.html"), "<html></html>");
    await expect(resolveContentRoot(dir)).resolves.toBe(dir);
  });

  it("descends into a single wrapper directory", async () => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.html"), "<html></html>");
    await expect(resolveContentRoot(dir)).resolves.toBe(join(dir, "dist"));
  });

  it("does not descend when there are two top-level entries", async () => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.html"), "<html></html>");
    writeFileSync(join(dir, "README.md"), "hi");
    await expect(resolveContentRoot(dir)).rejects.toMatchObject({ code: "no_index_html" });
  });

  it("rejects when no index.html exists anywhere it looks", async () => {
    writeFileSync(join(dir, "app.js"), "1");
    await expect(resolveContentRoot(dir)).rejects.toMatchObject({ code: "no_index_html" });
  });

  it("does not descend two levels", async () => {
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "index.html"), "<html></html>");
    await expect(resolveContentRoot(dir)).rejects.toMatchObject({ code: "no_index_html" });
  });
});
