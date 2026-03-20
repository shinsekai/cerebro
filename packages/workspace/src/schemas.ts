import { z } from "zod";

export const RuntimeSchema = z.enum(["bun", "node", "deno", "unknown"]);
export type Runtime = z.infer<typeof RuntimeSchema>;

export const LanguageSchema = z.enum([
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "unknown",
]);
export type Language = z.infer<typeof LanguageSchema>;

export const FrameworkSchema = z.enum([
  "next",
  "nuxt",
  "remix",
  "svelte",
  "hono",
  "express",
  "fastify",
  "fastapi",
  "gin",
  "actix",
  "none",
  "unknown",
]);
export type Framework = z.infer<typeof FrameworkSchema>;

export const TestRunnerSchema = z.enum([
  "vitest",
  "jest",
  "bun-test",
  "pytest",
  "go-test",
  "unknown",
]);
export type TestRunner = z.infer<typeof TestRunnerSchema>;

export const LinterSchema = z.enum([
  "biome",
  "eslint",
  "prettier",
  "ruff",
  "unknown",
]);
export type Linter = z.infer<typeof LinterSchema>;

export const DatabaseSchema = z.enum([
  "postgresql",
  "mysql",
  "sqlite",
  "mongodb",
  "none",
  "unknown",
]);
export type Database = z.infer<typeof DatabaseSchema>;

export const PackageManagerSchema = z.enum([
  "bun",
  "npm",
  "yarn",
  "pnpm",
  "cargo",
  "pip",
  "go-mod",
  "unknown",
]);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

export const WorkspaceProfileSchema = z.object({
  runtime: RuntimeSchema,
  language: LanguageSchema,
  framework: FrameworkSchema,
  testRunner: TestRunnerSchema,
  linter: LinterSchema,
  database: DatabaseSchema,
  packageManager: PackageManagerSchema,
  monorepo: z.boolean(),
  dependencies: z.array(z.string()),
});
export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;
