import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/schema/mockups.ts",
    "./src/schema/api-tokens.ts",
    "./src/schema/sessions.ts",
  ],
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DATABASE_PATH ?? "./data/db.sqlite" },
});
