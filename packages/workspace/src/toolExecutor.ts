import type { FileChange } from "@cerebro/core";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ALLOWED_COMMANDS = [
  // JS/TS
  "bun",
  "npm",
  "npx",
  "bunx",
  "node",
  "tsc",
  "biome",
  "vitest",
  "jest",
  // Python
  "python",
  "python3",
  "pip",
  "pytest",
  "ruff",
  "mypy",
  "uvicorn",
  // Go
  "go",
  // Rust
  "cargo",
  "rustc",
  // DevOps
  "docker",
  "git",
  "make",
  "cmake",
  // Unix
  "cat",
  "ls",
  "find",
  "grep",
  "head",
  "tail",
  "wc",
  "echo",
  "pwd",
  "which",
  "env",
];

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

interface ReadFileResult {
  content: string;
  size: number;
}

interface WriteFileResult {
  success: boolean;
  operation: "create" | "update";
}

interface ListDirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

interface ListDirectoryResult {
  entries: ListDirectoryEntry[];
}

interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SearchResult {
  path: string;
  line: number;
  content: string;
}

interface SearchFilesResult {
  matches: SearchResult[];
}

interface TaskCompleteResult {
  complete: boolean;
  summary?: string;
}

interface ToolError {
  error: string;
}

export interface ToolExecutorOptions {
  workspaceRoot: string;
  commandTimeout?: number;
  allowedCommands?: string[];
}

export class ToolExecutor {
  readonly workspaceRoot: string;
  readonly commandTimeout: number;
  readonly allowedCommands: Set<string>;
  private pendingWrites: Map<string, FileChange> = new Map();

  constructor(options: ToolExecutorOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.commandTimeout = options.commandTimeout ?? 30000;
    this.allowedCommands = new Set([
      ...DEFAULT_ALLOWED_COMMANDS,
      ...(options.allowedCommands ?? []),
    ]);
  }

  /**
   * Factory method that also detects project-specific commands
   */
  static async create(options: ToolExecutorOptions): Promise<ToolExecutor> {
    const executor = new ToolExecutor(options);
    const projectCommands = await ToolExecutor.detectProjectCommands(
      options.workspaceRoot,
    );
    for (const cmd of projectCommands) {
      executor.allowedCommands.add(cmd);
    }
    return executor;
  }

  /**
   * Detect project-specific commands from config files
   */
  static async detectProjectCommands(workspaceRoot: string): Promise<string[]> {
    const commands = new Set<string>();
    const rootPath = path.resolve(workspaceRoot);

    // Read package.json for npm/bun scripts
    try {
      const packageJsonPath = path.join(rootPath, "package.json");
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, "utf-8"),
      );
      if (packageJson.scripts) {
        for (const script of Object.values(packageJson.scripts)) {
          const match = String(script).match(/^([a-zA-Z0-9_-]+)/);
          if (match) {
            commands.add(match[1]);
          }
        }
      }
    } catch {
      // package.json doesn't exist or can't be parsed
    }

    // Read pyproject.toml for Python scripts
    try {
      const pyprojectPath = path.join(rootPath, "pyproject.toml");
      const pyprojectContent = await fs.readFile(pyprojectPath, "utf-8");
      // Parse [tool.poetry.scripts] or [project.scripts]
      // Match section until end of file or next section header
      const poetryMatch = pyprojectContent.match(
        /\[tool\.poetry\.scripts\]([\s\S]*?)(?=\n\[|$)/,
      );
      const projectMatch = pyprojectContent.match(
        /\[project\.scripts\]([\s\S]*?)(?=\n\[|$)/,
      );
      const sections = [poetryMatch, projectMatch];

      for (const sectionMatch of sections) {
        if (sectionMatch) {
          const scriptsSection = sectionMatch[1];
          const scriptNames = scriptsSection.matchAll(/^([a-zA-Z0-9_-]+)/gm);
          for (const match of scriptNames) {
            commands.add(match[1]);
          }
        }
      }
    } catch {
      // pyproject.toml doesn't exist
    }

    // Read Makefile for targets
    try {
      const makefilePath = path.join(rootPath, "Makefile");
      const makefileContent = await fs.readFile(makefilePath, "utf-8");
      const targets = makefileContent.matchAll(/^[a-zA-Z_-]+:/gm);
      for (const match of targets) {
        const target = match[0].replace(":", "");
        commands.add(target);
      }
    } catch {
      // Makefile doesn't exist
    }

    // Ensure cargo is allowed if Cargo.toml exists
    try {
      await fs.access(path.join(rootPath, "Cargo.toml"));
      commands.add("cargo");
    } catch {
      // Cargo.toml doesn't exist
    }

    return Array.from(commands);
  }

  /**
   * Safely resolve a relative path against workspace root
   * Returns null if path traversal is attempted
   */
  private resolveSafePath(relativePath: string): string | null {
    const resolved = path.resolve(this.workspaceRoot, relativePath);
    if (!resolved.startsWith(this.workspaceRoot)) {
      return null;
    }
    return resolved;
  }

  /**
   * Execute a tool call and return JSON string result
   */
  async execute(toolName: string, input: Record<string, any>): Promise<string> {
    switch (toolName) {
      case "read_file":
        return JSON.stringify(
          await this.readFile(input as unknown as { path: string }),
        );
      case "write_file":
        return JSON.stringify(
          await this.writeFile(
            input as unknown as { path: string; content: string },
          ),
        );
      case "list_directory":
        return JSON.stringify(
          await this.listDirectory(
            input as unknown as { path?: string; depth?: number },
          ),
        );
      case "run_command":
        return JSON.stringify(
          await this.runCommand(input as unknown as { command: string }),
        );
      case "search_files":
        return JSON.stringify(
          await this.searchFiles(
            input as unknown as {
              pattern: string;
              filePattern?: string;
              maxMatches?: number;
            },
          ),
        );
      case "task_complete":
        return JSON.stringify(
          await this.taskComplete(input as unknown as { summary?: string }),
        );
      default:
        return JSON.stringify({
          error: `Unknown tool: ${toolName}`,
        } satisfies ToolError);
    }
  }

  /**
   * Get all pending write operations for HITL approval
   */
  getPendingWrites(): FileChange[] {
    return Array.from(this.pendingWrites.values());
  }

  /**
   * Clear all pending write operations
   */
  clearPendingWrites(): void {
    this.pendingWrites.clear();
  }

  /**
   * Read file contents safely
   */
  private async readFile(input: {
    path: string;
  }): Promise<ReadFileResult | ToolError> {
    const safePath = this.resolveSafePath(input.path);
    if (!safePath) {
      return { error: "Path traversal detected" };
    }

    try {
      const content = await fs.readFile(safePath, "utf-8");
      const size = Buffer.byteLength(content, "utf-8");
      const maxSize = 100 * 1024; // 100KB

      if (size > maxSize) {
        return {
          content: content.slice(0, maxSize) + "\n\n[truncated]",
          size,
        };
      }

      return { content, size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { error: "File not found" };
      }
      return { error: String(error) };
    }
  }

  /**
   * Write file - stores in pending writes for HITL approval
   */
  private async writeFile(input: {
    path: string;
    content: string;
  }): Promise<WriteFileResult | ToolError> {
    const safePath = this.resolveSafePath(input.path);
    if (!safePath) {
      return { error: "Path traversal detected" };
    }

    try {
      // Check if file exists to determine operation type
      const relativePath = path.relative(this.workspaceRoot, safePath);
      let operation: "create" | "update" = "create";
      let isNew = true;

      try {
        await fs.access(safePath);
        operation = "update";
        isNew = false;
      } catch {
        isNew = true;
      }

      // Store in pending writes - DO NOT write to disk
      const fileChange: FileChange = {
        path: relativePath,
        content: input.content,
        operation,
        isNew,
      };

      this.pendingWrites.set(relativePath, fileChange);

      return { success: true, operation };
    } catch (error) {
      return { error: String(error) };
    }
  }

  /**
   * List directory contents recursively up to max depth
   */
  private async listDirectory(
    input: { path?: string; depth?: number } = {},
  ): Promise<ListDirectoryResult | ToolError> {
    const targetPath = input.path ?? "";
    const maxDepth = input.depth ?? 2;

    const safePath = this.resolveSafePath(targetPath);
    if (!safePath) {
      return { error: "Path traversal detected" };
    }

    const entries: ListDirectoryEntry[] = [];

    async function traverse(
      currentPath: string,
      relativePath: string,
      currentDepth: number,
    ): Promise<void> {
      if (currentDepth > maxDepth) {
        return;
      }

      try {
        const dirents = await fs.readdir(currentPath, { withFileTypes: true });

        for (const dirent of dirents) {
          if (ALWAYS_SKIP.has(dirent.name)) {
            continue;
          }

          const entryRelativePath = relativePath
            ? path.join(relativePath, dirent.name)
            : dirent.name;
          const entryPath = path.join(currentPath, dirent.name);

          if (dirent.isDirectory()) {
            entries.push({
              name: dirent.name,
              path: entryRelativePath,
              isDirectory: true,
            });
            await traverse(entryPath, entryRelativePath, currentDepth + 1);
          } else {
            const stats = await fs.stat(entryPath);
            entries.push({
              name: dirent.name,
              path: entryRelativePath,
              isDirectory: false,
              size: stats.size,
            });
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    await traverse(safePath, "", 0);

    return { entries };
  }

  /**
   * Run a shell command with timeout and output truncation
   */
  private async runCommand(input: {
    command: string;
  }): Promise<RunCommandResult | ToolError> {
    const parts = input.command.trim().split(/\s+/);
    const binary = parts[0];

    if (!this.allowedCommands.has(binary)) {
      return {
        error: `Command '${binary}' not allowed`,
      };
    }

    try {
      const proc = Bun.spawn(parts, {
        cwd: this.workspaceRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });

      // Timeout handling
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          proc.kill();
          reject(new Error("timeout"));
        }, this.commandTimeout);
      });

      const exitCode = await Promise.race([proc.exited, timeoutPromise]);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      // Truncate output
      const truncate = (text: string, maxLen = 10 * 1024): string => {
        return text.length > maxLen
          ? text.slice(0, maxLen) + "\n\n[truncated]"
          : text;
      };

      return {
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        exitCode,
      };
    } catch (error) {
      if ((error as Error).message === "timeout") {
        return { error: "Command timed out" };
      }
      return { error: String(error) };
    }
  }

  /**
   * Search for text patterns in files recursively
   */
  private async searchFiles(input: {
    pattern: string;
    filePattern?: string;
    maxMatches?: number;
  }): Promise<SearchFilesResult | ToolError> {
    const pattern = input.pattern;
    const filePattern = input.filePattern ?? "*";
    const maxMatches = input.maxMatches ?? 50;

    const matches: SearchResult[] = [];

    async function searchInFile(
      filePath: string,
      relativePath: string,
    ): Promise<void> {
      if (matches.length >= maxMatches) {
        return;
      }

      try {
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n");

        const regex = new RegExp(pattern, "gi");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxMatches) {
            break;
          }
          if (regex.test(lines[i])) {
            matches.push({
              path: relativePath,
              line: i + 1,
              content: lines[i].trim(),
            });
          }
        }
      } catch {
        // Skip files we can't read
      }
    }

    async function searchRecursive(
      currentPath: string,
      relativePath: string,
    ): Promise<void> {
      if (matches.length >= maxMatches) {
        return;
      }

      try {
        const dirents = await fs.readdir(currentPath, { withFileTypes: true });

        for (const dirent of dirents) {
          if (matches.length >= maxMatches) {
            break;
          }

          if (ALWAYS_SKIP.has(dirent.name)) {
            continue;
          }

          const entryRelativePath = relativePath
            ? path.join(relativePath, dirent.name)
            : dirent.name;
          const entryPath = path.join(currentPath, dirent.name);

          if (dirent.isDirectory()) {
            await searchRecursive(entryPath, entryRelativePath);
          } else {
            // Simple glob pattern matching
            const regex = new RegExp(
              "^" + filePattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
            );
            if (regex.test(dirent.name)) {
              await searchInFile(entryPath, entryRelativePath);
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    await searchRecursive(this.workspaceRoot, "");

    return { matches };
  }

  /**
   * Mark task as complete
   */
  private async taskComplete(input?: {
    summary?: string;
  }): Promise<TaskCompleteResult> {
    return {
      complete: true,
      summary: input?.summary,
    };
  }
}
