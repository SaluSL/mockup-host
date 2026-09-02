# Mockup Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host static frontend mockups at unguessable `/m/<uuid>` URLs, published by a CLI that builds with the correct `--base`, managed from a password-protected panel on a separate hostname.

**Architecture:** One Hono application serves everything — panel UI, panel API, the CLI ingest endpoint, and the mockup files themselves — routed by `Host` header so the panel lives on an origin no mockup's JavaScript can reach. Pushes unpack into a staging directory, are validated entry-by-entry, and are swapped into place with `rename()`. SQLite via Drizzle holds mockup metadata, API tokens, and sessions; the files live on disk under `/data/mockups/<uuid>/`.

**Tech Stack:** TypeScript (ESM, strict), Hono + `@hono/node-server`, Hono JSX for the panel, better-sqlite3 + Drizzle ORM, yauzl (extraction) / yazl (CLI archive creation), `@node-rs/argon2`, Vitest, Docker Compose + Caddy.

**Spec:** `docs/superpowers/specs/2026-09-01-mockup-hosting-design.md`

## Global Constraints

- Node 22. Docker base image `node:22-bookworm-slim` — **not** Alpine: `better-sqlite3` and `@node-rs/argon2` ship glibc prebuilds, and musl would force a source build.
- TypeScript `strict: true`, ESM throughout, relative imports carry a `.js` suffix (matches `vibekcal/server`).
- One Drizzle table per file under `server/src/schema/`, re-exported from `schema/index.ts`, with `$inferSelect` / `$inferInsert` type exports.
- Mockup id is `crypto.randomUUID()` and **is** the URL segment. Never expose an enumerable id.
- Ingest limits (defaults, overridable by env): `MAX_UPLOAD_BYTES` 209715200 (200MB), max files 20000, max uncompressed total 1073741824 (1GB), max compression ratio 100.
- Env vars: `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `PANEL_HOST`, `MOCKUPS_HOST`, `DATA_DIR`, `MAX_UPLOAD_BYTES`, `PORT`.
- The panel API is served on `PANEL_HOST`, not `MOCKUPS_HOST`. The mockups origin serves mockup bytes and nothing else.
- Never log a token, a password, or a session id.

---

## File Structure

```
mockups/
  package.json                 npm workspaces: shared, server, cli
  tsconfig.base.json           shared compiler options
  vitest.config.ts             root test runner, picks up */tests/**
  docker-compose.yml
  Caddyfile
  Dockerfile
  .env.example
  .gitignore
  shared/src/index.ts          API types, slugify, mockupBasePath — imported by server AND cli
  server/
    drizzle.config.ts
    src/env.ts                 getEnv()
    src/db.ts                  createDb(), Db type
    src/db-migrate.ts          runs migrations on boot
    src/schema/{mockups,api-tokens,sessions,index}.ts
    src/lib/zip-entry.ts       pure entry-name + mode validation      (security core)
    src/lib/extract.ts         streaming unzip with limits
    src/lib/content-root.ts    wrapper-dir strip + index.html requirement
    src/lib/base-path.ts       absolute-reference detector
    src/lib/serving.ts         cache-control / spa-fallback / mime — pure
    src/lib/storage.ts         directory paths, atomic swap, delete, measure
    src/lib/ingest.ts          orchestrates extract → validate → swap → db
    src/lib/password.ts        argon2id
    src/lib/tokens.ts          API token generate/hash/verify
    src/lib/sessions.ts        session create/get/delete
    src/lib/rate-limit.ts      in-memory fixed window
    src/middleware/{host,session,token}.ts
    src/routes/serve.ts        mockup static serving
    src/routes/api.ts          CLI-facing JSON API
    src/routes/panel.tsx       panel pages and form posts (JSX)
    src/panel/*.tsx            Hono JSX views
    src/index.ts               wiring
    scripts/hash-password.ts
    tests/**
  cli/
    src/index.ts               bin entry
    src/config.ts              .mockuprc.json + ~/.config/mockup/config.json
    src/api-client.ts
    src/build.ts               build command template execution
    src/zip.ts                 directory → zip via yazl
    src/commands/{init,push,ls,rm,open}.ts
    tests/**
```

Split by responsibility: the pure functions that decide security and caching outcomes (`zip-entry`, `serving`, `base-path`) are separated from the I/O that acts on those decisions (`extract`, `storage`, `serve`), so the dangerous logic is testable against a table of hostile inputs without touching a filesystem.

---

## Task 1: Repository scaffold and shared package

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/index.ts`
- Test: `shared/tests/shared.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `@mockups/shared` exporting `slugify(input: string): string`, `mockupBasePath(id: string): string`, `mockupUrl(origin: string, id: string): string`, `SLUG_PATTERN: RegExp`, and the types `MockupSummary`, `ResolveMockupRequest`, `ResolveMockupResponse`, `PushResponse`, `ErrorResponse`.

- [ ] **Step 1: Create the workspace root files**

`package.json`:

```json
{
  "name": "mockups",
  "private": true,
  "type": "module",
  "workspaces": ["shared", "server", "cli"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b shared server cli"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.8",
    "@types/node": "^22.10.1"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*/tests/**/*.test.ts"],
  },
});
```

`.gitignore`:

```
node_modules/
dist/
data/
.env
*.tsbuildinfo
```

- [ ] **Step 2: Create the shared package**

`shared/package.json`:

```json
{
  "name": "@mockups/shared",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

`shared/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write the failing test**

`shared/tests/shared.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SLUG_PATTERN, mockupBasePath, mockupUrl, slugify } from "../src/index.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("My Client Mockup")).toBe("my-client-mockup");
  });

  it("strips punctuation and collapses separators", () => {
    expect(slugify("Acme — v2.1 (final!!)")).toBe("acme-v2-1-final");
  });

  it("trims leading and trailing separators", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("produces slugs matching SLUG_PATTERN", () => {
    expect(SLUG_PATTERN.test(slugify("Foo Bar 42"))).toBe(true);
  });

  it("throws when nothing usable remains", () => {
    expect(() => slugify("!!!")).toThrow(/cannot be slugified/);
  });
});

describe("mockup paths", () => {
  it("builds a trailing-slash base path", () => {
    expect(mockupBasePath("abc-123")).toBe("/m/abc-123/");
  });

  it("builds a share url without a trailing slash", () => {
    expect(mockupUrl("https://mockups.example.com", "abc-123")).toBe(
      "https://mockups.example.com/m/abc-123",
    );
  });

  it("does not double a slash from the origin", () => {
    expect(mockupUrl("https://mockups.example.com/", "abc-123")).toBe(
      "https://mockups.example.com/m/abc-123",
    );
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm install && npx vitest run shared`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 5: Write the implementation**

`shared/src/index.ts`:

```ts
export const MOCKUP_PATH_PREFIX = "/m";
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") throw new Error(`"${input}" cannot be slugified`);
  return slug;
}

export function mockupBasePath(id: string): string {
  return `${MOCKUP_PATH_PREFIX}/${id}/`;
}

export function mockupUrl(origin: string, id: string): string {
  return `${origin.replace(/\/+$/, "")}${MOCKUP_PATH_PREFIX}/${id}`;
}

export interface MockupSummary {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  lastPushedAt: string | null;
  sizeBytes: number;
  fileCount: number;
  basePathWarning: string | null;
}

export interface ResolveMockupRequest {
  slug: string;
  name?: string;
}

export interface ResolveMockupResponse {
  mockup: MockupSummary;
  basePath: string;
  url: string;
}

export interface PushResponse {
  mockup: MockupSummary;
  url: string;
  warning: string | null;
}

export interface ErrorResponse {
  error: string;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run shared`
Expected: PASS, 8 tests.

- [ ] **Step 7: De-risk `.js`-suffix resolution under Vitest**

The server imports siblings as `./foo.js` while the file on disk is `foo.ts`. Vite resolves this for TypeScript sources, but confirm it here rather than discovering a problem in Task 7. Add `shared/src/probe.ts` containing `export const probe = "ok";`, import it from `shared/src/index.ts` as `import { probe } from "./probe.js";`, re-export it, and assert `probe === "ok"` in the test.

Run: `npx vitest run shared`
Expected: PASS. If it fails to resolve, add `resolve: { extensions: [".ts", ".js"] }` to `vitest.config.ts` and re-run before continuing. Delete the probe file and its assertions once the run is green.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.base.json vitest.config.ts .gitignore shared
git commit -m "feat: workspace scaffold and shared API contract"
```

---

## Task 2: Database schema, migrations, and test helper

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/drizzle.config.ts`
- Create: `server/src/env.ts`, `server/src/db.ts`, `server/src/db-migrate.ts`
- Create: `server/src/schema/{mockups,api-tokens,sessions,index}.ts`
- Create: `server/tests/helpers/db.ts`
- Test: `server/tests/schema.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime.
- Produces:
  - `getEnv(): Env` where `Env = { DATABASE_PATH, DATA_DIR, PORT, PANEL_HOST, MOCKUPS_HOST, SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH, MAX_UPLOAD_BYTES, NODE_ENV }`.
  - `createDb(path: string): Db`, `type Db`.
  - `runMigrations(db: Db): void`.
  - Tables `mockups`, `apiTokens`, `sessions` with types `Mockup`, `NewMockup`, `ApiToken`, `NewApiToken`, `Session`, `NewSession`.
  - `createTestDb(): { db: Db; dir: string; cleanup(): void }` from `server/tests/helpers/db.ts` — used by every later integration test.

- [ ] **Step 1: Create the server package**

`server/package.json`:

```json
{
  "name": "@mockups/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx --env-file=../.env --watch src/index.ts",
    "build": "tsc -b",
    "start": "node dist/index.js",
    "db:generate": "drizzle-kit generate",
    "hash-password": "tsx scripts/hash-password.ts"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.7",
    "@mockups/shared": "*",
    "@node-rs/argon2": "^2.0.2",
    "better-sqlite3": "^11.6.0",
    "drizzle-orm": "^0.36.4",
    "hono": "^4.6.12",
    "yauzl": "^3.2.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/yauzl": "^2.10.3",
    "drizzle-kit": "^0.28.1",
    "tsx": "^4.19.2"
  }
}
```

`server/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  },
  "include": ["src/**/*"],
  "references": [{ "path": "../shared" }]
}
```

`server/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/*.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DATABASE_PATH ?? "./data/db.sqlite" },
});
```

- [ ] **Step 2: Write the schema files**

`server/src/schema/mockups.ts`:

```ts
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
```

`server/src/schema/api-tokens.ts`:

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
```

`server/src/schema/sessions.ts`:

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
```

`server/src/schema/index.ts`:

```ts
export * from "./mockups.js";
export * from "./api-tokens.js";
export * from "./sessions.js";
```

- [ ] **Step 3: Write env, db, and the migration runner**

`server/src/env.ts`:

```ts
export interface Env {
  DATA_DIR: string;
  DATABASE_PATH: string;
  PORT: number;
  PANEL_HOST: string;
  MOCKUPS_HOST: string;
  SESSION_SECRET: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD_HASH: string;
  MAX_UPLOAD_BYTES: number;
  NODE_ENV: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function getEnv(): Env {
  const DATA_DIR = process.env.DATA_DIR ?? "./data";
  return {
    DATA_DIR,
    DATABASE_PATH: process.env.DATABASE_PATH ?? `${DATA_DIR}/db.sqlite`,
    PORT: parseInt(process.env.PORT ?? "3000", 10),
    PANEL_HOST: required("PANEL_HOST"),
    MOCKUPS_HOST: required("MOCKUPS_HOST"),
    SESSION_SECRET: required("SESSION_SECRET"),
    ADMIN_USERNAME: required("ADMIN_USERNAME"),
    ADMIN_PASSWORD_HASH: required("ADMIN_PASSWORD_HASH"),
    MAX_UPLOAD_BYTES: parseInt(process.env.MAX_UPLOAD_BYTES ?? "209715200", 10),
    NODE_ENV: process.env.NODE_ENV ?? "development",
  };
}
```

`server/src/db.ts`:

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema/index.js";

const here = dirname(fileURLToPath(import.meta.url));

export function createDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: join(here, "..", "drizzle") });
}
```

`server/src/db-migrate.ts`:

```ts
import { createDb, runMigrations } from "./db.js";
import { getEnv } from "./env.js";

const { DATABASE_PATH } = getEnv();
runMigrations(createDb(DATABASE_PATH));
console.log(`Migrations applied to ${DATABASE_PATH}`);
```

- [ ] **Step 4: Generate the migration**

Run: `cd server && npx drizzle-kit generate && ls drizzle`
Expected: a `drizzle/0000_*.sql` file plus a `meta/` directory, all committed.

- [ ] **Step 5: Write the test helper and the failing test**

`server/tests/helpers/db.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../../src/db.js";

export function createTestDb(): { db: Db; dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "mockups-test-"));
  const db = createDb(join(dir, "db.sqlite"));
  runMigrations(db);
  return { db, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
```

`server/tests/schema.test.ts`:

```ts
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
```

- [ ] **Step 6: Run the test to verify it fails, then passes**

Run: `npx vitest run server/tests/schema.test.ts`
Expected first: FAIL (migrations not yet generated, or module missing). After Step 4's migration exists: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "feat: sqlite schema, migrations, and test database helper"
```

---

## Task 3: Zip entry validation (pure)

This is the highest-risk logic in the system: it decides whether an attacker-supplied
name is allowed to become a path on disk. It is pure, so it is tested against a table
of hostile inputs with no filesystem involved.

**Files:**
- Create: `server/src/lib/zip-entry.ts`
- Test: `server/tests/lib/zip-entry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type EntryValidation = { ok: true; path: string; kind: "file" | "directory" } | { ok: false; reason: string }`
  - `validateEntryName(rawName: string): EntryValidation` — `path` is normalized, POSIX-separated, relative, with no trailing slash.
  - `isRegularFileMode(externalFileAttributes: number): boolean`

- [ ] **Step 1: Write the failing test**

`server/tests/lib/zip-entry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isRegularFileMode, validateEntryName } from "../../src/lib/zip-entry.js";

describe("validateEntryName", () => {
  it("accepts a plain nested file", () => {
    expect(validateEntryName("assets/index-abc123.js")).toEqual({
      ok: true,
      path: "assets/index-abc123.js",
      kind: "file",
    });
  });

  it("accepts a directory entry and strips the trailing slash", () => {
    expect(validateEntryName("assets/")).toEqual({
      ok: true,
      path: "assets",
      kind: "directory",
    });
  });

  it("normalizes redundant segments", () => {
    expect(validateEntryName("./assets/./app.css")).toEqual({
      ok: true,
      path: "assets/app.css",
      kind: "file",
    });
  });

  const hostile: Array<[string, string, RegExp]> = [
    ["parent traversal", "../evil.js", /traversal/],
    ["nested traversal", "a/../../evil.js", /traversal/],
    ["traversal that stays negative", "a/b/../../../evil.js", /traversal/],
    ["absolute posix path", "/etc/passwd", /absolute/],
    ["windows drive path", "C:\\Windows\\evil.dll", /backslash/],
    ["backslash separator", "assets\\app.js", /backslash/],
    ["null byte", "assets/app\u0000.js", /control character/],
    ["newline", "assets/ap\np.js", /control character/],
    ["empty name", "", /empty/],
    ["dot only", ".", /empty/],
  ];

  it.each(hostile)("rejects %s", (_label, name, reason) => {
    const result = validateEntryName(name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it("does not treat a filename merely containing dots as traversal", () => {
    expect(validateEntryName("assets/..hidden..js")).toEqual({
      ok: true,
      path: "assets/..hidden..js",
      kind: "file",
    });
  });
});

describe("isRegularFileMode", () => {
  const attrs = (unixMode: number) => unixMode << 16;

  it("accepts a regular file (0100644)", () => {
    expect(isRegularFileMode(attrs(0o100644))).toBe(true);
  });

  it("accepts mode 0, which many zip writers emit", () => {
    expect(isRegularFileMode(0)).toBe(true);
  });

  it("rejects a symlink (0120777)", () => {
    expect(isRegularFileMode(attrs(0o120777))).toBe(false);
  });

  it("rejects a character device (0020666)", () => {
    expect(isRegularFileMode(attrs(0o020666))).toBe(false);
  });

  it("rejects a fifo (0010644)", () => {
    expect(isRegularFileMode(attrs(0o010644))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/tests/lib/zip-entry.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/zip-entry.js`.

- [ ] **Step 3: Write the implementation**

`server/src/lib/zip-entry.ts`:

```ts
export type EntryValidation =
  | { ok: true; path: string; kind: "file" | "directory" }
  | { ok: false; reason: string };

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

export function validateEntryName(rawName: string): EntryValidation {
  if (rawName === "") return { ok: false, reason: "entry name is empty" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rawName)) {
    return { ok: false, reason: "entry name contains a control character" };
  }
  if (rawName.includes("\\")) {
    return { ok: false, reason: "entry name contains a backslash" };
  }
  if (rawName.startsWith("/")) {
    return { ok: false, reason: "entry name is an absolute path" };
  }

  const kind: "file" | "directory" = rawName.endsWith("/") ? "directory" : "file";

  const parts: string[] = [];
  for (const segment of rawName.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false, reason: "entry name contains a traversal segment" };
    parts.push(segment);
  }

  if (parts.length === 0) return { ok: false, reason: "entry name is empty after normalization" };
  return { ok: true, path: parts.join("/"), kind };
}

export function isRegularFileMode(externalFileAttributes: number): boolean {
  const mode = (externalFileAttributes >>> 16) & 0xffff;
  if (mode === 0) return true;
  return (mode & S_IFMT) === S_IFREG;
}
```

Note the `..` rejection is per-segment and outright — not "resolve and check the result
stays inside". Resolving first is how traversal bugs get written: `a/../../evil` can be
made to resolve back inside the target by a symlinked intermediate directory, and any
name that legitimately needs `..` in a build output does not exist.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/tests/lib/zip-entry.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/zip-entry.ts server/tests/lib/zip-entry.test.ts
git commit -m "feat: zip entry name and mode validation"
```

---

## Task 4: Streaming extraction with limits

**Files:**
- Create: `server/src/lib/errors.ts`, `server/src/lib/extract.ts`
- Create: `server/tests/helpers/zip.ts`
- Test: `server/tests/lib/extract.test.ts`
- Modify: `server/package.json` (add `yazl` and `@types/yazl` to `devDependencies` for fixture building)

**Interfaces:**
- Consumes: `validateEntryName`, `isRegularFileMode` from Task 3.
- Produces:
  - `class IngestError extends Error { constructor(message: string, code: IngestErrorCode) ; readonly code: IngestErrorCode }` and `type IngestErrorCode = "invalid_entry" | "too_many_files" | "too_large" | "ratio_exceeded" | "no_index_html" | "empty_archive"` in `errors.ts`.
  - `interface ExtractLimits { maxFiles: number; maxTotalBytes: number; maxRatio: number }`
  - `DEFAULT_EXTRACT_LIMITS: ExtractLimits` — `{ maxFiles: 20000, maxTotalBytes: 1073741824, maxRatio: 100 }`
  - `extractZip(zipPath: string, destDir: string, limits: ExtractLimits): Promise<{ fileCount: number; totalBytes: number }>`
  - Test helper `writeZip(dir: string, entries: ZipFixtureEntry[]): Promise<string>` where `ZipFixtureEntry = { name: string; content?: string | Buffer; mode?: number }`.

- [ ] **Step 1: Write the fixture helper**

`server/tests/helpers/zip.ts`:

```ts
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { ZipFile } from "yazl";

export interface ZipFixtureEntry {
  name: string;
  content?: string | Buffer;
  mode?: number;
}

export function writeZip(dir: string, entries: ZipFixtureEntry[], fileName = "fixture.zip"): Promise<string> {
  const zip = new ZipFile();
  for (const entry of entries) {
    if (entry.name.endsWith("/")) {
      zip.addEmptyDirectory(entry.name);
      continue;
    }
    const buffer = Buffer.from(entry.content ?? "");
    zip.addBuffer(buffer, entry.name, entry.mode ? { mode: entry.mode } : undefined);
  }
  zip.end();

  const target = join(dir, fileName);
  return new Promise((resolve, reject) => {
    const out = createWriteStream(target);
    zip.outputStream.pipe(out);
    out.on("close", () => resolve(target));
    out.on("error", reject);
  });
}
```

- [ ] **Step 2: Write the failing test**

`server/tests/lib/extract.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_LIMITS, extractZip } from "../../src/lib/extract.js";
import { IngestError } from "../../src/lib/errors.js";
import { writeZip } from "../helpers/zip.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "extract-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const dest = () => join(dir, "out");

describe("extractZip", () => {
  it("writes files and reports counts", async () => {
    const zip = await writeZip(dir, [
      { name: "index.html", content: "<html></html>" },
      { name: "assets/app.js", content: "console.log(1)" },
    ]);

    const result = await extractZip(zip, dest(), DEFAULT_EXTRACT_LIMITS);

    expect(result.fileCount).toBe(2);
    expect(result.totalBytes).toBe("<html></html>".length + "console.log(1)".length);
    expect(readFileSync(join(dest(), "assets/app.js"), "utf8")).toBe("console.log(1)");
  });

  it("refuses a traversal entry and writes nothing outside the destination", async () => {
    const zip = await writeZip(dir, [{ name: "../escaped.js", content: "pwned" }]);

    await expect(extractZip(zip, dest(), DEFAULT_EXTRACT_LIMITS)).rejects.toThrow(IngestError);
    expect(existsSync(join(dir, "escaped.js"))).toBe(false);
  });

  it("refuses a symlink entry", async () => {
    const zip = await writeZip(dir, [
      { name: "index.html", content: "<html></html>" },
      { name: "link", content: "/etc/passwd", mode: 0o120777 },
    ]);

    await expect(extractZip(zip, dest(), DEFAULT_EXTRACT_LIMITS)).rejects.toMatchObject({
      code: "invalid_entry",
    });
  });

  it("refuses an archive with too many files", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, content: "x" }));
    const zip = await writeZip(dir, entries);

    await expect(
      extractZip(zip, dest(), { ...DEFAULT_EXTRACT_LIMITS, maxFiles: 3 }),
    ).rejects.toMatchObject({ code: "too_many_files" });
  });

  it("refuses an archive exceeding the uncompressed cap, mid-stream", async () => {
    const zip = await writeZip(dir, [{ name: "big.bin", content: "a".repeat(10_000) }]);

    await expect(
      extractZip(zip, dest(), { ...DEFAULT_EXTRACT_LIMITS, maxTotalBytes: 1000 }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("refuses a high compression ratio", async () => {
    const zip = await writeZip(dir, [{ name: "bomb.bin", content: "\u0000".repeat(2_000_000) }]);

    await expect(
      extractZip(zip, dest(), { ...DEFAULT_EXTRACT_LIMITS, maxRatio: 5 }),
    ).rejects.toMatchObject({ code: "ratio_exceeded" });
  });

  it("refuses an archive with no files at all", async () => {
    const zip = await writeZip(dir, [{ name: "empty/" }]);

    await expect(extractZip(zip, dest(), DEFAULT_EXTRACT_LIMITS)).rejects.toMatchObject({
      code: "empty_archive",
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm install -w @mockups/server -D yazl @types/yazl && npx vitest run server/tests/lib/extract.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/extract.js`.

- [ ] **Step 4: Write the implementation**

`server/src/lib/errors.ts`:

```ts
export type IngestErrorCode =
  | "invalid_entry"
  | "too_many_files"
  | "too_large"
  | "ratio_exceeded"
  | "no_index_html"
  | "empty_archive";

export class IngestError extends Error {
  constructor(
    message: string,
    readonly code: IngestErrorCode,
  ) {
    super(message);
    this.name = "IngestError";
  }
}
```

`server/src/lib/extract.ts`:

```ts
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { IngestError } from "./errors.js";
import { isRegularFileMode, validateEntryName } from "./zip-entry.js";

export interface ExtractLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxRatio: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxFiles: 20000,
  maxTotalBytes: 1_073_741_824,
  maxRatio: 100,
};

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error("could not open archive"));
      else resolve(zip);
    });
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error("could not read entry"));
      else resolve(stream);
    });
  });
}

/** Counts bytes as they pass and aborts the moment a cap is crossed. */
function guard(check: (bytesSoFar: number) => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      try {
        check(seen);
      } catch (error) {
        cb(error as Error);
        return;
      }
      cb(null, chunk);
    },
  });
}

export async function extractZip(
  zipPath: string,
  destDir: string,
  limits: ExtractLimits,
): Promise<{ fileCount: number; totalBytes: number }> {
  const compressedBytes = (await stat(zipPath)).size;
  const ratioCap = compressedBytes * limits.maxRatio;
  const zip = await openZip(zipPath);

  let fileCount = 0;
  let totalBytes = 0;

  await mkdir(destDir, { recursive: true });

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          try {
            const validation = validateEntryName(entry.fileName);
            if (!validation.ok) {
              throw new IngestError(
                `Rejected archive entry "${entry.fileName}": ${validation.reason}`,
                "invalid_entry",
              );
            }

            if (validation.kind === "directory") {
              await mkdir(join(destDir, validation.path), { recursive: true });
              zip.readEntry();
              return;
            }

            if (!isRegularFileMode(entry.externalFileAttributes)) {
              throw new IngestError(
                `Rejected archive entry "${entry.fileName}": not a regular file`,
                "invalid_entry",
              );
            }

            fileCount += 1;
            if (fileCount > limits.maxFiles) {
              throw new IngestError(
                `Archive contains more than ${limits.maxFiles} files`,
                "too_many_files",
              );
            }

            const target = join(destDir, validation.path);
            await mkdir(dirname(target), { recursive: true });

            const startedAt = totalBytes;
            const source = await openEntryStream(zip, entry);
            await pipeline(
              source,
              guard((bytesSoFar) => {
                const running = startedAt + bytesSoFar;
                if (running > limits.maxTotalBytes) {
                  throw new IngestError(
                    `Archive expands beyond ${limits.maxTotalBytes} bytes`,
                    "too_large",
                  );
                }
                if (running > ratioCap) {
                  throw new IngestError(
                    `Archive compression ratio exceeds ${limits.maxRatio}:1`,
                    "ratio_exceeded",
                  );
                }
              }),
              createWriteStream(target),
            );
            totalBytes = startedAt + (await stat(target)).size;

            zip.readEntry();
          } catch (error) {
            zip.close();
            reject(error);
          }
        })();
      });

      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  if (fileCount === 0) {
    throw new IngestError("Archive contains no files", "empty_archive");
  }

  return { fileCount, totalBytes };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/tests/lib/extract.test.ts`
Expected: PASS, 7 tests.

If the ratio test is flaky because two-megabyte zeroes compress differently than assumed,
raise the fixture size rather than relaxing `maxRatio` — the cap is a security control and
the test exists to prove it fires.

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/errors.ts server/src/lib/extract.ts server/tests
git commit -m "feat: streaming zip extraction with bomb and traversal guards"
```

---

## Task 5: Content root resolution and base-path detection

**Files:**
- Create: `server/src/lib/content-root.ts`, `server/src/lib/base-path.ts`
- Test: `server/tests/lib/content-root.test.ts`, `server/tests/lib/base-path.test.ts`

**Interfaces:**
- Consumes: `IngestError` from Task 4.
- Produces:
  - `resolveContentRoot(extractedDir: string): Promise<string>` — returns `extractedDir`, or its single child directory when that is where `index.html` lives; throws `IngestError("...", "no_index_html")` otherwise.
  - `findAbsoluteRefs(content: string, expectedBase: string): string[]` — pure.
  - `detectBasePathWarning(rootDir: string, expectedBase: string): Promise<string | null>`

- [ ] **Step 1: Write the failing tests**

`server/tests/lib/content-root.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveContentRoot } from "../../src/lib/content-root.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "content-root-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveContentRoot", () => {
  it("returns the directory itself when index.html is at the top", async () => {
    writeFileSync(join(dir, "index.html"), "<html></html>");
    await expect(resolveContentRoot(dir)).resolves.toBe(dir);
  });

  it("descends into a single wrapper directory", async () => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.html"), "<html></html>");
    await expect(resolveContentRoot(dir)).resolves.toBe(join(dir, "dist"));
  });

  it("does not descend when there are two top-level entries", async () => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "index.html"), "<html></html>");
    writeFileSync(join(dir, "README.md"), "hi");
    await expect(resolveContentRoot(dir)).rejects.toMatchObject({ code: "no_index_html" });
  });

  it("rejects when no index.html exists anywhere it looks", async () => {
    writeFileSync(join(dir, "app.js"), "1");
    await expect(resolveContentRoot(dir)).rejects.toMatchObject({ code: "no_index_html" });
  });

  it("does not descend two levels", async () => {
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "index.html"), "<html></html>");
    await expect(resolveContentRoot(dir)).rejects.toMatchObject({ code: "no_index_html" });
  });
});
```

`server/tests/lib/base-path.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectBasePathWarning, findAbsoluteRefs } from "../../src/lib/base-path.js";

describe("findAbsoluteRefs", () => {
  const base = "/m/abc-123/";

  it("finds a root-absolute script src", () => {
    const html = '<script type="module" src="/assets/index-abc.js"></script>';
    expect(findAbsoluteRefs(html, base)).toEqual(["/assets/index-abc.js"]);
  });

  it("finds a root-absolute stylesheet href", () => {
    const html = '<link rel="stylesheet" href="/assets/app.css">';
    expect(findAbsoluteRefs(html, base)).toEqual(["/assets/app.css"]);
  });

  it("ignores references already carrying the expected base", () => {
    const html = '<script src="/m/abc-123/assets/index-abc.js"></script>';
    expect(findAbsoluteRefs(html, base)).toEqual([]);
  });

  it("ignores protocol-relative and absolute URLs", () => {
    const html = '<script src="//cdn.example.com/x.js"></script><img src="https://e.com/a.png">';
    expect(findAbsoluteRefs(html, base)).toEqual([]);
  });

  it("ignores relative references", () => {
    expect(findAbsoluteRefs('<script src="./assets/app.js"></script>', base)).toEqual([]);
  });

  it("finds absolute urls inside css", () => {
    expect(findAbsoluteRefs("body{background:url(/assets/bg.png)}", base)).toEqual([
      "/assets/bg.png",
    ]);
  });

  it("deduplicates repeated references", () => {
    const js = 'import("/assets/chunk.js");import("/assets/chunk.js")';
    expect(findAbsoluteRefs(js, base)).toEqual(["/assets/chunk.js"]);
  });
});

describe("detectBasePathWarning", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "base-path-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null for a correctly based build", async () => {
    writeFileSync(join(dir, "index.html"), '<script src="/m/abc-123/assets/a.js"></script>');
    await expect(detectBasePathWarning(dir, "/m/abc-123/")).resolves.toBeNull();
  });

  it("names the remedy when it finds root-absolute references", async () => {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), '<script src="/assets/a.js"></script>');

    const warning = await detectBasePathWarning(dir, "/m/abc-123/");

    expect(warning).toMatch(/\/assets\/a\.js/);
    expect(warning).toMatch(/--base=\/m\/abc-123\//);
  });

  it("scans nested js and css, not only the entry html", async () => {
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), '<script src="./assets/a.js"></script>');
    writeFileSync(join(dir, "assets", "a.css"), "body{background:url(/img/x.png)}");

    await expect(detectBasePathWarning(dir, "/m/abc-123/")).resolves.toMatch(/\/img\/x\.png/);
  });

  it("ignores file types it cannot reason about", async () => {
    writeFileSync(join(dir, "index.html"), "<html></html>");
    writeFileSync(join(dir, "notes.txt"), "see /assets/a.js");
    await expect(detectBasePathWarning(dir, "/m/abc-123/")).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/tests/lib/content-root.test.ts server/tests/lib/base-path.test.ts`
Expected: FAIL — both modules unresolvable.

- [ ] **Step 3: Write the implementations**

`server/src/lib/content-root.ts`:

```ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { IngestError } from "./errors.js";

async function hasIndex(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, "index.html"))).isFile();
  } catch {
    return false;
  }
}

export async function resolveContentRoot(extractedDir: string): Promise<string> {
  if (await hasIndex(extractedDir)) return extractedDir;

  const entries = await readdir(extractedDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const wrapped = join(extractedDir, entries[0].name);
    if (await hasIndex(wrapped)) return wrapped;
  }

  throw new IngestError(
    "Archive has no index.html at its root (or in a single wrapping directory)",
    "no_index_html",
  );
}
```

`server/src/lib/base-path.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const SCANNED_EXTENSIONS = new Set([".html", ".htm", ".js", ".mjs", ".css"]);

// Matches a root-absolute reference inside src="", href="", url(), or an import specifier.
const REFERENCE = /(?:src|href)\s*=\s*["'](\/[^"'\s>]*)["']|url\(\s*["']?(\/[^"')\s]*)["']?\s*\)|import\(\s*["'](\/[^"']*)["']\s*\)/g;

export function findAbsoluteRefs(content: string, expectedBase: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(REFERENCE)) {
    const ref = match[1] ?? match[2] ?? match[3];
    if (!ref) continue;
    if (ref.startsWith("//")) continue;
    if (ref.startsWith(expectedBase)) continue;
    found.add(ref);
  }
  return [...found];
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export async function detectBasePathWarning(
  rootDir: string,
  expectedBase: string,
): Promise<string | null> {
  const offenders = new Set<string>();

  for await (const file of walk(rootDir)) {
    if (!SCANNED_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const content = await readFile(file, "utf8");
    for (const ref of findAbsoluteRefs(content, expectedBase)) {
      offenders.add(ref);
      if (offenders.size >= 5) break;
    }
    if (offenders.size >= 5) break;
  }

  if (offenders.size === 0) return null;

  const sample = [...offenders].slice(0, 3).join(", ");
  return `This build references ${sample} from the site root and will 404 when served at ${expectedBase}. Rebuild with --base=${expectedBase}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/tests/lib/content-root.test.ts server/tests/lib/base-path.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/content-root.ts server/src/lib/base-path.ts server/tests/lib
git commit -m "feat: content root resolution and base path detection"
```

---

## Task 6: Serving decisions (pure)

These three functions decide the two failure modes called out in the spec: HTML returned
for a missing asset, and a client seeing a stale build after a push.

**Files:**
- Create: `server/src/lib/serving.ts`
- Test: `server/tests/lib/serving.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `contentTypeFor(relPath: string): string`
  - `cacheControlFor(relPath: string): string`
  - `shouldFallbackToIndex(relPath: string, acceptHeader: string | null): boolean`

- [ ] **Step 1: Write the failing test**

`server/tests/lib/serving.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cacheControlFor, contentTypeFor, shouldFallbackToIndex } from "../../src/lib/serving.js";

describe("contentTypeFor", () => {
  it.each([
    ["index.html", "text/html; charset=utf-8"],
    ["assets/app.js", "text/javascript; charset=utf-8"],
    ["assets/app.mjs", "text/javascript; charset=utf-8"],
    ["assets/app.css", "text/css; charset=utf-8"],
    ["assets/logo.svg", "image/svg+xml"],
    ["assets/photo.webp", "image/webp"],
    ["assets/font.woff2", "font/woff2"],
    ["data.json", "application/json; charset=utf-8"],
  ])("maps %s", (path, expected) => {
    expect(contentTypeFor(path)).toBe(expected);
  });

  it("falls back to an octet stream for unknown types", () => {
    expect(contentTypeFor("weird.xyz")).toBe("application/octet-stream");
  });
});

describe("cacheControlFor", () => {
  it("never caches html", () => {
    expect(cacheControlFor("index.html")).toBe("no-cache");
    expect(cacheControlFor("nested/page.html")).toBe("no-cache");
  });

  it("caches content-hashed assets immutably", () => {
    expect(cacheControlFor("assets/index-DkT3Bq7x.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("assets/style-a1b2c3d4.css")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("uses a short cache for unhashed non-html files", () => {
    expect(cacheControlFor("favicon.ico")).toBe("public, max-age=3600");
    expect(cacheControlFor("images/logo.png")).toBe("public, max-age=3600");
  });
});

describe("shouldFallbackToIndex", () => {
  const html = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

  it("falls back for an extensionless navigation", () => {
    expect(shouldFallbackToIndex("settings", html)).toBe(true);
    expect(shouldFallbackToIndex("settings/profile", html)).toBe(true);
  });

  it("falls back for an explicit html path", () => {
    expect(shouldFallbackToIndex("about.html", html)).toBe(true);
  });

  it("does NOT fall back for a missing script", () => {
    expect(shouldFallbackToIndex("assets/app.js", html)).toBe(false);
  });

  it("does NOT fall back when html is not accepted", () => {
    expect(shouldFallbackToIndex("settings", "*/*")).toBe(false);
    expect(shouldFallbackToIndex("settings", null)).toBe(false);
  });

  it("does NOT fall back for an image or stylesheet", () => {
    expect(shouldFallbackToIndex("logo.png", html)).toBe(false);
    expect(shouldFallbackToIndex("app.css", html)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/tests/lib/serving.test.ts`
Expected: FAIL — module unresolvable.

- [ ] **Step 3: Write the implementation**

`server/src/lib/serving.ts`:

```ts
import { basename, extname } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};

const HASHED = /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

export function contentTypeFor(relPath: string): string {
  return MIME[extname(relPath).toLowerCase()] ?? "application/octet-stream";
}

export function cacheControlFor(relPath: string): string {
  const ext = extname(relPath).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "no-cache";
  if (HASHED.test(basename(relPath))) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

export function shouldFallbackToIndex(relPath: string, acceptHeader: string | null): boolean {
  if (!acceptHeader?.includes("text/html")) return false;
  const ext = extname(relPath).toLowerCase();
  return ext === "" || ext === ".html" || ext === ".htm";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/tests/lib/serving.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/serving.ts server/tests/lib/serving.test.ts
git commit -m "feat: content type, cache control, and spa fallback decisions"
```

---

## Task 7: Storage layer

**Files:**
- Create: `server/src/lib/storage.ts`
- Test: `server/tests/lib/storage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces `createStorage(dataDir: string): Storage` with:
  - `mockupDir(id: string): string`
  - `createStagingDir(id: string): Promise<string>`
  - `commit(id: string, contentRoot: string): Promise<void>` — atomic swap
  - `discardStaging(stagingDir: string): Promise<void>`
  - `remove(id: string): Promise<void>`
  - `measure(dir: string): Promise<{ fileCount: number; sizeBytes: number }>`
  - `resolveFile(id: string, relPath: string): string | null` — `null` when the path escapes the mockup directory
  - `type Storage = ReturnType<typeof createStorage>`

- [ ] **Step 1: Write the failing test**

`server/tests/lib/storage.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorage } from "../../src/lib/storage.js";

let dataDir: string;
let storage: ReturnType<typeof createStorage>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "storage-test-"));
  storage = createStorage(dataDir);
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

async function stage(id: string, files: Record<string, string>): Promise<string> {
  const dir = await storage.createStagingDir(id);
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

describe("commit", () => {
  it("moves staged content into the live directory", async () => {
    const staged = await stage("id-1", { "index.html": "v1" });
    await storage.commit("id-1", staged);

    expect(readFileSync(join(storage.mockupDir("id-1"), "index.html"), "utf8")).toBe("v1");
  });

  it("replaces previous content entirely, leaving no stale files", async () => {
    await storage.commit("id-1", await stage("id-1", { "index.html": "v1", "old.js": "gone" }));
    await storage.commit("id-1", await stage("id-1", { "index.html": "v2" }));

    const live = storage.mockupDir("id-1");
    expect(readFileSync(join(live, "index.html"), "utf8")).toBe("v2");
    expect(existsSync(join(live, "old.js"))).toBe(false);
  });

  it("leaves no staging or backup directories behind", async () => {
    await storage.commit("id-1", await stage("id-1", { "index.html": "v1" }));
    const second = await stage("id-1", { "index.html": "v2" });
    await storage.commit("id-1", second);
    await storage.discardStaging(second);

    expect(readdirSync(join(dataDir, "tmp"))).toEqual([]);
  });
});

describe("remove", () => {
  it("deletes the live directory", async () => {
    await storage.commit("id-1", await stage("id-1", { "index.html": "v1" }));
    await storage.remove("id-1");
    expect(existsSync(storage.mockupDir("id-1"))).toBe(false);
  });

  it("is a no-op for a mockup that was never pushed", async () => {
    await expect(storage.remove("never")).resolves.toBeUndefined();
  });
});

describe("measure", () => {
  it("counts files and bytes recursively", async () => {
    const staged = await stage("id-1", { "index.html": "abc", "assets/a.js": "de" });
    await expect(storage.measure(staged)).resolves.toEqual({ fileCount: 2, sizeBytes: 5 });
  });
});

describe("resolveFile", () => {
  it("resolves a nested path inside the mockup", () => {
    expect(storage.resolveFile("id-1", "assets/a.js")).toBe(
      join(storage.mockupDir("id-1"), "assets/a.js"),
    );
  });

  it("refuses a traversal that escapes the mockup directory", () => {
    expect(storage.resolveFile("id-1", "../id-2/secret.js")).toBeNull();
    expect(storage.resolveFile("id-1", "../../db.sqlite")).toBeNull();
  });

  it("refuses an absolute path", () => {
    expect(storage.resolveFile("id-1", "/etc/passwd")).toBeNull();
  });

  it("refuses a path containing a null byte", () => {
    expect(storage.resolveFile("id-1", "assets/a\u0000.js")).toBeNull();
  });

  it("resolves the empty path to the directory itself", () => {
    expect(storage.resolveFile("id-1", "")).toBe(storage.mockupDir("id-1"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/tests/lib/storage.test.ts`
Expected: FAIL — module unresolvable.

- [ ] **Step 3: Write the implementation**

`server/src/lib/storage.ts`:

```ts
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export function createStorage(dataDir: string) {
  const mockupsRoot = resolve(dataDir, "mockups");
  const tmpRoot = resolve(dataDir, "tmp");

  async function ensureRoots(): Promise<void> {
    await mkdir(mockupsRoot, { recursive: true });
    await mkdir(tmpRoot, { recursive: true });
  }

  function mockupDir(id: string): string {
    return join(mockupsRoot, id);
  }

  async function createStagingDir(id: string): Promise<string> {
    await ensureRoots();
    return mkdtemp(join(tmpRoot, `${id}-`));
  }

  async function discardStaging(stagingDir: string): Promise<void> {
    await rm(stagingDir, { recursive: true, force: true });
  }

  /**
   * Swap staged content into place. The live directory is moved aside first and
   * deleted afterwards, so a reader is never inside a partially written tree —
   * both renames are atomic and the only gap is the instant between them.
   */
  async function commit(id: string, contentRoot: string): Promise<void> {
    await ensureRoots();
    const live = mockupDir(id);
    const retired = join(tmpRoot, `retired-${id}-${randomBytes(6).toString("hex")}`);

    let hadPrevious = true;
    try {
      await rename(live, retired);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hadPrevious = false;
    }

    try {
      await rename(contentRoot, live);
    } catch (error) {
      if (hadPrevious) await rename(retired, live).catch(() => undefined);
      throw error;
    }

    if (hadPrevious) await rm(retired, { recursive: true, force: true });
  }

  async function remove(id: string): Promise<void> {
    await rm(mockupDir(id), { recursive: true, force: true });
  }

  async function measure(dir: string): Promise<{ fileCount: number; sizeBytes: number }> {
    let fileCount = 0;
    let sizeBytes = 0;

    async function walk(current: string): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          fileCount += 1;
          sizeBytes += (await stat(full)).size;
        }
      }
    }

    await walk(dir);
    return { fileCount, sizeBytes };
  }

  function resolveFile(id: string, relPath: string): string | null {
    if (isAbsolute(relPath)) return null;
    if (/[\u0000-\u001f]/.test(relPath)) return null;

    const root = mockupDir(id);
    const target = resolve(root, normalize(relPath));
    if (target !== root && !target.startsWith(root + sep)) return null;
    if (relative(root, target).startsWith("..")) return null;
    return target;
  }

  return {
    mockupDir,
    createStagingDir,
    discardStaging,
    commit,
    remove,
    measure,
    resolveFile,
  };
}

export type Storage = ReturnType<typeof createStorage>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/tests/lib/storage.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/storage.ts server/tests/lib/storage.test.ts
git commit -m "feat: mockup storage with atomic swap and path containment"
```

---

## Task 8: Ingest orchestration

**Files:**
- Create: `server/src/lib/ingest.ts`
- Test: `server/tests/lib/ingest.test.ts`

**Interfaces:**
- Consumes: `extractZip` + `DEFAULT_EXTRACT_LIMITS` (Task 4), `resolveContentRoot` and `detectBasePathWarning` (Task 5), `createStorage` (Task 7), `mockups` table + `Db` (Task 2), `mockupBasePath` (Task 1).
- Produces:
  - `interface IngestDeps { db: Db; storage: Storage; limits: ExtractLimits }`
  - `interface IngestResult { fileCount: number; sizeBytes: number; warning: string | null }`
  - `ingestZip(deps: IngestDeps, mockupId: string, zipPath: string): Promise<IngestResult>`

- [ ] **Step 1: Write the failing test**

`server/tests/lib/ingest.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/lib/extract.js";
import { ingestZip, type IngestDeps } from "../../src/lib/ingest.js";
import { createStorage } from "../../src/lib/storage.js";
import { mockups } from "../../src/schema/index.js";
import { createTestDb } from "../helpers/db.js";
import { writeZip } from "../helpers/zip.js";

let ctx: ReturnType<typeof createTestDb>;
let workDir: string;
let deps: IngestDeps;

beforeEach(() => {
  ctx = createTestDb();
  workDir = mkdtempSync(join(tmpdir(), "ingest-zips-"));
  deps = {
    db: ctx.db,
    storage: createStorage(join(ctx.dir, "data")),
    limits: DEFAULT_EXTRACT_LIMITS,
  };
  ctx.db.insert(mockups).values({ id: "id-1", name: "Acme", slug: "acme" }).run();
});

afterEach(() => {
  ctx.cleanup();
  rmSync(workDir, { recursive: true, force: true });
});

const row = () => ctx.db.select().from(mockups).where(eq(mockups.id, "id-1")).get();

describe("ingestZip", () => {
  it("serves the pushed files and records counts on the row", async () => {
    const zip = await writeZip(workDir, [
      { name: "index.html", content: '<script src="/m/id-1/assets/a.js"></script>' },
      { name: "assets/a.js", content: "console.log(1)" },
    ]);

    const result = await ingestZip(deps, "id-1", zip);

    expect(result.fileCount).toBe(2);
    expect(result.warning).toBeNull();
    expect(row()?.fileCount).toBe(2);
    expect(row()?.sizeBytes).toBe(result.sizeBytes);
    expect(row()?.lastPushedAt).toBeInstanceOf(Date);
    expect(row()?.basePathWarning).toBeNull();
  });

  it("strips a wrapping dist directory", async () => {
    const zip = await writeZip(workDir, [
      { name: "dist/index.html", content: "<html></html>" },
      { name: "dist/assets/a.js", content: "x" },
    ]);

    await ingestZip(deps, "id-1", zip);

    expect(readFileSync(join(deps.storage.mockupDir("id-1"), "index.html"), "utf8")).toBe(
      "<html></html>",
    );
  });

  it("records a warning for a root-absolute build without rejecting it", async () => {
    const zip = await writeZip(workDir, [
      { name: "index.html", content: '<script src="/assets/a.js"></script>' },
    ]);

    const result = await ingestZip(deps, "id-1", zip);

    expect(result.warning).toMatch(/--base=\/m\/id-1\//);
    expect(row()?.basePathWarning).toBe(result.warning);
    expect(existsSync(join(deps.storage.mockupDir("id-1"), "index.html"))).toBe(true);
  });

  it("clears a previous warning when a corrected build is pushed", async () => {
    const bad = await writeZip(
      workDir,
      [{ name: "index.html", content: '<script src="/a.js"></script>' }],
      "bad.zip",
    );
    const good = await writeZip(
      workDir,
      [{ name: "index.html", content: "<html></html>" }],
      "good.zip",
    );

    await ingestZip(deps, "id-1", bad);
    await ingestZip(deps, "id-1", good);

    expect(row()?.basePathWarning).toBeNull();
  });

  it("leaves the previous build untouched when the archive is rejected", async () => {
    const ok = await writeZip(workDir, [{ name: "index.html", content: "good" }], "ok.zip");
    await ingestZip(deps, "id-1", ok);

    const bad = await writeZip(workDir, [{ name: "../evil.js", content: "pwned" }], "bad.zip");
    await expect(ingestZip(deps, "id-1", bad)).rejects.toMatchObject({ code: "invalid_entry" });

    expect(readFileSync(join(deps.storage.mockupDir("id-1"), "index.html"), "utf8")).toBe("good");
  });

  it("rejects an archive with no index.html and leaves no staging behind", async () => {
    const zip = await writeZip(workDir, [{ name: "app.js", content: "1" }]);

    await expect(ingestZip(deps, "id-1", zip)).rejects.toMatchObject({ code: "no_index_html" });
    expect(readdirSync(join(ctx.dir, "data", "tmp"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/tests/lib/ingest.test.ts`
Expected: FAIL — module unresolvable.

- [ ] **Step 3: Write the implementation**

`server/src/lib/ingest.ts`:

```ts
import { eq } from "drizzle-orm";
import { mockupBasePath } from "@mockups/shared";
import type { Db } from "../db.js";
import { mockups } from "../schema/index.js";
import { detectBasePathWarning } from "./base-path.js";
import { resolveContentRoot } from "./content-root.js";
import { extractZip, type ExtractLimits } from "./extract.js";
import type { Storage } from "./storage.js";

export interface IngestDeps {
  db: Db;
  storage: Storage;
  limits: ExtractLimits;
}

export interface IngestResult {
  fileCount: number;
  sizeBytes: number;
  warning: string | null;
}

export async function ingestZip(
  deps: IngestDeps,
  mockupId: string,
  zipPath: string,
): Promise<IngestResult> {
  const staging = await deps.storage.createStagingDir(mockupId);

  try {
    await extractZip(zipPath, staging, deps.limits);
    const contentRoot = await resolveContentRoot(staging);
    const warning = await detectBasePathWarning(contentRoot, mockupBasePath(mockupId));
    const { fileCount, sizeBytes } = await deps.storage.measure(contentRoot);

    await deps.storage.commit(mockupId, contentRoot);

    deps.db
      .update(mockups)
      .set({
        fileCount,
        sizeBytes,
        basePathWarning: warning,
        lastPushedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mockups.id, mockupId))
      .run();

    return { fileCount, sizeBytes, warning };
  } finally {
    await deps.storage.discardStaging(staging);
  }
}
```

Note the ordering: everything that can fail happens before `commit`, so a rejected archive
never touches the live directory. The `finally` cleans up the staging directory whether the
push succeeded (the content root has already moved out of it) or failed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/tests/lib/ingest.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/ingest.ts server/tests/lib/ingest.test.ts
git commit -m "feat: ingest pipeline wiring extraction, detection, and atomic commit"
```

---

## Task 9: Authentication primitives

**Files:**
- Create: `server/src/lib/password.ts`, `server/src/lib/tokens.ts`, `server/src/lib/sessions.ts`, `server/src/lib/rate-limit.ts`
- Test: `server/tests/lib/auth.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 2), `apiTokens` and `sessions` tables (Task 2).
- Produces:
  - `hashPassword(plain: string): Promise<string>`, `verifyPassword(digest: string, plain: string): Promise<boolean>`, `safeEquals(a: string, b: string): boolean`
  - `generateToken(): string`, `hashToken(token: string): string`, `createApiToken(db: Db, name: string): { id: string; token: string }`, `verifyApiToken(db: Db, token: string): ApiToken | null`, `listApiTokens(db: Db): ApiToken[]`, `revokeApiToken(db: Db, id: string): void`
  - `SESSION_TTL_MS: number`, `createSession(db: Db, now?: Date): string`, `getValidSession(db: Db, id: string, now?: Date): Session | null`, `deleteSession(db: Db, id: string): void`, `deleteExpiredSessions(db: Db, now?: Date): void`
  - `createRateLimiter(options: { windowMs: number; max: number }): { check(key: string, now?: number): boolean; reset(key: string): void }`

- [ ] **Step 1: Write the failing test**

`server/tests/lib/auth.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/tests/lib/auth.test.ts`
Expected: FAIL — the four modules do not exist.

- [ ] **Step 3: Write `password.ts`**

```ts
import { timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain);
  } catch {
    return false;
  }
}

/** Constant-time string comparison that tolerates unequal lengths. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
```

- [ ] **Step 4: Write `tokens.ts`**

```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db.js";
import { apiTokens, type ApiToken } from "../schema/index.js";

export function generateToken(): string {
  return `mk_${randomBytes(32).toString("base64url")}`;
}

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
```

Tokens are hashed with SHA-256 rather than argon2 on purpose: a 256-bit random token has
no dictionary to attack, so the slow KDF buys nothing and would add latency to every push.
Passwords, which are guessable, get argon2.

- [ ] **Step 5: Write `sessions.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import type { Db } from "../db.js";
import { sessions, type Session } from "../schema/index.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(db: Db, now: Date = new Date()): string {
  const id = randomUUID();
  db.insert(sessions)
    .values({ id, createdAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .run();
  return id;
}

export function getValidSession(db: Db, id: string, now: Date = new Date()): Session | null {
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return row;
}

export function deleteSession(db: Db, id: string): void {
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

export function deleteExpiredSessions(db: Db, now: Date = new Date()): void {
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
}
```

- [ ] **Step 6: Write `rate-limit.ts`**

```ts
export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

export function createRateLimiter({ windowMs, max }: RateLimiterOptions) {
  const buckets = new Map<string, { count: number; startedAt: number }>();

  return {
    check(key: string, now: number = Date.now()): boolean {
      const bucket = buckets.get(key);
      if (!bucket || now - bucket.startedAt >= windowMs) {
        buckets.set(key, { count: 1, startedAt: now });
        return true;
      }
      if (bucket.count >= max) return false;
      bucket.count += 1;
      return true;
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}
```

In-memory is the right scope here: one process, one server, and a limiter that forgets
everything on restart is acceptable for a personal panel. Do not reach for a table.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run server/tests/lib/auth.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 8: Commit**

```bash
git add server/src/lib/password.ts server/src/lib/tokens.ts server/src/lib/sessions.ts server/src/lib/rate-limit.ts server/tests/lib/auth.test.ts
git commit -m "feat: password hashing, api tokens, sessions, and rate limiting"
```

---

## Task 10: Host, session, and token middleware

**Files:**
- Create: `server/src/app-env.ts`, `server/src/middleware/host.ts`, `server/src/middleware/session.ts`, `server/src/middleware/token.ts`
- Test: `server/tests/middleware.test.ts`

**Interfaces:**
- Consumes: `getValidSession` (Task 9), `verifyApiToken` (Task 9), `Db` (Task 2).
- Produces:
  - `type AppEnv = { Variables: { sessionId: string; tokenId: string } }` from `app-env.ts`
  - `SESSION_COOKIE = "mockup_session"` from `session.ts`
  - `requireHost(expected: string): MiddlewareHandler<AppEnv>`
  - `requireSession(db: Db, secret: string): MiddlewareHandler<AppEnv>` — redirects to `/login` when unauthenticated
  - `requireToken(db: Db): MiddlewareHandler<AppEnv>` — 401 JSON when the bearer token is missing or invalid

- [ ] **Step 1: Write the failing test**

`server/tests/middleware.test.ts`:

```ts
import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/app-env.js";
import { requireHost } from "../src/middleware/host.js";
import { SESSION_COOKIE, requireSession } from "../src/middleware/session.js";
import { requireToken } from "../src/middleware/token.js";
import { createSession, deleteSession } from "../src/lib/sessions.js";
import { createApiToken, revokeApiToken } from "../src/lib/tokens.js";
import { createTestDb } from "./helpers/db.js";

const SECRET = "test-secret";
let ctx: ReturnType<typeof createTestDb>;

beforeEach(() => {
  ctx = createTestDb();
});
afterEach(() => ctx.cleanup());

describe("requireHost", () => {
  const app = new Hono<AppEnv>();
  app.use("*", requireHost("panel.example.org"));
  app.get("/", (c) => c.text("panel"));

  it("serves a request on the expected host", async () => {
    const res = await app.request("/", { headers: { host: "panel.example.org" } });
    expect(res.status).toBe(200);
  });

  it("ignores a port on the host header", async () => {
    const res = await app.request("/", { headers: { host: "panel.example.org:3000" } });
    expect(res.status).toBe(200);
  });

  it("404s a request on a different host, without saying why", async () => {
    const res = await app.request("/", { headers: { host: "mockups.example.org" } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/panel/i);
  });

  it("404s when no host header is present", async () => {
    const res = await app.request("/", { headers: {} });
    expect(res.status).toBe(404);
  });
});

describe("requireSession", () => {
  function buildApp() {
    const app = new Hono<AppEnv>();
    app.get("/login", (c) => c.text("login page"));
    app.post("/sign-in", async (c) => {
      const id = createSession(ctx.db);
      await setSignedCookie(c, SESSION_COOKIE, id, SECRET, { path: "/", httpOnly: true });
      return c.text("ok");
    });
    app.use("/private/*", requireSession(ctx.db, SECRET));
    app.get("/private/thing", (c) => c.text(`hello ${c.get("sessionId")}`));
    return app;
  }

  async function signedInCookie(app: Hono<AppEnv>): Promise<string> {
    const res = await app.request("/sign-in", { method: "POST" });
    return res.headers.get("set-cookie")!.split(";")[0];
  }

  it("redirects an anonymous request to /login", async () => {
    const res = await buildApp().request("/private/thing");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("allows a request carrying a valid signed session cookie", async () => {
    const app = buildApp();
    const cookie = await signedInCookie(app);

    const res = await app.request("/private/thing", { headers: { cookie } });

    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^hello /);
  });

  it("rejects a tampered cookie value", async () => {
    const app = buildApp();
    const cookie = await signedInCookie(app);
    const tampered = `${SESSION_COOKIE}=${cookie.split("=")[1]}x`;

    const res = await app.request("/private/thing", { headers: { cookie: tampered } });
    expect(res.status).toBe(302);
  });

  it("rejects a cookie whose session has been revoked", async () => {
    const app = buildApp();
    const cookie = await signedInCookie(app);
    const id = createSession(ctx.db);
    deleteSession(ctx.db, id);

    const before = await app.request("/private/thing", { headers: { cookie } });
    expect(before.status).toBe(200);

    for (const row of ctx.db.$client.prepare("select id from sessions").all() as { id: string }[]) {
      deleteSession(ctx.db, row.id);
    }

    const after = await app.request("/private/thing", { headers: { cookie } });
    expect(after.status).toBe(302);
  });
});

describe("requireToken", () => {
  function buildApp() {
    const app = new Hono<AppEnv>();
    app.use("/api/*", requireToken(ctx.db));
    app.get("/api/thing", (c) => c.json({ tokenId: c.get("tokenId") }));
    return app;
  }

  it("401s without an Authorization header", async () => {
    const res = await buildApp().request("/api/thing");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("401s for a malformed Authorization header", async () => {
    const res = await buildApp().request("/api/thing", {
      headers: { authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });

  it("allows a valid bearer token and exposes its id", async () => {
    const { token, id } = createApiToken(ctx.db, "laptop");

    const res = await buildApp().request("/api/thing", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokenId: id });
  });

  it("401s for a revoked token", async () => {
    const { token, id } = createApiToken(ctx.db, "laptop");
    revokeApiToken(ctx.db, id);

    const res = await buildApp().request("/api/thing", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/tests/middleware.test.ts`
Expected: FAIL — middleware modules do not exist.

- [ ] **Step 3: Write `app-env.ts`**

```ts
export type AppEnv = {
  Variables: {
    sessionId: string;
    tokenId: string;
  };
};
```

- [ ] **Step 4: Write `middleware/host.ts`**

```ts
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.js";

/**
 * Enforces the panel/mockups origin split in the application, not just in Caddy.
 * A mismatched host gets a bare 404 — it must not reveal that another vhost exists.
 */
export function requireHost(expected: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const host = c.req.header("host")?.split(":")[0].toLowerCase();
    if (host !== expected.toLowerCase()) return c.notFound();
    await next();
  };
}
```

- [ ] **Step 5: Write `middleware/session.ts`**

```ts
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
```

- [ ] **Step 6: Write `middleware/token.ts`**

```ts
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
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run server/tests/middleware.test.ts`
Expected: PASS, 12 tests.

If `ctx.db.$client` is not exposed by the installed Drizzle version, replace that loop in the
revocation test with `ctx.db.delete(sessions).run()` and import `sessions` from the schema.

- [ ] **Step 8: Commit**

```bash
git add server/src/app-env.ts server/src/middleware server/tests/middleware.test.ts
git commit -m "feat: host split, session, and bearer token middleware"
```

---

## Task 11: Mockup serving route

**Files:**
- Create: `server/src/lib/range.ts`, `server/src/lib/mockup-cache.ts`, `server/src/routes/serve.ts`
- Test: `server/tests/lib/range.test.ts`, `server/tests/routes/serve.test.ts`

**Interfaces:**
- Consumes: `contentTypeFor`, `cacheControlFor`, `shouldFallbackToIndex` (Task 6), `createStorage` (Task 7), `Db` + `mockups` (Task 2), `AppEnv` (Task 10).
- Produces:
  - `type ParsedRange = { start: number; end: number } | "invalid" | null` and `parseRange(header: string | undefined, size: number): ParsedRange`
  - `createMockupCache(db: Db): { exists(id: string): boolean; invalidate(id: string): void; clear(): void }`
  - `createServeRoutes(deps: { storage: Storage; cache: MockupCache }): Hono<AppEnv>` — mounts `GET /m/:id` and `GET /m/:id/*`
  - `type MockupCache = ReturnType<typeof createMockupCache>`

- [ ] **Step 1: Write the failing range test**

`server/tests/lib/range.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRange } from "../../src/lib/range.js";

describe("parseRange", () => {
  it("returns null when no range is requested", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  });

  it("parses an open-ended range", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("parses a suffix range", () => {
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("clamps an end beyond the file size", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("clamps a suffix longer than the file", () => {
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("rejects a start beyond the file size", () => {
    expect(parseRange("bytes=2000-", 1000)).toBe("invalid");
  });

  it("rejects an inverted range", () => {
    expect(parseRange("bytes=500-100", 1000)).toBe("invalid");
  });

  it("ignores unsupported units", () => {
    expect(parseRange("items=0-10", 1000)).toBeNull();
  });

  it("ignores multi-range requests rather than mishandling them", () => {
    expect(parseRange("bytes=0-10,20-30", 1000)).toBeNull();
  });

  it("treats a zero-length file as unsatisfiable", () => {
    expect(parseRange("bytes=0-", 0)).toBe("invalid");
  });
});
```

- [ ] **Step 2: Write `lib/range.ts`, then run the test**

```ts
export type ParsedRange = { start: number; end: number } | "invalid" | null;

export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (size === 0) return "invalid";

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (start >= size) return "invalid";

  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return "invalid";

  return { start, end };
}
```

Run: `npx vitest run server/tests/lib/range.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 3: Write `lib/mockup-cache.ts`**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../db.js";
import { mockups } from "../schema/index.js";

/**
 * Keeps the database out of the path of every asset request. Entries are only
 * ever added or dropped wholesale, so there is nothing to go stale except
 * existence — which push and delete invalidate explicitly.
 */
export function createMockupCache(db: Db) {
  const known = new Map<string, boolean>();

  return {
    exists(id: string): boolean {
      const cached = known.get(id);
      if (cached !== undefined) return cached;

      const row = db.select({ id: mockups.id }).from(mockups).where(eq(mockups.id, id)).get();
      const found = row !== undefined;
      known.set(id, found);
      return found;
    },
    invalidate(id: string): void {
      known.delete(id);
    },
    clear(): void {
      known.clear();
    },
  };
}

export type MockupCache = ReturnType<typeof createMockupCache>;
```

- [ ] **Step 4: Write the failing serving test**

`server/tests/routes/serve.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockupCache } from "../../src/lib/mockup-cache.js";
import { createStorage } from "../../src/lib/storage.js";
import { createServeRoutes } from "../../src/routes/serve.js";
import { mockups } from "../../src/schema/index.js";
import { createTestDb } from "../helpers/db.js";

let ctx: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createServeRoutes>;
let storage: ReturnType<typeof createStorage>;

const HTML_ACCEPT = { accept: "text/html,application/xhtml+xml" };

beforeEach(async () => {
  ctx = createTestDb();
  storage = createStorage(join(ctx.dir, "data"));
  ctx.db.insert(mockups).values({ id: "id-1", name: "Acme", slug: "acme" }).run();

  const staged = await storage.createStagingDir("id-1");
  mkdirSync(join(staged, "assets"), { recursive: true });
  writeFileSync(join(staged, "index.html"), "<h1>home</h1>");
  writeFileSync(join(staged, "assets", "app-a1b2c3d4.js"), "console.log(1)");
  writeFileSync(join(staged, "assets", "big.bin"), "0123456789");
  await storage.commit("id-1", staged);

  app = createServeRoutes({ storage, cache: createMockupCache(ctx.db) });
});

afterEach(() => ctx.cleanup());

describe("serving", () => {
  it("redirects the bare mockup path to a trailing slash", async () => {
    const res = await app.request("/m/id-1");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/m/id-1/");
  });

  it("serves index.html at the root of a mockup", async () => {
    const res = await app.request("/m/id-1/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("<h1>home</h1>");
  });

  it("serves a hashed asset with an immutable cache header", async () => {
    const res = await app.request("/m/id-1/assets/app-a1b2c3d4.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("answers a conditional request with 304", async () => {
    const first = await app.request("/m/id-1/assets/app-a1b2c3d4.js");
    const etag = first.headers.get("etag")!;

    const second = await app.request("/m/id-1/assets/app-a1b2c3d4.js", {
      headers: { "if-none-match": etag },
    });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("serves a byte range", async () => {
    const res = await app.request("/m/id-1/assets/big.bin", {
      headers: { range: "bytes=2-5" },
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
  });

  it("answers an unsatisfiable range with 416", async () => {
    const res = await app.request("/m/id-1/assets/big.bin", {
      headers: { range: "bytes=99-" },
    });

    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });

  it("falls back to index.html for a client-side route", async () => {
    const res = await app.request("/m/id-1/settings/profile", { headers: HTML_ACCEPT });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>home</h1>");
  });

  it("does NOT fall back for a missing script, so bundlers fail loudly", async () => {
    const res = await app.request("/m/id-1/assets/missing.js", { headers: HTML_ACCEPT });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toMatch(/html/);
  });

  it("404s an unknown mockup id", async () => {
    const res = await app.request("/m/id-unknown/", { headers: HTML_ACCEPT });
    expect(res.status).toBe(404);
  });

  it("refuses a traversal out of the mockup directory", async () => {
    const res = await app.request("/m/id-1/..%2F..%2Fdb.sqlite");
    expect(res.status).toBe(404);
  });

  it("404s after the mockup is deleted and the cache invalidated", async () => {
    const cache = createMockupCache(ctx.db);
    const scoped = createServeRoutes({ storage, cache });
    expect((await scoped.request("/m/id-1/")).status).toBe(200);

    ctx.db.delete(mockups).run();
    await storage.remove("id-1");
    cache.invalidate("id-1");

    expect((await scoped.request("/m/id-1/")).status).toBe(404);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run server/tests/routes/serve.test.ts`
Expected: FAIL — `../../src/routes/serve.js` unresolvable.

- [ ] **Step 6: Write `routes/serve.ts`**

```ts
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { MockupCache } from "../lib/mockup-cache.js";
import { parseRange } from "../lib/range.js";
import { cacheControlFor, contentTypeFor, shouldFallbackToIndex } from "../lib/serving.js";
import type { Storage } from "../lib/storage.js";

export interface ServeDeps {
  storage: Storage;
  cache: MockupCache;
}

function webStream(path: string, options?: { start: number; end: number }): ReadableStream {
  return Readable.toWeb(createReadStream(path, options)) as ReadableStream;
}

async function sendFile(
  c: Context<AppEnv>,
  absPath: string,
  relPath: string,
): Promise<Response | null> {
  const info = await stat(absPath).catch(() => null);
  if (!info?.isFile()) return null;

  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(relPath),
    "cache-control": cacheControlFor(relPath),
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "last-modified": info.mtime.toUTCString(),
    etag,
  };

  if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);

  const range = parseRange(c.req.header("range"), info.size);
  if (range === "invalid") {
    return c.body(null, 416, { ...headers, "content-range": `bytes */${info.size}` });
  }

  if (range) {
    return c.body(webStream(absPath, range), 206, {
      ...headers,
      "content-range": `bytes ${range.start}-${range.end}/${info.size}`,
      "content-length": String(range.end - range.start + 1),
    });
  }

  return c.body(webStream(absPath), 200, { ...headers, "content-length": String(info.size) });
}

export function createServeRoutes(deps: ServeDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/m/:id", (c) => c.redirect(`/m/${c.req.param("id")}/`, 301));

  app.get("/m/:id/*", async (c) => {
    const id = c.req.param("id");
    if (!deps.cache.exists(id)) return c.notFound();

    let relPath: string;
    try {
      relPath = decodeURIComponent(c.req.path.slice(`/m/${id}/`.length));
    } catch {
      return c.notFound();
    }

    const target = relPath === "" ? "index.html" : relPath;
    const absPath = deps.storage.resolveFile(id, target);
    if (absPath === null) return c.notFound();

    // A directory request resolves to its own index.html.
    const info = await stat(absPath).catch(() => null);
    if (info?.isDirectory()) {
      const nested = join(absPath, "index.html");
      const served = await sendFile(c, nested, "index.html");
      if (served) return served;
    } else {
      const served = await sendFile(c, absPath, target);
      if (served) return served;
    }

    if (!shouldFallbackToIndex(target, c.req.header("accept") ?? null)) return c.notFound();

    const indexPath = deps.storage.resolveFile(id, "index.html");
    if (indexPath === null) return c.notFound();

    const fallback = await sendFile(c, indexPath, "index.html");
    return fallback ?? c.notFound();
  });

  return app;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run server/tests/routes/serve.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 8: Commit**

```bash
git add server/src/lib/range.ts server/src/lib/mockup-cache.ts server/src/routes/serve.ts server/tests
git commit -m "feat: mockup static serving with etag, range, and conditional spa fallback"
```

---

## Task 12: CLI-facing JSON API

**Files:**
- Create: `server/src/lib/mockup-service.ts`, `server/src/routes/api.ts`
- Test: `server/tests/routes/api.test.ts`

**Interfaces:**
- Consumes: `ingestZip` (Task 8), `createStorage` (Task 7), `createMockupCache` (Task 11), `requireToken` (Task 10), `slugify`/`SLUG_PATTERN`/`mockupUrl`/`mockupBasePath` and the response types (Task 1).
- Produces:
  - `toSummary(row: Mockup): MockupSummary`
  - `resolveOrCreateMockup(db: Db, input: { slug: string; name?: string }): Mockup`
  - `deleteMockup(deps: { db: Db; storage: Storage; cache: MockupCache }, id: string): boolean`
  - `receiveUpload(c: Context, maxBytes: number): Promise<string>` — writes the request body (raw zip or `file` form field) to a temp path, throwing `IngestError("...", "too_large")` past the cap
  - `createApiRoutes(deps: ApiDeps): Hono<AppEnv>` where `ApiDeps = { db: Db; storage: Storage; cache: MockupCache; limits: ExtractLimits; maxUploadBytes: number; mockupsOrigin: string }`

Routes, all under bearer auth:

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/api/mockups/resolve` | `ResolveMockupRequest` | `ResolveMockupResponse` |
| `POST` | `/api/mockups/:id/content` | zip bytes | `PushResponse` |
| `GET` | `/api/mockups` | — | `{ mockups: MockupSummary[] }` |
| `DELETE` | `/api/mockups/:id` | — | `204` |

- [ ] **Step 1: Write the failing test**

`server/tests/routes/api.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/lib/extract.js";
import { createMockupCache } from "../../src/lib/mockup-cache.js";
import { createStorage } from "../../src/lib/storage.js";
import { createApiToken } from "../../src/lib/tokens.js";
import { createApiRoutes } from "../../src/routes/api.js";
import { createTestDb } from "../helpers/db.js";
import { writeZip } from "../helpers/zip.js";

let ctx: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createApiRoutes>;
let storage: ReturnType<typeof createStorage>;
let workDir: string;
let auth: Record<string, string>;

beforeEach(() => {
  ctx = createTestDb();
  workDir = mkdtempSync(join(tmpdir(), "api-test-"));
  storage = createStorage(join(ctx.dir, "data"));
  app = createApiRoutes({
    db: ctx.db,
    storage,
    cache: createMockupCache(ctx.db),
    limits: DEFAULT_EXTRACT_LIMITS,
    maxUploadBytes: 10_000_000,
    mockupsOrigin: "https://mockups.example.org",
  });
  auth = { authorization: `Bearer ${createApiToken(ctx.db, "test").token}` };
});

afterEach(() => {
  ctx.cleanup();
  rmSync(workDir, { recursive: true, force: true });
});

function resolve(body: unknown) {
  return app.request("/api/mockups/resolve", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function pushZip(id: string, entries: Parameters<typeof writeZip>[1], name?: string) {
  const zipPath = await writeZip(workDir, entries, name);
  return app.request(`/api/mockups/${id}/content`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/zip" },
    body: readFileSync(zipPath),
  });
}

describe("authentication", () => {
  it("401s every route without a token", async () => {
    expect((await app.request("/api/mockups")).status).toBe(401);
    expect((await app.request("/api/mockups/resolve", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/mockups/x", { method: "DELETE" })).status).toBe(401);
  });
});

describe("POST /api/mockups/resolve", () => {
  it("creates a mockup and returns its base path and url", async () => {
    const res = await resolve({ slug: "acme", name: "Acme" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mockup.slug).toBe("acme");
    expect(body.mockup.name).toBe("Acme");
    expect(body.basePath).toBe(`/m/${body.mockup.id}/`);
    expect(body.url).toBe(`https://mockups.example.org/m/${body.mockup.id}`);
  });

  it("returns the same mockup on a second resolve", async () => {
    const first = await (await resolve({ slug: "acme", name: "Acme" })).json();
    const second = await (await resolve({ slug: "acme", name: "Ignored" })).json();

    expect(second.mockup.id).toBe(first.mockup.id);
    expect(second.mockup.name).toBe("Acme");
  });

  it("400s an invalid slug", async () => {
    const res = await resolve({ slug: "Not A Slug" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/slug/i);
  });

  it("defaults the name to the slug", async () => {
    const body = await (await resolve({ slug: "acme" })).json();
    expect(body.mockup.name).toBe("acme");
  });
});

describe("POST /api/mockups/:id/content", () => {
  it("accepts a zip and reports the share url", async () => {
    const { mockup } = await (await resolve({ slug: "acme" })).json();

    const res = await pushZip(mockup.id, [
      { name: "index.html", content: `<script src="/m/${mockup.id}/a.js"></script>` },
    ]);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe(`https://mockups.example.org/m/${mockup.id}`);
    expect(body.warning).toBeNull();
    expect(body.mockup.fileCount).toBe(1);
    expect(existsSync(join(storage.mockupDir(mockup.id), "index.html"))).toBe(true);
  });

  it("returns the base-path warning without failing the push", async () => {
    const { mockup } = await (await resolve({ slug: "acme" })).json();

    const res = await pushZip(mockup.id, [
      { name: "index.html", content: '<script src="/assets/a.js"></script>' },
    ]);

    expect(res.status).toBe(200);
    expect((await res.json()).warning).toMatch(/--base=/);
  });

  it("400s a rejected archive with a readable message", async () => {
    const { mockup } = await (await resolve({ slug: "acme" })).json();

    const res = await pushZip(mockup.id, [{ name: "app.js", content: "1" }]);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/index\.html/);
  });

  it("404s a push to an unknown mockup", async () => {
    const res = await pushZip("no-such-id", [{ name: "index.html", content: "x" }]);
    expect(res.status).toBe(404);
  });

  it("413s a body over the upload cap", async () => {
    const { mockup } = await (await resolve({ slug: "acme" })).json();
    const small = createApiRoutes({
      db: ctx.db,
      storage,
      cache: createMockupCache(ctx.db),
      limits: DEFAULT_EXTRACT_LIMITS,
      maxUploadBytes: 10,
      mockupsOrigin: "https://mockups.example.org",
    });

    const zipPath = await writeZip(workDir, [{ name: "index.html", content: "x".repeat(500) }]);
    const res = await small.request(`/api/mockups/${mockup.id}/content`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/zip" },
      body: readFileSync(zipPath),
    });

    expect(res.status).toBe(413);
  });
});

describe("GET /api/mockups and DELETE /api/mockups/:id", () => {
  it("lists mockups", async () => {
    await resolve({ slug: "acme" });
    await resolve({ slug: "beta" });

    const body = await (await app.request("/api/mockups", { headers: auth })).json();
    expect(body.mockups.map((m: { slug: string }) => m.slug).sort()).toEqual(["acme", "beta"]);
  });

  it("deletes the row and the files", async () => {
    const { mockup } = await (await resolve({ slug: "acme" })).json();
    await pushZip(mockup.id, [{ name: "index.html", content: "x" }]);

    const res = await app.request(`/api/mockups/${mockup.id}`, { method: "DELETE", headers: auth });

    expect(res.status).toBe(204);
    expect(existsSync(storage.mockupDir(mockup.id))).toBe(false);
    const body = await (await app.request("/api/mockups", { headers: auth })).json();
    expect(body.mockups).toEqual([]);
  });

  it("404s deleting an unknown mockup", async () => {
    const res = await app.request("/api/mockups/nope", { method: "DELETE", headers: auth });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/tests/routes/api.test.ts`
Expected: FAIL — modules unresolvable.

- [ ] **Step 3: Write `lib/mockup-service.ts`**

```ts
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { MockupSummary } from "@mockups/shared";
import type { Db } from "../db.js";
import { mockups, type Mockup } from "../schema/index.js";
import { IngestError } from "./errors.js";
import type { MockupCache } from "./mockup-cache.js";
import type { Storage } from "./storage.js";

export function toSummary(row: Mockup): MockupSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastPushedAt: row.lastPushedAt?.toISOString() ?? null,
    sizeBytes: row.sizeBytes,
    fileCount: row.fileCount,
    basePathWarning: row.basePathWarning,
  };
}

export function resolveOrCreateMockup(db: Db, input: { slug: string; name?: string }): Mockup {
  const existing = db.select().from(mockups).where(eq(mockups.slug, input.slug)).get();
  if (existing) return existing;

  const id = randomUUID();
  db.insert(mockups).values({ id, slug: input.slug, name: input.name ?? input.slug }).run();
  return db.select().from(mockups).where(eq(mockups.id, id)).get()!;
}

export async function deleteMockup(
  deps: { db: Db; storage: Storage; cache: MockupCache },
  id: string,
): Promise<boolean> {
  const row = deps.db.select().from(mockups).where(eq(mockups.id, id)).get();
  if (!row) return false;

  deps.db.delete(mockups).where(eq(mockups.id, id)).run();
  deps.cache.invalidate(id);
  await deps.storage.remove(id);
  return true;
}

/** Streams the request body to a temp file, refusing to buffer more than the cap. */
export async function receiveUpload(c: Context, maxBytes: number): Promise<string> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new IngestError(`Upload exceeds ${maxBytes} bytes`, "too_large");
  }

  const dir = await mkdtemp(join(tmpdir(), "mockup-upload-"));
  const target = join(dir, "upload.zip");

  const contentType = c.req.header("content-type") ?? "";
  let source: ReadableStream<Uint8Array> | null;

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      await rm(dir, { recursive: true, force: true });
      throw new IngestError("Expected a file field named \"file\"", "invalid_entry");
    }
    if (file.size > maxBytes) {
      await rm(dir, { recursive: true, force: true });
      throw new IngestError(`Upload exceeds ${maxBytes} bytes`, "too_large");
    }
    source = file.stream();
  } else {
    source = c.req.raw.body;
  }

  if (!source) {
    await rm(dir, { recursive: true, force: true });
    throw new IngestError("Request had no body", "empty_archive");
  }

  let written = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength;
      if (written > maxBytes) {
        throw new IngestError(`Upload exceeds ${maxBytes} bytes`, "too_large");
      }
      controller.enqueue(chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(source.pipeThrough(counted)), createWriteStream(target));
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  return target;
}
```

- [ ] **Step 4: Write `routes/api.ts`**

```ts
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { SLUG_PATTERN, mockupBasePath, mockupUrl } from "@mockups/shared";
import type { AppEnv } from "../app-env.js";
import type { Db } from "../db.js";
import { IngestError } from "../lib/errors.js";
import type { ExtractLimits } from "../lib/extract.js";
import { ingestZip } from "../lib/ingest.js";
import type { MockupCache } from "../lib/mockup-cache.js";
import {
  deleteMockup,
  receiveUpload,
  resolveOrCreateMockup,
  toSummary,
} from "../lib/mockup-service.js";
import type { Storage } from "../lib/storage.js";
import { requireToken } from "../middleware/token.js";
import { mockups } from "../schema/index.js";

export interface ApiDeps {
  db: Db;
  storage: Storage;
  cache: MockupCache;
  limits: ExtractLimits;
  maxUploadBytes: number;
  mockupsOrigin: string;
}

const STATUS_FOR: Record<string, 400 | 413> = {
  too_large: 413,
  ratio_exceeded: 413,
  too_many_files: 413,
};

export function createApiRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("/api/*", requireToken(deps.db));

  app.post("/api/mockups/resolve", async (c) => {
    const body = await c.req.json<{ slug?: string; name?: string }>().catch(() => ({}));
    const slug = body.slug ?? "";
    if (!SLUG_PATTERN.test(slug)) {
      return c.json({ error: "slug must be lowercase words separated by hyphens" }, 400);
    }

    const mockup = resolveOrCreateMockup(deps.db, { slug, name: body.name });
    return c.json({
      mockup: toSummary(mockup),
      basePath: mockupBasePath(mockup.id),
      url: mockupUrl(deps.mockupsOrigin, mockup.id),
    });
  });

  app.post("/api/mockups/:id/content", async (c) => {
    const id = c.req.param("id");
    const row = deps.db.select().from(mockups).where(eq(mockups.id, id)).get();
    if (!row) return c.json({ error: "Mockup not found" }, 404);

    let uploadPath: string | null = null;
    try {
      uploadPath = await receiveUpload(c, deps.maxUploadBytes);
      const result = await ingestZip(
        { db: deps.db, storage: deps.storage, limits: deps.limits },
        id,
        uploadPath,
      );
      deps.cache.invalidate(id);

      const updated = deps.db.select().from(mockups).where(eq(mockups.id, id)).get()!;
      return c.json({
        mockup: toSummary(updated),
        url: mockupUrl(deps.mockupsOrigin, id),
        warning: result.warning,
      });
    } catch (error) {
      if (error instanceof IngestError) {
        return c.json({ error: error.message }, STATUS_FOR[error.code] ?? 400);
      }
      throw error;
    } finally {
      if (uploadPath) await rm(dirname(uploadPath), { recursive: true, force: true });
    }
  });

  app.get("/api/mockups", (c) => {
    const rows = deps.db.select().from(mockups).all();
    return c.json({ mockups: rows.map(toSummary) });
  });

  app.delete("/api/mockups/:id", async (c) => {
    const removed = await deleteMockup(deps, c.req.param("id"));
    if (!removed) return c.json({ error: "Mockup not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run server/tests/routes/api.test.ts`
Expected: PASS, 13 tests.

If the 413 test fails with a 400 or a 500, the cause is the stream machinery wrapping the
`IngestError` thrown inside `TransformStream.transform`. Unwrap it in `receiveUpload`'s catch
rather than loosening the assertion:

```ts
} catch (error) {
  await rm(dir, { recursive: true, force: true });
  const cause = (error as { cause?: unknown }).cause;
  throw cause instanceof IngestError ? cause : error;
}
```

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/mockup-service.ts server/src/routes/api.ts server/tests/routes/api.test.ts
git commit -m "feat: token-authenticated api for resolve, push, list, and delete"
```

---

## Task 13: Panel authentication and mockup management

The panel is server-rendered and works entirely through form posts, so this task needs no
client JavaScript at all. The zip drop in Task 14 is the only place JS appears.

**Files:**
- Create: `server/src/panel/layout.tsx`, `server/src/panel/login.tsx`, `server/src/panel/mockups.tsx`
- Create: `server/src/routes/panel.tsx` (JSX, so `.tsx` not `.ts`)
- Test: `server/tests/routes/panel.test.ts`

**Interfaces:**
- Consumes: `verifyPassword`/`safeEquals` (Task 9), `createSession`/`deleteSession` (Task 9), `createRateLimiter` (Task 9), `requireSession`/`SESSION_COOKIE` (Task 10), `toSummary`/`resolveOrCreateMockup`/`deleteMockup` (Task 12), `slugify` (Task 1).
- Produces:
  - `interface PanelDeps { db: Db; storage: Storage; cache: MockupCache; limits: ExtractLimits; maxUploadBytes: number; mockupsOrigin: string; adminUsername: string; adminPasswordHash: string; sessionSecret: string; secureCookies: boolean }`
  - `createPanelRoutes(deps: PanelDeps): Hono<AppEnv>`
  - `Layout(props: { title: string; children: unknown }): JSX.Element`
  - `LoginPage(props: { error?: string }): JSX.Element`
  - `MockupsPage(props: { mockups: MockupSummary[]; mockupsOrigin: string; flash?: string }): JSX.Element`

Routes: `GET /login`, `POST /login`, `POST /logout`, `GET /` (list), `POST /mockups` (create), `POST /mockups/:id/rename`, `POST /mockups/:id/delete`.

- [ ] **Step 1: Write the failing test**

`server/tests/routes/panel.test.ts`:

```ts
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/lib/extract.js";
import { createMockupCache } from "../../src/lib/mockup-cache.js";
import { hashPassword } from "../../src/lib/password.js";
import { createStorage } from "../../src/lib/storage.js";
import { createPanelRoutes, type PanelDeps } from "../../src/routes/panel.js";
import { mockups } from "../../src/schema/index.js";
import { createTestDb } from "../helpers/db.js";

let ctx: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createPanelRoutes>;
let deps: PanelDeps;

beforeEach(async () => {
  ctx = createTestDb();
  deps = {
    db: ctx.db,
    storage: createStorage(join(ctx.dir, "data")),
    cache: createMockupCache(ctx.db),
    limits: DEFAULT_EXTRACT_LIMITS,
    maxUploadBytes: 10_000_000,
    mockupsOrigin: "https://mockups.example.org",
    adminUsername: "szymon",
    adminPasswordHash: await hashPassword("hunter2"),
    sessionSecret: "test-secret",
    secureCookies: false,
  };
  app = createPanelRoutes(deps);
});

afterEach(() => ctx.cleanup());

function form(fields: Record<string, string>): BodyInit {
  return new URLSearchParams(fields);
}

async function login(): Promise<string> {
  const res = await app.request("/login", {
    method: "POST",
    body: form({ username: "szymon", password: "hunter2" }),
  });
  expect(res.status).toBe(302);
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("login", () => {
  it("shows the login form", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/name="password"/);
  });

  it("redirects to the list on correct credentials", async () => {
    const res = await app.request("/login", {
      method: "POST",
      body: form({ username: "szymon", password: "hunter2" }),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
  });

  it("rejects a wrong password without revealing which field was wrong", async () => {
    const res = await app.request("/login", {
      method: "POST",
      body: form({ username: "szymon", password: "wrong" }),
    });

    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toMatch(/incorrect/i);
    expect(body).not.toMatch(/password is|username is/i);
  });

  it("rejects an unknown username", async () => {
    const res = await app.request("/login", {
      method: "POST",
      body: form({ username: "someone", password: "hunter2" }),
    });
    expect(res.status).toBe(401);
  });

  it("rate-limits repeated failures", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await app.request("/login", {
        method: "POST",
        body: form({ username: "szymon", password: "wrong" }),
      });
    }

    const res = await app.request("/login", {
      method: "POST",
      body: form({ username: "szymon", password: "hunter2" }),
    });

    expect(res.status).toBe(429);
  });
});

describe("session gating", () => {
  it("redirects an anonymous visitor to /login", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("logs out and stops accepting the cookie", async () => {
    const cookie = await login();
    expect((await app.request("/", { headers: { cookie } })).status).toBe(200);

    const out = await app.request("/logout", { method: "POST", headers: { cookie } });
    expect(out.status).toBe(302);

    expect((await app.request("/", { headers: { cookie } })).status).toBe(302);
  });
});

describe("mockup management", () => {
  it("creates a mockup from a name and shows its share url", async () => {
    const cookie = await login();

    const created = await app.request("/mockups", {
      method: "POST",
      headers: { cookie },
      body: form({ name: "Acme Landing" }),
    });
    expect(created.status).toBe(302);

    const page = await (await app.request("/", { headers: { cookie } })).text();
    expect(page).toMatch(/Acme Landing/);
    expect(page).toMatch(/acme-landing/);
    expect(page).toMatch(/https:\/\/mockups\.example\.org\/m\//);
  });

  it("rejects a name that cannot be slugified", async () => {
    const cookie = await login();
    const res = await app.request("/mockups", {
      method: "POST",
      headers: { cookie },
      body: form({ name: "!!!" }),
    });
    expect(res.status).toBe(400);
  });

  it("renames a mockup", async () => {
    const cookie = await login();
    ctx.db.insert(mockups).values({ id: "id-1", name: "Old", slug: "old" }).run();

    await app.request("/mockups/id-1/rename", {
      method: "POST",
      headers: { cookie },
      body: form({ name: "New Name" }),
    });

    const page = await (await app.request("/", { headers: { cookie } })).text();
    expect(page).toMatch(/New Name/);
    expect(page).not.toMatch(/>Old</);
  });

  it("deletes a mockup", async () => {
    const cookie = await login();
    ctx.db.insert(mockups).values({ id: "id-1", name: "Doomed", slug: "doomed" }).run();

    const res = await app.request("/mockups/id-1/delete", { method: "POST", headers: { cookie } });

    expect(res.status).toBe(302);
    expect(ctx.db.select().from(mockups).all()).toEqual([]);
  });

  it("shows the base-path warning when one is recorded", async () => {
    const cookie = await login();
    ctx.db
      .insert(mockups)
      .values({
        id: "id-1",
        name: "Broken",
        slug: "broken",
        basePathWarning: "Rebuild with --base=/m/id-1/",
      })
      .run();

    const page = await (await app.request("/", { headers: { cookie } })).text();
    expect(page).toMatch(/--base=\/m\/id-1\//);
  });

  it("requires a session for every management route", async () => {
    for (const path of ["/mockups", "/mockups/id-1/rename", "/mockups/id-1/delete"]) {
      const res = await app.request(path, { method: "POST", body: form({ name: "x" }) });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/tests/routes/panel.test.ts`
Expected: FAIL — panel modules do not exist.

- [ ] **Step 3: Write `panel/layout.tsx`**

```tsx
const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem; max-width: 60rem; }
  h1 { font-size: 1.25rem; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  code { font-family: ui-monospace, monospace; font-size: .85em; }
  form.inline { display: inline; }
  input, button { font: inherit; padding: .35rem .5rem; }
  .warn { color: #a15c00; background: #f9c74f22; padding: .4rem .6rem; border-radius: .3rem; display: block; margin-top: .35rem; font-size: .85em; }
  .muted { opacity: .65; font-size: .85em; }
  .error { color: #b3261e; }
  .flash { background: #2a9d8f22; padding: .5rem .75rem; border-radius: .3rem; margin-bottom: 1rem; }
`;

export function Layout(props: { title: string; children: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{props.title}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLE }} />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
```

- [ ] **Step 4: Write `panel/login.tsx`**

```tsx
import { Layout } from "./layout.js";

export function LoginPage(props: { error?: string }) {
  return (
    <Layout title="Sign in">
      <h1>Mockups</h1>
      {props.error ? <p class="error">{props.error}</p> : null}
      <form method="post" action="/login">
        <p>
          <label>
            Username
            <br />
            <input name="username" autocomplete="username" required />
          </label>
        </p>
        <p>
          <label>
            Password
            <br />
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
        </p>
        <button type="submit">Sign in</button>
      </form>
    </Layout>
  );
}
```

- [ ] **Step 5: Write `panel/mockups.tsx`**

```tsx
import type { MockupSummary } from "@mockups/shared";
import { mockupUrl } from "@mockups/shared";
import { Layout } from "./layout.js";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") : "never";
}

export function MockupsPage(props: {
  mockups: MockupSummary[];
  mockupsOrigin: string;
  flash?: string;
}) {
  return (
    <Layout title="Mockups">
      <header>
        <h1>Mockups</h1>
        <nav>
          <a href="/tokens">Tokens</a>{" "}
          <form class="inline" method="post" action="/logout">
            <button type="submit">Sign out</button>
          </form>
        </nav>
      </header>

      {props.flash ? <p class="flash">{props.flash}</p> : null}

      <form method="post" action="/mockups">
        <input name="name" placeholder="New mockup name" required />
        <button type="submit">Create</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Share URL</th>
            <th>Size</th>
            <th>Files</th>
            <th>Last pushed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.mockups.map((mockup) => (
            <tr key={mockup.id}>
              <td>
                {mockup.name}
                <br />
                <span class="muted">{mockup.slug}</span>
              </td>
              <td>
                <code class="share-url">{mockupUrl(props.mockupsOrigin, mockup.id)}</code>{" "}
                <button type="button" class="copy" title="Copy share URL">
                  Copy
                </button>
                {mockup.basePathWarning ? (
                  <span class="warn">{mockup.basePathWarning}</span>
                ) : null}
              </td>
              <td>{formatBytes(mockup.sizeBytes)}</td>
              <td>{mockup.fileCount || "—"}</td>
              <td>{formatDate(mockup.lastPushedAt)}</td>
              <td>
                <form class="inline" method="post" action={`/mockups/${mockup.id}/rename`}>
                  <input name="name" placeholder="Rename" required />
                  <button type="submit">Rename</button>
                </form>
                <form
                  class="inline"
                  method="post"
                  action={`/mockups/${mockup.id}/delete`}
                  onsubmit="return confirm('Delete this mockup and its files?')"
                >
                  <button type="submit">Delete</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {props.mockups.length === 0 ? (
        <p class="muted">Nothing here yet. Create one, then push to it with the CLI.</p>
      ) : null}
    </Layout>
  );
}
```

- [ ] **Step 6: Write `routes/panel.tsx`**

```ts
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, setSignedCookie } from "hono/cookie";
import { slugify } from "@mockups/shared";
import type { AppEnv } from "../app-env.js";
import type { Db } from "../db.js";
import type { ExtractLimits } from "../lib/extract.js";
import type { MockupCache } from "../lib/mockup-cache.js";
import { deleteMockup, resolveOrCreateMockup, toSummary } from "../lib/mockup-service.js";
import { safeEquals, verifyPassword } from "../lib/password.js";
import { createRateLimiter } from "../lib/rate-limit.js";
import { createSession, deleteSession } from "../lib/sessions.js";
import type { Storage } from "../lib/storage.js";
import { SESSION_COOKIE, requireSession } from "../middleware/session.js";
import { mockups } from "../schema/index.js";
import { LoginPage } from "../panel/login.js";
import { MockupsPage } from "../panel/mockups.js";

export interface PanelDeps {
  db: Db;
  storage: Storage;
  cache: MockupCache;
  limits: ExtractLimits;
  maxUploadBytes: number;
  mockupsOrigin: string;
  adminUsername: string;
  adminPasswordHash: string;
  sessionSecret: string;
  secureCookies: boolean;
}

export function createPanelRoutes(deps: PanelDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

  app.get("/login", (c) => c.html(<LoginPage />));

  app.post("/login", async (c) => {
    const clientKey =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? c.req.header("host") ?? "unknown";
    if (!loginLimiter.check(clientKey)) {
      return c.html(<LoginPage error="Too many attempts. Try again later." />, 429);
    }

    const body = await c.req.parseBody();
    const username = String(body.username ?? "");
    const password = String(body.password ?? "");

    const usernameOk = safeEquals(username, deps.adminUsername);
    const passwordOk = await verifyPassword(deps.adminPasswordHash, password);
    if (!usernameOk || !passwordOk) {
      return c.html(<LoginPage error="Those credentials are incorrect." />, 401);
    }

    loginLimiter.reset(clientKey);
    const sessionId = createSession(deps.db);
    await setSignedCookie(c, SESSION_COOKIE, sessionId, deps.sessionSecret, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: deps.secureCookies,
      maxAge: 30 * 24 * 60 * 60,
    });
    return c.redirect("/", 302);
  });

  app.post("/logout", requireSession(deps.db, deps.sessionSecret), (c) => {
    deleteSession(deps.db, c.get("sessionId"));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/login", 302);
  });

  app.use("/", requireSession(deps.db, deps.sessionSecret));
  app.use("/mockups", requireSession(deps.db, deps.sessionSecret));
  app.use("/mockups/*", requireSession(deps.db, deps.sessionSecret));

  app.get("/", (c) => {
    const rows = deps.db.select().from(mockups).all();
    return c.html(
      <MockupsPage
        mockups={rows.map(toSummary)}
        mockupsOrigin={deps.mockupsOrigin}
        flash={c.req.query("flash")}
      />,
    );
  });

  app.post("/mockups", async (c) => {
    const body = await c.req.parseBody();
    const name = String(body.name ?? "").trim();

    let slug: string;
    try {
      slug = slugify(name);
    } catch {
      return c.text("That name has no usable characters for a slug.", 400);
    }

    resolveOrCreateMockup(deps.db, { slug, name });
    return c.redirect("/", 302);
  });

  app.post("/mockups/:id/rename", async (c) => {
    const body = await c.req.parseBody();
    const name = String(body.name ?? "").trim();
    if (name === "") return c.text("A name is required.", 400);

    deps.db
      .update(mockups)
      .set({ name, updatedAt: new Date() })
      .where(eq(mockups.id, c.req.param("id")))
      .run();
    return c.redirect("/", 302);
  });

  app.post("/mockups/:id/delete", async (c) => {
    await deleteMockup(deps, c.req.param("id"));
    return c.redirect("/", 302);
  });

  return app;
}
```

Because this file contains JSX it must be named `panel.tsx`, not `panel.ts`. Rename it and
update the import in Task 16's wiring accordingly.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run server/tests/routes/panel.test.ts`
Expected: PASS, 13 tests. Update the test's import to `../../src/routes/panel.js` (the `.js`
suffix is correct even though the source is `.tsx`).

- [ ] **Step 8: Commit**

```bash
git add server/src/panel server/src/routes/panel.tsx server/tests/routes/panel.test.ts
git commit -m "feat: panel login, session gating, and mockup management"
```

---

## Task 14: Panel zip drop and token management

**Files:**
- Create: `server/src/panel/tokens.tsx`
- Modify: `server/src/routes/panel.tsx` (add upload and token routes), `server/src/panel/mockups.tsx` (add the drop zone)
- Test: `server/tests/routes/panel-upload.test.ts`

**Interfaces:**
- Consumes: `receiveUpload` (Task 12), `ingestZip` (Task 8), `createApiToken`/`listApiTokens`/`revokeApiToken` (Task 9).
- Produces:
  - `TokensPage(props: { tokens: TokenRow[]; created?: string }): JSX.Element` where `TokenRow = { id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }`
  - New routes: `POST /mockups/:id/content` (multipart zip), `GET /tokens`, `POST /tokens`, `POST /tokens/:id/revoke`

- [ ] **Step 1: Write the failing test**

`server/tests/routes/panel-upload.test.ts`:

```ts
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/lib/extract.js";
import { createMockupCache } from "../../src/lib/mockup-cache.js";
import { hashPassword } from "../../src/lib/password.js";
import { createStorage } from "../../src/lib/storage.js";
import { listApiTokens } from "../../src/lib/tokens.js";
import { createPanelRoutes, type PanelDeps } from "../../src/routes/panel.js";
import { mockups } from "../../src/schema/index.js";
import { createTestDb } from "../helpers/db.js";
import { writeZip } from "../helpers/zip.js";

let ctx: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createPanelRoutes>;
let deps: PanelDeps;
let workDir: string;
let cookie: string;

beforeEach(async () => {
  ctx = createTestDb();
  workDir = mkdtempSync(join(tmpdir(), "panel-upload-"));
  deps = {
    db: ctx.db,
    storage: createStorage(join(ctx.dir, "data")),
    cache: createMockupCache(ctx.db),
    limits: DEFAULT_EXTRACT_LIMITS,
    maxUploadBytes: 10_000_000,
    mockupsOrigin: "https://mockups.example.org",
    adminUsername: "szymon",
    adminPasswordHash: await hashPassword("hunter2"),
    sessionSecret: "test-secret",
    secureCookies: false,
  };
  app = createPanelRoutes(deps);

  const res = await app.request("/login", {
    method: "POST",
    body: new URLSearchParams({ username: "szymon", password: "hunter2" }),
  });
  cookie = res.headers.get("set-cookie")!.split(";")[0];

  ctx.db.insert(mockups).values({ id: "id-1", name: "Acme", slug: "acme" }).run();
});

afterEach(() => {
  ctx.cleanup();
  rmSync(workDir, { recursive: true, force: true });
});

async function upload(entries: Parameters<typeof writeZip>[1]) {
  const zipPath = await writeZip(workDir, entries);
  const body = new FormData();
  body.set("file", new File([readFileSync(zipPath)], "dist.zip", { type: "application/zip" }));
  return app.request("/mockups/id-1/content", { method: "POST", headers: { cookie }, body });
}

describe("panel zip drop", () => {
  it("accepts a dropped zip and serves it", async () => {
    const res = await upload([{ name: "index.html", content: "<h1>hi</h1>" }]);

    expect(res.status).toBe(302);
    expect(existsSync(join(deps.storage.mockupDir("id-1"), "index.html"))).toBe(true);
  });

  it("reports a rejected archive rather than redirecting", async () => {
    const res = await upload([{ name: "app.js", content: "1" }]);

    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/index\.html/);
  });

  it("refuses an upload without a session", async () => {
    const zipPath = await writeZip(workDir, [{ name: "index.html", content: "x" }]);
    const body = new FormData();
    body.set("file", new File([readFileSync(zipPath)], "dist.zip"));

    const res = await app.request("/mockups/id-1/content", { method: "POST", body });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("tokens page", () => {
  it("shows the token value exactly once, at creation", async () => {
    const created = await app.request("/tokens", {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "laptop" }),
    });

    expect(created.status).toBe(200);
    const page = await created.text();
    const match = /mk_[A-Za-z0-9_-]+/.exec(page);
    expect(match).not.toBeNull();

    const later = await (await app.request("/tokens", { headers: { cookie } })).text();
    expect(later).not.toContain(match![0]);
    expect(later).toMatch(/laptop/);
  });

  it("revokes a token", async () => {
    await app.request("/tokens", {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "laptop" }),
    });
    const id = listApiTokens(ctx.db)[0].id;

    const res = await app.request(`/tokens/${id}/revoke`, { method: "POST", headers: { cookie } });

    expect(res.status).toBe(302);
    expect(listApiTokens(ctx.db)[0].revokedAt).toBeInstanceOf(Date);
  });

  it("requires a session", async () => {
    const res = await app.request("/tokens");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/tests/routes/panel-upload.test.ts`
Expected: FAIL — routes not registered (404 rather than the expected statuses).

- [ ] **Step 3: Write `panel/tokens.tsx`**

```tsx
import { Layout } from "./layout.js";

export interface TokenRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function TokensPage(props: { tokens: TokenRow[]; created?: string }) {
  return (
    <Layout title="API tokens">
      <header>
        <h1>API tokens</h1>
        <a href="/">Mockups</a>
      </header>

      {props.created ? (
        <p class="flash">
          Copy this now — it is not shown again:
          <br />
          <code>{props.created}</code>
        </p>
      ) : null}

      <form method="post" action="/tokens">
        <input name="name" placeholder="Token name (e.g. laptop)" required />
        <button type="submit">Create token</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.tokens.map((token) => (
            <tr key={token.id}>
              <td>{token.name}</td>
              <td>{token.createdAt.slice(0, 10)}</td>
              <td>{token.lastUsedAt?.slice(0, 10) ?? "never"}</td>
              <td>{token.revokedAt ? "revoked" : "active"}</td>
              <td>
                {token.revokedAt ? null : (
                  <form class="inline" method="post" action={`/tokens/${token.id}/revoke`}>
                    <button type="submit">Revoke</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>
  );
}
```

- [ ] **Step 4: Add the drop zone to `panel/mockups.tsx`**

Add this cell inside the actions column of each row, before the rename form. It is the only
JavaScript in the panel: a drop target that posts the file through the same multipart route
the fallback file input uses, so the page works with JS disabled.

```tsx
<form
  class="inline"
  method="post"
  action={`/mockups/${mockup.id}/content`}
  enctype="multipart/form-data"
>
  <input type="file" name="file" accept=".zip,application/zip" required />
  <button type="submit">Upload zip</button>
</form>
```

And append this script tag inside `Layout`, just before `</body>`, to make each row's file
input accept a drop:

```tsx
<script
  dangerouslySetInnerHTML={{
    __html: `
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  const row = e.target.closest('tr');
  const input = row && row.querySelector('input[type=file]');
  if (!input || !e.dataTransfer.files.length) return;
  e.preventDefault();
  input.files = e.dataTransfer.files;
  input.form.submit();
});
document.addEventListener('click', (e) => {
  if (!e.target.classList.contains('copy')) return;
  const url = e.target.closest('td').querySelector('.share-url').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const label = e.target.textContent;
    e.target.textContent = 'Copied';
    setTimeout(() => { e.target.textContent = label; }, 1200);
  });
});
`,
  }}
/>
```

The copy button is inert without JavaScript, which is why it is a `<button type="button">`
outside any form: with JS off the URL is still there in the `<code>` to select by hand.

- [ ] **Step 5: Add the routes to `routes/panel.tsx`**

Insert these before `return app;`, and add the imports they need: `rm` from `node:fs/promises`,
`dirname` from `node:path`, plus `ingestZip`, `receiveUpload`, `IngestError`, `createApiToken`,
`listApiTokens`, `revokeApiToken`, and `TokensPage`.

```tsx
app.post("/mockups/:id/content", async (c) => {
  const id = c.req.param("id");
  const row = deps.db.select().from(mockups).where(eq(mockups.id, id)).get();
  if (!row) return c.text("Mockup not found", 404);

  let uploadPath: string | null = null;
  try {
    uploadPath = await receiveUpload(c, deps.maxUploadBytes);
    await ingestZip({ db: deps.db, storage: deps.storage, limits: deps.limits }, id, uploadPath);
    deps.cache.invalidate(id);
    return c.redirect("/?flash=Upload+complete", 302);
  } catch (error) {
    if (error instanceof IngestError) {
      return c.text(error.message, error.code === "too_large" ? 413 : 400);
    }
    throw error;
  } finally {
    if (uploadPath) await rm(dirname(uploadPath), { recursive: true, force: true });
  }
});

app.use("/tokens", requireSession(deps.db, deps.sessionSecret));
app.use("/tokens/*", requireSession(deps.db, deps.sessionSecret));

app.get("/tokens", (c) => c.html(<TokensPage tokens={tokenRows()} />));

app.post("/tokens", async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name ?? "").trim() || "unnamed";
  const { token } = createApiToken(deps.db, name);
  return c.html(<TokensPage tokens={tokenRows()} created={token} />);
});

app.post("/tokens/:id/revoke", (c) => {
  revokeApiToken(deps.db, c.req.param("id"));
  return c.redirect("/tokens", 302);
});
```

with this helper defined above the routes:

```tsx
const tokenRows = () =>
  listApiTokens(deps.db).map((token) => ({
    id: token.id,
    name: token.name,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  }));
```

Note that `POST /tokens` renders the page directly rather than redirecting: the plaintext
token exists only in that response, and a redirect would either lose it or force it into a
query string where it would land in logs and browser history.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run server/tests/routes/panel-upload.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: every test from Tasks 1–14 passes.

- [ ] **Step 8: Commit**

```bash
git add server/src/panel server/src/routes/panel.tsx server/tests/routes/panel-upload.test.ts
git commit -m "feat: panel zip drop upload and api token management"
```

---

## Task 15: Application wiring and host dispatch

**Files:**
- Create: `server/src/app.tsx`, `server/src/index.ts`, `server/scripts/hash-password.ts`
- Test: `server/tests/app.test.ts`

**Interfaces:**
- Consumes: `createServeRoutes` (Task 11), `createApiRoutes` (Task 12), `createPanelRoutes` (Task 13), `createStorage` (Task 7), `createMockupCache` (Task 11), `getEnv`/`createDb`/`runMigrations` (Task 2), `deleteExpiredSessions` (Task 9).
- Produces:
  - `interface AppOptions { db: Db; storage: Storage; cache: MockupCache; env: Env }`
  - `createApp(options: AppOptions): Hono<AppEnv>`

Host dispatch happens once, at the top of the application: the request is handed to the
mockups sub-app or the panel sub-app by `Host`, and anything else gets a bare 404. Each
sub-app still carries its own `requireHost` from Task 10 — redundant by design, so a future
refactor of this dispatcher cannot silently expose the panel on the mockups origin.

- [ ] **Step 1: Write the failing test**

`server/tests/app.test.ts`:

```ts
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { createMockupCache } from "../src/lib/mockup-cache.js";
import { hashPassword } from "../src/lib/password.js";
import { createStorage } from "../src/lib/storage.js";
import { mockups } from "../src/schema/index.js";
import { createTestDb } from "./helpers/db.js";

let ctx: ReturnType<typeof createTestDb>;
let app: ReturnType<typeof createApp>;

const PANEL = { host: "panel.example.org" };
const MOCKUPS = { host: "mockups.example.org" };

beforeEach(async () => {
  ctx = createTestDb();
  const env: Env = {
    DATA_DIR: join(ctx.dir, "data"),
    DATABASE_PATH: join(ctx.dir, "db.sqlite"),
    PORT: 3000,
    PANEL_HOST: "panel.example.org",
    MOCKUPS_HOST: "mockups.example.org",
    SESSION_SECRET: "test-secret",
    ADMIN_USERNAME: "szymon",
    ADMIN_PASSWORD_HASH: await hashPassword("hunter2"),
    MAX_UPLOAD_BYTES: 10_000_000,
    NODE_ENV: "test",
  };

  app = createApp({
    db: ctx.db,
    storage: createStorage(env.DATA_DIR),
    cache: createMockupCache(ctx.db),
    env,
  });

  ctx.db.insert(mockups).values({ id: "id-1", name: "Acme", slug: "acme" }).run();
});

afterEach(() => ctx.cleanup());

describe("host dispatch", () => {
  it("serves /healthz on either host", async () => {
    expect((await app.request("/healthz", { headers: PANEL })).status).toBe(200);
    expect((await app.request("/healthz", { headers: MOCKUPS })).status).toBe(200);
  });

  it("serves the login page on the panel host only", async () => {
    expect((await app.request("/login", { headers: PANEL })).status).toBe(200);
    expect((await app.request("/login", { headers: MOCKUPS })).status).toBe(404);
  });

  it("exposes the api on the panel host only", async () => {
    expect((await app.request("/api/mockups", { headers: PANEL })).status).toBe(401);
    expect((await app.request("/api/mockups", { headers: MOCKUPS })).status).toBe(404);
  });

  it("serves mockups on the mockups host only", async () => {
    expect((await app.request("/m/id-1", { headers: MOCKUPS })).status).toBe(301);
    expect((await app.request("/m/id-1", { headers: PANEL })).status).toBe(404);
  });

  it("404s an unrecognised host", async () => {
    const res = await app.request("/login", { headers: { host: "evil.example.org" } });
    expect(res.status).toBe(404);
  });

  it("does not leak the panel hostname in a 404 body", async () => {
    const res = await app.request("/login", { headers: MOCKUPS });
    expect(await res.text()).not.toContain("panel.example.org");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/tests/app.test.ts`
Expected: FAIL — `../src/app.js` unresolvable.

- [ ] **Step 3: Write `src/app.tsx`**

```tsx
import { Hono } from "hono";
import { logger } from "hono/logger";
import type { AppEnv } from "./app-env.js";
import type { Db } from "./db.js";
import type { Env } from "./env.js";
import { DEFAULT_EXTRACT_LIMITS } from "./lib/extract.js";
import type { MockupCache } from "./lib/mockup-cache.js";
import type { Storage } from "./lib/storage.js";
import { requireHost } from "./middleware/host.js";
import { createApiRoutes } from "./routes/api.js";
import { createPanelRoutes } from "./routes/panel.js";
import { createServeRoutes } from "./routes/serve.js";

export interface AppOptions {
  db: Db;
  storage: Storage;
  cache: MockupCache;
  env: Env;
}

export function createApp({ db, storage, cache, env }: AppOptions): Hono<AppEnv> {
  const scheme = env.NODE_ENV === "production" ? "https" : "http";
  const mockupsOrigin = `${scheme}://${env.MOCKUPS_HOST}`;
  const shared = { db, storage, cache, limits: DEFAULT_EXTRACT_LIMITS };

  const mockupsSite = new Hono<AppEnv>();
  mockupsSite.use("*", requireHost(env.MOCKUPS_HOST));
  mockupsSite.route("/", createServeRoutes({ storage, cache }));

  const panelSite = new Hono<AppEnv>();
  panelSite.use("*", requireHost(env.PANEL_HOST));
  panelSite.route(
    "/",
    createApiRoutes({ ...shared, maxUploadBytes: env.MAX_UPLOAD_BYTES, mockupsOrigin }),
  );
  panelSite.route(
    "/",
    createPanelRoutes({
      ...shared,
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
      mockupsOrigin,
      adminUsername: env.ADMIN_USERNAME,
      adminPasswordHash: env.ADMIN_PASSWORD_HASH,
      sessionSecret: env.SESSION_SECRET,
      secureCookies: env.NODE_ENV === "production",
    }),
  );

  const app = new Hono<AppEnv>();
  app.use("*", logger());
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.all("*", (c) => {
    const host = c.req.header("host")?.split(":")[0].toLowerCase();
    if (host === env.MOCKUPS_HOST.toLowerCase()) return mockupsSite.fetch(c.req.raw);
    if (host === env.PANEL_HOST.toLowerCase()) return panelSite.fetch(c.req.raw);
    return c.notFound();
  });

  return app;
}
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
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
```

- [ ] **Step 5: Write `scripts/hash-password.ts`**

```ts
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../src/lib/password.js";

const rl = createInterface({ input: process.stdin, output: process.stderr });
const password = await rl.question("Password: ");
rl.close();

if (password.length < 12) {
  console.error("Refusing to hash a password shorter than 12 characters.");
  process.exit(1);
}

process.stdout.write(`${await hashPassword(password)}\n`);
```

The hash goes to stdout and the prompt to stderr, so `npm run hash-password > hash.txt`
captures only the value. Never accept the password as an argv parameter — it would land in
the shell history and the process list.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run server/tests/app.test.ts && npm test`
Expected: PASS, 6 new tests plus every earlier test still green.

- [ ] **Step 7: Commit**

```bash
git add server/src/app.tsx server/src/index.ts server/scripts server/tests/app.test.ts
git commit -m "feat: application wiring with host-based dispatch"
```

---

## Task 16: CLI configuration, client, archive, and build

**Files:**
- Create: `cli/package.json`, `cli/tsconfig.json`
- Create: `cli/src/config.ts`, `cli/src/api-client.ts`, `cli/src/zip.ts`, `cli/src/build.ts`
- Test: `cli/tests/config.test.ts`, `cli/tests/zip.test.ts`, `cli/tests/api-client.test.ts`

**Interfaces:**
- Consumes: `MockupSummary`, `ResolveMockupResponse`, `PushResponse` (Task 1); the API contract from Task 12.
- Produces:
  - `interface ProjectConfig { slug: string; name?: string; distDir: string; buildCommand: string | null }`
  - `PROJECT_CONFIG_FILE = ".mockuprc.json"`
  - `readProjectConfig(cwd: string): ProjectConfig | null`, `writeProjectConfig(cwd: string, config: ProjectConfig): void`
  - `detectProjectDefaults(cwd: string): { buildCommand: string | null; distDir: string }`
  - `interface UserConfig { serverUrl: string; token: string }`
  - `userConfigPath(): string`, `readUserConfig(): UserConfig | null`, `writeUserConfig(config: UserConfig): void`
  - `substituteBase(template: string, base: string): string`
  - `runBuild(command: string, base: string, cwd: string): Promise<void>`
  - `zipDirectory(dir: string, outPath: string): Promise<void>`
  - `createClient(options: UserConfig): { resolve(slug, name?): Promise<ResolveMockupResponse>; push(id, zipPath): Promise<PushResponse>; list(): Promise<MockupSummary[]>; remove(id): Promise<void> }`

- [ ] **Step 1: Create the CLI package**

`cli/package.json`:

```json
{
  "name": "@mockups/cli",
  "private": true,
  "type": "module",
  "bin": { "mockup": "./dist/index.js" },
  "scripts": {
    "build": "tsc -b",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@mockups/shared": "*",
    "yazl": "^3.3.1"
  },
  "devDependencies": {
    "@types/yazl": "^2.4.5",
    "tsx": "^4.19.2"
  }
}
```

`cli/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "references": [{ "path": "../shared" }]
}
```

- [ ] **Step 2: Write the failing config test**

`cli/tests/config.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROJECT_CONFIG_FILE,
  detectProjectDefaults,
  readProjectConfig,
  writeProjectConfig,
} from "../src/config.js";
import { substituteBase } from "../src/build.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("project config", () => {
  it("returns null when no config file exists", () => {
    expect(readProjectConfig(dir)).toBeNull();
  });

  it("round-trips a config", () => {
    const config = {
      slug: "acme",
      name: "Acme",
      distDir: "dist",
      buildCommand: "npx vite build --base={base}",
    };
    writeProjectConfig(dir, config);
    expect(readProjectConfig(dir)).toEqual(config);
  });

  it("throws a readable error on malformed json", () => {
    writeFileSync(join(dir, PROJECT_CONFIG_FILE), "{ not json");
    expect(() => readProjectConfig(dir)).toThrow(/could not be parsed/i);
  });
});

describe("detectProjectDefaults", () => {
  it("detects vite from a config file", () => {
    writeFileSync(join(dir, "vite.config.ts"), "export default {}");
    expect(detectProjectDefaults(dir)).toEqual({
      buildCommand: "npx vite build --base={base}",
      distDir: "dist",
    });
  });

  it("detects vite from package.json dependencies", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^5" } }));
    expect(detectProjectDefaults(dir).buildCommand).toBe("npx vite build --base={base}");
  });

  it("returns no build command for an unrecognised project", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^14" } }));
    expect(detectProjectDefaults(dir)).toEqual({ buildCommand: null, distDir: "dist" });
  });

  it("prefers an existing build directory name", () => {
    mkdirSync(join(dir, "build"));
    expect(detectProjectDefaults(dir).distDir).toBe("build");
  });
});

describe("substituteBase", () => {
  it("replaces every occurrence of the placeholder", () => {
    expect(substituteBase("vite build --base={base} --out {base}", "/m/x/")).toBe(
      "vite build --base=/m/x/ --out /m/x/",
    );
  });

  it("leaves a template without the placeholder untouched", () => {
    expect(substituteBase("npm run build", "/m/x/")).toBe("npm run build");
  });
});
```

- [ ] **Step 3: Write `cli/src/config.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROJECT_CONFIG_FILE = ".mockuprc.json";

export interface ProjectConfig {
  slug: string;
  name?: string;
  distDir: string;
  buildCommand: string | null;
}

export interface UserConfig {
  serverUrl: string;
  token: string;
}

export function readProjectConfig(cwd: string): ProjectConfig | null {
  const path = join(cwd, PROJECT_CONFIG_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
  } catch {
    throw new Error(`${PROJECT_CONFIG_FILE} could not be parsed as JSON`);
  }
}

export function writeProjectConfig(cwd: string, config: ProjectConfig): void {
  writeFileSync(join(cwd, PROJECT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

const VITE_CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mjs"];
const VITE_BUILD = "npx vite build --base={base}";

export function detectProjectDefaults(cwd: string): {
  buildCommand: string | null;
  distDir: string;
} {
  const distDir = existsSync(join(cwd, "build")) && !existsSync(join(cwd, "dist"))
    ? "build"
    : "dist";

  if (VITE_CONFIGS.some((name) => existsSync(join(cwd, name)))) {
    return { buildCommand: VITE_BUILD, distDir };
  }

  const packagePath = join(cwd, "package.json");
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.devDependencies?.vite || pkg.dependencies?.vite) {
        return { buildCommand: VITE_BUILD, distDir };
      }
    } catch {
      // A malformed package.json is not this tool's problem; fall through.
    }
  }

  return { buildCommand: null, distDir };
}

export function userConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "mockup", "config.json");
}

export function readUserConfig(): UserConfig | null {
  const fromEnv = process.env.MOCKUP_TOKEN;
  const serverFromEnv = process.env.MOCKUP_SERVER;
  if (fromEnv && serverFromEnv) return { token: fromEnv, serverUrl: serverFromEnv };

  const path = userConfigPath();
  if (!existsSync(path)) return null;

  const stored = JSON.parse(readFileSync(path, "utf8")) as UserConfig;
  return {
    serverUrl: serverFromEnv ?? stored.serverUrl,
    token: fromEnv ?? stored.token,
  };
}

export function writeUserConfig(config: UserConfig): void {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
```

- [ ] **Step 4: Write `cli/src/build.ts`**

```ts
import { spawn } from "node:child_process";

export function substituteBase(template: string, base: string): string {
  return template.replaceAll("{base}", base);
}

export function runBuild(command: string, base: string, cwd: string): Promise<void> {
  const resolved = substituteBase(command, base);

  return new Promise((resolve, reject) => {
    const child = spawn(resolved, { cwd, shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build command exited with code ${code}: ${resolved}`));
    });
  });
}
```

- [ ] **Step 5: Write the failing zip test and `cli/src/zip.ts`**

`cli/tests/zip.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { zipDirectory } from "../src/zip.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-zip-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entryNames(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      zip.on("entry", (entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve(names.sort()));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

describe("zipDirectory", () => {
  it("archives files with paths relative to the directory root", async () => {
    const source = join(dir, "dist");
    mkdirSync(join(source, "assets"), { recursive: true });
    writeFileSync(join(source, "index.html"), "<html></html>");
    writeFileSync(join(source, "assets", "app.js"), "1");

    const out = join(dir, "out.zip");
    await zipDirectory(source, out);

    expect(await entryNames(out)).toEqual(["assets/app.js", "index.html"]);
  });

  it("rejects a directory that does not exist", async () => {
    await expect(zipDirectory(join(dir, "missing"), join(dir, "o.zip"))).rejects.toThrow(
      /missing/,
    );
  });

  it("rejects an empty directory rather than pushing nothing", async () => {
    mkdirSync(join(dir, "empty"));
    await expect(zipDirectory(join(dir, "empty"), join(dir, "o.zip"))).rejects.toThrow(
      /no files/i,
    );
  });
});
```

`cli/src/zip.ts`:

```ts
import { createWriteStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ZipFile } from "yazl";

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export async function zipDirectory(dir: string, outPath: string): Promise<void> {
  if (!existsSync(dir)) throw new Error(`Directory not found: ${dir}`);

  const zip = new ZipFile();
  let count = 0;

  for await (const file of walk(dir)) {
    zip.addFile(file, relative(dir, file).split(sep).join("/"));
    count += 1;
  }

  if (count === 0) throw new Error(`Directory contains no files: ${dir}`);

  zip.end();

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outPath);
    zip.outputStream.pipe(out);
    out.on("close", resolve);
    out.on("error", reject);
  });
}
```

- [ ] **Step 6: Write the failing client test and `cli/src/api-client.ts`**

`cli/tests/api-client.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/api-client.js";

let dir: string;
const client = () => createClient({ serverUrl: "https://panel.example.org", token: "mk_test" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-client-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("createClient", () => {
  it("sends the bearer token and the slug on resolve", async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ mockup: { id: "id-1" }, basePath: "/m/id-1/", url: "u" }), {
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await client().resolve("acme", "Acme");

    expect(result.basePath).toBe("/m/id-1/");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://panel.example.org/api/mockups/resolve");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer mk_test");
    expect(JSON.parse(init.body as string)).toEqual({ slug: "acme", name: "Acme" });
  });

  it("surfaces the server error message", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: "slug must be lowercase" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(client().resolve("Bad Slug")).rejects.toThrow(/slug must be lowercase/);
  });

  it("falls back to the status code when the body is not json", async () => {
    stubFetch(new Response("gateway timeout", { status: 504 }));
    await expect(client().list()).rejects.toThrow(/504/);
  });

  it("streams a zip on push with the right content type", async () => {
    const zipPath = join(dir, "a.zip");
    writeFileSync(zipPath, "PK");
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ mockup: {}, url: "u", warning: null }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await client().push("id-1", zipPath);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://panel.example.org/api/mockups/id-1/content");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/zip");
    expect(init.method).toBe("POST");
  });

  it("trims a trailing slash from the server url", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ mockups: [] })));
    await createClient({ serverUrl: "https://panel.example.org/", token: "t" }).list();
    expect(fetchMock.mock.calls[0][0]).toBe("https://panel.example.org/api/mockups");
  });
});
```

`cli/src/api-client.ts`:

```ts
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { MockupSummary, PushResponse, ResolveMockupResponse } from "@mockups/shared";
import type { UserConfig } from "./config.js";

async function unwrap<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  let message = `Request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // Body was not JSON; the status-code message stands.
  }
  throw new Error(message);
}

export function createClient({ serverUrl, token }: UserConfig) {
  const base = serverUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${token}` };

  return {
    async resolve(slug: string, name?: string): Promise<ResolveMockupResponse> {
      const response = await fetch(`${base}/api/mockups/resolve`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(name === undefined ? { slug } : { slug, name }),
      });
      return unwrap<ResolveMockupResponse>(response);
    },

    async push(id: string, zipPath: string): Promise<PushResponse> {
      const size = statSync(zipPath).size;
      const response = await fetch(`${base}/api/mockups/${id}/content`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/zip", "content-length": String(size) },
        body: Readable.toWeb(createReadStream(zipPath)) as ReadableStream,
        duplex: "half",
      } as RequestInit);
      return unwrap<PushResponse>(response);
    },

    async list(): Promise<MockupSummary[]> {
      const response = await fetch(`${base}/api/mockups`, { headers: auth });
      const body = await unwrap<{ mockups: MockupSummary[] }>(response);
      return body.mockups;
    },

    async remove(id: string): Promise<void> {
      const response = await fetch(`${base}/api/mockups/${id}`, { method: "DELETE", headers: auth });
      if (!response.ok) await unwrap(response);
    },
  };
}
```

- [ ] **Step 7: Run the CLI tests**

Run: `npm install && npx vitest run cli`
Expected: PASS, 17 tests.

- [ ] **Step 8: Commit**

```bash
git add cli package-lock.json
git commit -m "feat: cli configuration, api client, archiver, and build runner"
```

---

## Task 17: CLI commands

**Files:**
- Create: `cli/src/commands/push.ts`, `cli/src/commands/init.ts`, `cli/src/commands/login.ts`, `cli/src/commands/simple.ts`, `cli/src/index.ts`
- Test: `cli/tests/push.test.ts`

**Interfaces:**
- Consumes: everything from Task 16.
- Produces:
  - `interface PushDeps { client: Pick<Client, "resolve" | "push">; runBuild: typeof runBuild; zipDirectory: typeof zipDirectory; log: (message: string) => void }`
  - `pushProject(deps: PushDeps, options: { cwd: string; config: ProjectConfig; noBuild: boolean }): Promise<PushResponse>`
  - `initProject(cwd: string, slug?: string): ProjectConfig`
  - `type Client = ReturnType<typeof createClient>`

Commands: `mockup login`, `mockup init [slug]`, `mockup push [--no-build]`, `mockup ls`, `mockup rm <slug>`, `mockup open`.

`pushProject` takes its collaborators as parameters so the orchestration — resolve, then
build with the returned base, then zip, then upload, in that order — is testable without a
server or a real build.

- [ ] **Step 1: Write the failing test**

`cli/tests/push.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushProject } from "../src/commands/push.js";
import type { ProjectConfig } from "../src/config.js";

let cwd: string;
let logs: string[];

const CONFIG: ProjectConfig = {
  slug: "acme",
  name: "Acme",
  distDir: "dist",
  buildCommand: "npx vite build --base={base}",
};

function deps(overrides: Partial<Parameters<typeof pushProject>[0]> = {}) {
  return {
    client: {
      resolve: vi.fn().mockResolvedValue({
        mockup: { id: "id-1", slug: "acme" },
        basePath: "/m/id-1/",
        url: "https://mockups.example.org/m/id-1",
      }),
      push: vi.fn().mockResolvedValue({
        mockup: { id: "id-1", fileCount: 3 },
        url: "https://mockups.example.org/m/id-1",
        warning: null,
      }),
    },
    runBuild: vi.fn().mockResolvedValue(undefined),
    zipDirectory: vi.fn().mockImplementation(async (_dir: string, out: string) => {
      writeFileSync(out, "PK");
    }),
    log: (message: string) => logs.push(message),
    ...overrides,
  } as Parameters<typeof pushProject>[0];
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cli-push-"));
  mkdirSync(join(cwd, "dist"));
  logs = [];
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("pushProject", () => {
  it("resolves first, then builds with the returned base path", async () => {
    const d = deps();

    await pushProject(d, { cwd, config: CONFIG, noBuild: false });

    expect(d.client.resolve).toHaveBeenCalledWith("acme", "Acme");
    expect(d.runBuild).toHaveBeenCalledWith("npx vite build --base={base}", "/m/id-1/", cwd);

    const resolveOrder = (d.client.resolve as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const buildOrder = (d.runBuild as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(resolveOrder).toBeLessThan(buildOrder);
  });

  it("zips the configured dist directory and uploads it", async () => {
    const d = deps();

    await pushProject(d, { cwd, config: CONFIG, noBuild: false });

    expect(d.zipDirectory).toHaveBeenCalledWith(join(cwd, "dist"), expect.stringMatching(/\.zip$/));
    expect(d.client.push).toHaveBeenCalledWith("id-1", expect.stringMatching(/\.zip$/));
  });

  it("skips the build when noBuild is set", async () => {
    const d = deps();

    await pushProject(d, { cwd, config: CONFIG, noBuild: true });

    expect(d.runBuild).not.toHaveBeenCalled();
    expect(d.client.push).toHaveBeenCalled();
  });

  it("skips the build when the project has no build command", async () => {
    const d = deps();

    await pushProject(d, { cwd, config: { ...CONFIG, buildCommand: null }, noBuild: false });

    expect(d.runBuild).not.toHaveBeenCalled();
  });

  it("prints the share url", async () => {
    await pushProject(deps(), { cwd, config: CONFIG, noBuild: false });
    expect(logs.join("\n")).toContain("https://mockups.example.org/m/id-1");
  });

  it("prints a warning returned by the server", async () => {
    const d = deps({
      client: {
        resolve: vi.fn().mockResolvedValue({
          mockup: { id: "id-1" },
          basePath: "/m/id-1/",
          url: "u",
        }),
        push: vi.fn().mockResolvedValue({
          mockup: {},
          url: "u",
          warning: "Rebuild with --base=/m/id-1/",
        }),
      },
    });

    await pushProject(d, { cwd, config: CONFIG, noBuild: false });

    expect(logs.join("\n")).toContain("Rebuild with --base=/m/id-1/");
  });

  it("does not upload when the build fails", async () => {
    const d = deps({ runBuild: vi.fn().mockRejectedValue(new Error("build blew up")) });

    await expect(pushProject(d, { cwd, config: CONFIG, noBuild: false })).rejects.toThrow(
      /build blew up/,
    );
    expect(d.client.push).not.toHaveBeenCalled();
  });

  it("fails with a clear message when the dist directory is missing", async () => {
    rmSync(join(cwd, "dist"), { recursive: true });

    await expect(
      pushProject(deps(), { cwd, config: CONFIG, noBuild: true }),
    ).rejects.toThrow(/dist/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run cli/tests/push.test.ts`
Expected: FAIL — `../src/commands/push.js` unresolvable.

- [ ] **Step 3: Write `cli/src/commands/push.ts`**

```ts
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushResponse } from "@mockups/shared";
import type { createClient } from "../api-client.js";
import type { runBuild } from "../build.js";
import type { ProjectConfig } from "../config.js";
import type { zipDirectory } from "../zip.js";

export type Client = ReturnType<typeof createClient>;

export interface PushDeps {
  client: Pick<Client, "resolve" | "push">;
  runBuild: typeof runBuild;
  zipDirectory: typeof zipDirectory;
  log: (message: string) => void;
}

export interface PushOptions {
  cwd: string;
  config: ProjectConfig;
  noBuild: boolean;
}

export async function pushProject(deps: PushDeps, options: PushOptions): Promise<PushResponse> {
  const { cwd, config, noBuild } = options;

  // Resolve first: the build needs the uuid to bake the correct base path in.
  const resolved = await deps.client.resolve(config.slug, config.name);
  deps.log(`Mockup ${config.slug} -> ${resolved.mockup.id}`);

  if (!noBuild && config.buildCommand) {
    deps.log(`Building with base ${resolved.basePath}`);
    await deps.runBuild(config.buildCommand, resolved.basePath, cwd);
  }

  const distPath = join(cwd, config.distDir);
  if (!existsSync(distPath)) {
    throw new Error(`Dist directory not found: ${distPath}`);
  }

  const stagingDir = await mkdtemp(join(tmpdir(), "mockup-push-"));
  const zipPath = join(stagingDir, "dist.zip");

  try {
    await deps.zipDirectory(distPath, zipPath);
    const result = await deps.client.push(resolved.mockup.id, zipPath);

    deps.log(`Pushed. ${result.url}`);
    if (result.warning) deps.log(`Warning: ${result.warning}`);
    return result;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Write `cli/src/commands/init.ts`**

```ts
import { basename } from "node:path";
import { slugify } from "@mockups/shared";
import {
  PROJECT_CONFIG_FILE,
  detectProjectDefaults,
  readProjectConfig,
  writeProjectConfig,
  type ProjectConfig,
} from "../config.js";

export function initProject(cwd: string, slug?: string): ProjectConfig {
  const existing = readProjectConfig(cwd);
  if (existing) throw new Error(`${PROJECT_CONFIG_FILE} already exists`);

  const name = basename(cwd);
  const defaults = detectProjectDefaults(cwd);
  const config: ProjectConfig = {
    slug: slug ?? slugify(name),
    name,
    distDir: defaults.distDir,
    buildCommand: defaults.buildCommand,
  };

  writeProjectConfig(cwd, config);
  return config;
}
```

- [ ] **Step 5: Write `cli/src/commands/login.ts` and `cli/src/commands/simple.ts`**

`login.ts`:

```ts
import { createInterface } from "node:readline/promises";
import { userConfigPath, writeUserConfig } from "../config.js";

export async function login(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const serverUrl = (await rl.question("Panel URL (e.g. https://panel-mockups.example.com): ")).trim();
  const token = (await rl.question("API token: ")).trim();
  rl.close();

  if (!serverUrl || !token) throw new Error("Both a panel URL and a token are required");

  writeUserConfig({ serverUrl, token });
  console.log(`Saved to ${userConfigPath()} (mode 0600)`);
}
```

`simple.ts`:

```ts
import { execFile } from "node:child_process";
import type { createClient } from "../api-client.js";

type Client = ReturnType<typeof createClient>;

export async function list(client: Client): Promise<void> {
  const mockups = await client.list();
  if (mockups.length === 0) {
    console.log("No mockups yet.");
    return;
  }

  for (const mockup of mockups) {
    const pushed = mockup.lastPushedAt?.slice(0, 10) ?? "never";
    console.log(`${mockup.slug.padEnd(24)} ${mockup.id}  pushed ${pushed}`);
    if (mockup.basePathWarning) console.log(`  ! ${mockup.basePathWarning}`);
  }
}

export async function remove(client: Client, slug: string): Promise<void> {
  const mockup = (await client.list()).find((candidate) => candidate.slug === slug);
  if (!mockup) throw new Error(`No mockup with slug "${slug}"`);

  await client.remove(mockup.id);
  console.log(`Deleted ${slug}`);
}

export function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(command, [url], (error) => {
    if (error) console.log(url);
  });
}
```

- [ ] **Step 6: Write `cli/src/index.ts`**

```ts
#!/usr/bin/env node
import { createClient } from "./api-client.js";
import { runBuild } from "./build.js";
import { PROJECT_CONFIG_FILE, readProjectConfig, readUserConfig } from "./config.js";
import { initProject } from "./commands/init.js";
import { login } from "./commands/login.js";
import { pushProject } from "./commands/push.js";
import { list, openInBrowser, remove } from "./commands/simple.js";
import { zipDirectory } from "./zip.js";

const USAGE = `mockup <command>

  login              Store the panel URL and an API token
  init [slug]        Create ${PROJECT_CONFIG_FILE} in the current directory
  push [--no-build]  Build, archive, and upload the dist directory
  ls                 List mockups
  rm <slug>          Delete a mockup and its files
  open               Open this project's mockup in a browser
`;

function requireClient() {
  const config = readUserConfig();
  if (!config) throw new Error('Not configured. Run "mockup login" first.');
  return createClient(config);
}

function requireProject(cwd: string) {
  const config = readProjectConfig(cwd);
  if (!config) throw new Error(`No ${PROJECT_CONFIG_FILE} here. Run "mockup init" first.`);
  return config;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const cwd = process.cwd();

  switch (command) {
    case "login":
      await login();
      return;

    case "init": {
      const config = initProject(cwd, args[0]);
      console.log(`Wrote ${PROJECT_CONFIG_FILE} for "${config.slug}"`);
      if (!config.buildCommand) {
        console.log("No Vite build detected — push will upload the dist directory as-is.");
      }
      return;
    }

    case "push":
      await pushProject(
        { client: requireClient(), runBuild, zipDirectory, log: (m) => console.log(m) },
        { cwd, config: requireProject(cwd), noBuild: args.includes("--no-build") },
      );
      return;

    case "ls":
      await list(requireClient());
      return;

    case "rm": {
      if (!args[0]) throw new Error("Usage: mockup rm <slug>");
      await remove(requireClient(), args[0]);
      return;
    }

    case "open": {
      const project = requireProject(cwd);
      const client = requireClient();
      const mockup = (await client.list()).find((m) => m.slug === project.slug);
      if (!mockup) throw new Error(`"${project.slug}" does not exist yet — run "mockup push"`);
      const { url } = await client.resolve(project.slug);
      openInBrowser(url);
      return;
    }

    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run cli`
Expected: PASS, 25 tests.

- [ ] **Step 8: Commit**

```bash
git add cli/src
git commit -m "feat: cli commands for login, init, push, ls, rm, and open"
```

---

## Task 18: Deployment

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `Caddyfile`, `.env.example`, `README.md`
- Modify: `server/package.json` (move `tsx` into `dependencies`)

**Interfaces:**
- Consumes: `server/src/index.ts` (Task 15), `getEnv` (Task 2).
- Produces: a running stack on `docker compose up -d`.

The server runs under `tsx` in production rather than compiled output. The reason is
`@mockups/shared`: it is consumed as TypeScript source by both packages, and making a
compiled build resolve correctly at runtime would mean a dual `exports` map and a build
ordering constraint, in exchange for saving a few hundred milliseconds of startup on a
long-lived process. Types are still checked — `npm run typecheck` runs in the image build
and fails it.

- [ ] **Step 1: Move `tsx` to a runtime dependency**

In `server/package.json`, move `"tsx"` from `devDependencies` to `dependencies` and set:

```json
"scripts": {
  "start": "tsx src/index.ts"
}
```

Otherwise `npm ci --omit=dev` in the image strips the thing that runs the server.

- [ ] **Step 2: Write the `Dockerfile`**

```dockerfile
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY cli/package.json cli/
RUN npm ci

FROM deps AS check
COPY . .
RUN npm run typecheck && npm test

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY cli/package.json cli/
RUN npm ci --omit=dev --workspace @mockups/server --include-workspace-root
COPY shared/src shared/src
COPY server/src server/src
COPY server/drizzle server/drizzle
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start", "--workspace", "@mockups/server"]
```

The `check` stage runs the suite during the image build, so a broken push cannot become a
running container. It is a separate stage, so `--target runtime` skips it when you need a
fast rebuild.

`.dockerignore`:

```
node_modules
*/node_modules
data
.git
docs
*.tsbuildinfo
.env
```

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      DATA_DIR: /data
      PORT: "3000"
      NODE_ENV: production
    volumes:
      - ./data:/data
    expose:
      - "3000"

  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on:
      - app
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

- [ ] **Step 4: Write the `Caddyfile`**

```caddyfile
{
	email you@example.com
}

mockups.example.com, panel-mockups.example.com {
	encode zstd gzip

	request_body {
		max_size 250MB
	}

	reverse_proxy app:3000 {
		transport http {
			read_timeout 600s
			write_timeout 600s
		}
	}
}
```

Both hostnames proxy to the same container; the application splits them by `Host`. The body
cap sits above `MAX_UPLOAD_BYTES` so an oversized push is refused by the application with a
JSON error rather than cut off at the edge, and the timeouts are raised because a 200MB
upload over a slow link outlives Caddy's defaults.

- [ ] **Step 5: Write `.env.example`**

```bash
# Hostnames. The panel MUST NOT share an origin with the mockups.
PANEL_HOST=panel-mockups.example.com
MOCKUPS_HOST=mockups.example.com

# Panel login. Generate the hash with: npm run hash-password -w @mockups/server
ADMIN_USERNAME=szymon
ADMIN_PASSWORD_HASH=

# Signs the session cookie. Generate with: openssl rand -base64 48
SESSION_SECRET=

# 200MB
MAX_UPLOAD_BYTES=209715200
```

- [ ] **Step 6: Write `README.md`**

Cover, in this order: what it is and the URL shape; first-time server setup (`cp .env.example
.env`, generate the hash and secret, `docker compose up -d --build`, point both DNS records
at the host); creating a token in the panel; CLI setup (`npm i -g ./cli` or `npm link`, then
`mockup login`); the per-project flow (`mockup init`, `mockup push`); what the base-path
warning means and how to fix it; and the backup procedure —

```bash
sqlite3 /path/to/data/db.sqlite ".backup '/path/to/data/backup.sqlite'" && tar czf mockups-backup.tar.gz -C /path/to data
```

Also state plainly that `/m/<uuid>` is unlisted, not access-controlled: anyone with the link
can view it, and it is not protected against a link forwarded onward.

- [ ] **Step 7: Verify the whole stack**

```bash
npm test
npm run typecheck
docker compose build
```

Then, with a `.env` filled in, `docker compose up -d` and check:

- `curl -H 'Host: panel-mockups.example.com' http://localhost/login` returns the login form.
- `curl -H 'Host: mockups.example.com' http://localhost/login` returns 404.
- Signing in, creating a mockup, and pushing to it from a real Vite project produces a working
  share URL whose assets load from `/m/<uuid>/`.

Report actual command output for each. Do not mark this task done on the basis of the code
looking right.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml Caddyfile .env.example README.md server/package.json
git commit -m "feat: docker compose deployment with caddy and documentation"
```

---

## Definition of done

- `npm test` passes with no skipped tests.
- `npm run typecheck` is clean.
- A hostile archive (traversal, symlink, bomb) is rejected with the previous build still
  serving.
- The panel is unreachable on the mockups hostname.
- A real Vite project goes from `mockup init` to a working share URL in two commands.
