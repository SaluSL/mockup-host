import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mockups } from "../src/schema/index.js";
import { createTestDb } from "./helpers/db.js";

let ctx: ReturnType<typeof createTestDb>;

beforeEach(() => {
  ctx = createTestDb();
});
afterEach(() => ctx.cleanup());

describe("mockups table", () => {
  it("round-trips a row with defaults applied", () => {
    ctx.db.insert(mockups).values({ id: "uuid-1", name: "Acme", slug: "acme" }).run();
    const row = ctx.db.select().from(mockups).where(eq(mockups.id, "uuid-1")).get();

    expect(row?.name).toBe("Acme");
    expect(row?.sizeBytes).toBe(0);
    expect(row?.fileCount).toBe(0);
    expect(row?.lastPushedAt).toBeNull();
    expect(row?.basePathWarning).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it("rejects a duplicate slug", () => {
    ctx.db.insert(mockups).values({ id: "uuid-1", name: "Acme", slug: "acme" }).run();
    expect(() =>
      ctx.db.insert(mockups).values({ id: "uuid-2", name: "Other", slug: "acme" }).run(),
    ).toThrow(/UNIQUE/);
  });
});
