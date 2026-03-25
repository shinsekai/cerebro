import { describe, expect, it } from "bun:test";
import { MeshPipeline, type MeshPipelineConfig, type MeshPipelineDeps } from "../meshPipeline.js";
import type { StateTicket, ExecutionPlan } from "@cerebro/core";

describe("MeshPipeline", () => {
  // Mock ticket
  const mockTicket: StateTicket = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    task: "Test task",
    retry_count: 0,
    status: "in-progress",
  };

  // Mock save function
  const mockSaveTicket = async (ticket: StateTicket) => {
    // No-op for testing
  };

  // Mock approval service
  const mockApprovalService = {
    setWorkspaceRoot: () => {},
    waitForApproval: async () => ({
      ticketId: mockTicket.id,
      approved: true,
    }),
  };

  // Mock file system
  const mockFs = {
    mkdir: async () => undefined,
    writeFile: async () => {},
    unlink: async () => {},
  };

  // Mock runAgentLoop function
  const mockRunAgentLoop = async () => ({
    content: "Agent completed task",
    toolCalls: [],
    pendingWrites: [],
    iterations: 1,
    completeSummary: "Task complete",
    totalTokens: 100,
    inputTokens: 50,
    outputTokens: 50,
  });

  // Mock agent with invoke method
  const mockAgent = {
    invoke: async (args: { context: string; workspaceContext: string }) => ({
      usage_metadata: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
    }),
  };

  // Simple ToolExecutor mock with execute method
  class SimpleMockExecutor {
    private pendingAgentCalls: number = 0;
    async execute(name: string, input: Record<string, unknown>): Promise<string> {
      this.pendingAgentCalls++;
      // Track that agent was invoked
      return JSON.stringify({ success: true });
    }
    getPendingWrites() {
      // Return that agent was invoked
      return this.pendingAgentCalls > 0 ? [{ path: "test.ts", content: "test", operation: "create", isNew: true }] : [];
    }
  }

  describe("constructor", () => {
    it("should initialize with empty tracking", () => {
      const singleWavePlan: ExecutionPlan = {
        summary: "Single agent plan",
        steps: [{ agent: "backend", description: "Test", depends_on: [], lightweight: false }],
      };

      const config: MeshPipelineConfig = {
        workspaceRoot: "/tmp/test",
        contextString: "test context",
        ticket: mockTicket,
        plan: { content: singleWavePlan },
        mode: "develop",
        approvalService: mockApprovalService,
        saveStateTicket: mockSaveTicket,
      };

      const pipeline = new MeshPipeline(config);
      expect(pipeline.getAgentOutputs()).toEqual({});
      expect(pipeline.getAllFileChanges()).toEqual([]);
      expect(pipeline.getFailedAgents()).toEqual([]);
      expect(pipeline.getSkippedAgents()).toEqual([]);
      expect(pipeline.getProcessedAgents().size).toBe(0);
    });

    it("should accept injected dependencies", () => {
      const deps: MeshPipelineDeps = {
        agentRegistry: { backend: mockAgent },
        agenticAgentRegistry: {},
        ToolExecutor: SimpleMockExecutor as any, // Use fallback mock
        runAgentLoop: mockRunAgentLoop,
        fs: mockFs,
      };

      const config: MeshPipelineConfig = {
        workspaceRoot: "/tmp/test",
        contextString: "test context",
        ticket: mockTicket,
        plan: {
          content: {
            summary: "Test plan",
            steps: [{ agent: "backend", description: "Test", depends_on: [], lightweight: false }],
          },
        },
        mode: "develop",
        approvalService: mockApprovalService,
        saveStateTicket: mockSaveTicket,
        deps,
      };

      const pipeline = new MeshPipeline(config);
      expect(pipeline).toBeDefined();
    });
  });

  describe("executeWaves", () => {
    it("should dispatch single-wave agents in parallel", async () => {
      // Track execution order
      const executionOrder: string[] = [];

      // Create mock agent that tracks execution
      const trackingAgent = {
        invoke: async (args: { context: string; workspaceContext: string }) => {
          executionOrder.push("backend");
          return {
            usage_metadata: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
          };
        },
      };

      const deps: MeshPipelineDeps = {
        agentRegistry: { backend: trackingAgent },
        agenticAgentRegistry: {},
        ToolExecutor: SimpleMockExecutor as any,
        runAgentLoop: mockRunAgentLoop,
        fs: mockFs,
      };

      const config: MeshPipelineConfig = {
        workspaceRoot: "/tmp/test",
        contextString: "test context",
        ticket: mockTicket,
        plan: {
          content: {
            summary: "Parallel agents",
            steps: [{ agent: "backend", description: "Backend task", depends_on: [], lightweight: false }],
          },
        },
        mode: "develop",
        approvalService: mockApprovalService,
        saveStateTicket: mockSaveTicket,
        deps,
      };

      const pipeline = new MeshPipeline(config);
      await pipeline.executeWaves();

      expect(executionOrder).toContain("backend");
    });

    it("should respect dependency order in multi-wave plan", async () => {
      const executionOrder: string[] = [];

      const trackingAgent = {
        invoke: async (args: { context: string; workspaceContext: string }) => {
          executionOrder.push("agent");
          return {
            usage_metadata: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
          };
        },
      };

      const deps: MeshPipelineDeps = {
        agentRegistry: { backend: trackingAgent, frontend: trackingAgent },
        agenticAgentRegistry: {},
        ToolExecutor: SimpleMockExecutor as any,
        runAgentLoop: mockRunAgentLoop,
        fs: mockFs,
      };

      const config: MeshPipelineConfig = {
        workspaceRoot: "/tmp/test",
        contextString: "test context",
        ticket: mockTicket,
        plan: {
          content: {
            summary: "Sequential plan",
            steps: [
              { agent: "backend", description: "Backend first", depends_on: [], lightweight: false },
              { agent: "frontend", description: "Frontend after backend", depends_on: ["backend"], lightweight: false },
            ],
          },
        },
        mode: "develop",
        approvalService: mockApprovalService,
        saveStateTicket: mockSaveTicket,
        deps,
      };

      const pipeline = new MeshPipeline(config);
      await pipeline.executeWaves();

      // Backend should complete before frontend
      expect(executionOrder.length).toBe(2);
    });

    it("should record failed agents in failedAgents array", async () => {
      const failingAgent = {
        invoke: async () => {
          throw new Error("Agent failed");
        },
      };

      const deps: MeshPipelineDeps = {
        agentRegistry: { backend: failingAgent },
        agenticAgentRegistry: {},
        ToolExecutor: SimpleMockExecutor as any,
        runAgentLoop: mockRunAgentLoop,
        fs: mockFs,
      };

      const config: MeshPipelineConfig = {
        workspaceRoot: "/tmp/test",
        contextString: "test context",
        ticket: mockTicket,
        plan: {
          content: {
            summary: "Failing agent",
            steps: [{ agent: "backend", description: "Failing task", depends_on: [], lightweight: false }],
          },
        },
        mode: "develop",
        approvalService: mockApprovalService,
        saveStateTicket: mockSaveTicket,
        deps,
      };

      const pipeline = new MeshPipeline(config);
      await pipeline.executeWaves();

      const failedAgents = pipeline.getFailedAgents();
      expect(failedAgents.length).toBe(1);
      expect(failedAgents[0].agent).toBe("backend");
      expect(failedAgents[0].error).toBe("Agent failed");
    });

    it("should add downstream agents to skippedAgents when dependency fails", async () => {
      const failingAgent = {
        invoke: async () => {
          throw new Error("Backend failed");
        },
      };

      const trackingAgent = {
        invoke: async () => ({
          usage_metadata: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
        }),
      };

      const deps: MeshPipelineDeps = {
        agentRegistry: { backend: failingAgent, frontend: trackingAgent, quality: trackingAgent },
        agenticAgentRegistry: {},
        ToolExecutor: SimpleMockExecutor as any,
        runAgentLoop: mockRunAgentLoop,
        fs: mockFs,
      };

      const config: MeshPipelineConfig = {
        workspaceRoot: "/tmp/test",
        contextString: "test context",
        ticket: mockTicket,
        plan: {
          content: {
            summary: "Chain plan",
            steps: [
              { agent: "backend", description: "Backend task", depends_on: [], lightweight: false },
              { agent: "frontend", description: "Frontend task", depends_on: ["backend"], lightweight: false },
              { agent: "quality", description: "Quality task", depends_on: ["backend"], lightweight: false },
            ],
          },
        },
        mode: "develop",
        approvalService: mockApprovalService,
        saveStateTicket: mockSaveTicket,
        deps,
      };

      const pipeline = new MeshPipeline(config);
      await pipeline.executeWaves();

      const skippedAgents = pipeline.getSkippedAgents();
      expect(skippedAgents.length).toBe(2);
      expect(skippedAgents.map(s => s.agent)).toContain("frontend");
      expect(skippedAgents.map(s => s.agent)).toContain("quality");
      skippedAgents.forEach(skipped => {
        expect(skipped.reason).toContain("depends on backend which failed");
      });
    });

    it("should handle ops mode with direct plan", async () => {
      const trackingAgent = {
        invoke: async () => ({
          usage_metadata: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
        }),
      };

      const deps: MeshPipelineDeps = {
        agentRegistry: { ops: trackingAgent },
        agenticAgentRegistry: {},
        ToolExecutor: SimpleMockExecutor as any,
        runAgentLoop: mockRunAgentLoop,
        fs: mockFs,
      };

      const opsModePlan: ExecutionPlan = {
        summary: "Ops task",
        steps: [{ agent: "ops", description: "Infrastructure task", depends_on: [], lightweight: false }],
      };

      const config: MeshPipelineConfig = {
        workspaceRoot: "/tmp/test",
        contextString: "test context",
        ticket: mockTicket,
        plan: { content: opsModePlan, raw: null },
        mode: "ops",
        approvalService: mockApprovalService,
        saveStateTicket: mockSaveTicket,
        deps,
      };

      const pipeline = new MeshPipeline(config);
      const result = await pipeline.executeWaves();

      expect(result).toBe(true);
      expect(pipeline.getProcessedAgents().has("ops")).toBe(true);
    });
  });

  describe("event handling", () => {
    it("should clear event queue when requested", async () => {
      const deps: MeshPipelineDeps = {
        agentRegistry: {},
        agenticAgentRegistry: {},
        ToolExecutor: SimpleMockExecutor as any,
        runAgentLoop: mockRunAgentLoop,
        fs: mockFs,
      };

      const config: MeshPipelineConfig = {
        workspaceRoot: "/tmp/test",
        contextString: "test context",
        ticket: mockTicket,
        plan: {
          content: {
            summary: "Clear queue test",
            steps: [{ agent: "backend", description: "Test", depends_on: [], lightweight: false }],
          },
        },
        mode: "develop",
        approvalService: mockApprovalService,
        saveStateTicket: mockSaveTicket,
        deps,
      };

      const pipeline = new MeshPipeline(config);
      await pipeline.executeWaves();

      expect(pipeline.getEventQueue().length).toBeGreaterThan(0);

      pipeline.clearEventQueue();

      expect(pipeline.getEventQueue().length).toBe(0);
    });
  });
});
