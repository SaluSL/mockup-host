import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/app-env.js";
import { requireHost } from "../src/middleware/host.js";
import { SESSION_COOKIE, requireSession } from "../src/middleware/session.js";
import { requireToken } from "../src/middleware/token.js";
import { createSession, deleteSession } from "../src/lib/sessions.js";
import { createApiToken, revokeApiToken } from "../src/lib/tokens.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret";
let ctx: ReturnType<typeof createTestDb>;

beforeEach(() => {
  ctx = createTestDb();
});
afterEach(() => ctx.cleanup());

describe("requireHost", () => {
  const app = new Hono<AppEnv>();
  app.use("*", requireHost("panel.example.org"));
  app.get("/", (c) => c.text("panel"));

  it("serves a request on the expected host", async () => {
    const res = await app.request("/", { headers: { host: "panel.example.org" } });
    expect(res.status).toBe(200);
  });

  it("ignores a port on the host header", async () => {
    const res = await app.request("/", { headers: { host: "panel.example.org:3000" } });
    expect(res.status).toBe(200);
  });

  it("404s a request on a different host, without saying why", async () => {
    const res = await app.request("/", { headers: { host: "mockups.example.org" } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/panel/i);
  });

  it("404s when no host header is present", async () => {
    const res = await app.request("/", { headers: {} });
    expect(res.status).toBe(404);
  });
});

describe("requireSession", () => {
  function buildApp() {
    const app = new Hono<AppEnv>();
    app.get("/login", (c) => c.text("login page"));
    app.post("/sign-in", async (c) => {
      const id = createSession(ctx.db);
      await setSignedCookie(c, SESSION_COOKIE, id, SECRET, { path: "/", httpOnly: true });
      return c.text("ok");
    });
    app.use("/private/*", requireSession(ctx.db, SECRET));
    app.get("/private/thing", (c) => c.text(`hello ${c.get("sessionId")}`));
    return app;
  }

  async function signedInCookie(app: Hono<AppEnv>): Promise<string> {
    const res = await app.request("/sign-in", { method: "POST" });
    return res.headers.get("set-cookie")!.split(";")[0];
  }

  it("redirects an anonymous request to /login", async () => {
    const res = await buildApp().request("/private/thing");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("allows a request carrying a valid signed session cookie", async () => {
    const app = buildApp();
    const cookie = await signedInCookie(app);

    const res = await app.request("/private/thing", { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^hello /);
  });

  it("rejects a tampered cookie value", async () => {
    const app = buildApp();
    const cookie = await signedInCookie(app);
    const tampered = `${SESSION_COOKIE}=${cookie.split("=")[1]}x`;

    const res = await app.request("/private/thing", { headers: { cookie: tampered } });
    expect(res.status).toBe(302);
  });

  it("rejects a cookie whose session has been revoked", async () => {
    const app = buildApp();
    const cookie = await signedInCookie(app);
    const id = createSession(ctx.db);
    deleteSession(ctx.db, id);

    const before = await app.request("/private/thing", { headers: { cookie } });
    expect(before.status).toBe(200);

    for (const row of ctx.db.$client.prepare("select id from sessions").all() as { id: string }[]) {
      deleteSession(ctx.db, row.id);
    }

    const after = await app.request("/private/thing", { headers: { cookie } });
    expect(after.status).toBe(302);
  });
});

describe("requireToken", () => {
  function buildApp() {
    const app = new Hono<AppEnv>();
    app.use("/api/*", requireToken(ctx.db));
    app.get("/api/thing", (c) => c.json({ tokenId: c.get("tokenId") }));
    return app;
  }

  it("401s without an Authorization header", async () => {
    const res = await buildApp().request("/api/thing");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("401s for a malformed Authorization header", async () => {
    const res = await buildApp().request("/api/thing", {
      headers: { authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });

  it("allows a valid bearer token and exposes its id", async () => {
    const { token, id } = createApiToken(ctx.db, "laptop");

    const res = await buildApp().request("/api/thing", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokenId: id });
  });

  it("401s for a revoked token", async () => {
    const { token, id } = createApiToken(ctx.db, "laptop");
    revokeApiToken(ctx.db, id);

    const res = await buildApp().request("/api/thing", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
