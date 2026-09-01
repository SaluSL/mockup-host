import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { IngestError } from "./errors.js";

async function hasIndex(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, "index.html"))).isFile();
  } catch {
    return false;
  }
}

export async function resolveContentRoot(extractedDir: string): Promise<string> {
  if (await hasIndex(extractedDir)) return extractedDir;

  const entries = await readdir(extractedDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const wrapped = join(extractedDir, entries[0].name);
    if (await hasIndex(wrapped)) return wrapped;
  }

  throw new IngestError(
    "Archive has no index.html at its root (or in a single wrapping directory)",
    "no_index_html",
  );
}
