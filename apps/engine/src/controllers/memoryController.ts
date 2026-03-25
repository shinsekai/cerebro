import type { MemoryTicket } from "@cerebro/core";
import { MemoryTicketSchema } from "@cerebro/core";
import { getActionableError } from "./utils.js";

export interface MemoryControllerDeps {
  saveMemoryTicket: (ticket: MemoryTicket) => Promise<any>;
  searchSimilarMemory: (
    embedding: number[],
    threshold?: number,
    limit?: number,
  ) => Promise<MemoryTicket[]>;
}

export async function handlePostMemory(
  c: any,
  deps: MemoryControllerDeps,
): Promise<Response> {
  try {
    const body = await c.req.json();
    const ticket = MemoryTicketSchema.parse({
      ...body,
      created_at: body.created_at ? new Date(body.created_at) : new Date(),
    });
    await deps.saveMemoryTicket(ticket);
    return c.json({ success: true, ticket });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const actionable = getActionableError(errorMsg);
    return c.json({ success: false, error: actionable.message }, 400);
  }
}

export async function handlePostMemorySearch(
  c: any,
  deps: MemoryControllerDeps,
): Promise<Response> {
  try {
    const { embedding, threshold, limit } = await c.req.json();
    const results = await deps.searchSimilarMemory(embedding, threshold, limit);
    return c.json({ success: true, results });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const actionable = getActionableError(errorMsg);
    return c.json({ success: false, error: actionable.message }, 400);
  }
}
