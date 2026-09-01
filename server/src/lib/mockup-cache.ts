import { eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { mockups } from "../schema/index.js";

/**
 * Keeps the database out of the path of every asset request. Entries are only
 * ever added or dropped wholesale, so there is nothing to go stale except
 * existence -- which push and delete invalidate explicitly.
 */
export function createMockupCache(db: Db) {
  const known = new Map<string, boolean>();

  return {
    exists(id: string): boolean {
      const cached = known.get(id);
      if (cached !== undefined) return cached;

      const row = db.select({ id: mockups.id }).from(mockups).where(eq(mockups.id, id)).get();
      const found = row !== undefined;
      known.set(id, found);
      return found;
    },
    invalidate(id: string): void {
      known.delete(id);
    },
    clear(): void {
      known.clear();
    },
  };
}

export type MockupCache = ReturnType<typeof createMockupCache>;
