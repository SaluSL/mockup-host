import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.js";

/**
 * Enforces the panel/mockups origin split in the application, not just in Caddy.
 * A mismatched host gets a bare 404 -- it must not reveal that another vhost exists.
 */
export function requireHost(expected: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const host = c.req.header("host")?.split(":")[0].toLowerCase();
    if (host !== expected.toLowerCase()) return c.notFound();
    await next();
  };
}
