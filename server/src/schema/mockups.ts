import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const mockups = sqliteTable("mockups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastPushedAt: integer("last_pushed_at", { mode: "timestamp" }),
  sizeBytes: integer("size_bytes").notNull().default(0),
  fileCount: integer("file_count").notNull().default(0),
  basePathWarning: text("base_path_warning"),
});

export type Mockup = typeof mockups.$inferSelect;
export type NewMockup = typeof mockups.$inferInsert;
