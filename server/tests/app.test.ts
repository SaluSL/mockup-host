import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { createMockupCache } from "../src/lib/mockup-cache.js";
import { hashPassword } from "../src/lib/password.js";
import { createStorage } from "../src/lib/storage.js";
import { mockups } from "../src/schema/index.js";
import { createTestDb } from "./helpers/db.js";

let ctx: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createApp>;

const PANEL = { host: "panel.example.org" };
const MOCKUPS = { host: "mockups.example.org" };

beforeEach(async () => {
  ctx = createTestDb();
  const env: Env = {
    DATA_DIR: join(ctx.dir, "data"),
    DATABASE_PATH: join(ctx.dir, "db.sqlite"),
    PORT: 3000,
    PANEL_HOST: "panel.example.org",
    MOCKUPS_HOST: "mockups.example.org",
    SESSION_SECRET: "test-secret",
    ADMIN_USERNAME: "szymon",
    ADMIN_PASSWORD_HASH: await hashPassword("hunter2"),
    MAX_UPLOAD_BYTES: 10_000_000,
    NODE_ENV: "test",
  };

  app = createApp({
    db: ctx.db,
    storage: createStorage(env.DATA_DIR),
    cache: createMockupCache(ctx.db),
    env,
  });

  ctx.db.insert(mockups).values({ id: "id-1", name: "Acme", slug: "acme" }).run();
});

afterEach(() => ctx.cleanup());

describe("host dispatch", () => {
  it("serves /healthz on either host", async () => {
    expect((await app.request("/healthz", { headers: PANEL })).status).toBe(200);
    expect((await app.request("/healthz", { headers: MOCKUPS })).status).toBe(200);
  });

  it("serves the login page on the panel host only", async () => {
    expect((await app.request("/login", { headers: PANEL })).status).toBe(200);
    expect((await app.request("/login", { headers: MOCKUPS })).status).toBe(404);
  });

  it("exposes the api on the panel host only", async () => {
    expect((await app.request("/api/mockups", { headers: PANEL })).status).toBe(401);
    expect((await app.request("/api/mockups", { headers: MOCKUPS })).status).toBe(404);
  });

  it("serves mockups on the mockups host only", async () => {
    expect((await app.request("/m/id-1", { headers: MOCKUPS })).status).toBe(301);
    expect((await app.request("/m/id-1", { headers: PANEL })).status).toBe(404);
  });

  it("404s an unrecognised host", async () => {
    const res = await app.request("/login", { headers: { host: "evil.example.org" } });
    expect(res.status).toBe(404);
  });

  it("does not leak the panel hostname in a 404 body", async () => {
    const res = await app.request("/login", { headers: MOCKUPS });
    expect(await res.text()).not.toContain("panel.example.org");
  });
});
