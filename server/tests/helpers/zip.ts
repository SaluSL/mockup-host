import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZipFile } from "yazl";

export interface ZipFixtureEntry {
  name: string;
  content?: string | Buffer;
  mode?: number;
}

/**
 * yazl validates entry names and refuses to write traversal or absolute paths,
 * so hostile fixtures are written under a same-length placeholder and the name
 * bytes are patched in the finished archive (they appear in the local header
 * and again in the central directory, both of which this replaces).
 */
function isHostile(name: string): boolean {
  return (
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").includes("..")
  );
}

const placeholderFor = (index: number, length: number): string =>
  String.fromCharCode(97 + (index % 26)).repeat(length);

export function writeZip(
  dir: string,
  entries: ZipFixtureEntry[],
  fileName = "fixture.zip",
): Promise<string> {
  const zip = new ZipFile();
  const patches: Array<[string, string]> = [];

  entries.forEach((entry, index) => {
    let name = entry.name;
    if (isHostile(name)) {
      const placeholder = placeholderFor(index, Buffer.byteLength(name));
      patches.push([placeholder, name]);
      name = placeholder;
    }
    if (name.endsWith("/")) {
      zip.addEmptyDirectory(name);
      return;
    }
    const buffer = Buffer.from(entry.content ?? "");
    zip.addBuffer(buffer, name, entry.mode ? { mode: entry.mode } : undefined);
  });
  zip.end();

  const target = join(dir, fileName);
  return new Promise<string>((resolve, reject) => {
    const out = createWriteStream(target);
    zip.outputStream.pipe(out);
    out.on("close", () => resolve(target));
    out.on("error", reject);
  }).then(async (path) => {
    if (patches.length === 0) return path;
    let bytes = await readFile(path);
    for (const [placeholder, real] of patches) {
      bytes = Buffer.from(
        bytes.toString("latin1").split(placeholder).join(real),
        "latin1",
      );
    }
    await writeFile(path, bytes);
    return path;
  });
}
