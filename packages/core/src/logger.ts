/**
 * Cerebro Logger Utility
 *
 * Lightweight logging with configurable levels and component-aware output formats.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Parse log level from environment variable.
 * Falls back to "info" if not set or invalid.
 */
function parseLogLevel(): LogLevel {
  const envLevel = process.env.CEREBRO_LOG_LEVEL;
  if (envLevel && envLevel in LEVEL_ORDER) {
    return envLevel as LogLevel;
  }
  return "info";
}

/**
 * Logger class for structured logging.
 *
 * Engine components output JSON to stderr for log aggregation.
 * CLI components output human-readable text.
 */
export class Logger {
  private level: LogLevel;
  private levelValue: number;
  private component: string;

  constructor(component: string) {
    this.component = component;
    this.level = parseLogLevel();
    this.levelValue = LEVEL_ORDER[this.level];
  }

  /**
   * Check if a log level should be emitted based on current threshold.
   */
  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= this.levelValue;
  }

  /**
   * Format timestamp as ISO string.
   */
  private getTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Log a message at the given level.
   * Engine: JSON to stderr
   * CLI: Human-readable to stdout
   */
  private log(level: LogLevel, msg: string): void {
    if (!this.shouldLog(level)) return;

    if (this.component === "engine") {
      // JSON format for structured logging
      console.error(
        JSON.stringify({
          level,
          msg,
          timestamp: this.getTimestamp(),
          component: this.component,
        }),
      );
    } else {
      // Human-readable format for CLI
      const label = level.toUpperCase().padEnd(5);
      console.log(`[${label}] ${msg}`);
    }
  }

  /** Debug level logging */
  debug(msg: string): void {
    this.log("debug", msg);
  }

  /** Info level logging */
  info(msg: string): void {
    this.log("info", msg);
  }

  /** Warning level logging */
  warn(msg: string): void {
    this.log("warn", msg);
  }

  /** Error level logging */
  error(msg: string): void {
    this.log("error", msg);
  }
}
