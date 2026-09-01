import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockupCache } from "../../src/lib/mockup-cache.js";
import { createStorage } from "../../src/lib/storage.js";
import { createServeRoutes } from "../../src/routes/serve.js";
import { mockups } from "../../src/schema/index.js";
import { createTestDb } from "../helpers/db.js";

let ctx: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createServeRoutes>;
let storage: ReturnType<typeof createStorage>;

const HTML_ACCEPT = { accept: "text/html,application/xhtml+xml" };

beforeEach(async () => {
  ctx = createTestDb();
  storage = createStorage(join(ctx.dir, "data"));
  ctx.db.insert(mockups).values({ id: "id-1", name: "Acme", slug: "acme" }).run();

  const staged = await storage.createStagingDir("id-1");
  mkdirSync(join(staged, "assets"), { recursive: true });
  writeFileSync(join(staged, "index.html"), "<h1>home</h1>");
  writeFileSync(join(staged, "assets", "app-a1b2c3d4.js"), "console.log(1)");
  writeFileSync(join(staged, "assets", "big.bin"), "0123456789");
  await storage.commit("id-1", staged);

  app = createServeRoutes({ storage, cache: createMockupCache(ctx.db) });
});

afterEach(() => ctx.cleanup());

describe("serving", () => {
  it("redirects the bare mockup path to a trailing slash", async () => {
    const res = await app.request("/m/id-1");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/m/id-1/");
  });

  it("serves index.html at the root of a mockup", async () => {
    const res = await app.request("/m/id-1/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("<h1>home</h1>");
  });

  it("serves a hashed asset with an immutable cache header", async () => {
    const res = await app.request("/m/id-1/assets/app-a1b2c3d4.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("answers a conditional request with 304", async () => {
    const first = await app.request("/m/id-1/assets/app-a1b2c3d4.js");
    const etag = first.headers.get("etag")!;

    const second = await app.request("/m/id-1/assets/app-a1b2c3d4.js", {
      headers: { "if-none-match": etag },
    });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("serves a byte range", async () => {
    const res = await app.request("/m/id-1/assets/big.bin", {
      headers: { range: "bytes=2-5" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
  });

  it("answers an unsatisfiable range with 416", async () => {
    const res = await app.request("/m/id-1/assets/big.bin", {
      headers: { range: "bytes=99-" },
    });

    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  it("falls back to index.html for a client-side route", async () => {
    const res = await app.request("/m/id-1/settings/profile", { headers: HTML_ACCEPT });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>home</h1>");
  });

  it("does NOT fall back for a missing script, so bundlers fail loudly", async () => {
    const res = await app.request("/m/id-1/assets/missing.js", { headers: HTML_ACCEPT });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toMatch(/html/);
  });

  it("404s an unknown mockup id", async () => {
    const res = await app.request("/m/id-unknown/", { headers: HTML_ACCEPT });
    expect(res.status).toBe(404);
  });

  it("refuses a traversal out of the mockup directory", async () => {
    const res = await app.request("/m/id-1/..%2F..%2Fdb.sqlite");
    expect(res.status).toBe(404);
  });

  it("404s after the mockup is deleted and the cache invalidated", async () => {
    const cache = createMockupCache(ctx.db);
    const scoped = createServeRoutes({ storage, cache });
    expect((await scoped.request("/m/id-1/")).status).toBe(200);

    ctx.db.delete(mockups).run();
    await storage.remove("id-1");
    cache.invalidate("id-1");

    expect((await scoped.request("/m/id-1/")).status).toBe(404);
  });
});
