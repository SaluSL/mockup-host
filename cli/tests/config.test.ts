import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROJECT_CONFIG_FILE,
  detectProjectDefaults,
  readProjectConfig,
  writeProjectConfig,
} from "../src/config.js";
import { substituteBase } from "../src/build.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("project config", () => {
  it("returns null when no config file exists", () => {
    expect(readProjectConfig(dir)).toBeNull();
  });

  it("round-trips a config", () => {
    const config = {
      slug: "acme",
      name: "Acme",
      distDir: "dist",
      buildCommand: "npx vite build --base={base}",
    };
    writeProjectConfig(dir, config);
    expect(readProjectConfig(dir)).toEqual(config);
  });

  it("throws a readable error on malformed json", () => {
    writeFileSync(join(dir, PROJECT_CONFIG_FILE), "{ not json");
    expect(() => readProjectConfig(dir)).toThrow(/could not be parsed/i);
  });
});

describe("detectProjectDefaults", () => {
  it("detects vite from a config file", () => {
    writeFileSync(join(dir, "vite.config.ts"), "export default {}");
    expect(detectProjectDefaults(dir)).toEqual({
      buildCommand: "npx vite build --base={base}",
      distDir: "dist",
    });
  });

  it("detects vite from package.json dependencies", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "^5" } }));
    expect(detectProjectDefaults(dir).buildCommand).toBe("npx vite build --base={base}");
  });

  it("returns no build command for an unrecognised project", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "^14" } }));
    expect(detectProjectDefaults(dir)).toEqual({ buildCommand: null, distDir: "dist" });
  });

  it("prefers an existing build directory name", () => {
    mkdirSync(join(dir, "build"));
    expect(detectProjectDefaults(dir).distDir).toBe("build");
  });
});

describe("substituteBase", () => {
  it("replaces every occurrence of the placeholder", () => {
    expect(substituteBase("vite build --base={base} --out {base}", "/m/x/")).toBe(
      "vite build --base=/m/x/ --out /m/x/",
    );
  });

  it("leaves a template without the placeholder untouched", () => {
    expect(substituteBase("npm run build", "/m/x/")).toBe("npm run build");
  });
});
