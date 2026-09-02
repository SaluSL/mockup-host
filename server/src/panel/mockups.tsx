/** @jsxImportSource hono/jsx */
import type { MockupSummary } from "@mockups/shared";
import { mockupUrl } from "@mockups/shared";
import { Layout } from "./layout.js";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "-";
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
                {mockup.basePathWarning ? <span class="warn">{mockup.basePathWarning}</span> : null}
              </td>
              <td>{formatBytes(mockup.sizeBytes)}</td>
              <td>{mockup.fileCount || "-"}</td>
              <td>{formatDate(mockup.lastPushedAt)}</td>
              <td>
                <form
                  class="inline"
                  method="post"
                  action={`/mockups/${mockup.id}/content`}
                  enctype="multipart/form-data"
                >
                  <input type="file" name="file" accept=".zip,application/zip" required />
                  <button type="submit">Upload zip</button>
                </form>
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
