import { describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWorkspace } from "./scanner";

async function mockDir(
  basePath: string,
  files: Record<string, string>,
): Promise<void> {
  await mkdir(basePath, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([path, content]) =>
      writeFile(join(basePath, path), content),
    ),
  );
}

describe("scanWorkspace", () => {
  it("detects a Next.js project", async () => {
    const dir = join(tmpdir(), `test-nextjs-${Date.now()}`);
    await mockDir(dir, {
      "package.json": JSON.stringify({
        name: "test-nextjs",
        dependencies: { next: "15.0.0", react: "19.0.0" },
      }),
      "next.config.js": "export default {};",
      "tsconfig.json": "{}",
      "bun.lockb": "lockfile-content",
    });

    const profile = await scanWorkspace(dir);

    expect(profile.runtime).toBe("bun");
    expect(profile.language).toBe("typescript");
    expect(profile.framework).toBe("next");
    expect(profile.packageManager).toBe("bun");
    expect(profile.dependencies).toContain("next");
  });

  it("detects a Python FastAPI project", async () => {
    const dir = join(tmpdir(), `test-fastapi-${Date.now()}`);
    await mockDir(dir, {
      "pyproject.toml": '[project]\ndependencies = ["fastapi", "uvicorn"]',
      "requirements.txt": "fastapi==0.100.0\nuvicorn==0.23.0",
    });

    const profile = await scanWorkspace(dir);

    expect(profile.runtime).toBe("unknown");
    expect(profile.language).toBe("python");
    expect(profile.framework).toBe("fastapi");
    expect(profile.packageManager).toBe("pip");
    expect(profile.testRunner).toBe("unknown");
  });

  it("detects a Hono project", async () => {
    const dir = join(tmpdir(), `test-hono-${Date.now()}`);
    await mockDir(dir, {
      "package.json": JSON.stringify({
        name: "test-hono",
        dependencies: { hono: "4.0.0", "@hono/zod-validator": "0.1.0" },
      }),
      "biome.json": "{}",
      "tsconfig.json": "{}",
      "bun.lockb": "lockfile-content",
    });

    const profile = await scanWorkspace(dir);

    expect(profile.runtime).toBe("bun");
    expect(profile.language).toBe("typescript");
    expect(profile.framework).toBe("hono");
    expect(profile.linter).toBe("biome");
    expect(profile.dependencies).toContain("hono");
  });

  it("detects monorepo with turbo.json", async () => {
    const dir = join(tmpdir(), `test-monorepo-${Date.now()}`);
    await mockDir(dir, {
      "package.json": JSON.stringify({
        name: "monorepo",
        workspaces: ["apps/*", "packages/*"],
      }),
      "turbo.json": "{}",
    });

    const profile = await scanWorkspace(dir);

    expect(profile.monorepo).toBe(true);
  });

  it("detects database dependencies", async () => {
    const dir = join(tmpdir(), `test-db-${Date.now()}`);
    await mockDir(dir, {
      "package.json": JSON.stringify({
        name: "test-db",
        dependencies: { pg: "8.11.0", "drizzle-orm": "0.29.0" },
      }),
    });

    const profile = await scanWorkspace(dir);

    expect(profile.database).toBe("postgresql");
  });

  it("returns unknown for empty directory", async () => {
    const dir = join(tmpdir(), `test-empty-${Date.now()}`);
    await mkdir(dir, { recursive: true });

    const profile = await scanWorkspace(dir);

    expect(profile.runtime).toBe("unknown");
    expect(profile.language).toBe("unknown");
    expect(profile.framework).toBe("unknown");
    expect(profile.monorepo).toBe(false);
    expect(profile.dependencies).toEqual([]);
  });
});
