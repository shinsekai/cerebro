import type { CerebroEvent } from "@cerebro/core";
import type { spinner } from "@clack/prompts";
import color from "picocolors";

/**
 * Options for handleTypedEvent
 */
interface HandleTypedEventOptions {
  /** Function to print a persistent line (stops spinner, prints, restarts) */
  printLine?: (line: string) => void;
}

/**
 * Default printLine implementation that stops the spinner, prints a line, and restarts it
 */
function defaultPrintLine(
  spinnerState: ReturnType<typeof spinner>,
): (line: string) => void {
  return (line: string) => {
    spinnerState.stop();
    console.log(line);
    spinnerState.start();
  };
}

/**
 * Handle a typed SSE event from the engine
 *
 * Produces structured output with box-drawing connectors:
 * - Agent start/complete are persistent lines with connectors
 * - Tool calls update spinner without creating permanent lines
 * - Agent errors are clearly visible in red
 */
export function handleTypedEvent(
  event: CerebroEvent,
  spinnerState: ReturnType<typeof spinner>,
  options?: HandleTypedEventOptions,
): void {
  const printLine = options?.printLine ?? defaultPrintLine(spinnerState);

  switch (event.type) {
    case "agent_started": {
      printLine(
        `  ┌ ${color.cyan(event.agent)} ${color.dim(event.description)}`,
      );
      spinnerState.message(color.dim(`  │ Working...`));
      break;
    }

    case "agent_completed": {
      printLine(
        `  └ ${color.green("✔")} ${color.cyan(event.agent)} ${color.dim(`${event.tokens.toLocaleString()} tok · $${event.cost.toFixed(3)} · ${(event.duration / 1000).toFixed(1)}s`)}`,
      );
      break;
    }

    case "agent_failed": {
      printLine(
        `  └ ${color.red("✖")} ${color.cyan(event.agent)} ${color.red(event.error.slice(0, 60))}`,
      );
      break;
    }

    case "tool_call": {
      const toolDisplay =
        event.tool === "run_command"
          ? `run ${event.input.slice(0, 40)}`
          : `${event.tool} ${event.input.slice(0, 35)}`;
      spinnerState.message(color.dim(`  │  ↳ ${toolDisplay}`));
      break;
    }

    case "tool_result": {
      // Silent by default — only show errors
      if (event.result.includes('"error"')) {
        spinnerState.message(color.red(`  │  ✖ ${event.result.slice(0, 60)}`));
      }
      break;
    }

    case "approval_requested":
      // Handled by legacy handler for now
      break;

    case "ticket_completed":
      // Ticket completed - final event handled by 'done' event
      break;

    case "ticket_failed":
      // Ticket failed - final event handled by 'error' event
      break;

    case "log": {
      // Only show non-trivial logs
      if (
        !event.message.includes("Initializing") &&
        !event.message.includes("Circuit Breaker")
      ) {
        spinnerState.message(color.dim(`  ${event.message.slice(0, 70)}`));
      }
      break;
    }
  }
}
