import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { SLUG_PATTERN, mockupBasePath, mockupUrl } from "@mockups/shared";
import type { AppEnv } from "../app-env.js";
import type { Db } from "../db.js";
import { IngestError } from "../lib/errors.js";
import type { ExtractLimits } from "../lib/extract.js";
import { ingestZip } from "../lib/ingest.js";
import type { MockupCache } from "../lib/mockup-cache.js";
import {
  deleteMockup,
  receiveUpload,
  resolveOrCreateMockup,
  toSummary,
} from "../lib/mockup-service.js";
import type { Storage } from "../lib/storage.js";
import { requireToken } from "../middleware/token.js";
import { mockups } from "../schema/index.js";

export interface ApiDeps {
  db: Db;
  storage: Storage;
  cache: MockupCache;
  limits: ExtractLimits;
  maxUploadBytes: number;
  mockupsOrigin: string;
}

const STATUS_FOR: Record<string, 400 | 413> = {
  too_large: 413,
  ratio_exceeded: 413,
  too_many_files: 413,
};

export function createApiRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/api/*", requireToken(deps.db));

  app.post("/api/mockups/resolve", async (c) => {
    const body = await c.req
      .json<{ slug?: string; name?: string }>()
      .catch((): { slug?: string; name?: string } => ({}));
    const slug = body.slug ?? "";
    if (!SLUG_PATTERN.test(slug)) {
      return c.json({ error: "slug must be lowercase words separated by hyphens" }, 400);
    }

    const mockup = resolveOrCreateMockup(deps.db, { slug, name: body.name });
    return c.json({
      mockup: toSummary(mockup),
      basePath: mockupBasePath(mockup.id),
      url: mockupUrl(deps.mockupsOrigin, mockup.id),
    });
  });

  app.post("/api/mockups/:id/content", async (c) => {
    const id = c.req.param("id");
    const row = deps.db.select().from(mockups).where(eq(mockups.id, id)).get();
    if (!row) return c.json({ error: "Mockup not found" }, 404);

    let uploadPath: string | null = null;
    try {
      uploadPath = await receiveUpload(c, deps.maxUploadBytes);
      const result = await ingestZip(
        { db: deps.db, storage: deps.storage, limits: deps.limits },
        id,
        uploadPath,
      );
      deps.cache.invalidate(id);

      const updated = deps.db.select().from(mockups).where(eq(mockups.id, id)).get()!;
      return c.json({
        mockup: toSummary(updated),
        url: mockupUrl(deps.mockupsOrigin, id),
        warning: result.warning,
      });
    } catch (error) {
      if (error instanceof IngestError) {
        return c.json({ error: error.message }, STATUS_FOR[error.code] ?? 400);
      }
      throw error;
    } finally {
      if (uploadPath) await rm(dirname(uploadPath), { recursive: true, force: true });
    }
  });

  app.get("/api/mockups", (c) => {
    const rows = deps.db.select().from(mockups).all();
    return c.json({ mockups: rows.map(toSummary) });
  });

  app.delete("/api/mockups/:id", async (c) => {
    const removed = await deleteMockup(deps, c.req.param("id"));
    if (!removed) return c.json({ error: "Mockup not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
