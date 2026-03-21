import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileChange } from "@cerebro/core";
import { ToolExecutor } from "./toolExecutor.js";

describe("ToolExecutor", () => {
  let tempWorkspace: string;

  beforeEach(async () => {
    tempWorkspace = await mkdtemp(path.join(tmpdir(), "cerebro-test-"));
  });

  afterEach(async () => {
    await rm(tempWorkspace, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("should initialize with default values", () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      expect(executor.workspaceRoot).toBe(path.resolve(tempWorkspace));
      expect(executor.commandTimeout).toBe(30000);
      expect(executor.allowedCommands.has("bun")).toBe(true);
      expect(executor.allowedCommands.has("python3")).toBe(true);
    });

    it("should accept custom timeout", () => {
      const executor = new ToolExecutor({
        workspaceRoot: tempWorkspace,
        commandTimeout: 60000,
      });
      expect(executor.commandTimeout).toBe(60000);
    });

    it("should merge custom allowed commands", () => {
      const executor = new ToolExecutor({
        workspaceRoot: tempWorkspace,
        allowedCommands: ["custom-cmd", "another-cmd"],
      });
      expect(executor.allowedCommands.has("bun")).toBe(true);
      expect(executor.allowedCommands.has("custom-cmd")).toBe(true);
    });
  });

  describe("create factory", () => {
    it("should detect project commands from package.json", async () => {
      const packageJson = {
        name: "test-project",
        scripts: {
          test: "vitest",
          lint: "biome check",
          build: "tsc",
        },
      };
      await writeFile(
        path.join(tempWorkspace, "package.json"),
        JSON.stringify(packageJson),
      );

      const executor = await ToolExecutor.create({
        workspaceRoot: tempWorkspace,
      });

      expect(executor.allowedCommands.has("vitest")).toBe(true);
      expect(executor.allowedCommands.has("biome")).toBe(true);
      expect(executor.allowedCommands.has("tsc")).toBe(true);
    });

    it("should detect targets from Makefile", async () => {
      const makefile = `
.PHONY: test build deploy
test:
	@echo running tests
build:
	@echo building
deploy:
	@echo deploying
`;
      await writeFile(path.join(tempWorkspace, "Makefile"), makefile);

      const executor = await ToolExecutor.create({
        workspaceRoot: tempWorkspace,
      });

      expect(executor.allowedCommands.has("test")).toBe(true);
      expect(executor.allowedCommands.has("build")).toBe(true);
      expect(executor.allowedCommands.has("deploy")).toBe(true);
    });

    it("should add cargo command if Cargo.toml exists", async () => {
      await writeFile(
        path.join(tempWorkspace, "Cargo.toml"),
        '[package]\nname = "test"\nversion = "1.0"',
      );

      const executor = await ToolExecutor.create({
        workspaceRoot: tempWorkspace,
      });

      expect(executor.allowedCommands.has("cargo")).toBe(true);
    });

    it("should detect Python scripts from pyproject.toml", async () => {
      const pyproject = `[tool.poetry.scripts]
mytool = "myproject.cli:main"
analyzer = "myproject.analyzer:run"
`;
      await writeFile(path.join(tempWorkspace, "pyproject.toml"), pyproject);

      const executor = await ToolExecutor.create({
        workspaceRoot: tempWorkspace,
      });

      expect(executor.allowedCommands.has("mytool")).toBe(true);
      expect(executor.allowedCommands.has("analyzer")).toBe(true);
    });

    it("should return empty array for empty project", async () => {
      const commands = await ToolExecutor.detectProjectCommands(tempWorkspace);
      expect(commands).toEqual([]);
    });
  });

  describe("detectProjectCommands static method", () => {
    it("should extract binary names from package.json scripts", async () => {
      const packageJson = {
        name: "test",
        scripts: {
          test: "bun test",
          format: "biome format",
          "type-check": "tsc --noEmit",
        },
      };
      await writeFile(
        path.join(tempWorkspace, "package.json"),
        JSON.stringify(packageJson),
      );

      const commands = await ToolExecutor.detectProjectCommands(tempWorkspace);
      expect(commands).toContain("bun");
      expect(commands).toContain("biome");
      expect(commands).toContain("tsc");
    });

    it("should read Makefile targets", async () => {
      await writeFile(
        path.join(tempWorkspace, "Makefile"),
        "clean:\n\trm -rf dist\nbuild:\n\tmake all\n",
      );

      const commands = await ToolExecutor.detectProjectCommands(tempWorkspace);
      expect(commands).toContain("clean");
      expect(commands).toContain("build");
    });
  });

  describe("execute - read_file", () => {
    it("should read existing file", async () => {
      const testContent = "Hello, World!";
      const testFile = path.join(tempWorkspace, "test.txt");
      await writeFile(testFile, testContent);

      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("read_file", { path: "test.txt" }),
      );

      expect(result.content).toBe(testContent);
      expect(result.size).toBe(13);
    });

    it("should return error for nonexistent file", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("read_file", { path: "nonexistent.txt" }),
      );

      expect(result.error).toBe("File not found");
    });

    it("should block path traversal attempts", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("read_file", { path: "../../../etc/passwd" }),
      );

      expect(result.error).toBe("Path traversal detected");
    });

    it("should truncate large files", async () => {
      const largeContent = "x".repeat(150 * 1024); // 150KB
      const testFile = path.join(tempWorkspace, "large.txt");
      await writeFile(testFile, largeContent);

      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("read_file", { path: "large.txt" }),
      );

      expect(result.size).toBe(largeContent.length);
      expect(result.content).toContain("[truncated]");
      expect(result.content.length).toBeLessThan(largeContent.length);
    });
  });

  describe("execute - write_file", () => {
    it("should store pending write for new file", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("write_file", {
          path: "newfile.txt",
          content: "New content",
        }),
      );

      expect(result.success).toBe(true);
      expect(result.operation).toBe("create");

      const pending = executor.getPendingWrites();
      expect(pending).toHaveLength(1);
      expect(pending[0].path).toBe("newfile.txt");
      expect(pending[0].content).toBe("New content");
      expect(pending[0].operation).toBe("create");
      expect(pending[0].isNew).toBe(true);

      // File should not exist on disk
      expect(async () => {
        await readFile(path.join(tempWorkspace, "newfile.txt"));
      }).toThrow();
    });

    it("should store pending update for existing file", async () => {
      const testFile = path.join(tempWorkspace, "existing.txt");
      await writeFile(testFile, "Original content");

      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("write_file", {
          path: "existing.txt",
          content: "Updated content",
        }),
      );

      expect(result.success).toBe(true);
      expect(result.operation).toBe("update");

      const pending = executor.getPendingWrites();
      expect(pending[0].operation).toBe("update");
      expect(pending[0].isNew).toBe(false);

      // File should still have original content on disk
      const content = await readFile(testFile, "utf-8");
      expect(content).toBe("Original content");
    });

    it("should block path traversal on write", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("write_file", {
          path: "../../../etc/malicious.txt",
          content: "bad content",
        }),
      );

      expect(result.error).toBe("Path traversal detected");
    });
  });

  describe("getPendingWrites and clearPendingWrites", () => {
    it("should return all pending writes", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });

      await executor.execute("write_file", { path: "file1.txt", content: "a" });
      await executor.execute("write_file", { path: "file2.txt", content: "b" });
      await executor.execute("write_file", { path: "file3.txt", content: "c" });

      const pending = executor.getPendingWrites() as FileChange[];
      expect(pending).toHaveLength(3);
      expect(pending.map((f) => f.path)).toEqual([
        "file1.txt",
        "file2.txt",
        "file3.txt",
      ]);
    });

    it("should clear all pending writes", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });

      await executor.execute("write_file", { path: "file1.txt", content: "a" });
      expect(executor.getPendingWrites()).toHaveLength(1);

      executor.clearPendingWrites();
      expect(executor.getPendingWrites()).toHaveLength(0);
    });

    it("should maintain FileChange type structure", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });

      await executor.execute("write_file", {
        path: "test.ts",
        content: "code",
      });
      const pending = executor.getPendingWrites() as FileChange[];

      expect(pending[0]).toHaveProperty("path");
      expect(pending[0]).toHaveProperty("content");
      expect(pending[0]).toHaveProperty("operation");
      expect(pending[0]).toHaveProperty("isNew");
    });
  });

  describe("execute - list_directory", () => {
    beforeEach(async () => {
      await writeFile(path.join(tempWorkspace, "file1.txt"), "a");
      await writeFile(path.join(tempWorkspace, "file2.ts"), "b");
      await mkdir(path.join(tempWorkspace, "dir1"));
      await mkdir(path.join(tempWorkspace, "dir2"));
    });

    it("should list directory contents", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(await executor.execute("list_directory", {}));

      expect(result.entries).toHaveLength(4);
      expect(result.entries.map((e: any) => e.name)).toContain("file1.txt");
      expect(result.entries.map((e: any) => e.name)).toContain("dir1");
    });

    it("should respect depth parameter", async () => {
      await writeFile(path.join(tempWorkspace, "dir1", "nested.txt"), "nested");

      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      // With depth=0, should only list root directory (no recursion)
      const result = JSON.parse(
        await executor.execute("list_directory", { depth: 0 }),
      );

      // Should contain dir1 but not its contents
      expect(result.entries.map((e: any) => e.name)).toContain("dir1");
      const nestedFile = result.entries.find(
        (e: any) => e.name === "nested.txt",
      );
      expect(nestedFile).toBeUndefined();
    });

    it("should skip node_modules and other always-skip directories", async () => {
      await mkdir(path.join(tempWorkspace, "node_modules"));
      await mkdir(path.join(tempWorkspace, ".git"));
      await writeFile(
        path.join(tempWorkspace, "node_modules", "dep.txt"),
        "dep",
      );

      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(await executor.execute("list_directory", {}));

      expect(result.entries.map((e: any) => e.name)).not.toContain(
        "node_modules",
      );
      expect(result.entries.map((e: any) => e.name)).not.toContain(".git");
    });

    it("should include file sizes", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(await executor.execute("list_directory", {}));

      const file1 = result.entries.find((e: any) => e.name === "file1.txt");
      expect(file1.size).toBe(1);

      const dir1 = result.entries.find((e: any) => e.name === "dir1");
      expect(dir1.isDirectory).toBe(true);
      expect(dir1.size).toBeUndefined();
    });
  });

  describe("execute - run_command", () => {
    it("should run allowed command", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("run_command", { command: "echo hello" }),
      );

      expect(result.stdout).toContain("hello");
      expect(result.exitCode).toBe(0);
    });

    it("should reject disallowed command", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("run_command", { command: "malicious-cmd" }),
      );

      expect(result.error).toContain("not allowed");
    });

    it("should support Python commands", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("run_command", { command: "python3 --version" }),
      );

      expect(result.exitCode).toBe(0);
    });

    it("should support Go commands", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("run_command", { command: "go version" }),
      );

      // Go might not be installed - just check we get a result
      expect(result).toBeDefined();
      expect(result).toHaveProperty("exitCode");
    });

    it("should run commands in workspace directory", async () => {
      await writeFile(
        path.join(tempWorkspace, "test-file.txt"),
        "workspace test",
      );

      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("run_command", { command: "pwd" }),
      );

      // macOS returns /private/var/... for /var/...
      const actualPath = result.stdout.trim();
      // Normalize both paths for comparison
      const normalizedActual = actualPath.replace(/^\/private\/var\//, "/var/");
      const normalizedExpected = path
        .resolve(tempWorkspace)
        .replace(/^\/private\/var\//, "/var/");
      expect(normalizedActual).toBe(normalizedExpected);
    });

    it("should use custom timeout", async () => {
      const executor = new ToolExecutor({
        workspaceRoot: tempWorkspace,
        commandTimeout: 100,
        allowedCommands: ["sleep"],
      });
      // Sleep command should timeout
      const result = JSON.parse(
        await executor.execute("run_command", { command: "sleep 1" }),
      );

      expect(result.error).toBe("Command timed out");
    });

    it("should truncate long output", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      // Create a large file and cat it to generate lots of output
      const largeFile = path.join(tempWorkspace, "large.txt");
      await writeFile(largeFile, "a".repeat(20000));
      const result = JSON.parse(
        await executor.execute("run_command", { command: "cat large.txt" }),
      );

      expect(result.stdout).toContain("[truncated]");
      expect(result.stdout.length).toBeLessThan(20000);
    });

    it("should support project-specific commands", async () => {
      await writeFile(
        path.join(tempWorkspace, "Makefile"),
        "test:\n\t@echo make test ran\n",
      );

      const executor = await ToolExecutor.create({
        workspaceRoot: tempWorkspace,
      });
      const result = JSON.parse(
        await executor.execute("run_command", { command: "make test" }),
      );

      expect(result.stdout).toContain("make test ran");
    });
  });

  describe("execute - search_files", () => {
    beforeEach(async () => {
      await writeFile(
        path.join(tempWorkspace, "file1.txt"),
        "line 1: hello\nline 2: world\nline 3: hello",
      );
      await writeFile(
        path.join(tempWorkspace, "file2.ts"),
        "const hello = 'world';\nconsole.log(hello);",
      );
      await mkdir(path.join(tempWorkspace, "dir"));
      await writeFile(
        path.join(tempWorkspace, "dir", "file3.py"),
        "def hello():\n    pass",
      );
    });

    it("should find matching text across files", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("search_files", { pattern: "hello" }),
      );

      expect(result.matches.length).toBeGreaterThan(0);
      const match = result.matches.find((m: any) =>
        m.content.includes("hello"),
      );
      expect(match).toBeDefined();
    });

    it("should respect filePattern parameter", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("search_files", {
          pattern: "hello",
          filePattern: "*.ts",
        }),
      );

      expect(result.matches.length).toBeGreaterThan(0);
      // Only .ts files should match
      for (const match of result.matches) {
        expect(match.path).toMatch(/\.ts$/);
      }
    });

    it("should limit matches with maxMatches", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("search_files", {
          pattern: "hello",
          maxMatches: 2,
        }),
      );

      expect(result.matches.length).toBeLessThanOrEqual(2);
    });

    it("should return line numbers", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("search_files", { pattern: "world" }),
      );

      const match = result.matches[0];
      expect(match.line).toBeGreaterThan(0);
      expect(match.path).toBeDefined();
    });
  });

  describe("execute - task_complete", () => {
    it("should return completion status", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(
        await executor.execute("task_complete", { summary: "All done!" }),
      );

      expect(result.complete).toBe(true);
      expect(result.summary).toBe("All done!");
    });

    it("should work without summary", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(await executor.execute("task_complete", {}));

      expect(result.complete).toBe(true);
    });
  });

  describe("execute - unknown tool", () => {
    it("should return error for unknown tool", async () => {
      const executor = new ToolExecutor({ workspaceRoot: tempWorkspace });
      const result = JSON.parse(await executor.execute("unknown_tool", {}));

      expect(result.error).toContain("Unknown tool");
    });
  });
});
