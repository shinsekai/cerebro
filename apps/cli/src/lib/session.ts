import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SESSION_FILE = ".cerebro/session.json";
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface SessionState {
  sessionId: string;
  lastTicketId: string;
  lastTask: string;
  agentOutputs: Record<string, string>;
  fileChanges: string[];
  timestamp: string;
}

export async function loadSession(
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

export async function saveSession(
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

export async function clearSession(workspaceRoot: string): Promise<void> {
  const sessionPath = path.join(workspaceRoot, SESSION_FILE);
  try {
    await fs.unlink(sessionPath);
  } catch {
    // File doesn't exist, ignore
  }
}
