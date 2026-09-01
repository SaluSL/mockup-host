import { randomUUID } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import type { Db } from "../db.js";
import { sessions, type Session } from "../schema/index.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(db: Db, now: Date = new Date()): string {
  const id = randomUUID();
  db.insert(sessions)
    .values({ id, createdAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .run();
  return id;
}

export function getValidSession(db: Db, id: string, now: Date = new Date()): Session | null {
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

export function deleteSession(db: Db, id: string): void {
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

export function deleteExpiredSessions(db: Db, now: Date = new Date()): void {
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
}
