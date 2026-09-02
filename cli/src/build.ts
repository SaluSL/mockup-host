import { spawn } from "node:child_process";

export function substituteBase(template: string, base: string): string {
  return template.replaceAll("{base}", base);
}

export function runBuild(command: string, base: string, cwd: string): Promise<void> {
  const resolved = substituteBase(command, base);

  return new Promise((resolve, reject) => {
    const child = spawn(resolved, { cwd, shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build command exited with code ${code}: ${resolved}`));
    });
  });
}
