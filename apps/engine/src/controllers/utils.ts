import { Logger } from "@cerebro/core";

const log = new Logger("engine");

// --- Actionable Error Messages ---

interface ActionableError {
  message: string;
  debugHint?: string;
}

/**
 * Converts raw error messages into actionable guidance
 */
export function getActionableError(rawError: string): ActionableError {
  const errorLower = rawError.toLowerCase();

  // Engine connection errors (reported back to CLI)
  if (
    errorLower.includes("econnrefused") ||
    errorLower.includes("fetch failed") ||
    errorLower.includes("connection refused") ||
    errorLower.includes("engine") ||
    errorLower.includes("localhost:8080")
  ) {
    return {
      message:
        "Engine unreachable on port 8080. Run `make dev-engine` in a separate terminal.",
    };
  }

  // API key errors
  if (
    errorLower.includes("api key") ||
    errorLower.includes("anthropic_api_key") ||
    errorLower.includes("unauthorized") ||
    errorLower.includes("401") ||
    errorLower.includes("invalid api key") ||
    errorLower.includes("not_provided")
  ) {
    return {
      message:
        "Invalid ANTHROPIC_API_KEY. Set it via: export ANTHROPIC_API_KEY=sk-...",
    };
  }

  // Database connection errors
  if (
    errorLower.includes("econnrefused") &&
    (errorLower.includes("5432") ||
      errorLower.includes("postgres") ||
      errorLower.includes("database"))
  ) {
    return {
      message: "Database unavailable. Run `make db-up` to start PostgreSQL.",
    };
  }

  // Rate limit errors
  if (
    errorLower.includes("rate limit") ||
    errorLower.includes("429") ||
    errorLower.includes("too many requests")
  ) {
    return {
      message: "API rate limited. Wait 60 seconds and retry.",
    };
  }

  // Context too large errors
  if (
    errorLower.includes("context") ||
    errorLower.includes("token") ||
    errorLower.includes("too large") ||
    errorLower.includes("exceeds") ||
    errorLower.includes("maximum")
  ) {
    return {
      message:
        "Context exceeds model limit. Try narrowing your task description or running `cerebro init` to index your workspace.",
    };
  }

  // Approval timeout errors
  if (
    errorLower.includes("approval timeout") ||
    errorLower.includes("timed out") ||
    errorLower.includes("timeout")
  ) {
    return {
      message:
        "No approval response in 5 minutes. Re-run the command to try again.",
    };
  }

  // Circuit breaker errors
  if (
    errorLower.includes("circuit breaker") ||
    errorLower.includes("3 retries") ||
    errorLower.includes("infinite loop") ||
    errorLower.includes("terminal failure")
  ) {
    return {
      message:
        "Task failed after 3 retries. The error may require manual intervention. Check .cerebro/logs/ for details.",
    };
  }

  // Catch-all
  return {
    message: rawError,
    debugHint: "Run with CEREBRO_LOG_LEVEL=debug for details.",
  };
}

// --- SSE Event Emission Helpers ---
// Re-export from services/sse.ts for backward compatibility

export { emitEvent, emitLog } from "../services/sse.js";

// --- Helper to clean raw API Error JSON strings ---
export function cleanErrorMessage(msg: string | undefined): string {
  if (!msg) return "Unknown error";
  try {
    const match = msg.match(/^\d{3}\s+({.*})$/);
    if (match && match[1]) {
      const parsed = JSON.parse(match[1]);
      if (parsed?.error?.message) {
        return parsed.error.message;
      }
    }
  } catch (_e) {}
  return msg;
}

export function getLog(): Logger {
  return log;
}
