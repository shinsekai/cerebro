import type { CerebroEvent, LogEvent } from "@cerebro/core";

/**
 * Emit a typed SSE event to the client
 */
export async function emitEvent(
  stream: any,
  event: CerebroEvent,
): Promise<void> {
  await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
}

/**
 * Emit a legacy untyped log message (for backward compatibility)
 */
export async function emitLog(
  stream: any,
  message: string,
  level = "info",
): Promise<void> {
  const logEvent: LogEvent = { type: "log", message, level };
  await emitEvent(stream, logEvent);
}
