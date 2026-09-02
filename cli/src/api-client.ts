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
      const response = await fetch(`${base}/api/mockups/${id}`, {
        method: "DELETE",
        headers: auth,
      });
      if (!response.ok) await unwrap(response);
    },
  };
}
