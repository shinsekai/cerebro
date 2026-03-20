import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const RelevantFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  score: z.number(),
  truncated: z.boolean(),
});

export type RelevantFile = z.infer<typeof RelevantFileSchema>;

export const FileSelectorOptionsSchema = z.object({
  maxFiles: z.number().min(1).optional().default(15),
  maxTotalTokens: z.number().min(1).optional().default(30000),
  includePatterns: z.array(z.string()).optional().default([]),
  excludePatterns: z.array(z.string()).optional().default([]),
});

export type FileSelectorOptions = z.infer<typeof FileSelectorOptionsSchema>;

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

const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".sql",
  ".prisma",
  ".graphql",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".md",
  ".env.example",
]);

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "to",
  "for",
  "with",
  "and",
  "or",
  "in",
  "on",
  "of",
  "at",
  "by",
  "from",
  "this",
  "that",
  "these",
  "those",
  "be",
  "are",
  "was",
  "were",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "need",
  "as",
  "if",
  "when",
  "then",
  "else",
  "but",
  "not",
  "no",
  "yes",
  "so",
  "than",
  "such",
  "both",
  "each",
  "either",
  "neither",
  "all",
  "any",
  "some",
  "few",
  "many",
  "much",
  "more",
  "most",
  "less",
  "least",
  "own",
  "same",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "where",
  "why",
  "how",
]);

function extractKeywords(taskDescription: string): Set<string> {
  const keywords = new Set<string>();
  const words = taskDescription.split(/\s+/).filter(Boolean);

  for (const word of words) {
    const normalized = word.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.length >= 3 && !STOP_WORDS.has(normalized)) {
      keywords.add(normalized);
    }
  }

  return keywords;
}

function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const regexPattern = pattern
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".");
    return new RegExp(regexPattern).test(filePath);
  }
  return filePath === pattern || filePath.endsWith(pattern);
}

function shouldSkipByPatterns(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(filePath, pattern));
}

function scoreFileByPath(
  relativePath: string,
  keywords: Set<string>,
  isAlwaysInclude: boolean,
): number {
  if (isAlwaysInclude) {
    return 50;
  }

  let score = 0;
  const segments = relativePath.split(path.sep);

  for (const keyword of keywords) {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const filenameNoExt = path.basename(segment, path.extname(segment));

      if (filenameNoExt === keyword) {
        score += 10;
      } else if (segment.includes(keyword)) {
        score += 2;
      }

      if (filenameNoExt.includes(keyword)) {
        score += 5;
      }
    }
  }

  return score;
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
  let cleanPattern = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const isDirOnlyPattern = cleanPattern.endsWith("/");
  if (isDirOnlyPattern) {
    cleanPattern = cleanPattern.slice(0, -1);
  }

  if (isDirOnlyPattern && !isDirectory) {
    return false;
  }

  if (cleanPattern.includes("**")) {
    const regexPattern = cleanPattern
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".");
    return new RegExp(`^${regexPattern}$`).test(entryName);
  }

  if (cleanPattern.includes("*")) {
    const regexPattern = cleanPattern.replace(/\*/g, "[^/]*");
    return new RegExp(`^${regexPattern}$`).test(entryName);
  }

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

async function* walkProjectDir(
  rootPath: string,
  gitignorePatterns: Set<string>,
): AsyncGenerator<{ relativePath: string; fullPath: string }, void> {
  async function* walk(
    currentPath: string,
    relativePath: string,
  ): AsyncGenerator<{ relativePath: string; fullPath: string }, void> {
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

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

        const fullPath = path.join(currentPath, entry.name);

        if (isDirectory) {
          yield* walk(fullPath, entryRelativePath);
        } else {
          yield { relativePath: entryRelativePath, fullPath };
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  yield* walk(rootPath, "");
}

export async function selectRelevantFiles(
  rootPath: string,
  taskDescription: string,
  options?: Partial<FileSelectorOptions>,
): Promise<RelevantFile[]> {
  const opts = FileSelectorOptionsSchema.parse({
    maxFiles: 15,
    maxTotalTokens: 30000,
    includePatterns: [],
    excludePatterns: [],
    ...options,
  });

  const keywords = extractKeywords(taskDescription);
  const gitignorePatterns = await loadGitignore(rootPath);

  const filesToScore: Array<{
    relativePath: string;
    fullPath: string;
    score: number;
    isAlwaysInclude: boolean;
  }> = [];

  for await (const { relativePath, fullPath } of walkProjectDir(
    rootPath,
    gitignorePatterns,
  )) {
    const ext = path.extname(relativePath);
    // Check both simple extension and compound extensions like .env.example
    const hasAllowedExtension =
      ALLOWED_EXTENSIONS.has(ext) ||
      Array.from(ALLOWED_EXTENSIONS).some((allowed) =>
        relativePath.endsWith(allowed),
      );

    if (!hasAllowedExtension) {
      continue;
    }

    if (shouldSkipByPatterns(relativePath, opts.excludePatterns)) {
      continue;
    }

    const stats = await fs.stat(fullPath);
    if (stats.size > 100 * 1024) {
      continue;
    }

    const filename = path.basename(relativePath);
    const isPackageJson =
      filename === "package.json" && relativePath === filename;
    const isTsConfig =
      filename === "tsconfig.json" && relativePath === filename;
    const matchesIncludePattern = opts.includePatterns.some((pattern) =>
      matchesPattern(relativePath, pattern),
    );

    const isAlwaysInclude =
      isPackageJson || isTsConfig || matchesIncludePattern;

    const score = scoreFileByPath(relativePath, keywords, isAlwaysInclude);

    filesToScore.push({ relativePath, fullPath, score, isAlwaysInclude });
  }

  filesToScore.sort((a, b) => b.score - a.score);

  const topFiles = filesToScore.slice(0, opts.maxFiles);

  const results: RelevantFile[] = [];
  let remainingTokens = opts.maxTotalTokens;

  for (const { relativePath, fullPath, score } of topFiles) {
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      const estimatedTokens = Math.ceil(content.length / 4);

      if (estimatedTokens <= remainingTokens) {
        results.push({
          path: relativePath,
          content,
          score,
          truncated: false,
        });
        remainingTokens -= estimatedTokens;
      } else {
        const allowedChars = remainingTokens * 4;
        const truncatedContent = content.slice(0, allowedChars);
        results.push({
          path: relativePath,
          content: truncatedContent,
          score,
          truncated: true,
        });
        remainingTokens = 0;
        break;
      }
    } catch {
      // Skip files that can't be read as text
    }
  }

  return results;
}
