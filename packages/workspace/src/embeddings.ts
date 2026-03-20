import fs from "node:fs/promises";
import path from "node:path";
import * as process from "node:process";
import {
  deleteWorkspaceIndex,
  saveWorkspaceFile,
  searchWorkspaceFiles,
} from "@cerebro/database";
import type { RelevantFile } from "./schemas.js";

export interface SemanticSearchResult {
  path: string;
  score: number;
}

/**
 * Generate a heuristic summary for a file without using LLM.
 * Extracts path info, exported names, and key imports.
 */
export function generateFileSummary(filePath: string, content: string): string {
  const parts: string[] = [];
  const ext = path.extname(filePath);

  // Add file type and name
  parts.push(`File: ${filePath}`);
  parts.push(`Type: ${ext.slice(1) || "unknown"}`);

  // Extract exports for TS/JS files
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    const exportMatches = content.matchAll(
      /export\s+(?:default\s+)?(?:function|class|const|type|interface|enum)\s+(\w+)/g,
    );
    const exports = Array.from(exportMatches, (m) => m[1]);
    if (exports.length > 0) {
      parts.push(`Exports: ${exports.join(", ")}`);
    }

    // Extract default export if present
    if (content.includes("export default")) {
      const defaultMatch = content.match(
        /export\s+default\s+(?:function|class|const)?\s*(\w+)/,
      );
      if (defaultMatch) {
        parts.push(`Default export: ${defaultMatch[1]}`);
      }
    }
  }

  // Extract imports for TS/JS files
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    const importMatches = content.matchAll(
      /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
    );
    const imports = Array.from(importMatches, (m) => m[1]);
    if (imports.length > 0) {
      parts.push(`Imports: ${imports.slice(0, 5).join(", ")}`);
    }
  }

  // Extract class/function definitions for Python
  if (ext === ".py") {
    const classMatches = content.matchAll(/^class\s+(\w+)/gm);
    const classes = Array.from(classMatches, (m) => m[1]);
    if (classes.length > 0) {
      parts.push(`Classes: ${classes.join(", ")}`);
    }

    const funcMatches = content.matchAll(/^def\s+(\w+)/gm);
    const funcs = Array.from(funcMatches, (m) => m[1]);
    if (funcs.length > 0) {
      parts.push(`Functions: ${funcs.join(", ")}`);
    }
  }

  // Add directory structure hint
  const dirs = path.dirname(filePath).split(path.sep).filter(Boolean);
  if (dirs.length > 0) {
    parts.push(`Path: ${dirs.join(" > ")}`);
  }

  return parts.join(" | ");
}

/**
 * Generate embedding for text using Voyage API (voyage-code-3 model).
 */
export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY environment variable is required for semantic search",
    );
  }

  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: text,
      model: "voyage-code-3",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Voyage API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  return data.data[0]?.embedding ?? [];
}

export interface IndexWorkspaceResult {
  filesIndexed: number;
  errors: string[];
}

/**
 * Walk workspace, generate summaries, embed, and save to database.
 */
export async function indexWorkspace(
  rootPath: string,
): Promise<IndexWorkspaceResult> {
  const results: IndexWorkspaceResult = { filesIndexed: 0, errors: [] };

  const ALLOWED_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".go",
    ".rs",
  ]);

  const ALWAYS_SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "vendor",
    "target",
    "__pycache__",
    ".venv",
    ".turbo",
    ".cache",
    "coverage",
  ]);

  async function* walk(
    currentPath: string,
    relativePath: string,
  ): AsyncGenerator<{ relativePath: string; fullPath: string }> {
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryRelativePath = relativePath
          ? path.join(relativePath, entry.name)
          : entry.name;
        const fullPath = path.join(currentPath, entry.name);

        if (ALWAYS_SKIP.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }

        if (entry.isDirectory()) {
          yield* walk(fullPath, entryRelativePath);
        } else {
          const ext = path.extname(entryRelativePath);
          if (ALLOWED_EXTENSIONS.has(ext)) {
            yield { relativePath: entryRelativePath, fullPath };
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  for await (const { relativePath, fullPath } of walk(rootPath, "")) {
    try {
      const content = await fs.readFile(fullPath, "utf-8");

      // Skip very large files
      if (content.length > 50_000) {
        continue;
      }

      const summary = generateFileSummary(relativePath, content);
      const embedding = await embedText(summary);

      await saveWorkspaceFile(rootPath, relativePath, summary, embedding);
      results.filesIndexed++;
    } catch (error) {
      results.errors.push(
        `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return results;
}

/**
 * Perform semantic search over indexed workspace files.
 */
export async function semanticSearch(
  rootPath: string,
  taskDescription: string,
  limit = 10,
): Promise<SemanticSearchResult[]> {
  try {
    const queryEmbedding = await embedText(taskDescription);
    return await searchWorkspaceFiles(rootPath, queryEmbedding, limit, 0.6);
  } catch (error) {
    // Log warning but don't throw - graceful fallback
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[workspace] Semantic search failed: ${message}`);
    return [];
  }
}

/**
 * Clear workspace index for a given root path.
 */
export async function clearWorkspaceIndex(rootPath: string): Promise<void> {
  try {
    await deleteWorkspaceIndex(rootPath);
  } catch (error) {
    // Log warning but don't throw - graceful fallback
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[workspace] Failed to clear index: ${message}`);
  }
}

/**
 * Merge heuristic and semantic search results.
 * Semantic matches get +15 bonus to their score.
 */
export function mergeSearchResults(
  heuristicFiles: RelevantFile[],
  semanticResults: SemanticSearchResult[],
): RelevantFile[] {
  const pathToScore = new Map<string, number>();
  const pathToContent = new Map<string, string>();
  const pathToTruncated = new Map<string, boolean>();

  // Build map from heuristic results
  for (const file of heuristicFiles) {
    pathToScore.set(file.path, file.score);
    pathToContent.set(file.path, file.content);
    pathToTruncated.set(file.path, file.truncated);
  }

  // Add semantic bonus and include new semantic-only matches
  for (const semantic of semanticResults) {
    const baseScore = pathToScore.get(semantic.path) ?? 0;
    const semanticBonus = Math.round(semantic.score * 50); // Scale 0.6-1.0 to ~30-50
    pathToScore.set(semantic.path, baseScore + semanticBonus);
  }

  // Convert back to array and sort
  return Array.from(pathToScore.entries())
    .map(([path, score]) => ({
      path,
      content: pathToContent.get(path) ?? "",
      score,
      truncated: pathToTruncated.get(path) ?? false,
    }))
    .sort((a, b) => b.score - a.score);
}
