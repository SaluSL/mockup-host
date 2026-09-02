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
