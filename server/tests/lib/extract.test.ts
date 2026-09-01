import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_LIMITS, extractZip } from "../../src/lib/extract.js";
import { IngestError } from "../../src/lib/errors.js";
import { writeZip } from "../helpers/zip.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "extract-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const dest = () => join(dir, "out");

describe("extractZip", () => {
  it("writes files and reports counts", async () => {
    const zip = await writeZip(dir, [
      { name: "index.html", content: "<html></html>" },
      { name: "assets/app.js", content: "console.log(1)" },
    ]);

    const result = await extractZip(zip, dest(), DEFAULT_EXTRACT_LIMITS);

    expect(result.fileCount).toBe(2);
    expect(result.totalBytes).toBe("<html></html>".length + "console.log(1)".length);
    expect(readFileSync(join(dest(), "assets/app.js"), "utf8")).toBe("console.log(1)");
  });

  it("refuses a traversal entry and writes nothing outside the destination", async () => {
    const zip = await writeZip(dir, [{ name: "../escaped.js", content: "pwned" }]);

    await expect(extractZip(zip, dest(), DEFAULT_EXTRACT_LIMITS)).rejects.toThrow(IngestError);
    expect(existsSync(join(dir, "escaped.js"))).toBe(false);
  });

  it("refuses a symlink entry", async () => {
    const zip = await writeZip(dir, [
      { name: "index.html", content: "<html></html>" },
      { name: "link", content: "/etc/passwd", mode: 0o120777 },
    ]);

    await expect(extractZip(zip, dest(), DEFAULT_EXTRACT_LIMITS)).rejects.toMatchObject({
      code: "invalid_entry",
    });
  });

  it("refuses an archive with too many files", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, content: "x" }));
    const zip = await writeZip(dir, entries);

    await expect(
      extractZip(zip, dest(), { ...DEFAULT_EXTRACT_LIMITS, maxFiles: 3 }),
    ).rejects.toMatchObject({ code: "too_many_files" });
  });

  it("refuses an archive exceeding the uncompressed cap, mid-stream", async () => {
    const zip = await writeZip(dir, [{ name: "big.bin", content: "a".repeat(10_000) }]);

    await expect(
      extractZip(zip, dest(), { ...DEFAULT_EXTRACT_LIMITS, maxTotalBytes: 1000 }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("refuses a high compression ratio", async () => {
    const zip = await writeZip(dir, [{ name: "bomb.bin", content: "\u0000".repeat(2_000_000) }]);

    await expect(
      extractZip(zip, dest(), { ...DEFAULT_EXTRACT_LIMITS, maxRatio: 5 }),
    ).rejects.toMatchObject({ code: "ratio_exceeded" });
  });

  it("refuses an archive with no files at all", async () => {
    const zip = await writeZip(dir, [{ name: "empty/" }]);

    await expect(extractZip(zip, dest(), DEFAULT_EXTRACT_LIMITS)).rejects.toMatchObject({
      code: "empty_archive",
    });
  });
});
