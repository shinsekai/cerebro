import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import path from "path";
import { selectRelevantFiles } from "./fileSelector.js";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(
    path.join(process.env.TMPDIR || "/tmp", "cerebro-test-"),
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function setupTempProject(): Promise<void> {
  await mkdir(path.join(tempDir, "src", "auth"), { recursive: true });
  await mkdir(path.join(tempDir, "src", "components"), { recursive: true });
  await mkdir(path.join(tempDir, "src", "lib"), { recursive: true });

  await writeFile(
    path.join(tempDir, "package.json"),
    JSON.stringify({ name: "test-project", version: "1.0.0" }),
  );

  await writeFile(
    path.join(tempDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );

  await writeFile(
    path.join(tempDir, "src", "auth", "login.ts"),
    "export function login(username: string, password: string) {\n  // authentication logic\n  return { token: 'jwt-token', user: username };\n}\n",
  );

  await writeFile(
    path.join(tempDir, "src", "auth", "middleware.ts"),
    "export function authMiddleware(req: any) {\n  const token = req.headers.authorization;\n  if (!token) throw new Error('Unauthorized');\n  return req;\n}\n",
  );

  await writeFile(
    path.join(tempDir, "src", "components", "Button.tsx"),
    "export function Button({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {\n  return <button onClick={onClick}>{children}</button>;\n}\n",
  );

  await writeFile(
    path.join(tempDir, "src", "lib", "db.ts"),
    "export const db = {\n  connect: () => console.log('Connected to database'),\n  query: (sql: string) => console.log('Query:', sql),\n};\n",
  );

  await writeFile(
    path.join(tempDir, ".gitignore"),
    "node_modules\ndist\n*.log\n",
  );
}

describe("selectRelevantFiles", () => {
  it("should score login.ts higher than Button.tsx for login task", async () => {
    await setupTempProject();

    const results = await selectRelevantFiles(
      tempDir,
      "Add a login page with authentication",
    );

    const loginFile = results.find((f) => f.path.endsWith("login.ts"));
    const buttonFile = results.find((f) => f.path.endsWith("Button.tsx"));

    expect(loginFile).toBeDefined();
    expect(buttonFile).toBeDefined();

    expect(loginFile!.score).toBeGreaterThan(buttonFile!.score);
  });

  it("should always include package.json", async () => {
    await setupTempProject();

    const results = await selectRelevantFiles(tempDir, "Add some feature");

    const packageJson = results.find((f) => f.path === "package.json");

    expect(packageJson).toBeDefined();
    expect(packageJson?.score).toBe(50);
  });

  it("should always include tsconfig.json at root", async () => {
    await setupTempProject();

    const results = await selectRelevantFiles(tempDir, "Add some feature");

    const tsconfigJson = results.find((f) => f.path === "tsconfig.json");

    expect(tsconfigJson).toBeDefined();
    expect(tsconfigJson?.score).toBe(50);
  });

  it("should include files matching includePatterns with bonus score", async () => {
    await setupTempProject();

    const results = await selectRelevantFiles(tempDir, "Add some feature", {
      includePatterns: ["src/auth/*"],
    });

    const authFiles = results.filter((f) => f.path.startsWith("src/auth/"));

    expect(authFiles.length).toBeGreaterThan(0);
    authFiles.forEach((file) => {
      expect(file.score).toBe(50);
    });
  });

  it("should exclude files matching excludePatterns", async () => {
    await setupTempProject();

    const results = await selectRelevantFiles(tempDir, "Add some feature", {
      excludePatterns: ["src/components/*"],
    });

    const componentFiles = results.filter((f) =>
      f.path.startsWith("src/components/"),
    );

    expect(componentFiles.length).toBe(0);
  });

  it("should limit results to maxFiles", async () => {
    await setupTempProject();

    const results = await selectRelevantFiles(tempDir, "Add some feature", {
      maxFiles: 2,
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should enforce maxTotalTokens with truncation", async () => {
    await setupTempProject();

    const largeContent = "x".repeat(20000);
    await writeFile(path.join(tempDir, "large.ts"), largeContent);

    const results = await selectRelevantFiles(tempDir, "Use large file", {
      maxTotalTokens: 1000,
    });

    const largeFile = results.find((f) => f.path === "large.ts");

    if (largeFile) {
      expect(largeFile.truncated).toBe(true);
      expect(largeFile.content.length).toBeLessThan(4000);
    }
  });

  it("should set truncated=false when file fits in token budget", async () => {
    await setupTempProject();

    const results = await selectRelevantFiles(tempDir, "Add some feature", {
      maxTotalTokens: 100000,
    });

    results.forEach((file) => {
      if (!file.truncated) {
        expect(file.content.length).toBeGreaterThan(0);
      }
    });
  });

  it("should skip files larger than 100KB", async () => {
    await setupTempProject();

    const hugeContent = "x".repeat(1024 * 101);
    await writeFile(path.join(tempDir, "huge.ts"), hugeContent);

    const results = await selectRelevantFiles(tempDir, "Use huge file");

    const hugeFile = results.find((f) => f.path === "huge.ts");

    expect(hugeFile).toBeUndefined();
  });

  it("should only consider allowed file extensions", async () => {
    await setupTempProject();

    await writeFile(path.join(tempDir, "image.png"), "fake binary content");
    await writeFile(path.join(tempDir, "data.bin"), "binary data");

    const results = await selectRelevantFiles(tempDir, "Add some feature");

    const pngFile = results.find((f) => f.path.endsWith(".png"));
    const binFile = results.find((f) => f.path.endsWith(".bin"));

    expect(pngFile).toBeUndefined();
    expect(binFile).toBeUndefined();
  });

  it("should include .env.example files", async () => {
    await setupTempProject();

    await writeFile(
      path.join(tempDir, ".env.example"),
      "API_KEY=secret\nDB_URL=localhost\n",
    );

    const results = await selectRelevantFiles(tempDir, "Configure environment");

    const envExample = results.find((f) => f.path === ".env.example");

    expect(envExample).toBeDefined();
  });

  it("should return results sorted by score (highest first)", async () => {
    await setupTempProject();

    const results = await selectRelevantFiles(
      tempDir,
      "Add authentication and login",
    );

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("should extract keywords from task description", async () => {
    await setupTempProject();

    const results = await selectRelevantFiles(
      tempDir,
      "Create login authentication page",
    );

    const authRelated = results.filter(
      (f) => f.path.includes("auth") || f.path.includes("login"),
    );

    expect(authRelated.length).toBeGreaterThan(0);
  });

  it("should exclude node_modules and other always-skip directories", async () => {
    await setupTempProject();

    await mkdir(path.join(tempDir, "node_modules", "some-package"), {
      recursive: true,
    });
    await writeFile(
      path.join(tempDir, "node_modules", "some-package", "index.ts"),
      "module content",
    );

    const results = await selectRelevantFiles(tempDir, "Add some feature");

    const nodeModulesFiles = results.filter((f) =>
      f.path.includes("node_modules"),
    );

    expect(nodeModulesFiles.length).toBe(0);
  });
});
