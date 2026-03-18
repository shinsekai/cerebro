import type { StateTicket } from './schemas.js';

const MAX_RETRIES = 3;

export class CircuitBreaker {
  /**
   * Checks if a ticket has exceeded retry limits.
   * Modifies status to 'halted' if breached.
   * Returns true if safe to proceed, false if halted.
   */
  static check(ticket: StateTicket): boolean {
    if (ticket.retry_count >= MAX_RETRIES) {
      ticket.status = 'halted';
      return false;
    }
    return true;
  }

  /**
   * Increments the retry counter safely.
   */
  static recordFailure(ticket: StateTicket, errorPayload: string): void {
    ticket.retry_count += 1;
    ticket.error = errorPayload;
    ticket.status = 'failed';
  }
}
