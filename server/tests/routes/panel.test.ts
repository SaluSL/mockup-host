import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/lib/extract.js";
import { createMockupCache } from "../../src/lib/mockup-cache.js";
import { hashPassword } from "../../src/lib/password.js";
import { createStorage } from "../../src/lib/storage.js";
import { createPanelRoutes, type PanelDeps } from "../../src/routes/panel.js";
import { mockups } from "../../src/schema/index.js";
import { createTestDb } from "../helpers/db.js";

let ctx: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createPanelRoutes>;
let deps: PanelDeps;

beforeEach(async () => {
  ctx = createTestDb();
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
});

afterEach(() => ctx.cleanup());

function form(fields: Record<string, string>): BodyInit {
  return new URLSearchParams(fields);
}

async function login(): Promise<string> {
  const res = await app.request("/login", {
    method: "POST",
    body: form({ username: "szymon", password: "hunter2" }),
  });
  expect(res.status).toBe(302);
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("login", () => {
  it("shows the login form", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/name="password"/);
  });

  it("redirects to the list on correct credentials", async () => {
    const res = await app.request("/login", {
      method: "POST",
      body: form({ username: "szymon", password: "hunter2" }),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
  });

  it("rejects a wrong password without revealing which field was wrong", async () => {
    const res = await app.request("/login", {
      method: "POST",
      body: form({ username: "szymon", password: "wrong" }),
    });

    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toMatch(/incorrect/i);
    expect(body).not.toMatch(/password is|username is/i);
  });

  it("rejects an unknown username", async () => {
    const res = await app.request("/login", {
      method: "POST",
      body: form({ username: "someone", password: "hunter2" }),
    });
    expect(res.status).toBe(401);
  });

  it("rate-limits repeated failures", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await app.request("/login", {
        method: "POST",
        body: form({ username: "szymon", password: "wrong" }),
      });
    }

    const res = await app.request("/login", {
      method: "POST",
      body: form({ username: "szymon", password: "hunter2" }),
    });

    expect(res.status).toBe(429);
  });
});

describe("session gating", () => {
  it("redirects an anonymous visitor to /login", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("logs out and stops accepting the cookie", async () => {
    const cookie = await login();
    expect((await app.request("/", { headers: { cookie } })).status).toBe(200);

    const out = await app.request("/logout", { method: "POST", headers: { cookie } });
    expect(out.status).toBe(302);

    expect((await app.request("/", { headers: { cookie } })).status).toBe(302);
  });
});

describe("mockup management", () => {
  it("creates a mockup from a name and shows its share url", async () => {
    const cookie = await login();

    const created = await app.request("/mockups", {
      method: "POST",
      headers: { cookie },
      body: form({ name: "Acme Landing" }),
    });
    expect(created.status).toBe(302);

    const page = await (await app.request("/", { headers: { cookie } })).text();
    expect(page).toMatch(/Acme Landing/);
    expect(page).toMatch(/acme-landing/);
    expect(page).toMatch(/https:\/\/mockups\.example\.org\/m\//);
  });

  it("rejects a name that cannot be slugified", async () => {
    const cookie = await login();
    const res = await app.request("/mockups", {
      method: "POST",
      headers: { cookie },
      body: form({ name: "!!!" }),
    });
    expect(res.status).toBe(400);
  });

  it("renames a mockup", async () => {
    const cookie = await login();
    ctx.db.insert(mockups).values({ id: "id-1", name: "Old", slug: "old" }).run();

    await app.request("/mockups/id-1/rename", {
      method: "POST",
      headers: { cookie },
      body: form({ name: "New Name" }),
    });

    const page = await (await app.request("/", { headers: { cookie } })).text();
    expect(page).toMatch(/New Name/);
    expect(page).not.toMatch(/>Old</);
  });

  it("deletes a mockup", async () => {
    const cookie = await login();
    ctx.db.insert(mockups).values({ id: "id-1", name: "Doomed", slug: "doomed" }).run();

    const res = await app.request("/mockups/id-1/delete", { method: "POST", headers: { cookie } });

    expect(res.status).toBe(302);
    expect(ctx.db.select().from(mockups).all()).toEqual([]);
  });

  it("shows the base-path warning when one is recorded", async () => {
    const cookie = await login();
    ctx.db
      .insert(mockups)
      .values({
        id: "id-1",
        name: "Broken",
        slug: "broken",
        basePathWarning: "Rebuild with --base=/m/id-1/",
      })
      .run();

    const page = await (await app.request("/", { headers: { cookie } })).text();
    expect(page).toMatch(/--base=\/m\/id-1\//);
  });

  it("requires a session for every management route", async () => {
    for (const path of ["/mockups", "/mockups/id-1/rename", "/mockups/id-1/delete"]) {
      const res = await app.request(path, { method: "POST", body: form({ name: "x" }) });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login");
    }
  });
});
