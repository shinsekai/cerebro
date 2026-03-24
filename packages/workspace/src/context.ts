import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selectRelevantFiles } from "./fileSelector.js";
import { scanWorkspace } from "./scanner.js";
import type { WorkspaceContext, WorkspaceProfile } from "./schemas.js";
import { WorkspaceContextSchema } from "./schemas.js";
import { buildDirectoryTree } from "./tree.js";

// Cache metadata stored with the profile
interface CacheMetadata {
  cachedAt: number; // Unix timestamp
  trackedFiles: Record<string, number>; // path -> mtime
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Key config files to track for staleness detection
const TRACKED_CONFIG_FILES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "turbo.json",
  "biome.json",
  "biome.jsonc",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
];

async function isCacheValid(
  rootPath: string,
  metadata: CacheMetadata,
): Promise<boolean> {
  // Check age
  const now = Date.now();
  if (now - metadata.cachedAt > CACHE_TTL_MS) {
    return false;
  }

  // Check if any tracked config file has been modified
  for (const configFile of TRACKED_CONFIG_FILES) {
    const filePath = join(rootPath, configFile);
    try {
      const stats = await stat(filePath);
      const cachedMtime = metadata.trackedFiles[configFile];
      if (cachedMtime === undefined || stats.mtimeMs > cachedMtime) {
        return false;
      }
    } catch {
      // File doesn't exist now; if it existed in cache, invalidate
      if (metadata.trackedFiles[configFile] !== undefined) {
        return false;
      }
    }
  }

  return true;
}

async function getCacheMetadata(
  rootPath: string,
): Promise<Record<string, number>> {
  const trackedFiles: Record<string, number> = {};
  for (const configFile of TRACKED_CONFIG_FILES) {
    const filePath = join(rootPath, configFile);
    try {
      const stats = await stat(filePath);
      trackedFiles[configFile] = stats.mtimeMs;
    } catch {
      // File doesn't exist, skip
    }
  }
  return trackedFiles;
}

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

export interface BuildWorkspaceContextOptions {
  useSemanticSearch?: boolean;
  forceRescan?: boolean;
}

export async function buildWorkspaceContext(
  rootPath: string,
  taskDescription: string,
  options?: BuildWorkspaceContextOptions,
): Promise<WorkspaceContext> {
  const { forceRescan = false } = options || {};
  const cacheDir = join(rootPath, ".cerebro");
  const cacheFile = join(cacheDir, "profile.json");
  const metadataFile = join(cacheDir, "profile-meta.json");

  let profile: WorkspaceProfile;

  // Try to use cached profile unless forced rescan
  if (!forceRescan) {
    try {
      const [cachedProfile, cachedMetadata] = await Promise.all([
        readFile(cacheFile, "utf-8"),
        readFile(metadataFile, "utf-8"),
      ]);
      const metadata: CacheMetadata = JSON.parse(cachedMetadata);

      if (await isCacheValid(rootPath, metadata)) {
        // Use cached profile
        profile = JSON.parse(cachedProfile);
      } else {
        // Cache is stale, re-scan
        profile = await scanWorkspace(rootPath);
        // Update cache
        await mkdir(cacheDir, { recursive: true });
        const trackedFiles = await getCacheMetadata(rootPath);
        const newMetadata: CacheMetadata = {
          cachedAt: Date.now(),
          trackedFiles,
        };
        await Promise.all([
          writeFile(cacheFile, JSON.stringify(profile, null, 2)),
          writeFile(metadataFile, JSON.stringify(newMetadata, null, 2)),
        ]);
      }
    } catch {
      // Cache doesn't exist or is invalid, scan and create cache
      profile = await scanWorkspace(rootPath);
      try {
        await mkdir(cacheDir, { recursive: true });
        const trackedFiles = await getCacheMetadata(rootPath);
        const newMetadata: CacheMetadata = {
          cachedAt: Date.now(),
          trackedFiles,
        };
        await Promise.all([
          writeFile(cacheFile, JSON.stringify(profile, null, 2)),
          writeFile(metadataFile, JSON.stringify(newMetadata, null, 2)),
        ]);
      } catch {
        // Silently fail cache write - non-critical
      }
    }
  } else {
    // Force rescan
    profile = await scanWorkspace(rootPath);
    try {
      await mkdir(cacheDir, { recursive: true });
      const trackedFiles = await getCacheMetadata(rootPath);
      const newMetadata: CacheMetadata = {
        cachedAt: Date.now(),
        trackedFiles,
      };
      await Promise.all([
        writeFile(cacheFile, JSON.stringify(profile, null, 2)),
        writeFile(metadataFile, JSON.stringify(newMetadata, null, 2)),
      ]);
    } catch {
      // Silently fail cache write - non-critical
    }
  }

  const directoryTree = await buildDirectoryTree(rootPath);
  const relevantFiles = await selectRelevantFiles(
    rootPath,
    taskDescription,
    options,
  );
  const conventions = await detectConventions(rootPath);

  const context: WorkspaceContext = {
    profile,
    directoryTree,
    relevantFiles,
    conventions: conventions || undefined,
  };

  return WorkspaceContextSchema.parse(context);
}
