import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushProject } from "../src/commands/push.js";
import type { ProjectConfig } from "../src/config.js";

let cwd: string;
let logs: string[];

const CONFIG: ProjectConfig = {
  slug: "acme",
  name: "Acme",
  distDir: "dist",
  buildCommand: "npx vite build --base={base}",
};

function deps(overrides: Partial<Parameters<typeof pushProject>[0]> = {}) {
  return {
    client: {
      resolve: vi.fn().mockResolvedValue({
        mockup: { id: "id-1", slug: "acme" },
        basePath: "/m/id-1/",
        url: "https://mockups.example.org/m/id-1",
      }),
      push: vi.fn().mockResolvedValue({
        mockup: { id: "id-1", fileCount: 3 },
        url: "https://mockups.example.org/m/id-1",
        warning: null,
      }),
    },
    runBuild: vi.fn().mockResolvedValue(undefined),
    zipDirectory: vi.fn().mockImplementation(async (_dir: string, out: string) => {
      writeFileSync(out, "PK");
    }),
    log: (message: string) => logs.push(message),
    ...overrides,
  } as Parameters<typeof pushProject>[0];
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "cli-push-"));
  mkdirSync(join(cwd, "dist"));
  logs = [];
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("pushProject", () => {
  it("resolves first, then builds with the returned base path", async () => {
    const d = deps();

    await pushProject(d, { cwd, config: CONFIG, noBuild: false });

    expect(d.client.resolve).toHaveBeenCalledWith("acme", "Acme");
    expect(d.runBuild).toHaveBeenCalledWith("npx vite build --base={base}", "/m/id-1/", cwd);

    const resolveOrder = (d.client.resolve as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const buildOrder = (d.runBuild as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(resolveOrder).toBeLessThan(buildOrder);
  });

  it("zips the configured dist directory and uploads it", async () => {
    const d = deps();

    await pushProject(d, { cwd, config: CONFIG, noBuild: false });

    expect(d.zipDirectory).toHaveBeenCalledWith(join(cwd, "dist"), expect.stringMatching(/\.zip$/));
    expect(d.client.push).toHaveBeenCalledWith("id-1", expect.stringMatching(/\.zip$/));
  });

  it("skips the build when noBuild is set", async () => {
    const d = deps();

    await pushProject(d, { cwd, config: CONFIG, noBuild: true });

    expect(d.runBuild).not.toHaveBeenCalled();
    expect(d.client.push).toHaveBeenCalled();
  });

  it("skips the build when the project has no build command", async () => {
    const d = deps();

    await pushProject(d, { cwd, config: { ...CONFIG, buildCommand: null }, noBuild: false });

    expect(d.runBuild).not.toHaveBeenCalled();
  });

  it("prints the share url", async () => {
    await pushProject(deps(), { cwd, config: CONFIG, noBuild: false });
    expect(logs.join("\n")).toContain("https://mockups.example.org/m/id-1");
  });

  it("prints a warning returned by the server", async () => {
    const d = deps({
      client: {
        resolve: vi.fn().mockResolvedValue({
          mockup: { id: "id-1" },
          basePath: "/m/id-1/",
          url: "u",
        }),
        push: vi.fn().mockResolvedValue({
          mockup: {},
          url: "u",
          warning: "Rebuild with --base=/m/id-1/",
        }),
      },
    });

    await pushProject(d, { cwd, config: CONFIG, noBuild: false });

    expect(logs.join("\n")).toContain("Rebuild with --base=/m/id-1/");
  });

  it("does not upload when the build fails", async () => {
    const d = deps({ runBuild: vi.fn().mockRejectedValue(new Error("build blew up")) });

    await expect(pushProject(d, { cwd, config: CONFIG, noBuild: false })).rejects.toThrow(
      /build blew up/,
    );
    expect(d.client.push).not.toHaveBeenCalled();
  });

  it("fails with a clear message when the dist directory is missing", async () => {
    rmSync(join(cwd, "dist"), { recursive: true });

    await expect(pushProject(deps(), { cwd, config: CONFIG, noBuild: true })).rejects.toThrow(
      /dist/,
    );
  });
});
