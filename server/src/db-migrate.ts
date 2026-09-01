import { createDb, runMigrations } from "./db.js";
import { getEnv } from "./env.js";

const { DATABASE_PATH } = getEnv();
runMigrations(createDb(DATABASE_PATH));
console.log(`Migrations applied to ${DATABASE_PATH}`);
