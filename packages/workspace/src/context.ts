import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { selectRelevantFiles } from "./fileSelector.js";
import { scanWorkspace } from "./scanner.js";
import type { WorkspaceContext } from "./schemas.js";
import { WorkspaceContextSchema } from "./schemas.js";
import { buildDirectoryTree } from "./tree.js";

async function detectConventions(rootPath: string): Promise<string> {
  const conventions: string[] = [];

  try {
    // Check for TypeScript absolute imports via tsconfig paths
    const tsconfigPath = join(rootPath, "tsconfig.json");
    const tsconfigContent = await readFile(tsconfigPath, "utf-8");
    const tsconfig = JSON.parse(tsconfigContent);
    if (tsconfig.compilerOptions?.paths) {
      const pathKeys = Object.keys(tsconfig.compilerOptions.paths);
      if (pathKeys.some((key) => key.startsWith("@"))) {
        conventions.push("- Uses absolute imports with @ prefix");
      }
    }
  } catch {
    // Ignore errors reading tsconfig
  }

  try {
    // Check for ESM module type
    const pkgPath = join(rootPath, "package.json");
    const pkgContent = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(pkgContent);
    if (pkg.type === "module") {
      conventions.push("- Uses ESM (type: module)");
    }
  } catch {
    // Ignore errors reading package.json
  }

  try {
    // Check for Biome linter
    const biomePath = join(rootPath, "biome.json");
    await readFile(biomePath, "utf-8");
    conventions.push("- Uses Biome for linting/formatting");
  } catch {
    // Ignore errors - biome.json may not exist
  }

  return conventions.join("\n");
}

export async function buildWorkspaceContext(
  rootPath: string,
  taskDescription: string,
): Promise<WorkspaceContext> {
  const profile = await scanWorkspace(rootPath);
  const directoryTree = await buildDirectoryTree(rootPath);
  const relevantFiles = await selectRelevantFiles(rootPath, taskDescription);
  const conventions = await detectConventions(rootPath);

  const context: WorkspaceContext = {
    profile,
    directoryTree,
    relevantFiles,
    conventions: conventions || undefined,
  };

  return WorkspaceContextSchema.parse(context);
}
