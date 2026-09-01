import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../../src/db.js";

export function createTestDb(): { db: Db; dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "mockups-test-"));
  const db = createDb(join(dir, "db.sqlite"));
  runMigrations(db);
  return { db, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
