import { createWriteStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ZipFile } from "yazl";

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export async function zipDirectory(dir: string, outPath: string): Promise<void> {
  if (!existsSync(dir)) throw new Error(`Directory not found: ${dir}`);

  const zip = new ZipFile();
  let count = 0;

  for await (const file of walk(dir)) {
    zip.addFile(file, relative(dir, file).split(sep).join("/"));
    count += 1;
  }

  if (count === 0) throw new Error(`Directory contains no files: ${dir}`);

  zip.end();

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outPath);
    zip.outputStream.pipe(out);
    out.on("close", resolve);
    out.on("error", reject);
  });
}
