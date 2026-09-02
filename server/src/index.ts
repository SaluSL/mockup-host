import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb, runMigrations } from "./db.js";
import { getEnv } from "./env.js";
import { deleteExpiredSessions } from "./lib/sessions.js";
import { createMockupCache } from "./lib/mockup-cache.js";
import { createStorage } from "./lib/storage.js";

const env = getEnv();
mkdirSync(env.DATA_DIR, { recursive: true });

const db = createDb(env.DATABASE_PATH);
runMigrations(db);
deleteExpiredSessions(db);

const app = createApp({
  db,
  storage: createStorage(env.DATA_DIR),
  cache: createMockupCache(db),
  env,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`Listening on :${info.port}`);
  console.log(`  panel   ${env.PANEL_HOST}`);
  console.log(`  mockups ${env.MOCKUPS_HOST}`);
});
