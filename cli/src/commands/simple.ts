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
