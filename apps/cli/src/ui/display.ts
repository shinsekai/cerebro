import type { TokenUsage } from "@cerebro/core";
import color from "picocolors";

// Agent keys that have token/cost data (excluding 'model' which is a string)
type AgentKey = Exclude<keyof TokenUsage, "model">;

/**
 * Render a compact token summary panel showing only active agents
 */
export function renderTokenSummary(usage: TokenUsage, startTime: number): void {
  const agents: AgentKey[] = [
    "orchestrator",
    "frontend",
    "backend",
    "quality",
    "security",
    "tester",
    "ops",
  ];
  const active = agents.filter((a) => {
    const u = usage[a];
    return u?.tokens && u.tokens > 0;
  });

  console.log();
  console.log(color.dim("  ┌─ Cost Summary ──────────────────────────┐"));
  for (const agent of active) {
    const u = usage[agent];
    if (!u) continue;
    const model = agent === "orchestrator" ? "opus" : "sonnet";
    const name = agent.charAt(0).toUpperCase() + agent.slice(1);
    const tokStr = u.tokens.toLocaleString().padStart(8);
    const costStr = `$${u.cost.toFixed(3)}`.padStart(8);
    console.log(
      color.dim("  │ ") +
        `${name.padEnd(14)} ${color.yellow(tokStr)} tok  ${color.dim(costStr)}  ${color.dim(model)}` +
        color.dim(" │"),
    );
  }
  console.log(color.dim("  │─────────────────────────────────────────│"));
  const totalTok = (usage.total?.tokens || 0).toLocaleString().padStart(8);
  const totalCost = `$${(usage.total?.cost || 0).toFixed(3)}`.padStart(8);
  console.log(
    color.dim("  │ ") +
      `${color.bold("Total".padEnd(14))} ${color.magenta(totalTok)} tok  ${color.bold(totalCost)}` +
      color.dim("        │"),
  );
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `${color.dim("  │ ")}${color.dim("Duration".padEnd(14))} ${color.dim(`${duration}s`)}${color.dim("                       │")}`,
  );
  console.log(color.dim("  └─────────────────────────────────────────┘"));
  console.log();
}

/**
 * Render a colored unified diff line
 */
export function renderDiffLine(line: string): string {
  if (line.startsWith("@@")) {
    return color.cyan(line); // Hunk headers
  } else if (line.startsWith("+")) {
    return color.green(line); // Additions
  } else if (line.startsWith("-")) {
    return color.red(line); // Deletions
  } else if (line.startsWith("---") || line.startsWith("+++")) {
    return color.cyan(line); // File headers
  } else {
    return color.gray(line); // Context
  }
}

/**
 * Display file content or diff
 */
export function displayFileContent(file: {
  path: string;
  operation: string;
  content: string;
  diff?: string;
}) {
  console.log(
    color.dim(`  ${file.operation} ${file.content.length} characters`),
  );
  console.log(color.dim("─".repeat(50)));

  if (file.operation === "update" && file.diff) {
    // Display colored unified diff for updates
    const lines = file.diff.split("\n");
    if (lines.length > 20) {
      console.log(lines.slice(0, 20).map(renderDiffLine).join("\n"));
      console.log(color.dim(`... (${lines.length - 20} more lines)`));
    } else {
      console.log(lines.map(renderDiffLine).join("\n"));
    }
  } else {
    // Display full content for creates or when diff is missing
    const lines = file.content.split("\n");
    if (lines.length > 20) {
      console.log(color.gray(lines.slice(0, 20).join("\n")));
      console.log(color.dim(`... (${lines.length - 20} more lines)`));
    } else {
      console.log(color.gray(lines.join("\n")));
    }
  }
  console.log(color.dim(`${"─".repeat(50)}\n`));
}
