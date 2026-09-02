import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { MockupSummary } from "@mockups/shared";
import type { Db } from "../db.js";
import { mockups, type Mockup } from "../schema/index.js";
import { IngestError } from "./errors.js";
import type { MockupCache } from "./mockup-cache.js";
import type { Storage } from "./storage.js";

export function toSummary(row: Mockup): MockupSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastPushedAt: row.lastPushedAt?.toISOString() ?? null,
    sizeBytes: row.sizeBytes,
    fileCount: row.fileCount,
    basePathWarning: row.basePathWarning,
  };
}

export function resolveOrCreateMockup(db: Db, input: { slug: string; name?: string }): Mockup {
  const existing = db.select().from(mockups).where(eq(mockups.slug, input.slug)).get();
  if (existing) return existing;

  const id = randomUUID();
  db.insert(mockups).values({ id, slug: input.slug, name: input.name ?? input.slug }).run();
  return db.select().from(mockups).where(eq(mockups.id, id)).get()!;
}

export async function deleteMockup(
  deps: { db: Db; storage: Storage; cache: MockupCache },
  id: string,
): Promise<boolean> {
  const row = deps.db.select().from(mockups).where(eq(mockups.id, id)).get();
  if (!row) return false;

  deps.db.delete(mockups).where(eq(mockups.id, id)).run();
  deps.cache.invalidate(id);
  await deps.storage.remove(id);
  return true;
}

/** Streams the request body to a temp file, refusing to buffer more than the cap. */
export async function receiveUpload(c: Context, maxBytes: number): Promise<string> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new IngestError(`Upload exceeds ${maxBytes} bytes`, "too_large");
  }

  const dir = await mkdtemp(join(tmpdir(), "mockup-upload-"));
  const target = join(dir, "upload.zip");

  const contentType = c.req.header("content-type") ?? "";
  let source: ReadableStream<Uint8Array> | null;

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      await rm(dir, { recursive: true, force: true });
      throw new IngestError('Expected a file field named "file"', "invalid_entry");
    }
    if (file.size > maxBytes) {
      await rm(dir, { recursive: true, force: true });
      throw new IngestError(`Upload exceeds ${maxBytes} bytes`, "too_large");
    }
    source = file.stream();
  } else {
    source = c.req.raw.body;
  }

  if (!source) {
    await rm(dir, { recursive: true, force: true });
    throw new IngestError("Request had no body", "empty_archive");
  }

  let written = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength;
      if (written > maxBytes) {
        throw new IngestError(`Upload exceeds ${maxBytes} bytes`, "too_large");
      }
      controller.enqueue(chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(source.pipeThrough(counted)), createWriteStream(target));
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    // The stream machinery wraps an error thrown inside transform().
    const cause = (error as { cause?: unknown }).cause;
    throw cause instanceof IngestError ? cause : error;
  }

  return target;
}
