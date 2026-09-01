import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

const CONTROL_CHARS = /[\u0000-\u001f]/;

export function createStorage(dataDir: string) {
  const mockupsRoot = resolve(dataDir, "mockups");
  const tmpRoot = resolve(dataDir, "tmp");

  async function ensureRoots(): Promise<void> {
    await mkdir(mockupsRoot, { recursive: true });
    await mkdir(tmpRoot, { recursive: true });
  }

  function mockupDir(id: string): string {
    return join(mockupsRoot, id);
  }

  async function createStagingDir(id: string): Promise<string> {
    await ensureRoots();
    return mkdtemp(join(tmpRoot, `${id}-`));
  }

  async function discardStaging(stagingDir: string): Promise<void> {
    await rm(stagingDir, { recursive: true, force: true });
  }

  /**
   * Swap staged content into place. The live directory is moved aside first and
   * deleted afterwards, so a reader is never inside a partially written tree --
   * both renames are atomic and the only gap is the instant between them.
   */
  async function commit(id: string, contentRoot: string): Promise<void> {
    await ensureRoots();
    const live = mockupDir(id);
    const retired = join(tmpRoot, `retired-${id}-${randomBytes(6).toString("hex")}`);

    let hadPrevious = true;
    try {
      await rename(live, retired);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hadPrevious = false;
    }

    try {
      await rename(contentRoot, live);
    } catch (error) {
      if (hadPrevious) await rename(retired, live).catch(() => undefined);
      throw error;
    }

    if (hadPrevious) await rm(retired, { recursive: true, force: true });
  }

  async function remove(id: string): Promise<void> {
    await rm(mockupDir(id), { recursive: true, force: true });
  }

  async function measure(dir: string): Promise<{ fileCount: number; sizeBytes: number }> {
    let fileCount = 0;
    let sizeBytes = 0;

    async function walk(current: string): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          fileCount += 1;
          sizeBytes += (await stat(full)).size;
        }
      }
    }

    await walk(dir);
    return { fileCount, sizeBytes };
  }

  function resolveFile(id: string, relPath: string): string | null {
    if (isAbsolute(relPath)) return null;
    if (CONTROL_CHARS.test(relPath)) return null;

    const root = mockupDir(id);
    const target = resolve(root, normalize(relPath));
    if (target !== root && !target.startsWith(root + sep)) return null;
    if (relative(root, target).startsWith("..")) return null;
    return target;
  }

  return {
    mockupDir,
    createStagingDir,
    discardStaging,
    commit,
    remove,
    measure,
    resolveFile,
  };
}

export type Storage = ReturnType<typeof createStorage>;
