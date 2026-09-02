# mockup-host

Hosts static frontend mockups at unguessable URLs:

```
https://mockups.example.com/m/<uuid>
```

Mockups are published from the command line — the CLI builds the project with the
right base path, archives the output, and uploads it — or by dropping a zip on the
management panel. The panel lives on its own hostname, `panel-mockups.example.com`,
behind a username and password.

**A share URL is unlisted, not access-controlled.** Anyone holding the link can view
the mockup, and forwarding the link forwards the access. It is unguessable, nothing
more. Do not put anything confidential behind one.

## Server setup

```bash
cp .env.example .env
openssl rand -base64 48                      # paste into SESSION_SECRET
npm run hash-password -w @mockups/server     # paste into ADMIN_PASSWORD_HASH
docker compose up -d --build
```

Point both DNS records — `mockups.example.com` and `panel-mockups.example.com` — at the
host. Caddy obtains certificates for both on first request.

The panel is a **sibling** label, not `panel.mockups.example.com`. A wildcard
certificate matches exactly one label, so a nested name is not covered by
`*.example.com` — behind Cloudflare's Universal SSL that means the edge has no
certificate for it and drops the TLS handshake before any HTTP happens. Keep both
hostnames one label below the apex.

If the records are proxied through Cloudflare, note that the free plan caps request
bodies at 100MB, below this project's 200MB `MAX_UPLOAD_BYTES`; a larger push is
rejected at the edge rather than by the app.

The password prompt writes the hash to stdout and the prompt itself to stderr, so
`npm run hash-password -w @mockups/server > hash.txt` captures only the value. The
password is never passed as an argument, which would put it in shell history.

## Publishing from a project

Create a token in the panel under **Tokens**. It is shown once.

On the machine with this repo:

```bash
npm link --workspace @mockups/cli
mockup login            # panel URL + the token, stored 0600 in ~/.config/mockup/
```

On any other machine, the CLI is a single self-contained file — no clone, no
`npm install`, nothing but Node 22:

```bash
curl -fsSL https://raw.githubusercontent.com/SaluSL/mockup-host/master/cli/bin/mockup.cjs \
  -o ~/.local/bin/mockup && chmod +x ~/.local/bin/mockup
mockup login
```

Instead of `mockup login`, CI and one-off shells can pass the two values as
environment variables:

```bash
export MOCKUP_SERVER=https://panel-mockups.example.com MOCKUP_TOKEN=mk_...
```

`cli/bin/mockup.cjs` is a committed build artifact so that install stays a
single command. Regenerate it with `npm run bundle -w @mockups/cli` after
changing anything under `cli/src`, and commit the result — otherwise other
machines keep running the old CLI.

Then, in a project directory:

```bash
mockup init             # writes .mockuprc.json, detecting Vite and the dist directory
mockup push             # resolves the uuid, builds with --base, uploads, prints the URL
```

`mockup push` resolves the mockup *before* building, because the build needs the uuid
to bake `/m/<uuid>/` into the asset URLs. Other commands: `mockup ls`, `mockup rm <slug>`,
`mockup open`, and `mockup push --no-build` to upload an existing `dist/` untouched.

`.mockuprc.json` is committable:

```json
{
  "slug": "acme-landing",
  "name": "Acme Landing",
  "distDir": "dist",
  "buildCommand": "npx vite build --base={base}"
}
```

`{base}` is substituted with `/m/<uuid>/`. Override `buildCommand` for a project whose
build is more than a bare `vite build` — for example `vue-tsc && npx vite build --base={base}`.

## The base-path warning

After a push the server scans the HTML, JS, and CSS for references rooted at `/`, such as
`<script src="/assets/index-abc.js">`. Those resolve against the site root, not the mockup,
so they 404. When it finds any, the panel and the CLI show:

> This build references /assets/index-abc.js from the site root and will 404 when served
> at /m/<uuid>/. Rebuild with --base=/m/<uuid>/

The push still succeeds — the warning describes a broken page, not a rejected upload. It
appears when a zip was built without the CLI, or pushed with `--no-build`. The fix is to
build with the base path, which `mockup push` does on its own.

## Overwriting and deleting

A push replaces the previous build entirely; there is no versioning or rollback. The new
build is unpacked to a staging directory and validated in full before an atomic `rename()`
swaps it in, so a rejected archive leaves the previous build serving and no visitor sees a
half-written tree.

Deleting a mockup removes the database row and the files. The URL 404s afterwards.

## Backups

Everything lives in `./data`: `db.sqlite` plus `mockups/<uuid>/`.

```bash
sqlite3 /path/to/data/db.sqlite ".backup '/path/to/data/backup.sqlite'" && \
  tar czf mockups-backup.tar.gz -C /path/to data
```

Back up the SQLite file with `.backup` rather than copying it — the database runs in WAL
mode, and a plain copy can catch it mid-write.

## Development

```bash
npm install
npm test
npm run typecheck
npm run dev -w @mockups/server   # reads ../.env
```

Point `panel.localhost` and `mockups.localhost` at `127.0.0.1` (both resolve there on most
systems already) and set `PANEL_HOST`/`MOCKUPS_HOST` to match, including the port.
