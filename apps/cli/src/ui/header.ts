import { cwd } from "node:process";
import color from "picocolors";

/**
 * Format model identifier to a friendly display name
 */
function formatModelName(model: string): string {
  if (model.startsWith("claude-opus")) {
    return model.replace("claude-opus-", "Claude Opus ");
  }
  if (model.startsWith("claude-sonnet")) {
    return model.replace("claude-sonnet-", "Claude Sonnet ");
  }
  if (model.startsWith("claude-haiku")) {
    return model.replace("claude-haiku-", "Claude Haiku ");
  }
  return model;
}

/**
 * Get version from package.json or fallback to default
 */
function getVersion(): string {
  // Hardcoded version from package.json
  return "1.0.0";
}

/**
 * Shorten workspace path using ~ for home directory
 */
function shortenPath(workspaceRoot: string): string {
  const home = process.env.HOME || "";
  if (workspaceRoot.startsWith(home)) {
    return `~${workspaceRoot.slice(home.length)}`;
  }
  return workspaceRoot;
}

/**
 * Render the branded Cerebro header
 */
export async function renderHeader(
  workspaceRoot: string = cwd(),
): Promise<void> {
  const version = getVersion();
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const friendlyModel = formatModelName(model);
  const displayPath = shortenPath(workspaceRoot);
  const mode = "Agentic Mode";

  const cyan = color.cyan;

  // ASCII art for CEREBRO (7 letters)
  const logo = [
    `  ${cyan("██████╗███████╗██████╗ ███████╗██████╗ ██████╗  ██████╗")}`,
    `  ${cyan("██╔════╝██╔════╝██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔═══██╗")}`,
    `  ${cyan("██║     █████╗  ██████╔╝█████╗  ██████╔╝██████╔╝██║   ██║")}`,
    `  ${cyan("██║     ██╔══╝  ██╔══██╗██╔══╝  ██╔══██╗██╔══██╗██║   ██║")}`,
    `  ${cyan("╚██████╗███████╗██║  ██║███████╗██████╔╝██║  ██║╚██████╔╝")}`,
    `  ${cyan(" ╚═════╝╚══════╝╚═╝  ╚═╝╚══════╝╚═════╝╚═╝  ╚═╝ ╚═════╝")}`,
  ];

  const borderTop =
    "╔════════════════════════════════════════════════════════════╗";
  const borderBottom =
    "╚════════════════════════════════════════════════════════════╝";

  // Info line: version · model · mode
  const infoLine = `  ${version} · ${friendlyModel} · ${mode}`;
  const infoLinePadded = `║${infoLine.padEnd(60)}║`;

  // Path line
  const pathLinePadded = `║${`  ${displayPath}`.padEnd(60)}║`;

  // Empty lines
  const emptyLine =
    "║                                                            ║";

  // Logo lines with border and padding
  const logoLines = logo.map((line) => `║${line.padEnd(60)}║`);

  console.log("");
  console.log(borderTop);
  console.log(emptyLine);
  for (const line of logoLines) {
    console.log(line);
  }
  console.log(emptyLine);
  console.log(infoLinePadded);
  console.log(pathLinePadded);
  console.log(emptyLine);
  console.log(borderBottom);
  console.log("");
}
