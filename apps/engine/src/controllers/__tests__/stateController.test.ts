import { describe, it, expect } from "bun:test";
import {
  handlePostState,
  handleGetState,
  type StateControllerDeps,
} from "../stateController.js";
import type { StateTicket } from "@cerebro/core";

describe("stateController", () => {
  describe("POST /state", () => {
    it("should return success with valid body", async () => {
      const mockSaveTicket = async (_ticket: StateTicket) => Promise.resolve();
      const deps: StateControllerDeps = {
        saveStateTicket: mockSaveTicket,
        getStateTicket: async () => undefined,
      };

      // Mock Hono context
      const mockC = {
        req: {
          json: async () => ({
            id: "123e4567-e89b-12d3-a456-426614174000",
            task: "test task",
            retry_count: 0,
            status: "pending" as const,
          }),
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      const response = await handlePostState(mockC as any, deps);
      const responseData = await response.json();

      expect(responseData).toEqual({
        success: true,
        ticket: {
          id: "123e4567-e89b-12d3-a456-426614174000",
          task: "test task",
          retry_count: 0,
          status: "pending",
        },
      });
    });

    it("should return 400 with invalid body", async () => {
      const mockSaveTicket = async (_ticket: StateTicket) => Promise.resolve();
      const deps: StateControllerDeps = {
        saveStateTicket: mockSaveTicket,
        getStateTicket: async () => undefined,
      };

      // Mock Hono context with invalid body (missing id)
      const mockC = {
        req: {
          json: async () => ({
            task: "test task",
            retry_count: 0,
            status: "pending",
          }),
        },
        json: (data: any, status?: number) =>
          new Response(JSON.stringify(data), { status }),
      };

      const response = await handlePostState(mockC as any, deps);
      const responseData = await response.json();

      expect(response.status).toBe(400);
      expect(responseData.success).toBe(false);
      expect(responseData.error).toBeDefined();
    });
  });

  describe("GET /state/:id", () => {
    it("should return ticket with valid id", async () => {
      const mockTicket: StateTicket = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        task: "test task",
        retry_count: 0,
        status: "pending",
      };
      const deps: StateControllerDeps = {
        saveStateTicket: async () => Promise.resolve(),
        getStateTicket: async () => mockTicket,
      };

      // Mock Hono context
      const mockC = {
        req: {
          param: (key: string) =>
            key === "id" ? "123e4567-e89b-12d3-a456-426614174000" : undefined,
        },
        json: (data: any) => new Response(JSON.stringify(data)),
      };

      const response = await handleGetState(mockC as any, deps);
      const responseData = await response.json();

      expect(responseData).toEqual({
        success: true,
        ticket: mockTicket,
      });
    });

    it("should return 404 with unknown id", async () => {
      const deps: StateControllerDeps = {
        saveStateTicket: async () => Promise.resolve(),
        getStateTicket: async () => undefined,
      };

      // Mock Hono context
      const mockC = {
        req: {
          param: (key: string) =>
            key === "id" ? "unknown-id" : undefined,
        },
        json: (data: any, status?: number) =>
          new Response(JSON.stringify(data), { status }),
      };

      const response = await handleGetState(mockC as any, deps);
      const responseData = await response.json();

      expect(response.status).toBe(404);
      expect(responseData).toEqual({
        success: false,
        error: "Not found",
      });
    });
  });
});
