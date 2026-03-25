import { describe, it, expect, beforeEach } from "bun:test";
import { ApprovalService } from "../approvalService.js";
import type { ApprovalResponse } from "@cerebro/core";

describe("ApprovalService", () => {
  let service: ApprovalService;
  const testTicketId = "test-ticket-123";
  const testWorkspaceRoot = "/test/workspace/root";

  beforeEach(() => {
    service = new ApprovalService();
  });

  describe("recordResponse() and waitForApproval()", () => {
    it("should resolve immediately when response already exists", async () => {
      const mockResponse: ApprovalResponse = {
        ticketId: testTicketId,
        approved: true,
      };

      // Record response first
      service.recordResponse(testTicketId, mockResponse);

      // Should resolve immediately
      const result = await service.waitForApproval(testTicketId);
      expect(result).toEqual(mockResponse);

      // Response should be consumed (deleted after retrieval)
      expect(service.getPendingCount()).toBe(0);
    });

    it("should resolve when response arrives after waitForApproval is called", async () => {
      const mockResponse: ApprovalResponse = {
        ticketId: testTicketId,
        approved: true,
        rejectedFiles: ["file1.ts"],
      };

      const approvalPromise = service.waitForApproval(testTicketId);

      // Simulate async response
      setTimeout(() => {
        service.recordResponse(testTicketId, mockResponse);
      }, 10);

      const result = await approvalPromise;
      expect(result).toEqual(mockResponse);
    });

    it("should resolve with < 50ms latency when response arrives", async () => {
      const mockResponse: ApprovalResponse = {
        ticketId: testTicketId,
        approved: true,
      };

      const approvalPromise = service.waitForApproval(testTicketId);
      const startTime = performance.now();

      // Record response almost immediately
      setTimeout(() => {
        service.recordResponse(testTicketId, mockResponse);
      }, 5);

      await approvalPromise;
      const latency = performance.now() - startTime;

      // Should be well under 50ms (not the old 500ms polling delay)
      expect(latency).toBeLessThan(50);
    });

    it("should reject after timeout if no response arrives", async () => {
      // Short timeout for test
      const timeoutMs = 100;

      await expect(service.waitForApproval(testTicketId, timeoutMs)).rejects.toThrow(
        "No approval response in 5 minutes",
      );
    });

    it("should handle multiple tickets independently", async () => {
      const ticket1 = "ticket-1";
      const ticket2 = "ticket-2";

      const response1: ApprovalResponse = { ticketId: ticket1, approved: true };
      const response2: ApprovalResponse = { ticketId: ticket2, approved: false, reason: "test" };

      const promise1 = service.waitForApproval(ticket1);
      const promise2 = service.waitForApproval(ticket2);

      // Record responses in reverse order
      setTimeout(() => service.recordResponse(ticket2, response2), 5);
      setTimeout(() => service.recordResponse(ticket1, response1), 10);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toEqual(response1);
      expect(result2).toEqual(response2);
    });
  });

  describe("setWorkspaceRoot() and getWorkspaceRoot()", () => {
    it("should store and retrieve workspace root for a ticket", () => {
      service.setWorkspaceRoot(testTicketId, testWorkspaceRoot);

      const result = service.getWorkspaceRoot(testTicketId);
      expect(result).toBe(testWorkspaceRoot);
    });

    it("should return undefined for unknown ticket ID", () => {
      const result = service.getWorkspaceRoot("non-existent-ticket");
      expect(result).toBeUndefined();
    });

    it("should update workspace root for existing ticket", () => {
      service.setWorkspaceRoot(testTicketId, "/old/path");
      service.setWorkspaceRoot(testTicketId, "/new/path");

      const result = service.getWorkspaceRoot(testTicketId);
      expect(result).toBe("/new/path");
    });

    it("should handle multiple tickets independently", () => {
      const ticket1 = "ticket-1";
      const ticket2 = "ticket-2";

      service.setWorkspaceRoot(ticket1, "/path/1");
      service.setWorkspaceRoot(ticket2, "/path/2");

      expect(service.getWorkspaceRoot(ticket1)).toBe("/path/1");
      expect(service.getWorkspaceRoot(ticket2)).toBe("/path/2");
    });
  });

  describe("pending count and clear()", () => {
    it("should track pending approvals", () => {
      service.waitForApproval("ticket-1");
      service.waitForApproval("ticket-2");
      service.waitForApproval("ticket-3");

      expect(service.getPendingCount()).toBe(3);
    });

    it("should decrement pending count when response arrives", async () => {
      const ticket = "pending-ticket";
      service.waitForApproval(ticket);

      expect(service.getPendingCount()).toBe(1);

      service.recordResponse(ticket, { ticketId: ticket, approved: true });

      // Small delay to allow promise resolution
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(service.getPendingCount()).toBe(0);
    });

    it("should clear all state", () => {
      service.setWorkspaceRoot("ticket-1", "/path/1");
      service.waitForApproval("ticket-2");
      service.recordResponse("ticket-3", { ticketId: "ticket-3", approved: true });

      expect(service.getPendingCount()).toBeGreaterThan(0);

      service.clear();

      expect(service.getPendingCount()).toBe(0);
      expect(service.getWorkspaceRoot("ticket-1")).toBeUndefined();
    });
  });

  describe("response event emission", () => {
    it("should emit event when response is recorded", (done) => {
      const mockResponse: ApprovalResponse = {
        ticketId: testTicketId,
        approved: true,
      };

      service.on("response", (ticketId: string, response: ApprovalResponse) => {
        expect(ticketId).toBe(testTicketId);
        expect(response).toEqual(mockResponse);
        done();
      });

      service.recordResponse(testTicketId, mockResponse);
    });
  });
});
