# mockup-host

Hosts static frontend mockups at unguessable URLs:

```
https://mockups.example.com/m/<uuid>
```

Mockups are published from the command line — the CLI builds the project with the
right base path, archives the output, and uploads it — or by dropping a zip on the
management panel. The panel lives on its own hostname, `panel.mockups.example.com`,
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

Point both DNS records — `mockups.example.com` and `panel.mockups.example.com` — at the
host. Caddy obtains certificates for both on first request.

The password prompt writes the hash to stdout and the prompt itself to stderr, so
`npm run hash-password -w @mockups/server > hash.txt` captures only the value. The
password is never passed as an argument, which would put it in shell history.

## Publishing from a project

Create a token in the panel under **Tokens**. It is shown once.

```bash
npm i -g ./cli          # or: npm link --workspace @mockups/cli
mockup login            # panel URL + the token, stored 0600 in ~/.config/mockup/
```

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
