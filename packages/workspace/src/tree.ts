import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const TreeOptionsSchema = z.object({
  maxDepth: z.number().min(1).optional().default(4),
  maxTokenEstimate: z.number().min(1).optional().default(500),
  respectGitignore: z.boolean().optional().default(true),
});

export type TreeOptions = z.infer<typeof TreeOptionsSchema>;

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

interface TreeNode {
  name: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

function parseGitignore(content: string): Set<string> {
  const patterns = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      patterns.add(trimmed);
    }
  }
  return patterns;
}

function matchesGitignorePattern(
  entryName: string,
  pattern: string,
  relativePath: string,
  isDirectory: boolean,
): boolean {
  // Remove leading / for anchored patterns
  let cleanPattern = pattern.startsWith("/") ? pattern.slice(1) : pattern;

  // Handle trailing / (directory-only pattern)
  const isDirOnlyPattern = cleanPattern.endsWith("/");
  if (isDirOnlyPattern) {
    cleanPattern = cleanPattern.slice(0, -1);
  }

  // Directory-only patterns only match directories
  if (isDirOnlyPattern && !isDirectory) {
    return false;
  }

  // Handle ** wildcard
  if (cleanPattern.includes("**")) {
    const regexPattern = cleanPattern
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".");
    return new RegExp(`^${regexPattern}$`).test(entryName);
  }

  // Handle * wildcard
  if (cleanPattern.includes("*")) {
    const regexPattern = cleanPattern.replace(/\*/g, "[^/]*");
    return new RegExp(`^${regexPattern}$`).test(entryName);
  }

  // Exact match
  return entryName === cleanPattern || relativePath === cleanPattern;
}

function shouldSkip(
  name: string,
  relativePath: string,
  gitignorePatterns: Set<string>,
  isDirectory: boolean,
): boolean {
  if (ALWAYS_SKIP.has(name)) {
    return true;
  }

  for (const pattern of gitignorePatterns) {
    if (matchesGitignorePattern(name, pattern, relativePath, isDirectory)) {
      return true;
    }
  }

  return false;
}

async function loadGitignore(rootPath: string): Promise<Set<string>> {
  try {
    const content = await fs.readFile(
      path.join(rootPath, ".gitignore"),
      "utf-8",
    );
    return parseGitignore(content);
  } catch {
    return new Set<string>();
  }
}

async function buildTree(
  currentPath: string,
  relativePath: string,
  depth: number,
  maxDepth: number,
  gitignorePatterns: Set<string>,
): Promise<TreeNode[]> {
  if (depth > maxDepth) {
    return [];
  }

  try {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    const nodes: TreeNode[] = [];

    for (const entry of entries) {
      const entryRelativePath = relativePath
        ? path.join(relativePath, entry.name)
        : entry.name;

      const isDirectory = entry.isDirectory();

      if (
        shouldSkip(
          entry.name,
          entryRelativePath,
          gitignorePatterns,
          isDirectory,
        )
      ) {
        continue;
      }

      if (isDirectory) {
        const children = await buildTree(
          path.join(currentPath, entry.name),
          entryRelativePath,
          depth + 1,
          maxDepth,
          gitignorePatterns,
        );
        nodes.push({
          name: entry.name,
          isDirectory: true,
          children,
        });
      } else {
        nodes.push({
          name: entry.name,
          isDirectory: false,
        });
      }
    }

    return nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

function treeToString(nodes: TreeNode[], indent: number = 0): string {
  const padding = "  ".repeat(indent);
  const lines: string[] = [];

  for (const node of nodes) {
    const suffix = node.isDirectory ? "/" : "";
    lines.push(`${padding}${node.name}${suffix}`);

    if (node.children && node.children.length > 0) {
      lines.push(treeToString(node.children, indent + 1));
    }
  }

  return lines.join("\n");
}

function truncateTree(tree: string, maxChars: number): string {
  if (tree.length <= maxChars) {
    return tree;
  }

  const lines = tree.split("\n");
  const result: string[] = [];
  let currentLength = 0;

  for (const line of lines) {
    if (currentLength + line.length + 1 > maxChars) {
      result.push("... (truncated)");
      break;
    }
    result.push(line);
    currentLength += line.length + 1;
  }

  return result.join("\n");
}

export async function buildDirectoryTree(
  rootPath: string,
  options?: TreeOptions,
): Promise<string> {
  const opts = TreeOptionsSchema.parse(options ?? {});

  const gitignorePatterns = opts.respectGitignore
    ? await loadGitignore(rootPath)
    : new Set();

  const tree = await buildTree(
    rootPath,
    "",
    1,
    opts.maxDepth,
    gitignorePatterns,
  );

  const treeString = treeToString(tree);

  const maxChars = opts.maxTokenEstimate * 4;
  return truncateTree(treeString, maxChars);
}
