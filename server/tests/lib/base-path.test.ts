import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectBasePathWarning, findAbsoluteRefs } from "../../src/lib/base-path.js";

describe("findAbsoluteRefs", () => {
  const base = "/m/abc-123/";

  it("finds a root-absolute script src", () => {
    const html = '<script type="module" src="/assets/index-abc.js"></script>';
    expect(findAbsoluteRefs(html, base)).toEqual(["/assets/index-abc.js"]);
  });

  it("finds a root-absolute stylesheet href", () => {
    const html = '<link rel="stylesheet" href="/assets/app.css">';
    expect(findAbsoluteRefs(html, base)).toEqual(["/assets/app.css"]);
  });

  it("ignores references already carrying the expected base", () => {
    const html = '<script src="/m/abc-123/assets/index-abc.js"></script>';
    expect(findAbsoluteRefs(html, base)).toEqual([]);
  });

  it("ignores protocol-relative and absolute URLs", () => {
    const html = '<script src="//cdn.example.com/x.js"></script><img src="https://e.com/a.png">';
    expect(findAbsoluteRefs(html, base)).toEqual([]);
  });

  it("ignores relative references", () => {
    expect(findAbsoluteRefs('<script src="./assets/app.js"></script>', base)).toEqual([]);
  });

  it("finds absolute urls inside css", () => {
    expect(findAbsoluteRefs("body{background:url(/assets/bg.png)}", base)).toEqual([
      "/assets/bg.png",
    ]);
  });

  it("deduplicates repeated references", () => {
    const js = 'import("/assets/chunk.js");import("/assets/chunk.js")';
    expect(findAbsoluteRefs(js, base)).toEqual(["/assets/chunk.js"]);
  });
});

describe("detectBasePathWarning", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "base-path-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null for a correctly based build", async () => {
    writeFileSync(join(dir, "index.html"), '<script src="/m/abc-123/assets/a.js"></script>');
    await expect(detectBasePathWarning(dir, "/m/abc-123/")).resolves.toBeNull();
  });

  it("names the remedy when it finds root-absolute references", async () => {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), '<script src="/assets/a.js"></script>');

    const warning = await detectBasePathWarning(dir, "/m/abc-123/");

    expect(warning).toMatch(/\/assets\/a\.js/);
    expect(warning).toMatch(/--base=\/m\/abc-123\//);
  });

  it("scans nested js and css, not only the entry html", async () => {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), '<script src="./assets/a.js"></script>');
    writeFileSync(join(dir, "assets", "a.css"), "body{background:url(/img/x.png)}");

    await expect(detectBasePathWarning(dir, "/m/abc-123/")).resolves.toMatch(/\/img\/x\.png/);
  });

  it("ignores file types it cannot reason about", async () => {
    writeFileSync(join(dir, "index.html"), "<html></html>");
    writeFileSync(join(dir, "notes.txt"), "see /assets/a.js");
    await expect(detectBasePathWarning(dir, "/m/abc-123/")).resolves.toBeNull();
  });
});
