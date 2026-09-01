import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db.js";
import { apiTokens, type ApiToken } from "../schema/index.js";

export function generateToken(): string {
  return `mk_${randomBytes(32).toString("base64url")}`;
}

/**
 * SHA-256 rather than argon2 on purpose: a 256-bit random token has no
 * dictionary to attack, so a slow KDF buys nothing and would add latency to
 * every push. Passwords, which are guessable, get argon2.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createApiToken(db: Db, name: string): { id: string; token: string } {
  const id = randomUUID();
  const token = generateToken();
  db.insert(apiTokens).values({ id, name, tokenHash: hashToken(token) }).run();
  return { id, token };
}

export function verifyApiToken(db: Db, token: string): ApiToken | null {
  const row = db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, hashToken(token)), isNull(apiTokens.revokedAt)))
    .get();

  if (!row) return null;

  db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id)).run();
  return row;
}

export function listApiTokens(db: Db): ApiToken[] {
  return db.select().from(apiTokens).all();
}

export function revokeApiToken(db: Db, id: string): void {
  db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, id)).run();
}
