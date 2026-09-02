import { basename } from "node:path";
import { slugify } from "@mockups/shared";
import {
  PROJECT_CONFIG_FILE,
  detectProjectDefaults,
  readProjectConfig,
  writeProjectConfig,
  type ProjectConfig,
} from "../config.js";

export function initProject(cwd: string, slug?: string): ProjectConfig {
  const existing = readProjectConfig(cwd);
  if (existing) throw new Error(`${PROJECT_CONFIG_FILE} already exists`);

  const name = basename(cwd);
  const defaults = detectProjectDefaults(cwd);
  const config: ProjectConfig = {
    slug: slug ?? slugify(name),
    name,
    distDir: defaults.distDir,
    buildCommand: defaults.buildCommand,
  };

  writeProjectConfig(cwd, config);
  return config;
}
