import { basename, extname } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};

const HASHED = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

export function contentTypeFor(relPath: string): string {
  return MIME[extname(relPath).toLowerCase()] ?? "application/octet-stream";
}

export function cacheControlFor(relPath: string): string {
  const ext = extname(relPath).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "no-cache";
  if (HASHED.test(basename(relPath))) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

export function shouldFallbackToIndex(relPath: string, acceptHeader: string | null): boolean {
  if (!acceptHeader?.includes("text/html")) return false;
  const ext = extname(relPath).toLowerCase();
  return ext === "" || ext === ".html" || ext === ".htm";
}
