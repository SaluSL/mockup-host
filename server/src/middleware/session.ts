import type { MiddlewareHandler } from "hono";
import { getSignedCookie } from "hono/cookie";
import type { AppEnv } from "../app-env.js";
import type { Db } from "../db.js";
import { getValidSession } from "../lib/sessions.js";

export const SESSION_COOKIE = "mockup_session";

export function requireSession(db: Db, secret: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cookie = await getSignedCookie(c, secret, SESSION_COOKIE);
    if (typeof cookie !== "string") return c.redirect("/login", 302);

    const session = getValidSession(db, cookie);
    if (!session) return c.redirect("/login", 302);

    c.set("sessionId", session.id);
    await next();
  };
}
