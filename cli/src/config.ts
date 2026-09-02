import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PROJECT_CONFIG_FILE = ".mockuprc.json";

export interface ProjectConfig {
  slug: string;
  name?: string;
  distDir: string;
  buildCommand: string | null;
}

export interface UserConfig {
  serverUrl: string;
  token: string;
}

export function readProjectConfig(cwd: string): ProjectConfig | null {
  const path = join(cwd, PROJECT_CONFIG_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
  } catch {
    throw new Error(`${PROJECT_CONFIG_FILE} could not be parsed as JSON`);
  }
}

export function writeProjectConfig(cwd: string, config: ProjectConfig): void {
  writeFileSync(join(cwd, PROJECT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

const VITE_CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mjs"];
const VITE_BUILD = "npx vite build --base={base}";

export function detectProjectDefaults(cwd: string): {
  buildCommand: string | null;
  distDir: string;
} {
  const distDir =
    existsSync(join(cwd, "build")) && !existsSync(join(cwd, "dist")) ? "build" : "dist";

  if (VITE_CONFIGS.some((name) => existsSync(join(cwd, name)))) {
    return { buildCommand: VITE_BUILD, distDir };
  }

  const packagePath = join(cwd, "package.json");
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.devDependencies?.vite || pkg.dependencies?.vite) {
        return { buildCommand: VITE_BUILD, distDir };
      }
    } catch {
      // A malformed package.json is not this tool's problem; fall through.
    }
  }

  return { buildCommand: null, distDir };
}

export function userConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "mockup", "config.json");
}

export function readUserConfig(): UserConfig | null {
  const fromEnv = process.env.MOCKUP_TOKEN;
  const serverFromEnv = process.env.MOCKUP_SERVER;
  if (fromEnv && serverFromEnv) return { token: fromEnv, serverUrl: serverFromEnv };

  const path = userConfigPath();
  if (!existsSync(path)) return null;

  const stored = JSON.parse(readFileSync(path, "utf8")) as UserConfig;
  return {
    serverUrl: serverFromEnv ?? stored.serverUrl,
    token: fromEnv ?? stored.token,
  };
}

export function writeUserConfig(config: UserConfig): void {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
