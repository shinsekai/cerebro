import type { FileChange } from "@cerebro/core";
import type { ToolExecutor } from "@cerebro/workspace";
import {
  AIMessage,
  type BaseMessage,
  type BaseMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import { getTier2ModelWithTools } from "./base.js";

// --- Zod Schemas ---

export const ToolCallHistorySchema = z.object({
  name: z.enum([
    "read_file",
    "write_file",
    "list_directory",
    "run_command",
    "search_files",
    "task_complete",
  ]),
  input: z.record(z.unknown()),
  result: z.string(),
});

export type ToolCallHistory = z.infer<typeof ToolCallHistorySchema>;

export const AgentLoopResultSchema = z.object({
  content: z.string(),
  toolCalls: z.array(ToolCallHistorySchema),
  pendingWrites: z.array(z.custom<FileChange>()),
  iterations: z.number().int().min(0),
  completeSummary: z.string().nullable(),
  totalTokens: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});

export type AgentLoopResult = z.infer<typeof AgentLoopResultSchema>;

export interface RunAgentLoopOptions {
  systemPrompt: string;
  userMessage: string;
  toolExecutor: ToolExecutor;
  maxIterations?: number;
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
  agentType?: string;
  lightweight?: boolean;
}

// ToolUseBlock compatible with LangChain's ContentBlock type
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  [key: string]: unknown;
}

// Type guard to check if a content block is a tool_use block
function isToolUseBlock(block: unknown): block is ToolUseBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "tool_use" &&
    "id" in block &&
    "name" in block &&
    "input" in block
  );
}

/**
 * Run an agentic loop where the agent uses tools iteratively until task completion.
 *
 * @param options - Loop configuration
 * @returns Result containing final content, tool call history, and pending writes
 */
export async function runAgentLoop(
  options: RunAgentLoopOptions,
): Promise<AgentLoopResult> {
  const {
    systemPrompt,
    userMessage,
    toolExecutor,
    maxIterations = 15,
    onToolCall,
    onToolResult,
    agentType,
    lightweight = false,
  } = options;

  const model = getTier2ModelWithTools(agentType, { lightweight });
  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userMessage),
  ];
  const toolCallHistory: ToolCallHistory[] = [];
  let iterations = 0;
  let completeSummary: string | null = null;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  while (iterations < maxIterations) {
    iterations++;

    const response = await model.invoke(messages);
    const usageMetadata = (
      response as BaseMessageChunk & {
        usage_metadata?: unknown;
      }
    ).usage_metadata;

    // Accumulate token usage
    if (usageMetadata) {
      const {
        input_tokens: iterInputTokens = 0,
        output_tokens: iterOutputTokens = 0,
      } = usageMetadata as Record<string, number>;
      inputTokens += iterInputTokens;
      outputTokens += iterOutputTokens;
      totalTokens += iterInputTokens + iterOutputTokens;
    }

    // Handle response content (can be string or array of blocks)
    const contentArray = Array.isArray(response.content)
      ? response.content
      : [];
    const toolBlocks = contentArray.filter(isToolUseBlock);

    // If no tool blocks, text-only response = done
    if (toolBlocks.length === 0) {
      break;
    }

    // Push the AI response with tool_use blocks
    messages.push(new AIMessage({ content: response.content }));

    // Execute each tool call
    for (const block of toolBlocks) {
      const result = await toolExecutor.execute(block.name, block.input);

      onToolCall?.(block.name, block.input);
      onToolResult?.(block.name, result);

      messages.push(
        new ToolMessage({
          content: result,
          tool_call_id: block.id,
        }),
      );

      toolCallHistory.push({
        name: block.name as ToolCallHistory["name"],
        input: block.input,
        result,
      });

      // If task_complete was called, parse summary and break
      if (block.name === "task_complete") {
        try {
          const parsed = JSON.parse(result);
          completeSummary = parsed.summary ?? null;
        } catch {
          completeSummary = null;
        }
        break;
      }
    }

    // Exit loop if task_complete was called
    if (completeSummary !== null) {
      break;
    }
  }

  // Extract final text content from messages
  const finalContent = extractFinalTextContent(messages);

  return {
    content: finalContent,
    toolCalls: toolCallHistory,
    pendingWrites: toolExecutor.getPendingWrites(),
    iterations,
    completeSummary,
    totalTokens,
    inputTokens,
    outputTokens,
  };
}

/**
 * Extract final text content from the conversation history.
 */
function extractFinalTextContent(messages: BaseMessage[]): string {
  const textParts: string[] = [];

  for (const message of messages) {
    if (message instanceof AIMessage) {
      const content = message.content;
      if (typeof content === "string") {
        textParts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string"
          ) {
            textParts.push(block.text);
          }
        }
      }
    } else if (message instanceof HumanMessage) {
      const content = message.content;
      if (typeof content === "string") {
        textParts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string"
          ) {
            textParts.push(block.text);
          }
        }
      }
    }
  }

  return textParts.join("\n\n").trim();
}
