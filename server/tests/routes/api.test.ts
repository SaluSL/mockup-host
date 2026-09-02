import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/lib/extract.js";
import { createMockupCache } from "../../src/lib/mockup-cache.js";
import { createStorage } from "../../src/lib/storage.js";
import { createApiToken } from "../../src/lib/tokens.js";
import { createApiRoutes } from "../../src/routes/api.js";
import { createTestDb } from "../helpers/db.js";
import { writeZip } from "../helpers/zip.js";

let ctx: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createApiRoutes>;
let storage: ReturnType<typeof createStorage>;
let workDir: string;
let auth: Record<string, string>;

beforeEach(() => {
  ctx = createTestDb();
  workDir = mkdtempSync(join(tmpdir(), "api-test-"));
  storage = createStorage(join(ctx.dir, "data"));
  app = createApiRoutes({
    db: ctx.db,
    storage,
    cache: createMockupCache(ctx.db),
    limits: DEFAULT_EXTRACT_LIMITS,
    maxUploadBytes: 10_000_000,
    mockupsOrigin: "https://mockups.example.org",
  });
  auth = { authorization: `Bearer ${createApiToken(ctx.db, "test").token}` };
});

afterEach(() => {
  ctx.cleanup();
  rmSync(workDir, { recursive: true, force: true });
});

function resolve(body: unknown) {
  return app.request("/api/mockups/resolve", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function pushZip(id: string, entries: Parameters<typeof writeZip>[1], name?: string) {
  const zipPath = await writeZip(workDir, entries, name);
  return app.request(`/api/mockups/${id}/content`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/zip" },
    body: readFileSync(zipPath),
  });
}

describe("authentication", () => {
  it("401s every route without a token", async () => {
    expect((await app.request("/api/mockups")).status).toBe(401);
    expect((await app.request("/api/mockups/resolve", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/mockups/x", { method: "DELETE" })).status).toBe(401);
  });
});

describe("POST /api/mockups/resolve", () => {
  it("creates a mockup and returns its base path and url", async () => {
    const res = await resolve({ slug: "acme", name: "Acme" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mockup.slug).toBe("acme");
    expect(body.mockup.name).toBe("Acme");
    expect(body.basePath).toBe(`/m/${body.mockup.id}/`);
    expect(body.url).toBe(`https://mockups.example.org/m/${body.mockup.id}`);
  });

  it("returns the same mockup on a second resolve", async () => {
    const first = await (await resolve({ slug: "acme", name: "Acme" })).json();
    const second = await (await resolve({ slug: "acme", name: "Ignored" })).json();

    expect(second.mockup.id).toBe(first.mockup.id);
    expect(second.mockup.name).toBe("Acme");
  });

  it("400s an invalid slug", async () => {
    const res = await resolve({ slug: "Not A Slug" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/slug/i);
  });

  it("defaults the name to the slug", async () => {
    const body = await (await resolve({ slug: "acme" })).json();
    expect(body.mockup.name).toBe("acme");
  });
});

describe("POST /api/mockups/:id/content", () => {
  it("accepts a zip and reports the share url", async () => {
    const { mockup } = await (await resolve({ slug: "acme" })).json();

    const res = await pushZip(mockup.id, [
      { name: "index.html", content: `<script src="/m/${mockup.id}/a.js"></script>` },
    ]);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe(`https://mockups.example.org/m/${mockup.id}`);
    expect(body.warning).toBeNull();
    expect(body.mockup.fileCount).toBe(1);
    expect(existsSync(join(storage.mockupDir(mockup.id), "index.html"))).toBe(true);
  });

  it("returns the base-path warning without failing the push", async () => {
    const { mockup } = await (await resolve({ slug: "acme" })).json();

    const res = await pushZip(mockup.id, [
      { name: "index.html", content: '<script src="/assets/a.js"></script>' },
    ]);

    expect(res.status).toBe(200);
    expect((await res.json()).warning).toMatch(/--base=/);
  });

  it("400s a rejected archive with a readable message", async () => {
    const { mockup } = await (await resolve({ slug: "acme" })).json();

    const res = await pushZip(mockup.id, [{ name: "app.js", content: "1" }]);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/index\.html/);
  });

  it("404s a push to an unknown mockup", async () => {
    const res = await pushZip("no-such-id", [{ name: "index.html", content: "x" }]);
    expect(res.status).toBe(404);
  });

  it("413s a body over the upload cap", async () => {
    const { mockup } = await (await resolve({ slug: "acme" })).json();
    const small = createApiRoutes({
      db: ctx.db,
      storage,
      cache: createMockupCache(ctx.db),
      limits: DEFAULT_EXTRACT_LIMITS,
      maxUploadBytes: 10,
      mockupsOrigin: "https://mockups.example.org",
    });

    const zipPath = await writeZip(workDir, [{ name: "index.html", content: "x".repeat(500) }]);
    const res = await small.request(`/api/mockups/${mockup.id}/content`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/zip" },
      body: readFileSync(zipPath),
    });

    expect(res.status).toBe(413);
  });
});

describe("GET /api/mockups and DELETE /api/mockups/:id", () => {
  it("lists mockups", async () => {
    await resolve({ slug: "acme" });
    await resolve({ slug: "beta" });

    const body = await (await app.request("/api/mockups", { headers: auth })).json();
    expect(body.mockups.map((m: { slug: string }) => m.slug).sort()).toEqual(["acme", "beta"]);
  });

  it("deletes the row and the files", async () => {
    const { mockup } = await (await resolve({ slug: "acme" })).json();
    await pushZip(mockup.id, [{ name: "index.html", content: "x" }]);

    const res = await app.request(`/api/mockups/${mockup.id}`, { method: "DELETE", headers: auth });

    expect(res.status).toBe(204);
    expect(existsSync(storage.mockupDir(mockup.id))).toBe(false);
    const body = await (await app.request("/api/mockups", { headers: auth })).json();
    expect(body.mockups).toEqual([]);
  });

  it("404s deleting an unknown mockup", async () => {
    const res = await app.request("/api/mockups/nope", { method: "DELETE", headers: auth });
    expect(res.status).toBe(404);
  });
});
