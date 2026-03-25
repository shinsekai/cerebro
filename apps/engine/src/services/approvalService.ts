import { EventEmitter } from "events";
import type { ApprovalResponse } from "@cerebro/core";

/**
 * ApprovalService manages in-memory approval state with event-based signaling.
 * Replaces the old setInterval polling mechanism with efficient Promise resolution.
 */
export class ApprovalService extends EventEmitter {
  private approvalResponses: Map<string, ApprovalResponse> = new Map();
  private ticketWorkspaceRoots: Map<string, string> = new Map();
  private pendingPromises: Map<string, { resolve: (value: ApprovalResponse) => void; reject: (reason: Error) => void }> = new Map();

  /**
   * Record an approval response for a ticket.
   * Resolves any pending waitForApproval promise for this ticket.
   */
  recordResponse(ticketId: string, response: ApprovalResponse): void {
    this.approvalResponses.set(ticketId, response);

    // Resolve pending promise if exists
    const pending = this.pendingPromises.get(ticketId);
    if (pending) {
      pending.resolve(response);
      this.pendingPromises.delete(ticketId);
    }

    this.emit("response", ticketId, response);
  }

  /**
   * Wait for approval response for a ticket.
   * Returns a Promise that resolves when a response is recorded or rejects on timeout.
   */
  waitForApproval(ticketId: string, timeoutMs: number = 300000): Promise<ApprovalResponse> {
    // Check if response already exists
    const existingResponse = this.approvalResponses.get(ticketId);
    if (existingResponse) {
      this.approvalResponses.delete(ticketId);
      return Promise.resolve(existingResponse);
    }

    // Create new promise
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPromises.delete(ticketId);
        reject(new Error("No approval response in 5 minutes. Re-run the command to try again."));
      }, timeoutMs);

      // Store promise resolver with cleanup
      this.pendingPromises.set(ticketId, {
        resolve: (value: ApprovalResponse) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason: Error) => {
          clearTimeout(timeout);
          reject(reason);
        },
      });

      // Set up one-time listener for this ticket
      const onResponse = (id: string, response: ApprovalResponse) => {
        if (id === ticketId) {
          this.off("response", onResponse);
        }
      };
      this.on("response", onResponse);
    });
  }

  /**
   * Set the workspace root for a ticket.
   */
  setWorkspaceRoot(ticketId: string, root: string): void {
    this.ticketWorkspaceRoots.set(ticketId, root);
  }

  /**
   * Get the workspace root for a ticket.
   * Returns undefined if the ticket ID is unknown.
   */
  getWorkspaceRoot(ticketId: string): string | undefined {
    return this.ticketWorkspaceRoots.get(ticketId);
  }

  /**
   * Clear all state (useful for testing).
   */
  clear(): void {
    this.approvalResponses.clear();
    this.ticketWorkspaceRoots.clear();
    this.pendingPromises.clear();
  }

  /**
   * Get the number of pending approvals.
   */
  getPendingCount(): number {
    return this.pendingPromises.size;
  }
}

// Singleton instance for the engine
export const approvalService = new ApprovalService();
