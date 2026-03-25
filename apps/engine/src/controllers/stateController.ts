import type { StateTicket } from "@cerebro/core";
import { StateTicketSchema } from "@cerebro/core";
import { getActionableError } from "./utils.js";

export interface StateControllerDeps {
  saveStateTicket: (ticket: StateTicket) => Promise<any>;
  getStateTicket: (id: string) => Promise<StateTicket | undefined>;
}

export async function handlePostState(
  c: any,
  deps: StateControllerDeps,
): Promise<Response> {
  try {
    const body = await c.req.json();
    const ticket = StateTicketSchema.parse(body);
    await deps.saveStateTicket(ticket);
    return c.json({ success: true, ticket });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const actionable = getActionableError(errorMsg);
    return c.json({ success: false, error: actionable.message }, 400);
  }
}

export async function handleGetState(
  c: any,
  deps: StateControllerDeps,
): Promise<Response> {
  const id = c.req.param("id");
  const ticket = await deps.getStateTicket(id);
  if (!ticket) return c.json({ success: false, error: "Not found" }, 404);
  return c.json({ success: true, ticket });
}
