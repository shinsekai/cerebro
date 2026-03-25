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
 * Progress state for tracking execution phases
 */
interface ProgressState {
  currentWave: number;
  totalWaves: number;
  agentsInWave: number;
  completedInWave: number;
  currentPhase: "scan" | "plan" | "execute" | "approve" | "write" | "done";
  agentsInCurrentWave: Set<string>;
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

// Rate limiting for spinner updates
const SPINNER_MIN_INTERVAL = 200; // ms
let lastSpinnerUpdate = 0;

/**
 * Update spinner message with rate limiting to prevent flicker
 */
function updateSpinner(
  spinnerState: ReturnType<typeof spinner>,
  message: string,
): void {
  const now = Date.now();
  if (now - lastSpinnerUpdate < SPINNER_MIN_INTERVAL) {
    return;
  }
  lastSpinnerUpdate = now;
  spinnerState.message(message);
}

/**
 * Create a new progress state
 */
function createProgressState(): ProgressState {
  return {
    currentWave: 0,
    totalWaves: 0,
    agentsInWave: 0,
    completedInWave: 0,
    currentPhase: "scan",
    agentsInCurrentWave: new Set<string>(),
  };
}

// Module-level progress state
const progressState = createProgressState();

/**
 * Get formatted spinner message for current phase
 */
function getSpinnerMessage(): string {
  const {
    currentPhase,
    currentWave,
    totalWaves,
    completedInWave,
    agentsInWave,
  } = progressState;

  switch (currentPhase) {
    case "scan":
      return color.dim("Scanning workspace...");
    case "plan":
      return color.dim("Orchestrator planning...");
    case "execute":
      if (totalWaves > 0) {
        const waveProgress =
          agentsInWave > 0 ? ` (${completedInWave}/${agentsInWave})` : "";
        return color.dim(
          `Wave ${currentWave}/${totalWaves}: Executing agents${waveProgress}`,
        );
      }
      return color.dim("Executing agents...");
    case "approve":
      return color.dim("Reviewing changes...");
    case "write":
      return color.dim("Writing files...");
    case "done":
      return color.dim("Done");
    default:
      return color.dim("Processing...");
  }
}

/**
 * Handle a typed SSE event from the engine
 *
 * Produces structured output with box-drawing connectors:
 * - Agent start/complete are persistent lines with connectors
 * - Tool calls update spinner without creating permanent lines
 * - Agent errors are clearly visible in red
 * - Spinner message reflects current execution phase
 */
export function handleTypedEvent(
  event: CerebroEvent,
  spinnerState: ReturnType<typeof spinner>,
  options?: HandleTypedEventOptions,
): void {
  const printLine = options?.printLine ?? defaultPrintLine(spinnerState);

  switch (event.type) {
    case "agent_started": {
      // Update progress state
      progressState.currentPhase = "execute";
      progressState.currentWave = event.wave;

      // Track agent in current wave (avoid duplicates for retries)
      if (!progressState.agentsInCurrentWave.has(event.agent)) {
        progressState.agentsInCurrentWave.add(event.agent);
        progressState.agentsInWave = progressState.agentsInCurrentWave.size;
      }

      printLine(
        `  ┌ ${color.cyan(event.agent)} ${color.dim(event.description)}`,
      );
      // Update spinner with phase info
      updateSpinner(spinnerState, color.dim(`  │ ${getSpinnerMessage()}`));
      break;
    }

    case "agent_completed": {
      progressState.completedInWave++;
      printLine(
        `  └ ${color.green("✔")} ${color.cyan(event.agent)} ${color.dim(`${event.tokens.toLocaleString()} tok · $${event.cost.toFixed(3)} · ${(event.duration / 1000).toFixed(1)}s`)}`,
      );
      // Update spinner to show progress
      updateSpinner(spinnerState, color.dim(`  │ ${getSpinnerMessage()}`));
      break;
    }

    case "agent_failed": {
      progressState.completedInWave++;
      printLine(
        `  └ ${color.red("✖")} ${color.cyan(event.agent)} ${color.red(event.error.slice(0, 60))}`,
      );
      break;
    }

    case "tool_call": {
      // Show ONLY the tool name + key argument, never raw JSON
      let summary = event.tool;
      try {
        const input =
          typeof event.input === "string"
            ? JSON.parse(event.input)
            : event.input;
        if (input.path) summary += ` ${input.path}`;
        else if (input.command)
          summary += ` ${String(input.command).slice(0, 30)}`;
        else if (input.query)
          summary += ` "${String(input.query).slice(0, 20)}"`;
        else if (input.summary) summary += ` (completing)`;
      } catch {
        // input is not JSON — show first 30 chars
        summary += ` ${String(event.input).slice(0, 30)}`;
      }
      updateSpinner(spinnerState, color.dim(`  │  ↳ ${summary}`));
      break;
    }

    case "tool_result": {
      // SILENT — never show tool results in the spinner.
      // The tool_call line already told the user what's happening.
      // Only surface explicit errors:
      try {
        const result =
          typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result);
        if (result.includes('"error"')) {
          const parsed = JSON.parse(result);
          if (parsed.error) {
            updateSpinner(
              spinnerState,
              color.red(`  │  ✖ ${String(parsed.error).slice(0, 50)}`),
            );
          }
        }
      } catch {
        // Silent
      }
      break;
    }

    case "approval_requested": {
      progressState.currentPhase = "approve";
      // Handled by legacy handler for now
      break;
    }

    case "ticket_completed": {
      progressState.currentPhase = "done";
      // Ticket completed - final event handled by 'done' event
      break;
    }

    case "ticket_failed": {
      progressState.currentPhase = "done";
      // Ticket failed - final event handled by 'error' event
      break;
    }

    case "log": {
      // Only show meaningful logs, skip noisy internal ones
      const msg = event.message ?? "";

      // Extract wave info: "[Control Plane] Wave 1/2: backend, frontend"
      if (msg.includes("[Control Plane] Wave ")) {
        const waveMatch = msg.match(/Wave (\d+)\/(\d+):\s*(.+)/);
        if (waveMatch) {
          progressState.totalWaves = parseInt(waveMatch[2], 10);
          // Reset per-wave tracking when entering a new wave
          if (parseInt(waveMatch[1], 10) !== progressState.currentWave) {
            progressState.agentsInCurrentWave.clear();
            progressState.agentsInWave = 0;
            progressState.completedInWave = 0;
          }
        }
        return;
      }

      // Extract file write phase
      if (
        msg.includes("[Approval] Approved. Writing") ||
        msg.includes("[Files] Written:")
      ) {
        progressState.currentPhase = "write";
        updateSpinner(spinnerState, color.dim(`Writing files...`));
        return;
      }

      // Only show select non-trivial logs
      if (
        msg.includes("[Context]") ||
        msg.includes("[Orchestrator]") ||
        msg.includes("Plan:")
      ) {
        updateSpinner(spinnerState, color.dim(msg.slice(0, 60)));
      }
      // Skip: "Initializing", "Circuit Breaker", tool-related logs
      break;
    }
  }
}

/**
 * Reset progress state for new execution
 */
export function resetProgressState(): void {
  progressState.currentWave = 0;
  progressState.totalWaves = 0;
  progressState.agentsInWave = 0;
  progressState.completedInWave = 0;
  progressState.currentPhase = "scan";
  progressState.agentsInCurrentWave.clear();
  lastSpinnerUpdate = 0;
}
