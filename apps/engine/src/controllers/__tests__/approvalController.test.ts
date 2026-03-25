import { describe, it, expect, beforeEach } from "bun:test";
import {
  handleMeshApprove,
  type ApprovalControllerDeps,
} from "../approvalController.js";
import { approvalService } from "../../services/approvalService.js";
import type { ApprovalResponse } from "@cerebro/core";

describe("approvalController", () => {
  let deps: ApprovalControllerDeps;

  beforeEach(() => {
    // Clear approvalService state before each test
    approvalService.clear();
    deps = {};
  });

  describe("POST /mesh/approve", () => {
    it("should record approval with valid body", async () => {
      const mockApproval: ApprovalResponse = {
        ticketId: "123e4567-e89b-12d3-a456-426614174000",
        approved: true,
      };

      // Mock Hono context
      const mockC = {
        req: {
          json: async () => mockApproval,
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      const response = await handleMeshApprove(mockC as any, deps);
      const responseData = await response.json();

      expect(responseData).toEqual({
        success: true,
        message: "Approval recorded",
      });

      // Verify the approval was stored
      expect(await approvalService.waitForApproval(mockApproval.ticketId)).toEqual(mockApproval);
    });

    it("should record approval with rejected files", async () => {
      const mockApproval: ApprovalResponse = {
        ticketId: "123e4567-e89b-12d3-a456-426614174000",
        approved: true,
        rejectedFiles: ["src/file1.ts", "src/file2.ts"],
        reason: "Some files need changes",
      };

      // Mock Hono context
      const mockC = {
        req: {
          json: async () => mockApproval,
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      const response = await handleMeshApprove(mockC as any, deps);
      const responseData = await response.json();

      expect(responseData.success).toBe(true);

      // Verify the approval was stored correctly
      const stored = await approvalService.waitForApproval(mockApproval.ticketId);
      expect(stored?.approved).toBe(true);
      expect(stored?.rejectedFiles).toEqual(["src/file1.ts", "src/file2.ts"]);
      expect(stored?.reason).toBe("Some files need changes");
    });

    it("should record rejection with valid body", async () => {
      const mockApproval: ApprovalResponse = {
        ticketId: "123e4567-e89b-12d3-a456-426614174000",
        approved: false,
        reason: "Not satisfied with changes",
      };

      // Mock Hono context
      const mockC = {
        req: {
          json: async () => mockApproval,
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      const response = await handleMeshApprove(mockC as any, deps);
      const responseData = await response.json();

      expect(responseData.success).toBe(true);

      // Verify the rejection was stored
      const stored = await approvalService.waitForApproval(mockApproval.ticketId);
      expect(stored?.approved).toBe(false);
      expect(stored?.reason).toBe("Not satisfied with changes");
    });

    it("should return 400 with invalid ticketId (not UUID)", async () => {
      // Mock Hono context with invalid ticketId
      const mockC = {
        req: {
          json: async () => ({
            ticketId: "not-a-uuid",
            approved: true,
          }),
        },
        json: (data: any, status?: number) =>
          new Response(JSON.stringify(data), { status }),
      };

      const response = await handleMeshApprove(mockC as any, deps);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBeDefined();

      // Verify nothing was stored
      expect(approvalService.getPendingCount()).toBe(0);
    });

    it("should return 400 with missing ticketId", async () => {
      // Mock Hono context with missing ticketId
      const mockC = {
        req: {
          json: async () => ({
            approved: true,
          }),
        },
        json: (data: any, status?: number) =>
          new Response(JSON.stringify(data), { status }),
      };

      const response = await handleMeshApprove(mockC as any, deps);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBeDefined();

      // Verify nothing was stored
      expect(approvalService.getPendingCount()).toBe(0);
    });

    it("should return 400 with missing approved field", async () => {
      // Mock Hono context with missing approved field
      const mockC = {
        req: {
          json: async () => ({
            ticketId: "123e4567-e89b-12d3-a456-426614174000",
          }),
        },
        json: (data: any, status?: number) =>
          new Response(JSON.stringify(data), { status }),
      };

      const response = await handleMeshApprove(mockC as any, deps);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBeDefined();

      // Verify nothing was stored
      expect(approvalService.getPendingCount()).toBe(0);
    });

    it("should store multiple approvals independently", async () => {
      const approval1: ApprovalResponse = {
        ticketId: "123e4567-e89b-12d3-a456-426614174000",
        approved: true,
      };

      const approval2: ApprovalResponse = {
        ticketId: "223e4567-e89b-12d3-a456-426614174001",
        approved: false,
        reason: "Different ticket",
      };

      // Start waiting for both approvals first
      const wait1 = approvalService.waitForApproval(approval1.ticketId);
      const wait2 = approvalService.waitForApproval(approval2.ticketId);

      // Mock Hono context for first approval
      const mockC1 = {
        req: {
          json: async () => approval1,
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      // Mock Hono context for second approval
      const mockC2 = {
        req: {
          json: async () => approval2,
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      await handleMeshApprove(mockC1 as any, deps);
      await handleMeshApprove(mockC2 as any, deps);

      // Verify both are received correctly
      const [result1, result2] = await Promise.all([wait1, wait2]);
      expect(result1?.approved).toBe(true);
      expect(result2?.approved).toBe(false);
    });
  });
});
