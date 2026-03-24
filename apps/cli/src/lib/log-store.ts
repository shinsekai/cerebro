import fs from "node:fs/promises";
import path from "node:path";

export const LOGS_DIR = ".cerebro/logs";

interface LogData {
  ticket?: { task: string };
  [key: string]: unknown;
}

export interface LogEntry {
  type: string;
  data?: LogData;
  timestamp?: number;
  ticketId?: string;
  [key: string]: unknown;
}

export interface LogMetadata {
  ticketId: string;
  task: string;
  timestamp: string;
}

export async function ensureLogsDir(workspaceRoot: string): Promise<void> {
  const logsPath = path.join(workspaceRoot, LOGS_DIR);
  await fs.mkdir(logsPath, { recursive: true });
}

export async function writeLogEntry(
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

export async function listLogs(workspaceRoot: string): Promise<LogMetadata[]> {
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

export async function readLogLines(
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
