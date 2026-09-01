# Mockup Hosting — Design

**Date:** 2026-09-01
**Status:** Approved for planning

## Purpose

Host static frontend mockups (a Vite `dist` directory) at unguessable URLs so they
can be shared with clients without being discoverable. Mockups are published from
the command line as part of the build, and managed from a password-protected panel.

A mockup lives at:

```
https://mockups.example.com/m/<uuid>
```

The panel lives on a separate hostname (see [Security model](#security-model)):

```
https://panel.mockups.example.com
```

## Success criteria

- `mockup push` in a Vite project builds, uploads, and prints a working share URL.
- A mockup URL is not discoverable without the uuid; no index, no listing, no
  enumerable ids.
- Pushing to an existing mockup replaces it with no window in which the mockup
  serves a partial build.
- The panel can create, rename, upload to, and delete mockups, and manage API
  tokens.
- The whole system runs from one `docker compose up` on a single server.

## Non-goals

Deliberately excluded. Each is cheap to add later because the application is in
the serving path.

- Versioning or rollback — pushes replace destructively.
- View counts, analytics, last-viewed timestamps.
- Per-mockup passwords or any viewer-side authentication.
- Mockup expiry or scheduled deletion.
- Multi-user accounts, roles, or invitations.

## Decisions and rationale

### Base paths: the CLI builds with `--base`

A built SPA bakes its asset URLs in at build time. A default Vite build emits
root-absolute references (`/assets/index-abc.js`) in both `index.html` and inside
the JS chunks — dynamic imports, `new URL(...)`, CSS `url()`. Served from
`/m/<uuid>/`, all of them 404.

**Decision:** the CLI owns the build. It resolves the mockup first, receives its
uuid, and builds with `--base=/m/<uuid>/`. The build's assumption about where it
lives is therefore correct rather than patched, and client-side deep links
(`/m/<uuid>/settings`) work.

Alternatives rejected:

- `base: './'` (relative) — correct for chunk resolution at any depth, but breaks
  client-side deep links, and requires per-project discipline.
- Ingest-time rewriting of built bundles — misses template-constructed paths,
  corrupts string literals that merely look like paths, breaks source maps.
- Subdomain per mockup (`<uuid>.mockups.example.com`) — structurally correct with
  no build changes, but requires wildcard DNS and changes the requested URL shape.

Because a `--base` flag does not always reach Vite through a project's own build
script (`vue-tsc && vite build`, framework wrappers), the CLI stores a **build
command template** per project containing a `{base}` placeholder, defaulting to
`npx vite build --base={base}`.

Anything not built by the CLI — the panel's zip drop, or `--no-build` on a `dist`
built previously — is covered by a server-side detector rather than a guarantee.
See [Base-path detector](#base-path-detector).

### Overwrite: destructive replace, atomic swap

Pushing to an existing mockup discards what was there. No version history, no
rollback, no versions table.

To avoid serving a half-written build, a push unpacks into a staging directory and
is moved into place with `rename()` — atomic within a filesystem, so the swap is a
single instant.

### Static serving: by the application, not by Caddy

Caddy could serve `/m/<uuid>/*` straight off disk with no database lookup, and
would provide ETags, Range support and compression for free.

**Decision:** the application serves the files. This keeps view counts, expiry, and
per-mockup passwords available as later additions without restructuring, at the
cost of implementing caching and Range handling in the app.

### Stack: Hono + better-sqlite3 + Drizzle

TypeScript end to end, matching the existing `vibekcal` service. The decisive
argument is the CLI: it is the primary interface to this system, and sharing the
API types and ingest contract with the server through a common package prevents
drift between what the CLI sends and what the server expects.

Alternatives rejected: Laravel + Nuxt (mirrors `salustack/schedules`, but multiple
containers and a large framework for a service that unzips files, with the CLI
outside it); Go (best operational story — single static binary CLI needing no Node
— but a different language from the panel UI).

## Security model

Mockup JavaScript executes on the origin that serves it. A cookie scoped to
`Path=/panel` cannot be read by `document.cookie` from `/m/<uuid>/`, but nothing
prevents a mockup's script from issuing `fetch('/panel/api/...')`: the browser
attaches the session cookie because the request is same-origin, `SameSite` does not
apply within an origin, and a CSRF token is readable by same-origin JavaScript.

**Decision:** the panel is served from its own hostname, `panel.mockups.example.com`,
so the session cookie is scoped to an origin no mockup can reach. Same container,
same application; a host-check middleware enforces the split in the application
rather than relying only on Caddy. Panel routes return 404 on the mockups
hostname, and mockup routes return 404 on the panel hostname.

Shareable URLs are unaffected: `https://mockups.example.com/m/<uuid>`.

Additional measures:

- Admin credentials from environment: `ADMIN_USERNAME` plus an argon2id hash in
  `ADMIN_PASSWORD_HASH`. No plaintext password in any file.
- Session cookie is host-only (no `Domain` attribute), `HttpOnly`, `Secure`,
  `SameSite=Lax`. The cookie carries a session id, not a stateless token, so a
  login can be revoked.
- Login is rate-limited.
- API tokens are stored hashed, displayed once at creation, and revocable.
- Mockup responses carry `X-Content-Type-Options: nosniff` and an explicit
  `Content-Type` from a MIME map — never sniffed.

## Architecture

One repository at `~/dev/personal/mockups`, four packages plus infrastructure.

| Package | Responsibility |
|---|---|
| `server/` | Hono application: session auth, panel UI, panel API, ingest endpoint, static serving |
| `panel/` | Admin UI, rendered server-side with Hono JSX plus minimal vanilla JS |
| `cli/` | `mockup` binary: resolve, build, zip, upload |
| `shared/` | API request/response types and the ingest contract, imported by `server/` and `cli/` |

The panel is deliberately not a separate SPA. It is roughly five screens; a second
build pipeline would cost more than it returns. The only JavaScript it needs is the
drag-and-drop zip drop and copy-to-clipboard buttons.

Caddy runs as a second container for TLS termination and proxying.

## Data model

SQLite via Drizzle. Three tables.

### `mockups`

| Column | Notes |
|---|---|
| `id` | uuid v4, primary key. This value **is** the URL segment. |
| `name` | Human-readable label shown in the panel |
| `slug` | Unique. What the CLI resolves against. |
| `created_at`, `updated_at` | |
| `last_pushed_at` | Null until first push |
| `size_bytes`, `file_count` | Computed at ingest, shown in the panel |
| `base_path_warning` | Nullable text. The detector's finding, rendered as a badge in the panel. |

### `api_tokens`

| Column | Notes |
|---|---|
| `id` | |
| `name` | So multiple machines are distinguishable |
| `token_hash` | Plaintext shown once at creation and never stored |
| `created_at`, `last_used_at`, `revoked_at` | |

### `sessions`

| Column | Notes |
|---|---|
| `id` | Referenced by the signed cookie |
| `created_at`, `expires_at` | |

No pushes or versions table: destructive replace leaves no history to model.

## Filesystem layout

```
/data/db.sqlite            SQLite database (WAL)
/data/mockups/<uuid>/      Live files for one mockup
/data/tmp/<uuid>-<nonce>/  Staging during a push
```

Staging and live directories share a filesystem so the swap is a `rename()`.

## Flows

### CLI push

A project carries `.mockuprc.json` (slug, dist directory, build command template).
Credentials live in `~/.config/mockup/config.json` or the `MOCKUP_TOKEN`
environment variable, alongside the server URL.

`mockup push`:

1. Resolve or create the mockup by slug over the API; receive its uuid.
2. Run the build command with `{base}` substituted as `/m/<uuid>/`.
   Skipped when `--no-build` is passed.
3. Zip the dist directory.
4. Stream the archive to the ingest endpoint with a bearer token.
5. Print the share URL and any warnings the server returned.

Other commands: `mockup init`, `mockup ls`, `mockup rm <slug>`, `mockup open`.

Vite is the first-class path. Other toolchains are supported through `--no-build`,
which pushes an existing directory and relies on the detector to report whether the
paths will work.

### Ingest

The ingest routine is shared: the CLI endpoint (bearer token) and the panel's zip
drop (session cookie) differ only in authentication.

Validation, in order:

1. **Entry names.** Reject absolute paths, `..` segments, backslashes, and null
   bytes. Reject symlinks, hardlinks, and any entry that is not a regular file or
   directory. After normalization, verify the resolved path remains inside the
   staging directory.
2. **Size limits, enforced while streaming.** Compressed size (200MB default),
   total uncompressed size, file count, and compression ratio. The ratio check must
   happen during extraction; checked afterwards, a zip bomb has already landed.
3. **Wrapper directory.** If the archive is a single top-level directory containing
   `index.html`, strip it. Zipping a `dist` folder normally produces
   `dist/index.html`, and handling this silently removes a whole class of confusing
   404s.
4. **Require `index.html`** at the resulting root; otherwise reject with a message
   naming the problem.
5. **Base-path detector** (below); records a warning, never rejects.

Only after all validation: `rename()` the previous directory aside, `rename()` the
staging directory into place, delete the old one, then update the row.

### Base-path detector

Scans `.html`, `.js`, and `.css` for root-absolute references that are neither
protocol-relative (`//`) nor already correctly prefixed with `/m/<uuid>/`. On a
finding, stores a warning naming the exact remedy, e.g.:

> This build references `/assets/…` and will 404 at `/m/<uuid>/`. Rebuild with
> `--base=/m/<uuid>/`.

Advisory only. A mockup that trips the detector is still served.

### Serving

- `/m/<uuid>` redirects to `/m/<uuid>/`.
- Below that, the uuid resolves through an in-memory cache invalidated on push and
  delete, keeping the database out of the path for every asset request.
- Resolved paths are verified to remain within the mockup's directory.
- Unknown uuid returns 404.

**SPA fallback is conditional.** A missing path falls back to that mockup's
`index.html` only when the request accepts `text/html` and does not look like an
asset request. An unconditional fallback returns HTML for a missing `.js`, which
surfaces as `Unexpected token '<'` — a bad failure mode inside somebody else's
bundle.

**Cache-Control is split by file kind.** Content-hashed assets receive
`public, max-age=31536000, immutable`; `index.html` receives `no-cache` with an
ETag. Reversed, a client sees a stale mockup after being told to refresh.

Range requests are supported for large assets and media.

### Panel

Behind login on `panel.mockups.example.com`:

- List: name, slug, share URL with copy button, size, file count, last pushed,
  warning badge where present.
- Create, rename, delete. Delete removes the row and the directory.
- Zip drop upload to an existing mockup.
- Token management: create (value shown once) and revoke.

## Deployment

`docker compose` with two services.

- **`caddy`** — ports 80 and 443, `caddy_data` volume so certificates survive
  restarts. Both hostnames proxy to `app`. `request_body max_size` must exceed the
  upload cap and proxy timeouts must be loosened, or a large push fails at the edge
  with a confusing 413.
- **`app`** — built from the repository Dockerfile, `./data:/data`,
  `restart: unless-stopped`, `/healthz` endpoint. Drizzle migrations run on boot.

Configuration by environment: `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`,
`SESSION_SECRET`, `PANEL_HOST`, `MOCKUPS_HOST`, `DATA_DIR`, `MAX_UPLOAD_BYTES`.
An `npm run hash-password` helper generates the argon2id hash.

**Backups.** `/data` holds everything: the SQLite file and the mockup directories.
With WAL enabled the database cannot be safely copied mid-write; the documented
procedure is `sqlite3 /data/db.sqlite ".backup /data/backup.sqlite"` followed by
tarring `/data`. No tooling is built for this.

## Testing strategy

Vitest. The security-critical paths are written test-first: unzipping a
user-supplied archive is the one place in this system where a bug is a compromise
rather than a broken mockup.

**Unit tests** over pure functions:

- Zip entry path validation against a table of hostile names: `../x`,
  `/etc/passwd`, `a/../../b`, backslash separators, null bytes, symlink and
  non-regular entries.
- The compression-ratio guard.
- The base-path detector.
- The Cache-Control classifier.
- The SPA-fallback predicate.

**Integration tests** against the real Hono application with a temporary
`DATA_DIR` and a real SQLite file:

- Push a fixture archive; assert what is served, with which headers.
- Push again; assert the replacement is complete and no intermediate state is
  observable.
- Delete; assert the row and the directory are both gone.

**Fixture archives:** a correctly-based Vite build; one with root-absolute paths
(expects a warning, not a rejection); a traversal attempt; a compression bomb; one
wrapped in a `dist/` directory.

**Auth tests:** the host-check middleware returns 404 for panel routes on the
mockups hostname; sessions revoke; login rate-limits.

**CLI tests** against a stub server covering the resolve → build → zip → upload
sequence.
