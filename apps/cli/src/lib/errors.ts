/**
 * Converts raw error messages into actionable guidance
 */

export interface ActionableError {
  message: string;
  debugHint?: string;
}
/**
 * Converts raw error messages into actionable guidance
 */
export function getActionableError(rawError: string): ActionableError {
  const errorLower = rawError.toLowerCase();

  // Engine connection errors
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
    errorLower.includes("401")
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
    errorLower.includes("exceeds")
  ) {
    return {
      message:
        "Context exceeds model limit. Try narrowing your task description or running `cerebro init` to index your workspace.",
    };
  }

  // Approval timeout errors
  if (
    errorLower.includes("approval timeout") ||
    errorLower.includes("timed out")
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
    errorLower.includes("infinite loop")
  ) {
    return {
      message:
        "Task failed after 3 retries. The error may require manual intervention. Check .cerebro/logs/ for details.",
    };
  }

  // Catch-all
  return {
    message: `Unexpected error: ${rawError}`,
    debugHint: "Run with CEREBRO_LOG_LEVEL=debug for details.",
  };
}
