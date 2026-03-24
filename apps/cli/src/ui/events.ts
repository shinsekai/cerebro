import color from "picocolors";
import { spinner } from "@clack/prompts";
import type { CerebroEvent, ReviewResultEvent } from "@cerebro/core";

/**
 * Handle a typed SSE event from the engine
 */
export function handleTypedEvent(
  event: CerebroEvent,
  spinnerState: ReturnType<typeof spinner>,
  _onReviewResult?: (data: ReviewResultEvent) => void,
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
