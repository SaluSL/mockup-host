import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, safeEquals, verifyPassword } from "../../src/lib/password.js";
import {
  createApiToken,
  generateToken,
  hashToken,
  listApiTokens,
  revokeApiToken,
  verifyApiToken,
} from "../../src/lib/tokens.js";
import {
  SESSION_TTL_MS,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  getValidSession,
} from "../../src/lib/sessions.js";
import { createRateLimiter } from "../../src/lib/rate-limit.js";
import { createTestDb } from "../helpers/db.js";

let ctx: ReturnType<typeof createTestDb>;
beforeEach(() => {
  ctx = createTestDb();
});
afterEach(() => ctx.cleanup());

describe("password", () => {
  it("verifies a correct password", async () => {
    const digest = await hashPassword("correct horse");
    await expect(verifyPassword(digest, "correct horse")).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const digest = await hashPassword("correct horse");
    await expect(verifyPassword(digest, "wrong horse")).resolves.toBe(false);
  });

  it("returns false rather than throwing on a malformed digest", async () => {
    await expect(verifyPassword("not-a-hash", "anything")).resolves.toBe(false);
  });

  it("produces a different digest each time (salted)", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("compares strings without leaking length mismatches as exceptions", () => {
    expect(safeEquals("admin", "admin")).toBe(true);
    expect(safeEquals("admin", "adminx")).toBe(false);
    expect(safeEquals("admin", "")).toBe(false);
  });
});

describe("api tokens", () => {
  it("generates prefixed, high-entropy tokens", () => {
    const token = generateToken();
    expect(token.startsWith("mk_")).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    expect(generateToken()).not.toBe(token);
  });

  it("stores only a hash and verifies the plaintext once", () => {
    const { token, id } = createApiToken(ctx.db, "laptop");

    const stored = listApiTokens(ctx.db);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(id);
    expect(stored[0].tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    expect(verifyApiToken(ctx.db, token)?.id).toBe(id);
  });

  it("records last use", () => {
    const { token } = createApiToken(ctx.db, "laptop");
    verifyApiToken(ctx.db, token);
    expect(listApiTokens(ctx.db)[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects an unknown token", () => {
    createApiToken(ctx.db, "laptop");
    expect(verifyApiToken(ctx.db, "mk_nonsense")).toBeNull();
  });

  it("rejects a revoked token", () => {
    const { token, id } = createApiToken(ctx.db, "laptop");
    revokeApiToken(ctx.db, id);
    expect(verifyApiToken(ctx.db, token)).toBeNull();
  });
});

describe("sessions", () => {
  it("creates a session that validates", () => {
    const id = createSession(ctx.db);
    expect(getValidSession(ctx.db, id)?.id).toBe(id);
  });

  it("rejects an unknown session id", () => {
    expect(getValidSession(ctx.db, "nope")).toBeNull();
  });

  it("rejects an expired session", () => {
    const id = createSession(ctx.db);
    const later = new Date(Date.now() + SESSION_TTL_MS + 1000);
    expect(getValidSession(ctx.db, id, later)).toBeNull();
  });

  it("revokes a session immediately on delete", () => {
    const id = createSession(ctx.db);
    deleteSession(ctx.db, id);
    expect(getValidSession(ctx.db, id)).toBeNull();
  });

  it("prunes expired sessions and keeps live ones", () => {
    const old = createSession(ctx.db, new Date(Date.now() - SESSION_TTL_MS - 1000));
    const fresh = createSession(ctx.db);

    deleteExpiredSessions(ctx.db);

    expect(getValidSession(ctx.db, old)).toBeNull();
    expect(getValidSession(ctx.db, fresh)?.id).toBe(fresh);
  });
});

describe("rate limiter", () => {
  it("allows up to the limit then blocks", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    const now = 1_000_000;

    expect(limiter.check("ip", now)).toBe(true);
    expect(limiter.check("ip", now)).toBe(true);
    expect(limiter.check("ip", now)).toBe(true);
    expect(limiter.check("ip", now)).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    expect(limiter.check("a", 0)).toBe(true);
    expect(limiter.check("a", 0)).toBe(false);
    expect(limiter.check("b", 0)).toBe(true);
  });

  it("allows again once the window rolls over", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.check("ip", 0)).toBe(true);
    expect(limiter.check("ip", 500)).toBe(false);
    expect(limiter.check("ip", 1500)).toBe(true);
  });

  it("clears a key on reset, so a successful login stops counting against you", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    expect(limiter.check("ip", 0)).toBe(true);
    limiter.reset("ip");
    expect(limiter.check("ip", 0)).toBe(true);
  });
});
