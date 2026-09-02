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
        console.log("No Vite build detected - push will upload the dist directory as-is.");
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
      if (!mockup) throw new Error(`"${project.slug}" does not exist yet - run "mockup push"`);
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
