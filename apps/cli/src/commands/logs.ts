import { parseArgs } from "node:util";
import type { Spinner } from "@clack/prompts";
import color from "picocolors";
import { listLogs, readLogLines } from "../lib/log-store.js";
import { findWorkspaceRoot } from "../lib/workspace.js";

export async function runLogs(s: Spinner): Promise<void> {
  s.stop();
  const workspaceRoot = await findWorkspaceRoot(process.cwd());
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
      `   ${color.gray(
        log.task.length > 60 ? `${log.task.slice(0, 60)}...` : log.task,
      )}`,
    );
    console.log(`   ${color.dim(`cerebro replay ${log.ticketId}`)}\n`);
  }

  process.exit(0);
}

export async function runReplay(
  taskDesc: string | null,
  s: Spinner,
): Promise<void> {
  s.stop();
  const ticketId = taskDesc?.trim();

  if (!ticketId) {
    console.log(color.red("✖ Ticket ID is required."));
    console.log(color.dim("Usage: cerebro replay <ticket-id>"));
    console.log(color.dim("Use 'cerebro logs' to list available ticket IDs."));
    process.exit(1);
  }

  const workspaceRoot = await findWorkspaceRoot(process.cwd());
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
  const fastReplay = replayValues.fast as boolean;

  let currentTask = "Unknown task";

  for (const entry of logEntries) {
    const time = entry.timestamp
      ? new Date(entry.timestamp).toLocaleTimeString()
      : "unknown";
    const typeColor = color.magenta;
    const typeLabel = color.dim(`[${entry.type}]`);

    console.log(`${color.dim(time)} ${typeColor(entry.type)} ${typeLabel}`);

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
          color.red(`  ✖ Failed: ${entry.data?.error || "Unknown error"}`),
        );
      }

      if (entry.data?.usage) {
        const u = entry.data.usage;
        console.log(color.dim(`    Total tokens: ${u.total?.tokens || 0}`));
      }
    } else if (entry.type === "agent_started") {
      console.log(
        color.cyan(`  → ${entry.data?.agent}: ${entry.data?.description}`),
      );
    } else if (entry.type === "agent_completed") {
      console.log(
        color.green(
          `  ✔ ${entry.data?.agent} completed (${entry.data?.tokens} tokens)`,
        ),
      );
    } else if (entry.type === "agent_failed") {
      console.log(
        color.red(`  ✖ ${entry.data?.agent} failed: ${entry.data?.error}`),
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
      console.log(color.dim(`    Files: ${entry.data?.files?.length || 0}`));
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
