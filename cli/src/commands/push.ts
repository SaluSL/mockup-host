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
