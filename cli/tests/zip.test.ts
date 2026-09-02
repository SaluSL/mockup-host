import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { zipDirectory } from "../src/zip.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-zip-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entryNames(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      zip.on("entry", (entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve(names.sort()));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

describe("zipDirectory", () => {
  it("archives files with paths relative to the directory root", async () => {
    const source = join(dir, "dist");
    mkdirSync(join(source, "assets"), { recursive: true });
    writeFileSync(join(source, "index.html"), "<html></html>");
    writeFileSync(join(source, "assets", "app.js"), "1");

    const out = join(dir, "out.zip");
    await zipDirectory(source, out);

    expect(await entryNames(out)).toEqual(["assets/app.js", "index.html"]);
  });

  it("rejects a directory that does not exist", async () => {
    await expect(zipDirectory(join(dir, "missing"), join(dir, "o.zip"))).rejects.toThrow(/missing/);
  });

  it("rejects an empty directory rather than pushing nothing", async () => {
    mkdirSync(join(dir, "empty"));
    await expect(zipDirectory(join(dir, "empty"), join(dir, "o.zip"))).rejects.toThrow(/no files/i);
  });
});
