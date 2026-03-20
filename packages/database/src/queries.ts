import type { MemoryTicket, StateTicket } from "@cerebro/core";
import { sql } from "./index.js";

export async function saveStateTicket(ticket: StateTicket) {
  return await sql`
    INSERT INTO state_tickets (id, task, retry_count, status, context, error)
    VALUES (
      ${ticket.id}, 
      ${ticket.task}, 
      ${ticket.retry_count}, 
      ${ticket.status}, 
      ${ticket.context ? sql.json(ticket.context) : null}, 
      ${ticket.error || null}
    )
    ON CONFLICT (id) DO UPDATE SET
      retry_count = EXCLUDED.retry_count,
      status = EXCLUDED.status,
      context = EXCLUDED.context,
      error = EXCLUDED.error,
      updated_at = CURRENT_TIMESTAMP
  `;
}

export async function getStateTicket(
  id: string,
): Promise<StateTicket | undefined> {
  const result = await sql<
    StateTicket[]
  >`SELECT * FROM state_tickets WHERE id = ${id}`;
  return result[0];
}

export async function saveMemoryTicket(ticket: MemoryTicket) {
  const vectorStr = ticket.embedding ? `[${ticket.embedding.join(",")}]` : null;
  return await sql`
    INSERT INTO memory_tickets (id, task_hash, task_summary, solution_code, embedding)
    VALUES (
      ${ticket.id},
      ${ticket.task_hash},
      ${ticket.task_summary},
      ${ticket.solution_code},
      ${vectorStr ? sql`${vectorStr}::vector` : null}
    )
  `;
}

export async function searchSimilarMemory(
  embedding: number[],
  threshold = 0.8,
  limit = 5,
): Promise<MemoryTicket[]> {
  const vectorStr = `[${embedding.join(",")}]`;
  return await sql<MemoryTicket[]>`
    SELECT * FROM memory_tickets
    WHERE 1 - (embedding <=> ${vectorStr}::vector) > ${threshold}
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limit}
  `;
}

export interface WorkspaceFileRecord {
  id: string;
  workspace_root: string;
  file_path: string;
  file_summary: string;
  embedding: number[] | null;
  indexed_at: Date;
}

export async function saveWorkspaceFile(
  workspaceRoot: string,
  filePath: string,
  summary: string,
  embedding: number[],
): Promise<void> {
  const vectorStr = `[${embedding.join(",")}]`;
  await sql`
    INSERT INTO workspace_files (workspace_root, file_path, file_summary, embedding)
    VALUES (${workspaceRoot}, ${filePath}, ${summary}, ${vectorStr}::vector)
    ON CONFLICT (workspace_root, file_path) DO UPDATE SET
      file_summary = EXCLUDED.file_summary,
      embedding = EXCLUDED.embedding,
      indexed_at = CURRENT_TIMESTAMP
  `;
}

export async function searchWorkspaceFiles(
  workspaceRoot: string,
  queryEmbedding: number[],
  limit = 10,
  threshold = 0.6,
): Promise<{ path: string; score: number }[]> {
  const vectorStr = `[${queryEmbedding.join(",")}]`;
  const results = await sql<{ file_path: string; similarity: number }[]>`
    SELECT
      file_path,
      1 - (embedding <=> ${vectorStr}::vector) as similarity
    FROM workspace_files
    WHERE workspace_root = ${workspaceRoot}
      AND 1 - (embedding <=> ${vectorStr}::vector) > ${threshold}
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${limit}
  `;
  return results.map((r) => ({ path: r.file_path, score: r.similarity }));
}

export async function deleteWorkspaceIndex(
  workspaceRoot: string,
): Promise<void> {
  await sql`DELETE FROM workspace_files WHERE workspace_root = ${workspaceRoot}`;
}
