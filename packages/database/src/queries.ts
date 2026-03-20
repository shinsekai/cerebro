import { sql } from "./index.js";
import type { StateTicket, MemoryTicket } from "@cerebro/core";

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
