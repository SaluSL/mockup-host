import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { MockupCache } from "../lib/mockup-cache.js";
import { parseRange } from "../lib/range.js";
import { cacheControlFor, contentTypeFor, shouldFallbackToIndex } from "../lib/serving.js";
import type { Storage } from "../lib/storage.js";

export interface ServeDeps {
  storage: Storage;
  cache: MockupCache;
}

function webStream(path: string, options?: { start: number; end: number }): ReadableStream {
  return Readable.toWeb(createReadStream(path, options)) as ReadableStream;
}

async function sendFile(
  c: Context<AppEnv>,
  absPath: string,
  relPath: string,
): Promise<Response | null> {
  const info = await stat(absPath).catch(() => null);
  if (!info?.isFile()) return null;

  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(relPath),
    "cache-control": cacheControlFor(relPath),
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "last-modified": info.mtime.toUTCString(),
    etag,
  };

  if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);

  const range = parseRange(c.req.header("range"), info.size);
  if (range === "invalid") {
    return c.body(null, 416, { ...headers, "content-range": `bytes */${info.size}` });
  }

  if (range) {
    return c.body(webStream(absPath, range), 206, {
      ...headers,
      "content-range": `bytes ${range.start}-${range.end}/${info.size}`,
      "content-length": String(range.end - range.start + 1),
    });
  }

  return c.body(webStream(absPath), 200, { ...headers, "content-length": String(info.size) });
}

export function createServeRoutes(deps: ServeDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/m/:id", (c) => c.redirect(`/m/${c.req.param("id")}/`, 301));

  app.get("/m/:id/*", async (c) => {
    const id = c.req.param("id");
    if (!deps.cache.exists(id)) return c.notFound();

    let relPath: string;
    try {
      relPath = decodeURIComponent(c.req.path.slice(`/m/${id}/`.length));
    } catch {
      return c.notFound();
    }

    const target = relPath === "" ? "index.html" : relPath;
    const absPath = deps.storage.resolveFile(id, target);
    if (absPath === null) return c.notFound();

    // A directory request resolves to its own index.html.
    const info = await stat(absPath).catch(() => null);
    if (info?.isDirectory()) {
      const nested = join(absPath, "index.html");
      const served = await sendFile(c, nested, "index.html");
      if (served) return served;
    } else {
      const served = await sendFile(c, absPath, target);
      if (served) return served;
    }

    if (!shouldFallbackToIndex(target, c.req.header("accept") ?? null)) return c.notFound();

    const indexPath = deps.storage.resolveFile(id, "index.html");
    if (indexPath === null) return c.notFound();

    const fallback = await sendFile(c, indexPath, "index.html");
    return fallback ?? c.notFound();
  });

  return app;
}
