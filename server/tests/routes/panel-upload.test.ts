import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/lib/extract.js";
import { createMockupCache } from "../../src/lib/mockup-cache.js";
import { hashPassword } from "../../src/lib/password.js";
import { createStorage } from "../../src/lib/storage.js";
import { listApiTokens } from "../../src/lib/tokens.js";
import { createPanelRoutes, type PanelDeps } from "../../src/routes/panel.js";
import { mockups } from "../../src/schema/index.js";
import { createTestDb } from "../helpers/db.js";
import { writeZip } from "../helpers/zip.js";

let ctx: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createPanelRoutes>;
let deps: PanelDeps;
let workDir: string;
let cookie: string;

beforeEach(async () => {
  ctx = createTestDb();
  workDir = mkdtempSync(join(tmpdir(), "panel-upload-"));
  deps = {
    db: ctx.db,
    storage: createStorage(join(ctx.dir, "data")),
    cache: createMockupCache(ctx.db),
    limits: DEFAULT_EXTRACT_LIMITS,
    maxUploadBytes: 10_000_000,
    mockupsOrigin: "https://mockups.example.org",
    adminUsername: "szymon",
    adminPasswordHash: await hashPassword("hunter2"),
    sessionSecret: "test-secret",
    secureCookies: false,
  };
  app = createPanelRoutes(deps);

  const res = await app.request("/login", {
    method: "POST",
    body: new URLSearchParams({ username: "szymon", password: "hunter2" }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0];

  ctx.db.insert(mockups).values({ id: "id-1", name: "Acme", slug: "acme" }).run();
});

afterEach(() => {
  ctx.cleanup();
  rmSync(workDir, { recursive: true, force: true });
});

async function upload(entries: Parameters<typeof writeZip>[1]) {
  const zipPath = await writeZip(workDir, entries);
  const body = new FormData();
  body.set("file", new File([readFileSync(zipPath)], "dist.zip", { type: "application/zip" }));
  return app.request("/mockups/id-1/content", { method: "POST", headers: { cookie }, body });
}

describe("panel zip drop", () => {
  it("accepts a dropped zip and serves it", async () => {
    const res = await upload([{ name: "index.html", content: "<h1>hi</h1>" }]);

    expect(res.status).toBe(302);
    expect(existsSync(join(deps.storage.mockupDir("id-1"), "index.html"))).toBe(true);
  });

  it("reports a rejected archive rather than redirecting", async () => {
    const res = await upload([{ name: "app.js", content: "1" }]);

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/index\.html/);
  });

  it("refuses an upload without a session", async () => {
    const zipPath = await writeZip(workDir, [{ name: "index.html", content: "x" }]);
    const body = new FormData();
    body.set("file", new File([readFileSync(zipPath)], "dist.zip"));

    const res = await app.request("/mockups/id-1/content", { method: "POST", body });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("tokens page", () => {
  it("shows the token value exactly once, at creation", async () => {
    const created = await app.request("/tokens", {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "laptop" }),
    });

    expect(created.status).toBe(200);
    const page = await created.text();
    const match = /mk_[A-Za-z0-9_-]+/.exec(page);
    expect(match).not.toBeNull();

    const later = await (await app.request("/tokens", { headers: { cookie } })).text();
    expect(later).not.toContain(match![0]);
    expect(later).toMatch(/laptop/);
  });

  it("revokes a token", async () => {
    await app.request("/tokens", {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "laptop" }),
    });
    const id = listApiTokens(ctx.db)[0].id;

    const res = await app.request(`/tokens/${id}/revoke`, { method: "POST", headers: { cookie } });

    expect(res.status).toBe(302);
    expect(listApiTokens(ctx.db)[0].revokedAt).toBeInstanceOf(Date);
  });

  it("requires a session", async () => {
    const res = await app.request("/tokens");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});
