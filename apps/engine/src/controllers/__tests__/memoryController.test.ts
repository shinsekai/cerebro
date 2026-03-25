import { describe, it, expect } from "bun:test";
import {
  handlePostMemory,
  handlePostMemorySearch,
  type MemoryControllerDeps,
} from "../memoryController.js";
import type { MemoryTicket } from "@cerebro/core";

describe("memoryController", () => {
  describe("POST /memory", () => {
    it("should return success with valid body", async () => {
      const mockSaveTicket = async (_ticket: MemoryTicket) => Promise.resolve();
      const deps: MemoryControllerDeps = {
        saveMemoryTicket: mockSaveTicket,
        searchSimilarMemory: async () => [],
      };

      // Mock Hono context
      const mockC = {
        req: {
          json: async () => ({
            id: "123e4567-e89b-12d3-a456-426614174000",
            task_hash: "test-hash",
            task_summary: "test task",
            solution_code: "console.log('test')",
          }),
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      const response = await handlePostMemory(mockC as any, deps);
      const responseData = await response.json();

      expect(responseData.success).toBe(true);
      expect(responseData.ticket.id).toBe("123e4567-e89b-12d3-a456-426614174000");
      expect(responseData.ticket.task_hash).toBe("test-hash");
      expect(responseData.ticket.task_summary).toBe("test task");
      expect(responseData.ticket.solution_code).toBe("console.log('test')");
      expect(responseData.ticket.created_at).toBeDefined();
    });

    it("should preserve created_at from body if provided", async () => {
      const mockSaveTicket = async (_ticket: MemoryTicket) => Promise.resolve();
      const deps: MemoryControllerDeps = {
        saveMemoryTicket: mockSaveTicket,
        searchSimilarMemory: async () => [],
      };

      const providedDate = new Date("2025-01-01T00:00:00Z");

      // Mock Hono context
      const mockC = {
        req: {
          json: async () => ({
            id: "123e4567-e89b-12d3-a456-426614174000",
            task_hash: "test-hash",
            task_summary: "test task",
            solution_code: "console.log('test')",
            created_at: providedDate.toISOString(),
          }),
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      const response = await handlePostMemory(mockC as any, deps);
      const responseData = await response.json();

      expect(new Date(responseData.ticket.created_at)).toEqual(providedDate);
    });

    it("should return 400 with invalid body", async () => {
      const mockSaveTicket = async (_ticket: MemoryTicket) => Promise.resolve();
      const deps: MemoryControllerDeps = {
        saveMemoryTicket: mockSaveTicket,
        searchSimilarMemory: async () => [],
      };

      // Mock Hono context with invalid body (missing id)
      const mockC = {
        req: {
          json: async () => ({
            task_hash: "test-hash",
            task_summary: "test task",
            solution_code: "console.log('test')",
          }),
        },
        json: (data: any, status?: number) =>
          new Response(JSON.stringify(data), { status }),
      };

      const response = await handlePostMemory(mockC as any, deps);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBeDefined();
    });
  });

  describe("POST /memory/search", () => {
    it("should return success with valid body", async () => {
      const mockResults: MemoryTicket[] = [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          task_hash: "test-hash",
          task_summary: "test task",
          solution_code: "console.log('test')",
          created_at: new Date(),
        },
      ];
      const deps: MemoryControllerDeps = {
        saveMemoryTicket: async () => Promise.resolve(),
        searchSimilarMemory: async (_emb, _thresh, _limit) => mockResults,
      };

      // Mock Hono context
      const mockC = {
        req: {
          json: async () => ({
            embedding: [0.1, 0.2, 0.3],
            threshold: 0.8,
            limit: 5,
          }),
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      const response = await handlePostMemorySearch(mockC as any, deps);
      const responseData = await response.json();

      expect(responseData.success).toBe(true);
      expect(responseData.results).toHaveLength(1);
      expect(responseData.results[0].id).toBe("123e4567-e89b-12d3-a456-426614174000");
    });

    it("should pass undefined for threshold and limit when not provided", async () => {
      const mockResults: MemoryTicket[] = [];
      const deps: MemoryControllerDeps = {
        saveMemoryTicket: async () => Promise.resolve(),
        searchSimilarMemory: async (_emb, threshold, limit) => {
          expect(threshold).toBeUndefined();
          expect(limit).toBeUndefined();
          return mockResults;
        },
      };

      // Mock Hono context
      const mockC = {
        req: {
          json: async () => ({
            embedding: [0.1, 0.2, 0.3],
          }),
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      const response = await handlePostMemorySearch(mockC as any, deps);
      const responseData = await response.json();

      expect(responseData.success).toBe(true);
    });

    it("should return 400 when embedding is not an array", async () => {
      const deps: MemoryControllerDeps = {
        saveMemoryTicket: async () => Promise.resolve(),
        searchSimilarMemory: async (_emb) => {
          throw new Error("embedding must be an array");
        },
      };

      // Mock Hono context with invalid embedding
      const mockC = {
        req: {
          json: async () => ({
            embedding: "not-an-array",
          }),
        },
        json: (data: any, status?: number) =>
          new Response(JSON.stringify(data), { status }),
      };

      const response = await handlePostMemorySearch(mockC as any, deps);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBeDefined();
    });

    it("should return 400 when embedding is missing", async () => {
      const deps: MemoryControllerDeps = {
        saveMemoryTicket: async () => Promise.resolve(),
        searchSimilarMemory: async (_emb) => {
          throw new Error("embedding is required");
        },
      };

      // Mock Hono context with missing embedding
      const mockC = {
        req: {
          json: async () => ({}),
        },
        json: (data: any, status?: number) =>
          new Response(JSON.stringify(data), { status }),
      };

      const response = await handlePostMemorySearch(mockC as any, deps);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBeDefined();
    });
  });
});
