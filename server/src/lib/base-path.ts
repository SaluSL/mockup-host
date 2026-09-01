import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const SCANNED_EXTENSIONS = new Set([".html", ".htm", ".js", ".mjs", ".css"]);

// Matches a root-absolute reference inside src="", href="", url(), or an import specifier.
const REFERENCE =
  /(?:src|href)\s*=\s*["'](\/[^"'\s>]*)["']|url\(\s*["']?(\/[^"')\s]*)["']?\s*\)|import\(\s*["'](\/[^"']*)["']\s*\)/g;

export function findAbsoluteRefs(content: string, expectedBase: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(REFERENCE)) {
    const ref = match[1] ?? match[2] ?? match[3];
    if (!ref) continue;
    if (ref.startsWith("//")) continue;
    if (ref.startsWith(expectedBase)) continue;
    found.add(ref);
  }
  return [...found];
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export async function detectBasePathWarning(
  rootDir: string,
  expectedBase: string,
): Promise<string | null> {
  const offenders = new Set<string>();

  for await (const file of walk(rootDir)) {
    if (!SCANNED_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const content = await readFile(file, "utf8");
    for (const ref of findAbsoluteRefs(content, expectedBase)) {
      offenders.add(ref);
      if (offenders.size >= 5) break;
    }
    if (offenders.size >= 5) break;
  }

  if (offenders.size === 0) return null;

  const sample = [...offenders].slice(0, 3).join(", ");
  return `This build references ${sample} from the site root and will 404 when served at ${expectedBase}. Rebuild with --base=${expectedBase}`;
}
