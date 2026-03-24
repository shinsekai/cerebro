import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ToolExecutor } from "@cerebro/workspace";
import type { BaseMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";
import { runAgentLoop } from "./agentLoop.js";

describe("runAgentLoop", () => {
  let mockToolExecutor: ToolExecutor;

  beforeEach(() => {
    mockToolExecutor = {
      execute: mock(async (toolName: string) => {
        switch (toolName) {
          case "read_file":
            return JSON.stringify({
              content: "mock file content",
              size: 100,
            });
          case "write_file":
            return JSON.stringify({
              success: true,
              operation: "create" as const,
            });
          case "run_command":
            return JSON.stringify({
              stdout: "all tests passed",
              stderr: "",
              exitCode: 0,
            });
          case "task_complete":
            return JSON.stringify({
              complete: true,
              summary: "Task completed successfully",
            });
          default:
            return JSON.stringify({ error: `Unknown tool: ${toolName}` });
        }
      }),
      getPendingWrites: mock(() => []),
    } as unknown as ToolExecutor;
  });

  afterEach(() => {
    mock.restore();
  });

  it("should process iterations and terminate on task_complete", async () => {
    const systemPrompt = "You are a test agent.";
    const userMessage = "Test the application.";
    const iterations: BaseMessage[][] = [];
    const toolCalls: string[] = [];

    const onToolCall = mock((name: string) => {
      toolCalls.push(name);
    });

    // Mock the model to simulate a sequence of tool calls
    const mockModel = {
      invoke: mock(async (messages: BaseMessage[]) => {
        iterations.push([...messages]);

        const lastMessage = messages[messages.length - 1];

        // If last message is a ToolMessage for read_file, respond with write_file
        if (lastMessage instanceof ToolMessage) {
          const toolCallId = lastMessage.tool_call_id;

          if (toolCallId === "read_1") {
            return {
              content: [
                {
                  type: "tool_use",
                  id: "write_1",
                  name: "write_file",
                  input: {
                    path: "test.ts",
                    content: "export const test = true;",
                  },
                },
              ],
              usage_metadata: {
                input_tokens: 100,
                output_tokens: 50,
              },
            };
          }

          if (toolCallId === "write_1") {
            return {
              content: [
                {
                  type: "tool_use",
                  id: "run_1",
                  name: "run_command",
                  input: { command: "bun test" },
                },
              ],
              usage_metadata: {
                input_tokens: 150,
                output_tokens: 30,
              },
            };
          }

          if (toolCallId === "run_1") {
            return {
              content: [
                {
                  type: "tool_use",
                  id: "complete_1",
                  name: "task_complete",
                  input: { summary: "All tests passed successfully" },
                },
              ],
              usage_metadata: {
                input_tokens: 100,
                output_tokens: 20,
              },
            };
          }
        }

        // First invocation - respond with read_file
        return {
          content: [
            {
              type: "tool_use",
              id: "read_1",
              name: "read_file",
              input: { path: "test.ts" },
            },
          ],
          usage_metadata: {
            input_tokens: 50,
            output_tokens: 40,
          },
        };
      }),
    };

    mock.module("@cerebro/core", () => ({
      CEREBRO_TOOLS: [],
    }));

    mock.module("./base.js", () => ({
      getTier2ModelWithTools: () => mockModel,
    }));

    // Run the agent loop
    const result = await runAgentLoop({
      systemPrompt,
      userMessage,
      toolExecutor: mockToolExecutor,
      maxIterations: 10,
      onToolCall,
    });

    // Assert loop processed all iterations correctly
    expect(iterations.length).toBe(4); // Initial + 3 iterations for each tool

    // Assert tool results fed back as ToolMessage
    const lastIteration = iterations[iterations.length - 1];
    const toolMessages = lastIteration.filter((m) => m instanceof ToolMessage);
    expect(toolMessages.length).toBe(1);

    // Assert loop terminated on task_complete
    expect(result.completeSummary).toBe("All tests passed successfully");
    expect(result.iterations).toBe(3);

    // Assert all tools were called
    expect(onToolCall).toHaveBeenCalledTimes(3);
    expect(toolCalls).toEqual(["read_file", "write_file", "run_command"]);

    // Assert token tracking
    expect(result.totalTokens).toBe(400); // Sum of all tokens
    expect(result.inputTokens).toBe(400);
    expect(result.outputTokens).toBe(140);
  });

  it("should handle no tool blocks (text-only response)", async () => {
    const mockModel = {
      invoke: mock(async () => ({
        content: "Here is the result without any tools.",
        usage_metadata: {
          input_tokens: 50,
          output_tokens: 30,
        },
      })),
    };

    mock.module("@cerebro/core", () => ({
      CEREBRO_TOOLS: [],
    }));

    mock.module("./base.js", () => ({
      getTier2ModelWithTools: () => mockModel,
    }));

    const result = await runAgentLoop({
      systemPrompt: "You are a simple agent.",
      userMessage: "Generate some text.",
      toolExecutor: mockToolExecutor,
      maxIterations: 10,
    });

    // Should exit after first iteration since no tools were called
    expect(result.iterations).toBe(1);
    expect(result.completeSummary).toBeNull();
    expect(result.toolCalls).toHaveLength(0);
    expect(result.content).toBe("Here is the result without any tools.");
  });

  it("should stop at maxIterations", async () => {
    let invokeCount = 0;

    const mockModel = {
      invoke: mock(async () => {
        invokeCount++;
        return {
          content: [
            {
              type: "tool_use",
              id: `tool_${invokeCount}`,
              name: "read_file",
              input: { path: `file${invokeCount}.ts` },
            },
          ],
          usage_metadata: {
            input_tokens: 50,
            output_tokens: 30,
          },
        };
      }),
    };

    mock.module("@cerebro/core", () => ({
      CEREBRO_TOOLS: [],
    }));

    mock.module("./base.js", () => ({
      getTier2ModelWithTools: () => mockModel,
    }));

    const result = await runAgentLoop({
      systemPrompt: "You are a looping agent.",
      userMessage: "Keep reading files.",
      toolExecutor: mockToolExecutor,
      maxIterations: 3,
    });

    // Should stop at maxIterations
    expect(result.iterations).toBe(3);
    expect(invokeCount).toBe(3);
    expect(result.completeSummary).toBeNull();
  });

  it("should accumulate token usage across iterations", async () => {
    const mockModel = {
      invoke: mock(async (messages) => {
        const lastMessage = messages[messages.length - 1];

        if (lastMessage instanceof ToolMessage) {
          return {
            content: [
              {
                type: "tool_use",
                id: "complete_1",
                name: "task_complete",
                input: { summary: "Done" },
              },
            ],
            usage_metadata: {
              input_tokens: 100,
              output_tokens: 50,
            },
          };
        }

        return {
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "read_file",
              input: { path: "file.ts" },
            },
          ],
          usage_metadata: {
            input_tokens: 200,
            output_tokens: 100,
          },
        };
      }),
    };

    mock.module("@cerebro/core", () => ({
      CEREBRO_TOOLS: [],
    }));

    mock.module("./base.js", () => ({
      getTier2ModelWithTools: () => mockModel,
    }));

    const result = await runAgentLoop({
      systemPrompt: "You are an agent.",
      userMessage: "Read a file.",
      toolExecutor: mockToolExecutor,
      maxIterations: 10,
    });

    expect(result.totalTokens).toBe(450); // (200+100) + (100+50)
    expect(result.inputTokens).toBe(300); // 200 + 100
    expect(result.outputTokens).toBe(150); // 100 + 50
  });

  it("should call onToolResult callback for each tool execution", async () => {
    const mockModel = {
      invoke: mock(async (messages) => {
        const lastMessage = messages[messages.length - 1];

        if (lastMessage instanceof ToolMessage) {
          return {
            content: [
              {
                type: "tool_use",
                id: "complete_1",
                name: "task_complete",
                input: { summary: "Completed" },
              },
            ],
            usage_metadata: { input_tokens: 50, output_tokens: 20 },
          };
        }

        return {
          content: [
            {
              type: "tool_use",
              id: "read_1",
              name: "read_file",
              input: { path: "test.ts" },
            },
          ],
          usage_metadata: { input_tokens: 50, output_tokens: 30 },
        };
      }),
    };

    mock.module("@cerebro/core", () => ({
      CEREBRO_TOOLS: [],
    }));

    mock.module("./base.js", () => ({
      getTier2ModelWithTools: () => mockModel,
    }));

    const onToolResult = mock((name: string, result: string) => {
      expect(name).toBeDefined();
      expect(result).toBeDefined();
    });

    await runAgentLoop({
      systemPrompt: "You are an agent.",
      userMessage: "Test.",
      toolExecutor: mockToolExecutor,
      maxIterations: 10,
      onToolResult,
    });

    // Should have called onToolResult for read_file
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });
});
