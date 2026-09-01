import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Db } from "../db.js";
import { verifyApiToken } from "../lib/tokens.js";

export function requireToken(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const [scheme, value] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !value) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const token = verifyApiToken(db, value);
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    c.set("tokenId", token.id);
    await next();
  };
}
