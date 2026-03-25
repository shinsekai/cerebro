import fs from "node:fs/promises";
import path from "node:path";
import color from "picocolors";

interface CheckResult {
  message: string;
  status: "pass" | "warn" | "dim";
}

async function checkApiKey(): Promise<CheckResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.length > 0) {
    return {
      message: `${color.green("✓")} API key configured`,
      status: "pass",
    };
  }
  return {
    message: `${color.yellow("⚠")} ANTHROPIC_API_KEY not set — export ANTHROPIC_API_KEY=sk-...`,
    status: "warn",
  };
}

async function checkEngineConnectivity(): Promise<CheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch("http://localhost:8080/", {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      return {
        message: `${color.green("✓")} Engine connected (port 8080)`,
        status: "pass",
      };
    }
    throw new Error("Engine returned non-ok status");
  } catch {
    return {
      message: `${color.dim("○")} Engine offline — run: make dev-engine`,
      status: "dim",
    };
  }
}

async function checkWorkspace(workspaceRoot: string): Promise<CheckResult> {
  const profilePath = path.join(workspaceRoot, ".cerebro", "profile.json");
  try {
    await fs.access(profilePath);
    const content = await fs.readFile(profilePath, "utf-8");
    const profile = JSON.parse(content);
    const framework = profile.framework || "unknown";
    const language = profile.language || "unknown";
    return {
      message: `${color.green("✓")} Workspace initialized (${framework} / ${language})`,
      status: "pass",
    };
  } catch {
    return {
      message: `${color.dim("○")} Not initialized — run: cerebro init`,
      status: "dim",
    };
  }
}

async function checkVoyageApiKey(): Promise<CheckResult | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    return null; // Optional check, skip if not set
  }
  if (apiKey.length > 0) {
    return {
      message: `${color.green("✓")} Semantic search enabled`,
      status: "pass",
    };
  }
  return null;
}

export async function checkEnvironment(workspaceRoot: string): Promise<void> {
  const results = await Promise.allSettled([
    checkApiKey(),
    checkEngineConnectivity(),
    checkWorkspace(workspaceRoot),
    checkVoyageApiKey(),
  ]);

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      console.log(result.value.message);
    }
  }

  console.log("");
}
