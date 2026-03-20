import { describe, it, expect } from "bun:test";
import { buildDirectoryTree } from "./tree.js";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("buildDirectoryTree", () => {
  it("should build a simple tree structure", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cerebro-tree-"));

    try {
      await writeFile(join(tempDir, "package.json"), "{}");
      await mkdir(join(tempDir, "src"));
      await writeFile(join(tempDir, "src", "index.ts"), "");
      await mkdir(join(tempDir, "src", "lib"));
      await writeFile(join(tempDir, "src", "lib", "utils.ts"), "");

      const result = await buildDirectoryTree(tempDir);

      expect(result).toContain("src/");
      expect(result).toContain("src/");
      expect(result).toContain("index.ts");
      expect(result).toContain("lib/");
      expect(result).toContain("utils.ts");
      expect(result).toContain("package.json");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should skip node_modules and .git directories", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cerebro-tree-"));

    try {
      await mkdir(join(tempDir, "node_modules"));
      await mkdir(join(tempDir, "node_modules", "pkg"));
      await writeFile(join(tempDir, "node_modules", "pkg", "index.js"), "");
      await mkdir(join(tempDir, ".git"));
      await mkdir(join(tempDir, ".git", "objects"));
      await mkdir(join(tempDir, "src"));
      await writeFile(join(tempDir, "src", "main.ts"), "");
      await mkdir(join(tempDir, "dist"));
      await writeFile(join(tempDir, "dist", "bundle.js"), "");
      await writeFile(join(tempDir, "index.ts"), "");

      const result = await buildDirectoryTree(tempDir);

      expect(result).not.toContain("node_modules/");
      expect(result).not.toContain(".git/");
      expect(result).not.toContain("dist/");
      expect(result).not.toContain("bundle.js");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should respect maxDepth option", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cerebro-tree-"));

    try {
      await mkdir(join(tempDir, "src"));
      await mkdir(join(tempDir, "src", "nested"));
      await mkdir(join(tempDir, "src", "nested", "deep"));
      await mkdir(join(tempDir, "src", "nested", "deep", "deeper"));
      await writeFile(
        join(tempDir, "src", "nested", "deep", "deeper", "file.txt"),
        "",
      );

      const result = await buildDirectoryTree(tempDir, { maxDepth: 2 });

      expect(result).toContain("src/");
      expect(result).toContain("nested/");
      expect(result).not.toContain("deep/");
      expect(result).not.toContain("deeper/");
      expect(result).not.toContain("file.txt");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should respect .gitignore patterns", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cerebro-tree-"));

    try {
      await writeFile(join(tempDir, ".gitignore"), "*.log\n.env\nconfig/\n");
      await writeFile(join(tempDir, "debug.log"), "");
      await writeFile(join(tempDir, "app.log"), "");
      await writeFile(join(tempDir, ".env"), "");
      await mkdir(join(tempDir, "config"));
      await writeFile(join(tempDir, "config", "settings.json"), "");
      await writeFile(join(tempDir, "src.ts"), "");

      const result = await buildDirectoryTree(tempDir, {
        respectGitignore: true,
      });

      expect(result).not.toContain("debug.log");
      expect(result).not.toContain("app.log");
      expect(result).not.toContain(".env");
      expect(result).not.toContain("config/");
      expect(result).not.toContain("settings.json");
      expect(result).toContain("src.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should skip .gitignore when respectGitignore is false", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cerebro-tree-"));

    try {
      await writeFile(join(tempDir, ".gitignore"), "*.log\n.env\n");
      await writeFile(join(tempDir, "debug.log"), "");
      await writeFile(join(tempDir, "src.ts"), "");

      const result = await buildDirectoryTree(tempDir, {
        respectGitignore: false,
      });

      expect(result).toContain("debug.log");
      expect(result).toContain("src.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should truncate tree when exceeding maxTokenEstimate", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cerebro-tree-"));

    try {
      await mkdir(join(tempDir, "src"));
      for (let i = 0; i < 100; i++) {
        await writeFile(join(tempDir, `file${i}.ts`), "");
        await writeFile(join(tempDir, "src", `module${i}.ts`), "");
      }

      const result = await buildDirectoryTree(tempDir, {
        maxTokenEstimate: 10,
      });

      expect(result).toContain("... (truncated)");
      expect(result.length).toBeLessThan(100 * 10);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should sort directories before files alphabetically", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cerebro-tree-"));

    try {
      await mkdir(join(tempDir, "z-dir"));
      await writeFile(join(tempDir, "a.ts"), "");
      await mkdir(join(tempDir, "m-dir"));
      await writeFile(join(tempDir, "z.ts"), "");
      await writeFile(join(tempDir, "m.ts"), "");

      const result = await buildDirectoryTree(tempDir);

      const lines = result.split("\n");
      const zDirIndex = lines.findIndex((line) => line.includes("z-dir/"));
      const mDirIndex = lines.findIndex((line) => line.includes("m-dir/"));
      const mFileIndex = lines.findIndex((line) => line === "m.ts");

      expect(zDirIndex).toBeGreaterThan(-1);
      expect(mDirIndex).toBeGreaterThan(-1);

      expect(mDirIndex).toBeLessThan(mFileIndex);
      expect(zDirIndex).toBeLessThan(
        lines.findIndex((line) => line === "z.ts"),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should handle empty directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cerebro-tree-"));

    try {
      const result = await buildDirectoryTree(tempDir);
      expect(result).toBe("");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should skip all always-skip directories", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cerebro-tree-"));

    try {
      const skipDirs = [
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
      ];

      for (const dir of skipDirs) {
        await mkdir(join(tempDir, dir));
        await writeFile(join(tempDir, dir, "file.txt"), "");
      }

      await writeFile(join(tempDir, "src.ts"), "");

      const result = await buildDirectoryTree(tempDir);

      for (const dir of skipDirs) {
        expect(result).not.toContain(`${dir}/`);
      }
      expect(result).toContain("src.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("should handle nested gitignore patterns correctly", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "cerebro-tree-"));

    try {
      await writeFile(join(tempDir, ".gitignore"), "test/");
      await mkdir(join(tempDir, "test"));
      await mkdir(join(tempDir, "test", "nested"));
      await writeFile(join(tempDir, "test", "nested", "file.txt"), "");
      await writeFile(join(tempDir, "othertest.ts"), "");

      const result = await buildDirectoryTree(tempDir, {
        respectGitignore: true,
      });

      expect(result).not.toContain("test/");
      expect(result).toContain("othertest.ts");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
