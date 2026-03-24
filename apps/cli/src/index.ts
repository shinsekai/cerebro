import { type CerebroEvent, Logger } from "@cerebro/core";
import {
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";

/**
 * Render a colored unified diff line
 */
function renderDiffLine(line: string): string {
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
function displayFileContent(file: {
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

import {
  buildDirectoryTree,
  type IndexWorkspaceResult,
  indexWorkspace,
  scanWorkspace,
  type WorkspaceProfile,
} from "@cerebro/workspace";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import color from "picocolors";
import { cwd } from "process";
import { parseArgs } from "util";

// Create logger for CLI component
const log = new Logger("cli");

// --- Actionable Error Messages ---

interface ActionableError {
  message: string;
  debugHint?: string;
}

/**
 * Converts raw error messages into actionable guidance
 */
function getActionableError(rawError: string): ActionableError {
  const errorLower = rawError.toLowerCase();

  // Engine connection errors
  if (
    errorLower.includes("econnrefused") ||
    errorLower.includes("fetch failed") ||
    errorLower.includes("connection refused") ||
    errorLower.includes("engine") ||
    errorLower.includes("localhost:8080")
  ) {
    return {
      message:
        "Engine unreachable on port 8080. Run `make dev-engine` in a separate terminal.",
    };
  }

  // API key errors
  if (
    errorLower.includes("api key") ||
    errorLower.includes("anthropic_api_key") ||
    errorLower.includes("unauthorized") ||
    errorLower.includes("401")
  ) {
    return {
      message:
        "Invalid ANTHROPIC_API_KEY. Set it via: export ANTHROPIC_API_KEY=sk-...",
    };
  }

  // Database connection errors
  if (
    errorLower.includes("econnrefused") &&
    (errorLower.includes("5432") ||
      errorLower.includes("postgres") ||
      errorLower.includes("database"))
  ) {
    return {
      message: "Database unavailable. Run `make db-up` to start PostgreSQL.",
    };
  }

  // Rate limit errors
  if (
    errorLower.includes("rate limit") ||
    errorLower.includes("429") ||
    errorLower.includes("too many requests")
  ) {
    return {
      message: "API rate limited. Wait 60 seconds and retry.",
    };
  }

  // Context too large errors
  if (
    errorLower.includes("context") ||
    errorLower.includes("token") ||
    errorLower.includes("too large") ||
    errorLower.includes("exceeds")
  ) {
    return {
      message:
        "Context exceeds model limit. Try narrowing your task description or running `cerebro init` to index your workspace.",
    };
  }

  // Approval timeout errors
  if (
    errorLower.includes("approval timeout") ||
    errorLower.includes("timed out")
  ) {
    return {
      message:
        "No approval response in 5 minutes. Re-run the command to try again.",
    };
  }

  // Circuit breaker errors
  if (
    errorLower.includes("circuit breaker") ||
    errorLower.includes("3 retries") ||
    errorLower.includes("infinite loop")
  ) {
    return {
      message:
        "Task failed after 3 retries. The error may require manual intervention. Check .cerebro/logs/ for details.",
    };
  }

  // Catch-all
  return {
    message: `Unexpected error: ${rawError}`,
    debugHint: "Run with CEREBRO_LOG_LEVEL=debug for details.",
  };
}

// --- Session State Functions ---

const SESSION_FILE = ".cerebro/session.json";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface SessionState {
  sessionId: string;
  lastTicketId: string;
  lastTask: string;
  agentOutputs: Record<string, string>;
  fileChanges: string[];
  timestamp: string;
}

async function loadSession(
  workspaceRoot: string,
): Promise<SessionState | null> {
  const sessionPath = path.join(workspaceRoot, SESSION_FILE);
  try {
    const content = await fs.readFile(sessionPath, "utf-8");
    const session: SessionState = JSON.parse(content);

    // Check if session is still valid (within 30 minutes)
    const sessionTime = new Date(session.timestamp).getTime();
    const now = Date.now();
    if (now - sessionTime > SESSION_TIMEOUT_MS) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

async function saveSession(
  workspaceRoot: string,
  session: Omit<SessionState, "sessionId" | "timestamp">,
): Promise<void> {
  const sessionPath = path.join(workspaceRoot, SESSION_FILE);
  const cerebroDir = path.dirname(sessionPath);
  await fs.mkdir(cerebroDir, { recursive: true });

  const fullSession: SessionState = {
    ...session,
    sessionId: randomUUID(),
    timestamp: new Date().toISOString(),
  };

  await fs.writeFile(
    sessionPath,
    JSON.stringify(fullSession, null, 2),
    "utf-8",
  );
}

async function clearSession(workspaceRoot: string): Promise<void> {
  const sessionPath = path.join(workspaceRoot, SESSION_FILE);
  try {
    await fs.unlink(sessionPath);
  } catch {
    // File doesn't exist, ignore
  }
}

// --- Execution Log Functions ---

const LOGS_DIR = ".cerebro/logs";

interface LogEntry {
  type: string;
  data?: any;
  timestamp?: number;
  ticketId?: string;
  [key: string]: any;
}

interface LogMetadata {
  ticketId: string;
  task: string;
  timestamp: string;
}

async function ensureLogsDir(workspaceRoot: string): Promise<void> {
  const logsPath = path.join(workspaceRoot, LOGS_DIR);
  await fs.mkdir(logsPath, { recursive: true });
}

async function writeLogEntry(
  workspaceRoot: string,
  ticketId: string,
  entry: LogEntry,
): Promise<void> {
  const logsPath = path.join(workspaceRoot, LOGS_DIR);
  const logFile = path.join(logsPath, `${ticketId}.jsonl`);
  await fs.mkdir(logsPath, { recursive: true });

  const entryWithTimestamp = {
    ...entry,
    timestamp: Date.now(),
    ticketId,
  };

  const line = `${JSON.stringify(entryWithTimestamp)}\n`;
  await fs.appendFile(logFile, line, "utf-8");
}

async function listLogs(workspaceRoot: string): Promise<LogMetadata[]> {
  const logsPath = path.join(workspaceRoot, LOGS_DIR);
  try {
    await fs.access(logsPath);
  } catch {
    return []; // Logs directory doesn't exist
  }

  const entries = await fs.readdir(logsPath, { withFileTypes: true });
  const logs: LogMetadata[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const ticketId = entry.name.slice(0, -6); // Remove .jsonl
      const logFile = path.join(logsPath, entry.name);

      try {
        const content = await fs.readFile(logFile, "utf-8");
        const lines = content.trim().split("\n");

        if (lines.length > 0) {
          const firstEntry = JSON.parse(lines[0]) as LogEntry;
          const timestamp = firstEntry.timestamp
            ? new Date(firstEntry.timestamp).toISOString()
            : new Date().toISOString();

          // Try to find the task from any 'done' or start event
          let task = "Unknown task";
          for (const line of lines) {
            try {
              const e = JSON.parse(line) as LogEntry;
              if (e.type === "done" && e.data?.ticket?.task) {
                task = e.data.ticket.task;
                break;
              }
            } catch {}
          }

          logs.push({
            ticketId,
            task,
            timestamp,
          });
        }
      } catch {
        // Skip malformed log files
      }
    }
  }

  // Sort by timestamp, newest first
  logs.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return logs;
}

async function readLogLines(
  workspaceRoot: string,
  ticketId: string,
): Promise<LogEntry[]> {
  const logFile = path.join(workspaceRoot, LOGS_DIR, `${ticketId}.jsonl`);
  try {
    const content = await fs.readFile(logFile, "utf-8");
    return content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as LogEntry);
  } catch {
    return [];
  }
}

// --- Typed SSE Event Handlers ---

/**
 * Handle a typed SSE event from the engine
 */
function handleTypedEvent(
  event: CerebroEvent,
  spinnerState: any,
  onReviewResult?: (data: any) => void,
): void {
  switch (event.type) {
    case "agent_started":
      spinnerState.message(
        `${color.cyan(`[${event.agent}]`)} ${color.dim(event.description)}`,
      );
      break;
    case "agent_completed":
      spinnerState.message(
        `${color.green(`✔ ${event.agent}`)} ${color.dim(`completed (${event.tokens} tokens, $${event.cost.toFixed(4)})`)}`,
      );
      break;
    case "agent_failed":
      spinnerState.message(
        `${color.red(`✖ ${event.agent}`)} ${color.red(`failed: ${event.error}`)}`,
      );
      break;
    case "tool_call":
      spinnerState.message(
        `${color.dim(`[Tool] ${event.tool}(${event.input.slice(0, 50)}...)`)}`,
      );
      break;
    case "tool_result":
      spinnerState.message(
        `${color.dim(`→ ${event.result.slice(0, 100)}...`)}`,
      );
      break;
    case "approval_requested":
      // Handled by legacy handler for now
      break;
    case "ticket_completed":
      // Ticket completed - final event handled by 'done' event
      break;
    case "ticket_failed":
      // Ticket failed - final event handled by 'error' event
      break;
    case "log":
      spinnerState.message(`${color.dim(event.message)}`);
      break;
  }
}

// Shared SSE streaming function for engine responses
async function streamEngineResponse(payload: {
  url: string;
  body: object;
  spinner: ReturnType<typeof spinner>;
  onReviewResult?: (data: any) => void;
  workspaceRoot?: string;
}): Promise<{ success: boolean; data: any }> {
  const res = await fetch(payload.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload.body),
  });

  if (!res.body) throw new Error("No response body from Engine");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let finalData: any = null;
  let ticketId: string | undefined;

  // Start logging if workspace root provided
  if (payload.workspaceRoot && "id" in payload.body) {
    ticketId = String((payload.body as any).id);
    await ensureLogsDir(payload.workspaceRoot);
  }

  // SSE state machine — accumulate per-event block, parse on blank separator
  let currentEvent = "message";
  let dataLines: string[] = [];
  let buffer = "";

  while (!done) {
    const { value, done: doneReading } = await reader.read();
    done = doneReading;
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trimEnd();

        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.slice(7).trim();
        } else if (trimmed.startsWith("data: ")) {
          dataLines.push(trimmed.slice(6));
        } else if (trimmed === "") {
          // Blank line = end of SSE event block → dispatch
          if (dataLines.length > 0) {
            const fullData = dataLines.join("\n");

            // Try to parse as typed event first
            let handledAsTyped = false;
            let eventData: any = null;
            if (currentEvent !== "message") {
              try {
                eventData = JSON.parse(fullData);
                // Check if it's a CerebroEvent by checking for 'type' field
                if (
                  eventData &&
                  typeof eventData === "object" &&
                  "type" in eventData
                ) {
                  handleTypedEvent(
                    eventData as CerebroEvent,
                    payload.spinner,
                    payload.onReviewResult,
                  );
                  handledAsTyped = true;

                  // Log typed event
                  if (payload.workspaceRoot && ticketId) {
                    await writeLogEntry(payload.workspaceRoot, ticketId, {
                      type: currentEvent,
                      data: eventData,
                    });
                  }
                }
              } catch {
                // Not a typed event or malformed JSON, fall through to legacy handlers
              }
            }

            // Legacy event handlers (skip if already handled as typed event)
            if (
              !handledAsTyped &&
              (currentEvent === "done" || currentEvent === "error")
            ) {
              try {
                finalData = JSON.parse(fullData);
              } catch {
                // Malformed final payload — surface as a stream error
                finalData = {
                  success: false,
                  error: "Malformed response from Engine.",
                };
              }

              // Log final event
              if (payload.workspaceRoot && ticketId) {
                await writeLogEntry(payload.workspaceRoot, ticketId, {
                  type: currentEvent,
                  data: finalData,
                });
              }
            } else if (!handledAsTyped && currentEvent === "review_result") {
              // Handle review result
              if (payload.onReviewResult) {
                try {
                  const reviewData = JSON.parse(fullData);
                  payload.onReviewResult(reviewData);

                  // Log review result
                  if (payload.workspaceRoot && ticketId) {
                    await writeLogEntry(payload.workspaceRoot, ticketId, {
                      type: "review_result",
                      data: reviewData,
                    });
                  }
                } catch (error) {
                  log.error(`Error processing review result: ${error}`);
                }
              }
            } else if (!handledAsTyped && currentEvent === "approval_request") {
              // Handle approval request
              try {
                const approvalData = JSON.parse(fullData);

                // Log approval request
                if (payload.workspaceRoot && ticketId) {
                  await writeLogEntry(payload.workspaceRoot, ticketId, {
                    type: "approval_request",
                    data: approvalData,
                  });
                }
                payload.spinner.stop(
                  color.yellow(`⏸ Paused: Awaiting file approval...`),
                );

                // Display file changes
                console.log(color.bold(`\n${approvalData.summary}\n`));

                for (const file of approvalData.files) {
                  const operationIcon =
                    file.operation === "create"
                      ? color.green("+")
                      : file.operation === "delete"
                        ? color.red("-")
                        : color.yellow("~");

                  console.log(`${operationIcon} ${color.cyan(file.path)}`);
                  displayFileContent(file);

                  // For updates with diff, offer to view full file
                  if (file.operation === "update" && file.diff) {
                    const viewFull = await text({
                      message: "View full file instead of diff? (y/N)",
                      placeholder: "",
                    });

                    if (
                      typeof viewFull === "string" &&
                      viewFull.toLowerCase() === "y" &&
                      !isCancel(viewFull)
                    ) {
                      console.log(
                        color.bold(
                          `\n${color.cyan(file.path)} — Full Content\n`,
                        ),
                      );
                      console.log(color.dim("─".repeat(50)));
                      const lines = file.content.split("\n");
                      if (lines.length > 20) {
                        console.log(color.gray(lines.slice(0, 20).join("\n")));
                        console.log(
                          color.dim(`... (${lines.length - 20} more lines)`),
                        );
                      } else {
                        console.log(color.gray(lines.join("\n")));
                      }
                      console.log(color.dim(`${"─".repeat(50)}\n`));
                    }
                  }
                }

                // Ask user for approval
                const approved = await confirm({
                  message: "Approve these file changes?",
                  initialValue: true,
                });

                if (isCancel(approved)) {
                  console.log(color.red("\n✖ Approval cancelled"));
                  process.exit(0);
                }

                let rejectedFiles: string[] = [];

                if (approved) {
                  // Allow selective approval
                  const selectiveApproval = await confirm({
                    message: "Reject specific files?",
                    initialValue: false,
                  });

                  if (selectiveApproval && !isCancel(selectiveApproval)) {
                    rejectedFiles = (await multiselect({
                      message: "Select files to reject (use space to select)",
                      options: approvalData.files.map((f: any) => ({
                        value: f.path,
                        label: f.path,
                      })),
                      required: false,
                    })) as string[];

                    if (isCancel(rejectedFiles)) {
                      rejectedFiles = [];
                    }
                  }
                }

                const approvalResponse: any = {
                  ticketId: approvalData.ticketId,
                  approved: !!approved,
                  rejectedFiles:
                    rejectedFiles.length > 0 ? rejectedFiles : undefined,
                };

                if (!approved) {
                  approvalResponse.reason = await text({
                    message: "Reason for rejection:",
                    placeholder: "e.g., incorrect implementation",
                    validate: (value) => {
                      if (!value)
                        return "Please provide a reason for rejection.";
                    },
                  });

                  if (isCancel(approvalResponse.reason)) {
                    console.log(color.red("\n✖ Approval cancelled"));
                    process.exit(0);
                  }
                }

                // Send approval response to engine
                const approvalRes = await fetch(
                  "http://localhost:8080/mesh/approve",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(approvalResponse),
                  },
                );

                if (!approvalRes.ok) {
                  log.error("Failed to send approval response");
                  process.exit(1);
                }

                // Resume spinner
                payload.spinner.start(
                  `Processing ${approved ? "approved" : "rejected"} changes...`,
                );
              } catch (error) {
                log.error(`Error processing approval request: ${error}`);
                process.exit(1);
              }
            } else {
              const safeData = fullData.replace(/\r?\n|\r/g, " ").trim();
              if (safeData.length > 0) {
                payload.spinner.message(color.blue(safeData));
              }
            }
          }
          // Reset for next event block
          currentEvent = "message";
          dataLines = [];
        }
      }
    }
  }

  return { success: finalData?.success ?? false, data: finalData };
}

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: {
      type: "boolean",
      short: "h",
    },
    "new-session": {
      type: "boolean",
      default: false,
    },
  },
  allowPositionals: true,
  strict: false, // Prevents throwing when unexpected flags are passed
});

const isHelp = values.help || positionals[0] === "help";
const command = isHelp ? "help" : positionals[0];
const target = positionals.slice(1).join(" "); // e.g. "my new feature"

async function findWorkspaceRoot(startDir: string): Promise<string> {
  let current = startDir;
  while (current !== path.dirname(current)) {
    // Check for monorepo markers
    try {
      await fs.access(path.join(current, "turbo.json"));
      return current;
    } catch {}
    try {
      const pkg = JSON.parse(
        await fs.readFile(path.join(current, "package.json"), "utf-8"),
      );
      if (pkg.workspaces && Array.isArray(pkg.workspaces)) return current;
    } catch {}
    try {
      await fs.access(path.join(current, "pnpm-workspace.yaml"));
      return current;
    } catch {}
    current = path.dirname(current);
  }
  return startDir; // Fallback to original dir
}

async function main() {
  let action: string | null = command;
  let taskDesc: string | null = target;

  if (action === "help") {
    console.log(
      `\n${color.bgCyan(color.black(" Cerebro Developer CLI "))} v1.0.0\n`,
    );
    console.log(`${color.bold("Usage:")} cerebro [command] [options]\n`);
    console.log(`${color.bold("Commands:")}`);
    console.log(
      `  ${color.cyan("develop")} <feature>   Trigger the AI Mesh to scaffold & verify a new feature`,
    );
    console.log(
      `  ${color.cyan("init")}                Initialize Cerebro context in the current workspace`,
    );
    console.log(
      `  ${color.cyan("fix")}                 Diagnose and patch bugs automatically`,
    );
    console.log(
      `  ${color.cyan("review")}              Conduct a deep AST code quality review`,
    );
    console.log(
      `  ${color.cyan("ops")}                 Design robust 12-factor Cloud Infrastructure`,
    );
    console.log(
      `  ${color.cyan("chat")}                Open persistent REPL for iterative development`,
    );
    console.log(
      `  ${color.cyan("logs")}                List recent execution logs`,
    );
    console.log(
      `  ${color.cyan("replay")} <id>        Replay a past execution log`,
    );
    console.log(
      `  ${color.cyan("help")}                Show this interactive help message\n`,
    );
    console.log(`${color.bold("Options:")}`);
    console.log(`  -h, --help        Show this help menu`);
    console.log(
      `  --new-session      Force a fresh session (ignore existing context)`,
    );
    console.log(`  --fast             Instant replay (no simulated delays)\n`);
    process.exit(0);
  }

  intro(color.bgCyan(color.black(" Cerebro CLI ")));

  // Main loop - keeps CLI running until user quits
  while (true) {
    if (!action) {
      action = (await select({
        message: "What would you like to do?",
        options: [
          {
            value: "init",
            label: "Initialize Cerebro context in this repository",
          },
          { value: "develop", label: "Develop a new feature" },
          { value: "fix", label: "Fix a bug or issue" },
          { value: "review", label: "Review code / PR" },
          { value: "ops", label: "Perform Infrastructure Tasks" },
          { value: "chat", label: "Open Chat REPL" },
          { value: "quit", label: "Quit" },
        ],
      })) as string;

      if (isCancel(action)) {
        outro("Goodbye!");
        process.exit(0);
      }
    }

    if (action === "quit") {
      outro("Goodbye!");
      process.exit(0);
    }

    if (action === "develop" && !taskDesc) {
      taskDesc = (await text({
        message: "Describe the feature you want to develop:",
        placeholder: "e.g., authentication system using JWT",
        validate: (value) => {
          if (!value) return "Please provide a description.";
        },
      })) as string;

      if (isCancel(taskDesc)) {
        outro("Canceled.");
        process.exit(0);
      }
    }

    if (action === "fix" && !taskDesc) {
      taskDesc = (await text({
        message: "Describe the bug or paste the error/stack trace:",
        placeholder: "e.g., TypeError in src/api/users.ts:42",
        validate: (value) => {
          if (!value) return "Please provide a description.";
        },
      })) as string;

      if (isCancel(taskDesc)) {
        outro("Canceled.");
        process.exit(0);
      }
    }

    if (action === "ops" && !taskDesc) {
      taskDesc = (await select({
        message: "Select infrastructure task:",
        options: [
          {
            value:
              "Generate Dockerfile and docker-compose.yml for the current project",
            label: "Generate Dockerfile + docker-compose",
          },
          {
            value:
              "Generate GitHub Actions CI/CD pipeline for the current project",
            label: "Generate CI/CD pipeline (GitHub Actions)",
          },
          {
            value:
              "Generate deployment configuration (Kubernetes manifests, Terraform, or cloud provider configs)",
            label: "Generate deployment config",
          },
          {
            value: "custom",
            label: "Custom ops task",
          },
        ],
      })) as string;

      if (isCancel(taskDesc)) {
        outro("Canceled.");
        process.exit(0);
      }

      if (taskDesc === "custom") {
        taskDesc = (await text({
          message: "Describe the infrastructure task:",
          placeholder: "e.g., Add nginx reverse proxy config",
          validate: (value) => {
            if (!value) return "Please provide a description.";
          },
        })) as string;

        if (isCancel(taskDesc)) {
          outro("Canceled.");
          process.exit(0);
        }
      }
    }

    const s = spinner();
    s.start(`Starting cerebro ${action}...`);

    // Dispatch logic
    switch (action) {
      case "init": {
        s.start("Scanning workspace...");
        const workspaceRoot = await findWorkspaceRoot(cwd());
        const profile: WorkspaceProfile = await scanWorkspace(workspaceRoot);
        const tree = await buildDirectoryTree(workspaceRoot);

        // Create .cerebro directory
        const cerebroDir = path.join(workspaceRoot, ".cerebro");
        await fs.mkdir(cerebroDir, { recursive: true });

        // Write profile.json
        const profilePath = path.join(cerebroDir, "profile.json");
        await fs.writeFile(
          profilePath,
          JSON.stringify(profile, null, 2),
          "utf-8",
        );

        // Write tree.json
        const treePath = path.join(cerebroDir, "tree.json");
        await fs.writeFile(treePath, JSON.stringify(tree, null, 2), "utf-8");

        // Count files in tree
        const fileCount = tree
          .split("\n")
          .filter((line) => line && !line.endsWith("/")).length;
        const dirCount = tree
          .split("\n")
          .filter((line) => line.endsWith("/")).length;

        // Stop spinner and show summary
        s.stop(color.green(`✔ Cerebro initialized`));

        console.log(color.dim("─".repeat(50)));
        console.log(
          `  ${color.cyan("Runtime:")} ${profile.runtime} | ${color.cyan("Language:")} ${profile.language} | ${color.cyan("Framework:")} ${profile.framework}`,
        );
        console.log(
          `  ${color.cyan("Test runner:")} ${profile.testRunner} | ${color.cyan("Linter:")} ${profile.linter}`,
        );
        console.log(
          `  ${color.cyan("Database:")} ${profile.database} | ${color.cyan("Monorepo:")} ${profile.monorepo ? "yes" : "no"}`,
        );
        console.log(
          `  ${color.cyan("Indexed")} ${fileCount} files across ${dirCount} directories`,
        );
        console.log(color.dim("─".repeat(50)));

        // Suggest adding to .gitignore
        const gitignorePath = path.join(workspaceRoot, ".gitignore");
        let gitignoreContent = "";
        try {
          gitignoreContent = await fs.readFile(gitignorePath, "utf-8");
        } catch {
          // File doesn't exist
        }

        if (!gitignoreContent.includes(".cerebro")) {
          console.log(
            color.yellow(
              `\n⚠ Consider adding ${color.cyan(".cerebro")} to ${color.cyan(".gitignore")}:`,
            ),
          );
          console.log(color.dim('  echo ".cerebro" >> .gitignore'));
        }

        // Offer semantic indexing if VOYAGE_API_KEY is set
        if (process.env.VOYAGE_API_KEY) {
          const shouldIndex = await confirm({
            message:
              "Index workspace for semantic search? (improves context quality, ~$0.02)",
            initialValue: false,
          });

          if (shouldIndex && !isCancel(shouldIndex)) {
            const indexSpinner = spinner();
            indexSpinner.start(`Indexing ${fileCount} files...`);

            try {
              const result: IndexWorkspaceResult =
                await indexWorkspace(workspaceRoot);
              indexSpinner.stop(
                color.green(
                  `✔ Semantic index created (${result.filesIndexed} files)`,
                ),
              );

              if (result.errors.length > 0) {
                console.log(
                  color.dim(
                    `\n⚠ ${result.errors.length} files skipped due to errors`,
                  ),
                );
              }
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              // Check if it's a database connection error
              if (
                message.includes("ECONNREFUSED") ||
                message.includes("database") ||
                message.includes("connection")
              ) {
                indexSpinner.stop(
                  color.yellow(
                    "⚠ Database unavailable — skipping semantic index. Run `make db-up` first.",
                  ),
                );
              } else {
                indexSpinner.stop(
                  color.yellow(`⚠ Indexing failed: ${message}`),
                );
              }
            }
          }
        }

        // Reset for next loop iteration
        action = null;
        taskDesc = null;
        continue;
      }
      // biome-ignore lint/suspicious/noFallthroughSwitchClause: case exits via process.exit()
      case "chat": {
        const workspaceRoot = await findWorkspaceRoot(cwd());
        const sessionHistory: Array<{
          task: string;
          agentOutputs: Record<string, string>;
          fileChanges: string[];
        }> = [];

        console.log(
          color.bold(`\n${color.bgCyan(color.black(" Cerebro Chat "))}`),
        );
        console.log(
          color.dim(
            "Type your requests, 'exit' or 'quit' to end the session\n",
          ),
        );

        while (true) {
          const input = (await text({
            message: color.cyan(">"),
            placeholder: "e.g., Add a login page",
          })) as string;

          if (isCancel(input)) {
            outro("Goodbye!");
            process.exit(0);
          }

          const trimmedInput = input.trim();

          if (
            trimmedInput.toLowerCase() === "exit" ||
            trimmedInput.toLowerCase() === "quit"
          ) {
            // Save session state on exit
            if (sessionHistory.length > 0) {
              const lastExchange = sessionHistory[sessionHistory.length - 1];
              await saveSession(workspaceRoot, {
                lastTicketId: randomUUID(),
                lastTask: lastExchange.task,
                agentOutputs: lastExchange.agentOutputs,
                fileChanges: lastExchange.fileChanges,
              });
              console.log(
                color.dim(
                  `\nSession saved with ${sessionHistory.length} exchange(s)\n`,
                ),
              );
            }
            outro("Goodbye!");
            process.exit(0);
          }

          if (!trimmedInput) continue;

          const s = spinner();
          s.start(`Processing: ${trimmedInput.slice(0, 40)}...`);

          try {
            const { success, data: finalData } = await streamEngineResponse({
              url: "http://localhost:8080/mesh/loop",
              body: {
                id: randomUUID(),
                task: trimmedInput,
                retry_count: 0,
                status: "pending",
                workspaceRoot,
                mode: "chat",
                previousContext:
                  sessionHistory.length > 0
                    ? {
                        task: sessionHistory[sessionHistory.length - 1].task,
                        agentOutputs:
                          sessionHistory[sessionHistory.length - 1]
                            .agentOutputs,
                        fileChanges:
                          sessionHistory[sessionHistory.length - 1].fileChanges,
                      }
                    : undefined,
              },
              spinner: s,
              workspaceRoot,
            });

            if (success) {
              // Append this exchange to session history
              sessionHistory.push({
                task: trimmedInput,
                agentOutputs: finalData.ticket.context?.outputs || {},
                fileChanges: finalData.ticket.context?.fileChanges || [],
              });

              if (finalData.partial) {
                s.stop(color.yellow(`⚠ Completed with partial failures.`));
                console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));

                const allAgents = [
                  "frontend",
                  "backend",
                  "quality",
                  "security",
                  "tester",
                  "ops",
                ];
                const failedAgentSet = new Set(
                  finalData.failedAgents?.map((f: any) => f.agent) || [],
                );
                const skippedAgentSet = new Set(
                  finalData.skippedAgents?.map((s: any) => s.agent) || [],
                );
                const succeededAgents = allAgents.filter(
                  (a) => !failedAgentSet.has(a) && !skippedAgentSet.has(a),
                );

                for (const agent of succeededAgents) {
                  console.log(
                    `  ${color.green("✔")} ${color.cyan(agent)} completed`,
                  );
                }

                for (const failed of finalData.failedAgents || []) {
                  console.log(
                    `  ${color.red("✖")} ${color.cyan(failed.agent)} failed: ${color.red(failed.error)}`,
                  );
                }

                for (const skipped of finalData.skippedAgents || []) {
                  console.log(
                    `  ${color.yellow("⊘")} ${color.cyan(skipped.agent)} skipped (${color.yellow(skipped.reason)})`,
                  );
                }
                console.log();
              } else {
                s.stop(color.green(`✔ Completed successfully.`));
                console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));
              }

              if (finalData.usage) {
                const u = finalData.usage;
                console.log(color.cyan(`📊 Token Consumption:`));
                console.log(
                  `  Orchestrator : ${color.yellow(u.orchestrator?.tokens)} tokens`,
                );
                console.log(
                  `  Frontend     : ${color.yellow(u.frontend?.tokens)} tokens`,
                );
                console.log(
                  `  Backend      : ${color.yellow(u.backend?.tokens)} tokens`,
                );
                console.log(
                  `  Quality      : ${color.yellow(u.quality?.tokens)} tokens`,
                );
                console.log(
                  `  Security     : ${color.yellow(u.security?.tokens)} tokens`,
                );
                console.log(
                  `  Tester       : ${color.yellow(u.tester?.tokens)} tokens`,
                );
                console.log(
                  `  Ops          : ${color.yellow(u.ops?.tokens)} tokens`,
                );
                console.log(color.dim(`  -----------------------`));
                console.log(
                  `  Total        : ${color.magenta(u.total?.tokens)} tokens\n`,
                );
              }
            } else if (finalData) {
              s.stop(color.red(`✖ Failed: ${finalData.error}`));
            } else {
              s.stop(color.yellow(`⚠ Stream ended without final status.`));
            }
          } catch (err: any) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            const actionableError = getActionableError(errorMsg);
            s.stop(color.red(`✖ ${actionableError.message}`));
            if (actionableError.debugHint) {
              console.log(color.dim(`  ${actionableError.debugHint}`));
            }
          }
        }
      }
      // biome-ignore lint/suspicious/noFallthroughSwitchClause: case exits via process.exit()
      case "develop":
      case "fix":
        {
          const workspaceRoot = await findWorkspaceRoot(cwd());
          const newSession = values["new-session"] as boolean;
          let sessionContext: Record<string, any> = {};

          // Check for existing session unless --new-session is set
          if (!newSession) {
            const existingSession = await loadSession(workspaceRoot);
            if (existingSession) {
              const continueSession = await confirm({
                message: `Continue previous session? (task: '${existingSession.lastTask}')`,
                initialValue: true,
              });

              if (isCancel(continueSession)) {
                outro("Canceled.");
                process.exit(0);
              }

              if (continueSession) {
                sessionContext = {
                  sessionId: existingSession.sessionId,
                  lastTicketId: existingSession.lastTicketId,
                  agentOutputs: existingSession.agentOutputs,
                  fileChanges: existingSession.fileChanges,
                };
                console.log(
                  color.dim(
                    `\nContinuing session ${existingSession.sessionId}\n`,
                  ),
                );
              } else {
                // Start fresh, clear old session
                await clearSession(workspaceRoot);
              }
            }
          }

          try {
            const { success, data: finalData } = await streamEngineResponse({
              url: "http://localhost:8080/mesh/loop",
              body: {
                id: randomUUID(),
                task: taskDesc,
                retry_count: 0,
                status: "pending",
                workspaceRoot,
                mode: action,
                sessionContext,
                previousContext:
                  Object.keys(sessionContext).length > 0
                    ? {
                        task: sessionContext.lastTask || "",
                        agentOutputs: sessionContext.agentOutputs || {},
                        fileChanges: sessionContext.fileChanges || [],
                      }
                    : undefined,
              },
              spinner: s,
              workspaceRoot,
            });

            if (success) {
              // Save session state after successful completion
              await saveSession(workspaceRoot, {
                lastTicketId: finalData.ticket.id,
                lastTask: taskDesc || "",
                agentOutputs: finalData.ticket.context?.outputs || {},
                fileChanges: finalData.ticket.context?.fileChanges || [],
              });
              if (finalData.partial) {
                const actionLabel =
                  action === "fix" ? "Bug fixed" : "Feature developed";
                s.stop(color.yellow(`⚠ ${actionLabel} with partial failures.`));
                console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));

                // Show which agents succeeded, failed, and were skipped
                console.log(color.bold(`⚠  Execution Results:`));

                // Show successful agents (processed)
                const allAgents = [
                  "frontend",
                  "backend",
                  "quality",
                  "security",
                  "tester",
                  "ops",
                ];
                const failedAgentSet = new Set(
                  finalData.failedAgents?.map((f: any) => f.agent) || [],
                );
                const skippedAgentSet = new Set(
                  finalData.skippedAgents?.map((s: any) => s.agent) || [],
                );
                const succeededAgents = allAgents.filter(
                  (a) => !failedAgentSet.has(a) && !skippedAgentSet.has(a),
                );

                for (const agent of succeededAgents) {
                  console.log(
                    `  ${color.green("✔")} ${color.cyan(agent)} completed`,
                  );
                }

                for (const failed of finalData.failedAgents || []) {
                  console.log(
                    `  ${color.red("✖")} ${color.cyan(failed.agent)} failed: ${color.red(failed.error)}`,
                  );
                }

                for (const skipped of finalData.skippedAgents || []) {
                  console.log(
                    `  ${color.yellow("⊘")} ${color.cyan(skipped.agent)} skipped (${color.yellow(skipped.reason)})`,
                  );
                }

                console.log();
              } else {
                const actionLabel =
                  action === "fix" ? "Bug fixed" : "Feature developed";
                s.stop(color.green(`✔ ${actionLabel} successfully.`));
                console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));
              }

              if (finalData.usage) {
                const u = finalData.usage;
                console.log(color.cyan(`\n📊 Token Consumption:`));
                console.log(
                  `  Orchestrator : ${color.yellow(u.orchestrator?.tokens)} tokens`,
                );
                console.log(
                  `  Frontend     : ${color.yellow(u.frontend?.tokens)} tokens`,
                );
                console.log(
                  `  Backend      : ${color.yellow(u.backend?.tokens)} tokens`,
                );
                console.log(
                  `  Quality      : ${color.yellow(u.quality?.tokens)} tokens`,
                );
                console.log(
                  `  Security     : ${color.yellow(u.security?.tokens)} tokens`,
                );
                console.log(
                  `  Tester       : ${color.yellow(u.tester?.tokens)} tokens`,
                );
                console.log(
                  `  Ops          : ${color.yellow(u.ops?.tokens)} tokens`,
                );
                console.log(color.dim(`  -----------------------`));
                console.log(
                  `  Total        : ${color.magenta(u.total?.tokens)} tokens\n`,
                );
              }
            } else if (finalData) {
              s.stop(color.red(`✖ Failed: ${finalData.error}`));
            } else {
              s.stop(color.yellow(`⚠ Stream ended without final status.`));
            }
          } catch (err: any) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            const actionableError = getActionableError(errorMsg);
            s.stop(color.red(`✖ ${actionableError.message}`));
            if (actionableError.debugHint) {
              console.log(color.dim(`  ${actionableError.debugHint}`));
            }
          }
        }
        break;
      case "review":
        try {
          s.start("Detecting code changes...");
          const workspaceRoot = await findWorkspaceRoot(cwd());

          // Check if we're in a git repository and detect changes
          const { spawn } = await import("child_process");

          const runGitCommand = (command: string[]): Promise<string> => {
            return new Promise((resolve, reject) => {
              const proc = spawn("git", command, { cwd: workspaceRoot });
              let stdout = "";
              let stderr = "";
              proc.stdout?.on("data", (data) => (stdout += data.toString()));
              proc.stderr?.on("data", (data) => (stderr += data.toString()));
              proc.on("close", (code) => {
                if (code === 0) resolve(stdout.trim());
                else
                  reject(
                    new Error(stderr || `Git command failed with code ${code}`),
                  );
              });
            });
          };

          let diff = "";
          let reviewTarget = "";

          // Check for uncommitted changes
          try {
            const diffStat = await runGitCommand(["diff", "--stat"]);
            if (diffStat) {
              // Uncommitted changes exist
              s.stop("Uncommitted changes detected");
              const reviewUncommitted = await confirm({
                message: "Review uncommitted changes?",
                initialValue: true,
              });

              if (isCancel(reviewUncommitted)) {
                outro("Review cancelled.");
                process.exit(0);
              }

              if (reviewUncommitted) {
                diff = await runGitCommand(["diff"]);
                reviewTarget = "uncommitted changes";
              } else {
                // User wants to review a branch instead
                const branch = await text({
                  message: "Branch to compare against (e.g., main):",
                  placeholder: "main",
                  validate: (value) => {
                    if (!value) return "Please provide a branch name.";
                  },
                });

                if (isCancel(branch)) {
                  outro("Review cancelled.");
                  process.exit(0);
                }

                diff = await runGitCommand(["diff", `${branch}...HEAD`]);
                reviewTarget = branch;
              }
            } else {
              // No uncommitted changes, ask for branch
              s.stop("No uncommitted changes found");
              const branch = await text({
                message: "Branch to compare against (e.g., main):",
                placeholder: "main",
                validate: (value) => {
                  if (!value) return "Please provide a branch name.";
                },
              });

              if (isCancel(branch)) {
                outro("Review cancelled.");
                process.exit(0);
              }

              diff = await runGitCommand(["diff", `${branch}...HEAD`]);
              reviewTarget = branch;
            }
          } catch (gitError) {
            // Not a git repo or git command failed
            s.stop(
              color.yellow("⚠ Not in a git repository or git unavailable"),
            );
            console.log(
              color.gray(
                "Reviewing current workspace state without git diff...\n",
              ),
            );
            diff = "(No git diff available - reviewing workspace structure)";
            reviewTarget = "workspace";
          }

          if (!diff || diff === "") {
            s.stop(color.yellow("⚠ No changes found to review"));
            outro("No changes to review.");
            process.exit(0);
          }

          // Start the review
          const reviewSpinner = spinner();
          reviewSpinner.start(
            `Analyzing ${diff.includes("git") ? "git diff" : "workspace"} for quality and security issues...`,
          );

          const { success, data: finalData } = await streamEngineResponse({
            url: "http://localhost:8080/mesh/review",
            body: {
              id: randomUUID(),
              task: taskDesc || "code review",
              retry_count: 0,
              status: "pending",
              workspaceRoot,
              mode: "review",
              diff,
              reviewTarget,
            },
            spinner: reviewSpinner,
            workspaceRoot,
            onReviewResult: (reviewData) => {
              reviewSpinner.stop("Analysis complete");
              console.log(
                color.bold(`\n📊 Code Review Results (${reviewTarget})\n`),
              );

              if (!reviewData.findings || reviewData.findings.length === 0) {
                console.log(
                  color.green("✓ No issues found! Code looks clean.\n"),
                );
              } else {
                const { findings } = reviewData;

                // Group by severity
                const critical = findings.filter(
                  (f: any) => f.severity === "critical",
                );
                const warnings = findings.filter(
                  (f: any) => f.severity === "warning",
                );
                const info = findings.filter((f: any) => f.severity === "info");

                if (critical.length > 0) {
                  console.log(color.red(`\n${color.bold("Critical Issues:")}`));
                  for (const f of critical) {
                    console.log(
                      `${color.red("✖")} ${color.cyan(f.file)}:${f.line} — ${color.red(f.message)}`,
                    );
                    if (f.suggestion) {
                      console.log(color.dim(`  → ${f.suggestion}`));
                    }
                  }
                }

                if (warnings.length > 0) {
                  console.log(color.yellow(`\n${color.bold("Warnings:")}`));
                  for (const f of warnings) {
                    console.log(
                      `${color.yellow("⚠")} ${color.cyan(f.file)}:${f.line} — ${f.message}`,
                    );
                    if (f.suggestion) {
                      console.log(color.dim(`  → ${f.suggestion}`));
                    }
                  }
                }

                if (info.length > 0) {
                  console.log(color.blue(`\n${color.bold("Info:")}`));
                  for (const f of info) {
                    console.log(
                      `${color.blue("ℹ")} ${color.cyan(f.file)}:${f.line} — ${f.message}`,
                    );
                    if (f.suggestion) {
                      console.log(color.dim(`  → ${f.suggestion}`));
                    }
                  }
                }

                console.log(color.dim(`\n${"—".repeat(60)}`));
                console.log(
                  color.dim(
                    `Total: ${critical.length} critical, ${warnings.length} warning(s), ${info.length} info`,
                  ),
                );
                console.log(color.dim(`"${"—".repeat(60)}\n`));
              }
            },
          });

          if (success) {
            reviewSpinner.stop(color.green("✔ Review completed."));
            console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));

            if (finalData.usage) {
              const u = finalData.usage;
              console.log(color.cyan(`\n📊 Token Consumption:`));
              console.log(
                `  Orchestrator : ${color.yellow(u.orchestrator?.tokens)} tokens`,
              );
              console.log(
                `  Quality      : ${color.yellow(u.quality?.tokens)} tokens`,
              );
              console.log(
                `  Security     : ${color.yellow(u.security?.tokens)} tokens`,
              );
              console.log(color.dim(`  -----------------------`));
              console.log(
                `  Total        : ${color.magenta(u.total?.tokens)} tokens\n`,
              );
            }
          } else if (finalData) {
            reviewSpinner.stop(color.red(`✖ Failed: ${finalData.error}`));
          } else {
            reviewSpinner.stop(
              color.yellow(`⚠ Stream ended without final status.`),
            );
          }
        } catch (err: any) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const actionableError = getActionableError(errorMsg);
          s.stop(color.red(`✖ ${actionableError.message}`));
          if (actionableError.debugHint) {
            console.log(color.dim(`  ${actionableError.debugHint}`));
          }
        }
        break;
      case "ops":
        try {
          const opsWorkspaceRoot = await findWorkspaceRoot(cwd());
          const { success, data: finalData } = await streamEngineResponse({
            url: "http://localhost:8080/mesh/loop",
            body: {
              id: randomUUID(),
              task: taskDesc,
              retry_count: 0,
              status: "pending",
              workspaceRoot: opsWorkspaceRoot,
              mode: "ops",
            },
            spinner: s,
            workspaceRoot: opsWorkspaceRoot,
          });

          if (success) {
            if (finalData.partial) {
              s.stop(
                color.yellow(
                  `⚠ Infrastructure generated with partial failures.`,
                ),
              );
              console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));

              // Show which agents succeeded, failed, and were skipped
              console.log(color.bold(`⚠  Execution Results:`));

              const allAgents = [
                "frontend",
                "backend",
                "quality",
                "security",
                "tester",
                "ops",
              ];
              const failedAgentSet = new Set(
                finalData.failedAgents?.map((f: any) => f.agent) || [],
              );
              const skippedAgentSet = new Set(
                finalData.skippedAgents?.map((s: any) => s.agent) || [],
              );
              const succeededAgents = allAgents.filter(
                (a) => !failedAgentSet.has(a) && !skippedAgentSet.has(a),
              );

              for (const agent of succeededAgents) {
                console.log(
                  `  ${color.green("✔")} ${color.cyan(agent)} completed`,
                );
              }

              for (const failed of finalData.failedAgents || []) {
                console.log(
                  `  ${color.red("✖")} ${color.cyan(failed.agent)} failed: ${color.red(failed.error)}`,
                );
              }

              for (const skipped of finalData.skippedAgents || []) {
                console.log(
                  `  ${color.yellow("⊘")} ${color.cyan(skipped.agent)} skipped (${color.yellow(skipped.reason)})`,
                );
              }

              console.log();
            } else {
              s.stop(color.green(`✔ Infrastructure generated.`));
              console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));
            }

            if (finalData.usage) {
              const u = finalData.usage;
              console.log(color.cyan(`\n📊 Token Consumption:`));
              console.log(
                `  Orchestrator : ${color.yellow(u.orchestrator?.tokens)} tokens`,
              );
              console.log(
                `  Frontend     : ${color.yellow(u.frontend?.tokens)} tokens`,
              );
              console.log(
                `  Backend      : ${color.yellow(u.backend?.tokens)} tokens`,
              );
              console.log(
                `  Quality      : ${color.yellow(u.quality?.tokens)} tokens`,
              );
              console.log(
                `  Security     : ${color.yellow(u.security?.tokens)} tokens`,
              );
              console.log(
                `  Tester       : ${color.yellow(u.tester?.tokens)} tokens`,
              );
              console.log(
                `  Ops          : ${color.yellow(u.ops?.tokens)} tokens`,
              );
              console.log(color.dim(`  -----------------------`));
              console.log(
                `  Total        : ${color.magenta(u.total?.tokens)} tokens\n`,
              );
            }
          } else if (finalData) {
            s.stop(color.red(`✖ Failed: ${finalData.error}`));
          } else {
            s.stop(color.yellow(`⚠ Stream ended without final status.`));
          }
        } catch (err: any) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const actionableError = getActionableError(errorMsg);
          s.stop(color.red(`✖ ${actionableError.message}`));
          if (actionableError.debugHint) {
            console.log(color.dim(`  ${actionableError.debugHint}`));
          }
        }
        break;
      // biome-ignore lint/suspicious/noFallthroughSwitchClause: case exits via process.exit()
      case "logs": {
        s.stop();
        const workspaceRoot = await findWorkspaceRoot(cwd());
        const logs = await listLogs(workspaceRoot);

        if (logs.length === 0) {
          console.log(color.yellow("⚠ No execution logs found."));
          console.log(
            color.dim(
              "Run a command first (e.g., 'cerebro develop ...') to create logs.",
            ),
          );
          process.exit(0);
        }

        console.log(color.bold(`\nRecent Executions (${logs.length})\n`));

        for (let i = 0; i < logs.length; i++) {
          const log = logs[i];
          const date = new Date(log.timestamp).toLocaleString();
          const shortId = log.ticketId.slice(0, 8);

          console.log(
            `${color.cyan(`${i + 1}.`)} ${color.magenta(shortId)} ${color.dim(date)}`,
          );
          console.log(
            `   ${color.gray(log.task.length > 60 ? log.task.slice(0, 60) + "..." : log.task)}`,
          );
          console.log(`   ${color.dim(`cerebro replay ${log.ticketId}`)}\n`);
        }

        process.exit(0);
      }
      // biome-ignore lint/suspicious/noFallthroughSwitchClause: case exits via process.exit()
      case "replay": {
        s.stop();
        const ticketId = taskDesc?.trim();

        if (!ticketId) {
          console.log(color.red("✖ Ticket ID is required."));
          console.log(color.dim("Usage: cerebro replay <ticket-id>"));
          console.log(
            color.dim("Use 'cerebro logs' to list available ticket IDs."),
          );
          process.exit(1);
        }

        const workspaceRoot = await findWorkspaceRoot(cwd());
        const logEntries = await readLogLines(workspaceRoot, ticketId);

        if (logEntries.length === 0) {
          console.log(color.red(`✖ No log found for ticket ID: ${ticketId}`));
          process.exit(1);
        }

        console.log(
          color.bold(`\n${color.bgMagenta(color.black(" Replay Execution "))}`),
        );
        console.log(color.dim(`Ticket ID: ${ticketId}\n`));

        // Check for --fast flag for instant replay
        const { values: replayValues } = parseArgs({
          args: process.argv.slice(2),
          allowPositionals: true,
          strict: false,
        });
        const fastReplay = replayValues["fast"] as boolean;

        let currentTask = "Unknown task";

        for (const entry of logEntries) {
          const time = entry.timestamp
            ? new Date(entry.timestamp).toLocaleTimeString()
            : "unknown";
          const typeColor = color.magenta;
          const typeLabel = color.dim(`[${entry.type}]`);

          console.log(
            `${color.dim(time)} ${typeColor(entry.type)} ${typeLabel}`,
          );

          if (entry.type === "done" && entry.data?.ticket?.task) {
            currentTask = entry.data.ticket.task;
          }

          if (entry.type === "done") {
            // Show completion summary
            if (entry.data?.success) {
              console.log(color.green(`  ✔ Completed successfully`));
            } else if (entry.data?.partial) {
              console.log(color.yellow(`  ⚠ Completed with partial failures`));
            } else {
              console.log(
                color.red(
                  `  ✖ Failed: ${entry.data?.error || "Unknown error"}`,
                ),
              );
            }

            if (entry.data?.usage) {
              const u = entry.data.usage;
              console.log(
                color.dim(`    Total tokens: ${u.total?.tokens || 0}`),
              );
            }
          } else if (entry.type === "agent_started") {
            console.log(
              color.cyan(
                `  → ${entry.data?.agent}: ${entry.data?.description}`,
              ),
            );
          } else if (entry.type === "agent_completed") {
            console.log(
              color.green(
                `  ✔ ${entry.data?.agent} completed (${entry.data?.tokens} tokens)`,
              ),
            );
          } else if (entry.type === "agent_failed") {
            console.log(
              color.red(
                `  ✖ ${entry.data?.agent} failed: ${entry.data?.error}`,
              ),
            );
          } else if (entry.type === "tool_call") {
            console.log(
              color.dim(
                `    [Tool] ${entry.data?.tool}(${entry.data?.input?.slice(0, 50)}...)`,
              ),
            );
          } else if (entry.type === "approval_request") {
            console.log(
              color.yellow(
                `  ⏸ Approval requested: ${entry.data?.summary?.slice(0, 50)}...`,
              ),
            );
            console.log(
              color.dim(`    Files: ${entry.data?.files?.length || 0}`),
            );
          } else if (entry.type === "review_result") {
            console.log(
              color.cyan(
                `  📊 Review completed: ${entry.data?.findings?.length || 0} findings`,
              ),
            );
          }

          if (!fastReplay && entry.type !== "done" && entry.type !== "error") {
            // Simulate delay for realistic replay
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }

        console.log(color.dim(`\nTask: ${currentTask}\n`));
        process.exit(0);
      }
      // biome-ignore lint/suspicious/noFallthroughSwitchClause: case exits via process.exit()
      default:
        s.stop(color.red(`✖ Unknown command: ${action}`));
        process.exit(1);
    }

    // Reset for next loop iteration
    action = null;
    taskDesc = null;
  }
}

main().catch((err) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  const actionableError = getActionableError(errorMsg);
  console.error(color.red(`\n✖ ${actionableError.message}`));
  if (actionableError.debugHint) {
    console.error(color.dim(`  ${actionableError.debugHint}`));
  }
  process.exit(1);
});
