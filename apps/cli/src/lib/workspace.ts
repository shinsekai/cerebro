import fs from "node:fs/promises";
import path from "node:path";

export async function findWorkspaceRoot(startDir: string): Promise<string> {
  let current = startDir;
  while (current !== path.dirname(current)) {
    // Check for monorepo markers
    try {
      await fs.access(path.join(current, "turbo.json"));
      return current;
    } catch {}
    try {
      const pkg = JSON.parse(
        await fs.readFile(path.join(current, "package.json"), "utf-8"),
      );
      if (pkg.workspaces && Array.isArray(pkg.workspaces)) return current;
    } catch {}
    try {
      await fs.access(path.join(current, "pnpm-workspace.yaml"));
      return current;
    } catch {}
    current = path.dirname(current);
  }
  return startDir; // Fallback to original dir
}
