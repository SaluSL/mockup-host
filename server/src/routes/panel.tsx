import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, setSignedCookie } from "hono/cookie";
import { slugify } from "@mockups/shared";
import type { AppEnv } from "../app-env.js";
import type { Db } from "../db.js";
import type { ExtractLimits } from "../lib/extract.js";
import type { MockupCache } from "../lib/mockup-cache.js";
import { deleteMockup, resolveOrCreateMockup, toSummary } from "../lib/mockup-service.js";
import { safeEquals, verifyPassword } from "../lib/password.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { createSession, deleteSession } from "../lib/sessions.js";
import type { Storage } from "../lib/storage.js";
import { SESSION_COOKIE, requireSession } from "../middleware/session.js";
import { mockups } from "../schema/index.js";
import { LoginPage } from "../panel/login.js";
import { MockupsPage } from "../panel/mockups.js";

export interface PanelDeps {
  db: Db;
  storage: Storage;
  cache: MockupCache;
  limits: ExtractLimits;
  maxUploadBytes: number;
  mockupsOrigin: string;
  adminUsername: string;
  adminPasswordHash: string;
  sessionSecret: string;
  secureCookies: boolean;
}

export function createPanelRoutes(deps: PanelDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

  app.get("/login", (c) => c.html(<LoginPage />));

  app.post("/login", async (c) => {
    const clientKey =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? c.req.header("host") ?? "unknown";
    if (!loginLimiter.check(clientKey)) {
      return c.html(<LoginPage error="Too many attempts. Try again later." />, 429);
    }

    const body = await c.req.parseBody();
    const username = String(body.username ?? "");
    const password = String(body.password ?? "");

    const usernameOk = safeEquals(username, deps.adminUsername);
    const passwordOk = await verifyPassword(deps.adminPasswordHash, password);
    if (!usernameOk || !passwordOk) {
      return c.html(<LoginPage error="Those credentials are incorrect." />, 401);
    }

    loginLimiter.reset(clientKey);
    const sessionId = createSession(deps.db);
    await setSignedCookie(c, SESSION_COOKIE, sessionId, deps.sessionSecret, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: deps.secureCookies,
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect("/", 302);
  });

  app.post("/logout", requireSession(deps.db, deps.sessionSecret), (c) => {
    deleteSession(deps.db, c.get("sessionId"));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/login", 302);
  });

  app.use("/", requireSession(deps.db, deps.sessionSecret));
  app.use("/mockups", requireSession(deps.db, deps.sessionSecret));
  app.use("/mockups/*", requireSession(deps.db, deps.sessionSecret));

  app.get("/", (c) => {
    const rows = deps.db.select().from(mockups).all();
    return c.html(
      <MockupsPage
        mockups={rows.map(toSummary)}
        mockupsOrigin={deps.mockupsOrigin}
        flash={c.req.query("flash")}
      />,
    );
  });

  app.post("/mockups", async (c) => {
    const body = await c.req.parseBody();
    const name = String(body.name ?? "").trim();

    let slug: string;
    try {
      slug = slugify(name);
    } catch {
      return c.text("That name has no usable characters for a slug.", 400);
    }

    resolveOrCreateMockup(deps.db, { slug, name });
    return c.redirect("/", 302);
  });

  app.post("/mockups/:id/rename", async (c) => {
    const body = await c.req.parseBody();
    const name = String(body.name ?? "").trim();
    if (name === "") return c.text("A name is required.", 400);

    deps.db
      .update(mockups)
      .set({ name, updatedAt: new Date() })
      .where(eq(mockups.id, c.req.param("id")))
      .run();
    return c.redirect("/", 302);
  });

  app.post("/mockups/:id/delete", async (c) => {
    await deleteMockup(deps, c.req.param("id"));
    return c.redirect("/", 302);
  });

  return app;
}
