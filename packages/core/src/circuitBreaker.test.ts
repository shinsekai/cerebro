import { describe, it, expect, beforeEach } from "bun:test";
import { CircuitBreaker } from "./circuitBreaker.js";
import type { StateTicket } from "./schemas.js";

describe("CircuitBreaker", () => {
  let mockTicket: StateTicket;

  beforeEach(() => {
    mockTicket = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      task: "Create a login component",
      retry_count: 0,
      status: "pending" as const,
    };
  });

  describe("check", () => {
    it("should return true when retry_count is less than MAX_RETRIES", () => {
      mockTicket.retry_count = 0;
      expect(CircuitBreaker.check(mockTicket)).toBe(true);
      expect(mockTicket.status).toBe("pending");
    });

    it("should return true when retry_count equals 2 (one below MAX_RETRIES)", () => {
      mockTicket.retry_count = 2;
      expect(CircuitBreaker.check(mockTicket)).toBe(true);
      expect(mockTicket.status).toBe("pending");
    });

    it("should return false when retry_count equals MAX_RETRIES", () => {
      mockTicket.retry_count = 3;
      expect(CircuitBreaker.check(mockTicket)).toBe(false);
      expect(mockTicket.status).toBe("halted");
    });

    it("should return false and set status to halted when retry_count exceeds MAX_RETRIES", () => {
      mockTicket.retry_count = 5;
      expect(CircuitBreaker.check(mockTicket)).toBe(false);
      expect(mockTicket.status).toBe("halted");
    });

    it("should not modify status when check passes", () => {
      mockTicket.status = "in-progress";
      mockTicket.retry_count = 1;
      CircuitBreaker.check(mockTicket);
      expect(mockTicket.status).toBe("in-progress");
    });

    it("should handle different initial statuses", () => {
      const statuses: const[] = [
        "pending",
        "in-progress",
        "completed",
        "failed",
      ];
      statuses.forEach((status) => {
        const ticket = { ...mockTicket, status: status as any, retry_count: 0 };
        const result = CircuitBreaker.check(ticket);
        expect(result).toBe(true);
        expect(ticket.status).toBe(status);
      });
    });
  });

  describe("recordFailure", () => {
    it("should increment retry_count by 1", () => {
      const initialCount = mockTicket.retry_count;
      CircuitBreaker.recordFailure(mockTicket, "Test error");
      expect(mockTicket.retry_count).toBe(initialCount + 1);
    });

    it("should set the error message", () => {
      const errorMessage = "API request failed with timeout";
      CircuitBreaker.recordFailure(mockTicket, errorMessage);
      expect(mockTicket.error).toBe(errorMessage);
    });

    it("should set status to failed", () => {
      CircuitBreaker.recordFailure(mockTicket, "Test error");
      expect(mockTicket.status).toBe("failed");
    });

    it("should allow recording multiple failures", () => {
      CircuitBreaker.recordFailure(mockTicket, "First error");
      expect(mockTicket.retry_count).toBe(1);
      expect(mockTicket.error).toBe("First error");

      CircuitBreaker.recordFailure(mockTicket, "Second error");
      expect(mockTicket.retry_count).toBe(2);
      expect(mockTicket.error).toBe("Second error");
    });

    it("should handle empty error message", () => {
      CircuitBreaker.recordFailure(mockTicket, "");
      expect(mockTicket.error).toBe("");
    });

    it("should handle long error messages", () => {
      const longError = "A".repeat(10000);
      CircuitBreaker.recordFailure(mockTicket, longError);
      expect(mockTicket.error).toBe(longError);
    });

    it("should handle error messages with special characters", () => {
      const specialError =
        'Error: {"code": 500, "message": "Test \'error\' with \\"quotes\\" and \n newlines"}';
      CircuitBreaker.recordFailure(mockTicket, specialError);
      expect(mockTicket.error).toBe(specialError);
    });

    it("should replace existing error message", () => {
      CircuitBreaker.recordFailure(mockTicket, "First error");
      CircuitBreaker.recordFailure(mockTicket, "Second error");
      expect(mockTicket.error).toBe("Second error");
    });
  });

  describe("integration scenarios", () => {
    it("should handle circuit breaker loop correctly", () => {
      // First failure
      CircuitBreaker.recordFailure(mockTicket, "Error 1");
      expect(mockTicket.retry_count).toBe(1);
      expect(mockTicket.status).toBe("failed");
      expect(CircuitBreaker.check(mockTicket)).toBe(true);

      // Reset status for next iteration
      mockTicket.status = "in-progress";

      // Second failure
      CircuitBreaker.recordFailure(mockTicket, "Error 2");
      expect(mockTicket.retry_count).toBe(2);
      expect(CircuitBreaker.check(mockTicket)).toBe(true);

      // Reset status for next iteration
      mockTicket.status = "in-progress";

      // Third failure
      CircuitBreaker.recordFailure(mockTicket, "Error 3");
      expect(mockTicket.retry_count).toBe(3);
      expect(CircuitBreaker.check(mockTicket)).toBe(false);
      expect(mockTicket.status).toBe("halted");
    });

    it("should allow recovery before reaching MAX_RETRIES", () => {
      CircuitBreaker.recordFailure(mockTicket, "Error 1");
      expect(mockTicket.retry_count).toBe(1);
      expect(mockTicket.status).toBe("failed");

      // Simulate successful recovery
      mockTicket.status = "completed";
      mockTicket.error = undefined;

      // Check should still work if retry_count is below limit
      expect(CircuitBreaker.check(mockTicket)).toBe(true);
    });
  });
});
