import { describe, expect, it } from "bun:test";
import { emitEvent, emitLog } from "../sse.js";

describe("sse", () => {
  describe("emitEvent", () => {
    it("should call stream.writeSSE with correct event/data format", async () => {
      const mockStream = {
        writeSSE: async (data: any) => {
          mockStream.calls.push(data);
        },
        calls: [] as any[],
      };

      const event = {
        type: "agent_started",
        agent: "frontend",
        description: "Writing UI components...",
        wave: 1,
      };

      await emitEvent(mockStream as any, event);

      expect(mockStream.calls.length).toBe(1);
      expect(mockStream.calls[0].event).toBe("agent_started");
      expect(mockStream.calls[0].data).toBe(JSON.stringify(event));
    });

    it("should handle complex nested events", async () => {
      const mockStream = {
        writeSSE: async (data: any) => {
          mockStream.calls.push(data);
        },
        calls: [] as any[],
      };

      const event = {
        type: "agent_completed",
        agent: "backend",
        tokens: 1500,
        cost: 0.03,
        duration: 4500,
      };

      await emitEvent(mockStream as any, event);

      expect(mockStream.calls[0].event).toBe("agent_completed");
      const parsedData = JSON.parse(mockStream.calls[0].data);
      expect(parsedData.agent).toBe("backend");
      expect(parsedData.tokens).toBe(1500);
    });
  });

  describe("emitLog", () => {
    it("should wrap message in a LogEvent structure", async () => {
      const mockStream = {
        writeSSE: async (data: any) => {
          mockStream.calls.push(data);
        },
        calls: [] as any[],
      };

      await emitLog(mockStream as any, "Test message");

      expect(mockStream.calls.length).toBe(1);
      expect(mockStream.calls[0].event).toBe("log");

      const parsedData = JSON.parse(mockStream.calls[0].data);
      expect(parsedData.type).toBe("log");
      expect(parsedData.message).toBe("Test message");
      expect(parsedData.level).toBe("info");
    });

    it("should accept custom log level", async () => {
      const mockStream = {
        writeSSE: async (data: any) => {
          mockStream.calls.push(data);
        },
        calls: [] as any[],
      };

      await emitLog(mockStream as any, "Warning message", "warn");

      expect(mockStream.calls.length).toBe(1);
      expect(mockStream.calls[0].event).toBe("log");

      const parsedData = JSON.parse(mockStream.calls[0].data);
      expect(parsedData.message).toBe("Warning message");
      expect(parsedData.level).toBe("warn");
    });

    it("should accept error log level", async () => {
      const mockStream = {
        writeSSE: async (data: any) => {
          mockStream.calls.push(data);
        },
        calls: [] as any[],
      };

      await emitLog(mockStream as any, "Error occurred", "error");

      const parsedData = JSON.parse(mockStream.calls[0].data);
      expect(parsedData.level).toBe("error");
    });
  });
});
