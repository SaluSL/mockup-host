import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/lib/extract.js";
import { ingestZip, type IngestDeps } from "../../src/lib/ingest.js";
import { createStorage } from "../../src/lib/storage.js";
import { mockups } from "../../src/schema/index.js";
import { createTestDb } from "../helpers/db.js";
import { writeZip } from "../helpers/zip.js";

let ctx: ReturnType<typeof createTestDb>;
let workDir: string;
let deps: IngestDeps;

beforeEach(() => {
  ctx = createTestDb();
  workDir = mkdtempSync(join(tmpdir(), "ingest-zips-"));
  deps = {
    db: ctx.db,
    storage: createStorage(join(ctx.dir, "data")),
    limits: DEFAULT_EXTRACT_LIMITS,
  };
  ctx.db.insert(mockups).values({ id: "id-1", name: "Acme", slug: "acme" }).run();
});

afterEach(() => {
  ctx.cleanup();
  rmSync(workDir, { recursive: true, force: true });
});

const row = () => ctx.db.select().from(mockups).where(eq(mockups.id, "id-1")).get();

describe("ingestZip", () => {
  it("serves the pushed files and records counts on the row", async () => {
    const zip = await writeZip(workDir, [
      { name: "index.html", content: '<script src="/m/id-1/assets/a.js"></script>' },
      { name: "assets/a.js", content: "console.log(1)" },
    ]);

    const result = await ingestZip(deps, "id-1", zip);

    expect(result.fileCount).toBe(2);
    expect(result.warning).toBeNull();
    expect(row()?.fileCount).toBe(2);
    expect(row()?.sizeBytes).toBe(result.sizeBytes);
    expect(row()?.lastPushedAt).toBeInstanceOf(Date);
    expect(row()?.basePathWarning).toBeNull();
  });

  it("strips a wrapping dist directory", async () => {
    const zip = await writeZip(workDir, [
      { name: "dist/index.html", content: "<html></html>" },
      { name: "dist/assets/a.js", content: "x" },
    ]);

    await ingestZip(deps, "id-1", zip);

    expect(readFileSync(join(deps.storage.mockupDir("id-1"), "index.html"), "utf8")).toBe(
      "<html></html>",
    );
  });

  it("records a warning for a root-absolute build without rejecting it", async () => {
    const zip = await writeZip(workDir, [
      { name: "index.html", content: '<script src="/assets/a.js"></script>' },
    ]);

    const result = await ingestZip(deps, "id-1", zip);

    expect(result.warning).toMatch(/--base=\/m\/id-1\//);
    expect(row()?.basePathWarning).toBe(result.warning);
    expect(existsSync(join(deps.storage.mockupDir("id-1"), "index.html"))).toBe(true);
  });

  it("clears a previous warning when a corrected build is pushed", async () => {
    const bad = await writeZip(
      workDir,
      [{ name: "index.html", content: '<script src="/a.js"></script>' }],
      "bad.zip",
    );
    const good = await writeZip(
      workDir,
      [{ name: "index.html", content: "<html></html>" }],
      "good.zip",
    );

    await ingestZip(deps, "id-1", bad);
    await ingestZip(deps, "id-1", good);

    expect(row()?.basePathWarning).toBeNull();
  });

  it("leaves the previous build untouched when the archive is rejected", async () => {
    const ok = await writeZip(workDir, [{ name: "index.html", content: "good" }], "ok.zip");
    await ingestZip(deps, "id-1", ok);

    const bad = await writeZip(workDir, [{ name: "../evil.js", content: "pwned" }], "bad.zip");
    await expect(ingestZip(deps, "id-1", bad)).rejects.toMatchObject({ code: "invalid_entry" });

    expect(readFileSync(join(deps.storage.mockupDir("id-1"), "index.html"), "utf8")).toBe("good");
  });

  it("rejects an archive with no index.html and leaves no staging behind", async () => {
    const zip = await writeZip(workDir, [{ name: "app.js", content: "1" }]);

    await expect(ingestZip(deps, "id-1", zip)).rejects.toMatchObject({ code: "no_index_html" });
    expect(readdirSync(join(ctx.dir, "data", "tmp"))).toEqual([]);
  });
});
