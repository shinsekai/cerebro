import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Database,
  Framework,
  Language,
  Linter,
  PackageManager,
  Runtime,
  TestRunner,
  WorkspaceProfile,
} from "./schemas.js";
import { WorkspaceProfileSchema } from "./schemas.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function detectRuntime(rootPath: string): Promise<Runtime> {
  if (
    (await fileExists(join(rootPath, "bun.lockb"))) ||
    (await fileExists(join(rootPath, "bun.lock")))
  ) {
    return "bun";
  }
  if (await fileExists(join(rootPath, "package.json"))) {
    return "node";
  }
  if (await fileExists(join(rootPath, "deno.json"))) {
    return "deno";
  }
  return "unknown";
}

async function detectLanguage(rootPath: string): Promise<Language> {
  if (await fileExists(join(rootPath, "tsconfig.json"))) {
    return "typescript";
  }
  if (await fileExists(join(rootPath, "package.json"))) {
    return "javascript";
  }
  if (
    (await fileExists(join(rootPath, "pyproject.toml"))) ||
    (await fileExists(join(rootPath, "requirements.txt")))
  ) {
    return "python";
  }
  if (await fileExists(join(rootPath, "Cargo.toml"))) {
    return "rust";
  }
  if (await fileExists(join(rootPath, "go.mod"))) {
    return "go";
  }
  return "unknown";
}

async function detectFramework(
  rootPath: string,
  deps: string[],
): Promise<Framework> {
  // Check by config files first
  if (
    (await fileExists(join(rootPath, "next.config.js"))) ||
    (await fileExists(join(rootPath, "next.config.mjs"))) ||
    (await fileExists(join(rootPath, "next.config.ts")))
  ) {
    return "next";
  }
  if (
    (await fileExists(join(rootPath, "nuxt.config.js"))) ||
    (await fileExists(join(rootPath, "nuxt.config.ts")))
  ) {
    return "nuxt";
  }
  if (
    (await fileExists(join(rootPath, "remix.config.js"))) ||
    (await fileExists(join(rootPath, "remix.config.ts")))
  ) {
    return "remix";
  }
  if (
    (await fileExists(join(rootPath, "svelte.config.js"))) ||
    (await fileExists(join(rootPath, "svelte.config.ts")))
  ) {
    return "svelte";
  }

  // Check by dependencies
  const depsLower = deps.map((d) => d.toLowerCase());
  if (depsLower.some((d) => d.includes("hono"))) {
    return "hono";
  }
  if (depsLower.some((d) => d.includes("express"))) {
    return "express";
  }
  if (depsLower.some((d) => d.includes("fastify"))) {
    return "fastify";
  }
  if (depsLower.some((d) => d.includes("fastapi"))) {
    return "fastapi";
  }
  if (depsLower.some((d) => d.includes("gin"))) {
    return "gin";
  }
  if (depsLower.some((d) => d.includes("actix"))) {
    return "actix";
  }

  return "unknown";
}

async function detectTestRunner(
  rootPath: string,
  deps: string[],
): Promise<TestRunner> {
  if (
    (await fileExists(join(rootPath, "vitest.config.js"))) ||
    (await fileExists(join(rootPath, "vitest.config.ts")))
  ) {
    return "vitest";
  }
  if (
    (await fileExists(join(rootPath, "jest.config.js"))) ||
    (await fileExists(join(rootPath, "jest.config.ts"))) ||
    (await fileExists(join(rootPath, "jest.config.mjs")))
  ) {
    return "jest";
  }
  if (
    (await fileExists(join(rootPath, "pytest.ini"))) ||
    deps.some((d) => d.includes("pytest"))
  ) {
    return "pytest";
  }
  const depsLower = deps.map((d) => d.toLowerCase());
  if (depsLower.some((d) => d === "bun:test" || d === "bun-test")) {
    return "bun-test";
  }

  // Check for go-test (standard)
  const isGo = await fileExists(join(rootPath, "go.mod"));
  if (isGo) {
    return "go-test";
  }

  return "unknown";
}

async function detectLinter(rootPath: string): Promise<Linter> {
  if (
    (await fileExists(join(rootPath, "biome.json"))) ||
    (await fileExists(join(rootPath, "biome.jsonc")))
  ) {
    return "biome";
  }
  if (
    (await fileExists(join(rootPath, ".eslintrc.js"))) ||
    (await fileExists(join(rootPath, ".eslintrc.json"))) ||
    (await fileExists(join(rootPath, ".eslintrc.cjs"))) ||
    (await fileExists(join(rootPath, ".eslintrc.yaml"))) ||
    (await fileExists(join(rootPath, ".eslintrc.yml")))
  ) {
    return "eslint";
  }
  if (
    (await fileExists(join(rootPath, "prettier.config.js"))) ||
    (await fileExists(join(rootPath, "prettier.config.cjs"))) ||
    (await fileExists(join(rootPath, "prettier.config.mjs"))) ||
    (await fileExists(join(rootPath, ".prettierrc"))) ||
    (await fileExists(join(rootPath, ".prettierrc.json")))
  ) {
    return "prettier";
  }
  if (
    (await fileExists(join(rootPath, "ruff.toml"))) ||
    (await fileExists(join(rootPath, ".ruff.toml")))
  ) {
    return "ruff";
  }
  return "unknown";
}

async function detectDatabase(
  rootPath: string,
  deps: string[],
): Promise<Database> {
  // Check for Prisma schema
  if (await fileExists(join(rootPath, "prisma/schema.prisma"))) {
    return "postgresql"; // Default assumption for Prisma
  }

  const depsLower = deps.map((d) => d.toLowerCase());
  if (depsLower.some((d) => d.includes("pg") || d.includes("postgres"))) {
    return "postgresql";
  }
  if (depsLower.some((d) => d.includes("mysql") || d.includes("mysql2"))) {
    return "mysql";
  }
  if (depsLower.some((d) => d.includes("sqlite"))) {
    return "sqlite";
  }
  if (depsLower.some((d) => d.includes("mongoose") || d.includes("mongodb"))) {
    return "mongodb";
  }

  // Check Python deps
  if (await fileExists(join(rootPath, "requirements.txt"))) {
    const reqPath = join(rootPath, "requirements.txt");
    try {
      const reqContent = await readFile(reqPath, "utf-8");
      const reqLower = reqContent.toLowerCase();
      if (reqLower.includes("psycopg") || reqLower.includes("asyncpg")) {
        return "postgresql";
      }
      if (
        reqLower.includes("pymysql") ||
        reqLower.includes("mysql-connector")
      ) {
        return "mysql";
      }
      if (reqLower.includes("sqlite") && !reqLower.includes("mssql")) {
        return "sqlite";
      }
      if (reqLower.includes("pymongo") || reqLower.includes("motor")) {
        return "mongodb";
      }
    } catch {
      // Ignore errors reading requirements.txt
    }
  }

  return "unknown";
}

async function detectPackageManager(rootPath: string): Promise<PackageManager> {
  if (
    (await fileExists(join(rootPath, "bun.lockb"))) ||
    (await fileExists(join(rootPath, "bun.lock")))
  ) {
    return "bun";
  }
  if (await fileExists(join(rootPath, "package-lock.json"))) {
    return "npm";
  }
  if (await fileExists(join(rootPath, "yarn.lock"))) {
    return "yarn";
  }
  if (await fileExists(join(rootPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (
    (await fileExists(join(rootPath, "Cargo.lock"))) ||
    (await fileExists(join(rootPath, "Cargo.toml")))
  ) {
    return "cargo";
  }
  if (
    (await fileExists(join(rootPath, "pyproject.toml"))) ||
    (await fileExists(join(rootPath, "requirements.txt")))
  ) {
    return "pip";
  }
  if (await fileExists(join(rootPath, "go.mod"))) {
    return "go-mod";
  }
  return "unknown";
}

async function detectMonorepo(rootPath: string): Promise<boolean> {
  // Check for turbo.json
  if (await fileExists(join(rootPath, "turbo.json"))) {
    return true;
  }

  // Check for workspaces in package.json
  const pkgPath = join(rootPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkgContent = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(pkgContent);
      if (
        pkg.workspaces &&
        Array.isArray(pkg.workspaces) &&
        pkg.workspaces.length > 0
      ) {
        return true;
      }
    } catch {
      // Ignore errors parsing package.json
    }
  }

  // Check for pnpm-workspace.yaml
  if (await fileExists(join(rootPath, "pnpm-workspace.yaml"))) {
    return true;
  }

  // Check for yarn workspaces (yarn.lock + workspaces in package.json)
  if (await fileExists(join(rootPath, "yarn.lock"))) {
    if (existsSync(pkgPath)) {
      try {
        const pkgContent = await readFile(pkgPath, "utf-8");
        const pkg = JSON.parse(pkgContent);
        if (
          pkg.workspaces &&
          Array.isArray(pkg.workspaces) &&
          pkg.workspaces.length > 0
        ) {
          return true;
        }
      } catch {
        // Ignore errors
      }
    }
  }

  // Check for go workspaces
  if (await fileExists(join(rootPath, "go.work"))) {
    return true;
  }

  return false;
}

async function getDependencies(rootPath: string): Promise<string[]> {
  // Try package.json first
  const pkgPath = join(rootPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkgContent = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(pkgContent);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return Object.keys(deps);
    } catch {
      // Ignore errors
    }
  }

  // Try Python requirements.txt
  const reqPath = join(rootPath, "requirements.txt");
  if (await fileExists(reqPath)) {
    try {
      const reqContent = await readFile(reqPath, "utf-8");
      // Parse package names from requirements.txt (ignoring version specifiers)
      return reqContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split(/[=<>~!;]+/)[0].trim())
        .filter(Boolean);
    } catch {
      // Ignore errors
    }
  }

  // Try Python pyproject.toml
  const pyprojectPath = join(rootPath, "pyproject.toml");
  if (await fileExists(pyprojectPath)) {
    try {
      const pyprojectContent = await readFile(pyprojectPath, "utf-8");
      // Simple parsing for dependencies in pyproject.toml
      const depsMatch = pyprojectContent.match(
        /dependencies\s*=\s*\[([\s\S]*?)\]/,
      );
      if (depsMatch) {
        const depsString = depsMatch[1];
        return depsString
          .split(/,\s*/)
          .map(
            (dep) =>
              dep
                .trim()
                .replace(/["']/g, "")
                .split(/[=<>~!]+/)[0],
          )
          .filter(Boolean);
      }
    } catch {
      // Ignore errors
    }
  }

  return [];
}

export async function scanWorkspace(
  rootPath: string,
): Promise<WorkspaceProfile> {
  const dependencies = await getDependencies(rootPath);
  const [
    runtime,
    language,
    framework,
    testRunner,
    linter,
    database,
    packageManager,
    monorepo,
  ] = await Promise.all([
    detectRuntime(rootPath),
    detectLanguage(rootPath),
    detectFramework(rootPath, dependencies),
    detectTestRunner(rootPath, dependencies),
    detectLinter(rootPath),
    detectDatabase(rootPath, dependencies),
    detectPackageManager(rootPath),
    detectMonorepo(rootPath),
  ]);

  const profile: WorkspaceProfile = {
    runtime,
    language,
    framework,
    testRunner,
    linter,
    database,
    packageManager,
    monorepo,
    dependencies,
  };

  return WorkspaceProfileSchema.parse(profile);
}
