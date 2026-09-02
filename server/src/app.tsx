import { Hono } from "hono";
import { logger } from "hono/logger";
import type { AppEnv } from "./app-env.js";
import type { Db } from "./db.js";
import type { Env } from "./env.js";
import { DEFAULT_EXTRACT_LIMITS } from "./lib/extract.js";
import type { MockupCache } from "./lib/mockup-cache.js";
import type { Storage } from "./lib/storage.js";
import { requireHost } from "./middleware/host.js";
import { createApiRoutes } from "./routes/api.js";
import { createPanelRoutes } from "./routes/panel.js";
import { createServeRoutes } from "./routes/serve.js";

export interface AppOptions {
  db: Db;
  storage: Storage;
  cache: MockupCache;
  env: Env;
}

export function createApp({ db, storage, cache, env }: AppOptions): Hono<AppEnv> {
  const scheme = env.NODE_ENV === "production" ? "https" : "http";
  const mockupsOrigin = `${scheme}://${env.MOCKUPS_HOST}`;
  const shared = { db, storage, cache, limits: DEFAULT_EXTRACT_LIMITS };

  const mockupsSite = new Hono<AppEnv>();
  mockupsSite.use("*", requireHost(env.MOCKUPS_HOST));
  mockupsSite.route("/", createServeRoutes({ storage, cache }));

  const panelSite = new Hono<AppEnv>();
  panelSite.use("*", requireHost(env.PANEL_HOST));
  panelSite.route(
    "/",
    createApiRoutes({ ...shared, maxUploadBytes: env.MAX_UPLOAD_BYTES, mockupsOrigin }),
  );
  panelSite.route(
    "/",
    createPanelRoutes({
      ...shared,
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
      mockupsOrigin,
      adminUsername: env.ADMIN_USERNAME,
      adminPasswordHash: env.ADMIN_PASSWORD_HASH,
      sessionSecret: env.SESSION_SECRET,
      secureCookies: env.NODE_ENV === "production",
    }),
  );

  const app = new Hono<AppEnv>();
  app.use("*", logger());
  app.get("/healthz", (c) => c.json({ ok: true }));

  // Each sub-app also carries its own requireHost: redundant by design, so a
  // future refactor here cannot silently expose the panel on the mockups origin.
  app.all("*", (c) => {
    const host = c.req.header("host")?.split(":")[0].toLowerCase();
    if (host === env.MOCKUPS_HOST.toLowerCase()) return mockupsSite.fetch(c.req.raw);
    if (host === env.PANEL_HOST.toLowerCase()) return panelSite.fetch(c.req.raw);
    return c.notFound();
  });

  return app;
}
