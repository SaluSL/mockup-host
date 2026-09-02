import { createInterface } from "node:readline/promises";
import { userConfigPath, writeUserConfig } from "../config.js";

export async function login(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const serverUrl = (
    await rl.question("Panel URL (e.g. https://panel-mockups.example.com): ")
  ).trim();
  const token = (await rl.question("API token: ")).trim();
  rl.close();

  if (!serverUrl || !token) throw new Error("Both a panel URL and a token are required");

  writeUserConfig({ serverUrl, token });
  console.log(`Saved to ${userConfigPath()} (mode 0600)`);
}
