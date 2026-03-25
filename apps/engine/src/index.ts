import "dotenv/config";
import {
  agenticBackendAgent,
  agenticFrontendAgent,
  agenticOpsAgent,
  agenticQualityAgent,
  agenticSecurityAgent,
  agenticTesterAgent,
  backendAgent,
  frontendAgent,
  OrchestratorAgent,
  opsAgent,
  qualityAgent,
  runAgentLoop,
  securityAgent,
  testerAgent,
} from "@cerebro/agents";
import {
  type AgentCompletedEvent,
  type AgentFailedEvent,
  type AgentStartedEvent,
  type ApprovalRequestedEvent,
  type ApprovalResponse,
  ApprovalResponseSchema,
  buildExecutionWaves,
  type CerebroEvent,
  CircuitBreaker,
  type DoneEvent,
  type ErrorEvent,
  type FileChange,
  getDownstreamAgents,
  getModelForAgent,
  type LogEvent,
  Logger,
  MemoryTicketSchema,
  type ReviewResultEvent,
  StateTicketSchema,
  type TicketCompletedEvent,
  type TicketFailedEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@cerebro/core";
import {
  getStateTicket,
  saveMemoryTicket,
  saveStateTicket,
  searchSimilarMemory,
} from "@cerebro/database";
import {
  buildWorkspaceContext,
  formatContextForPrompt,
  ToolExecutor,
} from "@cerebro/workspace";
import fs from "fs/promises";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import path from "path";
import color from "picocolors";

const app = new Hono();

app.use("*", logger());

// Create logger for engine component
const log = new Logger("engine");

// --- Actionable Error Messages ---

interface ActionableError {
  message: string;
  debugHint?: string;
}

/**
 * Converts raw error messages into actionable guidance
 */
function getActionableError(rawError: string): ActionableError {
  const errorLower = rawError.toLowerCase();

  // Engine connection errors (reported back to CLI)
  if (
    errorLower.includes("econnrefused") ||
    errorLower.includes("fetch failed") ||
    errorLower.includes("connection refused") ||
    errorLower.includes("engine") ||
    errorLower.includes("localhost:8080")
  ) {
    return {
      message:
        "Engine unreachable on port 8080. Run `make dev-engine` in a separate terminal.",
    };
  }

  // API key errors
  if (
    errorLower.includes("api key") ||
    errorLower.includes("anthropic_api_key") ||
    errorLower.includes("unauthorized") ||
    errorLower.includes("401") ||
    errorLower.includes("invalid api key") ||
    errorLower.includes("not_provided")
  ) {
    return {
      message:
        "Invalid ANTHROPIC_API_KEY. Set it via: export ANTHROPIC_API_KEY=sk-...",
    };
  }

  // Database connection errors
  if (
    errorLower.includes("econnrefused") &&
    (errorLower.includes("5432") ||
      errorLower.includes("postgres") ||
      errorLower.includes("database"))
  ) {
    return {
      message: "Database unavailable. Run `make db-up` to start PostgreSQL.",
    };
  }

  // Rate limit errors
  if (
    errorLower.includes("rate limit") ||
    errorLower.includes("429") ||
    errorLower.includes("too many requests")
  ) {
    return {
      message: "API rate limited. Wait 60 seconds and retry.",
    };
  }

  // Context too large errors
  if (
    errorLower.includes("context") ||
    errorLower.includes("token") ||
    errorLower.includes("too large") ||
    errorLower.includes("exceeds") ||
    errorLower.includes("maximum")
  ) {
    return {
      message:
        "Context exceeds model limit. Try narrowing your task description or running `cerebro init` to index your workspace.",
    };
  }

  // Approval timeout errors
  if (
    errorLower.includes("approval timeout") ||
    errorLower.includes("timed out") ||
    errorLower.includes("timeout")
  ) {
    return {
      message:
        "No approval response in 5 minutes. Re-run the command to try again.",
    };
  }

  // Circuit breaker errors
  if (
    errorLower.includes("circuit breaker") ||
    errorLower.includes("3 retries") ||
    errorLower.includes("infinite loop") ||
    errorLower.includes("terminal failure")
  ) {
    return {
      message:
        "Task failed after 3 retries. The error may require manual intervention. Check .cerebro/logs/ for details.",
    };
  }

  // Catch-all
  return {
    message: rawError,
    debugHint: "Run with CEREBRO_LOG_LEVEL=debug for details.",
  };
}

// --- SSE Event Emission Helpers ---

/**
 * Emit a typed SSE event to the client
 */
async function emitEvent(stream: any, event: CerebroEvent): Promise<void> {
  await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
}

/**
 * Emit a legacy untyped log message (for backward compatibility)
 */
async function emitLog(
  stream: any,
  message: string,
  level = "info",
): Promise<void> {
  const logEvent: LogEvent = { type: "log", message, level };
  await emitEvent(stream, logEvent);
}

// In-memory approval state storage
const approvalResponses = new Map<string, ApprovalResponse>();

// Store workspace root per ticket
const ticketWorkspaceRoots = new Map<string, string>();

// Helper to wait for user approval
const waitForApproval = async (
  ticketId: string,
  timeoutMs = 300000,
): Promise<ApprovalResponse> => {
  return new Promise((resolve, reject) => {
    const checkInterval = setInterval(() => {
      const response = approvalResponses.get(ticketId);
      if (response) {
        clearInterval(checkInterval);
        approvalResponses.delete(ticketId);
        resolve(response);
      }
    }, 500);

    setTimeout(() => {
      clearInterval(checkInterval);
      reject(
        new Error(
          "No approval response in 5 minutes. Re-run the command to try again.",
        ),
      );
    }, timeoutMs);
  });
};

app.get("/", (c) => c.text("Cerebro Engine Running"));

// --- State Endpoints ---
app.post("/state", async (c) => {
  try {
    const body = await c.req.json();
    const ticket = StateTicketSchema.parse(body);
    await saveStateTicket(ticket);
    return c.json({ success: true, ticket });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const actionable = getActionableError(errorMsg);
    return c.json({ success: false, error: actionable.message }, 400);
  }
});

app.get("/state/:id", async (c) => {
  const id = c.req.param("id");
  const ticket = await getStateTicket(id);
  if (!ticket) return c.json({ success: false, error: "Not found" }, 404);
  return c.json({ success: true, ticket });
});

// --- Memory Endpoints ---
app.post("/memory", async (c) => {
  try {
    const body = await c.req.json();
    const ticket = MemoryTicketSchema.parse({
      ...body,
      created_at: body.created_at ? new Date(body.created_at) : new Date(),
    });
    await saveMemoryTicket(ticket);
    return c.json({ success: true, ticket });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const actionable = getActionableError(errorMsg);
    return c.json({ success: false, error: actionable.message }, 400);
  }
});

app.post("/memory/search", async (c) => {
  try {
    const { embedding, threshold, limit } = await c.req.json();
    const results = await searchSimilarMemory(embedding, threshold, limit);
    return c.json({ success: true, results });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const actionable = getActionableError(errorMsg);
    return c.json({ success: false, error: actionable.message }, 400);
  }
});

// --- Helper to clean raw API Error JSON strings ---
const cleanErrorMessage = (msg: string | undefined): string => {
  if (!msg) return "Unknown error";
  try {
    const match = msg.match(/^\d{3}\s+({.*})$/);
    if (match && match[1]) {
      const parsed = JSON.parse(match[1]);
      if (parsed?.error?.message) {
        return parsed.error.message;
      }
    }
  } catch (_e) {}
  return msg;
};

// --- Mesh Router (Server-Sent Events) ---
app.post("/mesh/loop", async (c) => {
  const body = await c.req.json();
  const ticket = StateTicketSchema.parse(body);
  await saveStateTicket(ticket);

  // Store workspace root for this ticket (from CLI or default to current working dir)
  const workspaceRoot = (body as any).workspaceRoot || process.cwd();
  ticketWorkspaceRoots.set(ticket.id, workspaceRoot);

  // Extract previous context for conversation history
  const previousContext = (body as any).previousContext;

  // Build history block if previous context exists
  let historyBlock = "";
  if (previousContext) {
    const { task, agentOutputs, fileChanges } = previousContext;
    historyBlock = `=== PREVIOUS SESSION ===
Previous task: ${task}

Previous outputs:
${Object.entries(agentOutputs || {})
  .map(([agent, output]) => `--- ${agent} ---\n${output}\n--- END ---`)
  .join("\n")}

Files changed: ${fileChanges ? fileChanges.join(", ") : "none"}
=== END PREVIOUS SESSION ===\n\n`;
  }

  return streamSSE(c, async (stream) => {
    let orchestratorTokens = 0;
    let frontendTokens = 0;
    let backendTokens = 0;
    let qualityTokens = 0;
    let securityTokens = 0;
    let testerTokens = 0;
    let opsTokens = 0;
    let orchestratorCost = 0;
    let frontendCost = 0;
    let backendCost = 0;
    let qualityCost = 0;
    let securityCost = 0;
    let testerCost = 0;
    let opsCost = 0;

    // Pricing configuration (per 1M tokens as of 2025)
    const MODEL_PRICING: Record<string, { input: number; output: number }> = {
      "claude-opus-4-6": { input: 15.0, output: 75.0 },
      "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
      "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
    };

    // Helper to get model name for an agent step
    const getModelForStep = (step: {
      agent: string;
      lightweight?: boolean;
    }): string => {
      if (step.lightweight) {
        return getModelForAgent("lightweight");
      }
      return getModelForAgent(step.agent);
    };

    // Helper to get pricing for a model
    const getPricingForModel = (modelName: string) => {
      return MODEL_PRICING[modelName] || MODEL_PRICING["claude-opus-4-6"];
    };

    const currentModel = process.env.ANTHROPIC_MODEL || "claude-opus-4-6";
    const currentPricing =
      MODEL_PRICING[currentModel] || MODEL_PRICING["claude-opus-4-6"];

    // Extract input/output tokens and calculate cost
    const extractTokenDetails = (res: any) => {
      const usage = res?.usage_metadata || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const totalTokens = usage.total_tokens || inputTokens + outputTokens;

      const cost =
        (inputTokens / 1_000_000) * currentPricing.input +
        (outputTokens / 1_000_000) * currentPricing.output;

      return { inputTokens, outputTokens, totalTokens, cost };
    };

    // Format cost for display
    const formatCost = (cost: number) => `$${cost.toFixed(4)}`;

    try {
      await emitLog(
        stream,
        `Initializing Mesh Loop for Ticket: ${ticket.id}`,
        "info",
      );
      console.log(
        color.cyan(`[Mesh]`) +
          ` ` +
          color.gray(`Initializing Mesh Loop for Ticket: ${ticket.id}`),
      );
      await emitLog(stream, `Task: "${ticket.task}"`, "info");
      console.log(
        color.cyan(`[Mesh]`) + ` ` + color.bold(`Task: "${ticket.task}"`),
      );

      // Build workspace context for agent awareness
      let contextString = "";
      try {
        const wsContext = await buildWorkspaceContext(
          workspaceRoot,
          ticket.task,
        );
        contextString = formatContextForPrompt(wsContext);
        // Prepend history block if it exists
        if (historyBlock) {
          contextString = historyBlock + contextString;
        }
        console.log(
          color.cyan(`[Mesh]`) +
            ` ` +
            color.cyan(
              `[Context] Workspace scanned: ${wsContext.profile.framework} / ${wsContext.profile.language}`,
            ),
        );
        await emitLog(
          stream,
          `[Context] Workspace scanned: ${wsContext.profile.framework} / ${wsContext.profile.language}`,
        );
      } catch (scanError: any) {
        console.log(
          color.cyan(`[Mesh]`) +
            ` ` +
            color.yellow(
              `[Context] Workspace scan failed: ${scanError.message}. Agents will work with empty context.`,
            ),
        );
        await emitLog(
          stream,
          `[Context] Workspace scan failed: ${scanError.message}. Agents will work with empty context.`,
          "warn",
        );
        contextString = historyBlock || "";
      }

      const orchestrator = new OrchestratorAgent();
      const mode = (body as any).mode || "develop";
      let plan: any;

      // Ops mode: skip orchestrator, create direct plan for ops agent only
      if (mode === "ops") {
        console.log(
          color.cyan(`[Mesh]`) +
            ` ` +
            color.magenta(
              `[Ops Mode] Bypassing orchestrator - direct ops agent dispatch...`,
            ),
        );
        await emitLog(
          stream,
          `[Ops Mode] Bypassing orchestrator - direct ops agent dispatch...`,
        );
        plan = {
          content: {
            summary: "Infrastructure and DevOps task",
            steps: [
              {
                agent: "ops",
                description: ticket.task,
                depends_on: [],
              },
            ],
          },
          raw: null, // No orchestrator usage
        };
        // No orchestrator tokens for ops mode
      } else {
        console.log(
          color.cyan(`[Mesh]`) +
            ` ` +
            color.magenta(
              `[Tier 1 Orchestrator] Analyzing request and planning constraints (mode: ${mode})...`,
            ),
        );
        await emitLog(
          stream,
          `[Tier 1 Orchestrator] Analyzing request and planning constraints (mode: ${mode})...`,
        );
        plan = await orchestrator.planExecution(
          ticket.task,
          mode as "develop" | "fix" | "review" | "ops" | "chat",
        );
        const orchestratorTokenDetails = extractTokenDetails(plan.raw);
        orchestratorTokens += orchestratorTokenDetails.totalTokens;
        orchestratorCost += orchestratorTokenDetails.cost;
        console.log(
          color.cyan(`[Mesh]`) +
            ` ` +
            color.green(
              `[Tier 1 Orchestrator] Plan generated successfully. (${orchestratorTokenDetails.totalTokens} tokens, ${formatCost(orchestratorTokenDetails.cost)})`,
            ),
        );
        await emitLog(
          stream,
          `[Tier 1 Orchestrator] Plan generated successfully. (${orchestratorTokenDetails.totalTokens} tokens, ${formatCost(orchestratorTokenDetails.cost)})`,
        );
      }

      ticket.status = "in-progress";
      await saveStateTicket(ticket);

      // --- CONTROL PLANE: Dynamic Agent Dispatcher ---
      const agentRegistry = {
        frontend: frontendAgent,
        backend: backendAgent,
        quality: qualityAgent,
        security: securityAgent,
        tester: testerAgent,
        ops: opsAgent,
      } as const;

      // Agentic agent registry (tool-calling loop mode)
      const agenticAgentRegistry: Record<
        string,
        { systemPrompt: string; roleDescription: string }
      > = {
        frontend: agenticFrontendAgent,
        backend: agenticBackendAgent,
        quality: agenticQualityAgent,
        security: agenticSecurityAgent,
        tester: agenticTesterAgent,
        ops: agenticOpsAgent,
      };

      const agentDescriptions: Record<string, string> = {
        frontend: "Writing UI components...",
        backend: "Writing API and code logic...",
        quality: "Auditing code formatting and AST rules...",
        security: "Scanning for OWASP vulnerabilities...",
        tester: "Running AST verification and unit testing...",
        ops: "Handling DevOps and infrastructure tasks...",
      };

      // Store agent outputs for dependencies
      const agentOutputs: Record<string, string> = {};
      const allFileChanges: FileChange[] = [];

      // Track failed and skipped agents across all waves
      const failedAgents: Array<{ agent: string; error: string }> = [];
      const skippedAgents: Array<{ agent: string; reason: string }> = [];
      const processedAgents = new Set<string>();

      while (CircuitBreaker.check(ticket)) {
        try {
          console.log(
            color.cyan(`[Mesh]`) +
              ` ` +
              color.yellow(
                `[Circuit Breaker] Starting Iteration ${ticket.retry_count + 1}/3...`,
              ),
          );
          await emitLog(
            stream,
            `[Circuit Breaker] Starting Iteration ${ticket.retry_count + 1}/3...`,
            "warn",
          );
          console.log(
            color.cyan(`[Mesh]`) +
              ` ` +
              color.cyan(
                `[Control Plane] Plan: ${plan.content.summary.slice(0, 80)}`,
              ),
          );
          await emitLog(
            stream,
            `[Control Plane] Plan: ${plan.content.summary}`,
          );

          // Build execution waves for parallel execution
          const waves = buildExecutionWaves(plan.content);

          for (let wi = 0; wi < waves.length; wi++) {
            const wave = waves[wi];
            console.log(
              color.cyan(`[Mesh]`) +
                ` ` +
                color.cyan(
                  `[Control Plane] Wave ${wi + 1}/${waves.length}: ${wave.map((s) => s.agent).join(", ")}`,
                ),
            );
            await emitLog(
              stream,
              `[Control Plane] Wave ${wi + 1}/${waves.length}: ${wave.map((s) => s.agent).join(", ")}`,
            );

            // Execute agents in this wave in parallel
            const results = await Promise.allSettled(
              wave.map(async (step) => {
                const { agent, description } = step;

                console.log(
                  color.cyan(`[Mesh]`) +
                    ` ` +
                    color.magenta(
                      `[Tier 2 ${agent.charAt(0).toUpperCase() + agent.slice(1)}] ${agentDescriptions[agent]}`,
                    ),
                );
                const agentStartedEvent: AgentStartedEvent = {
                  type: "agent_started",
                  agent,
                  description: agentDescriptions[agent],
                  wave: wi + 1,
                };
                await emitEvent(stream, agentStartedEvent);

                // Build context from previous wave outputs (dependencies already resolved)
                let context = ticket.task;
                if (step.depends_on.length > 0) {
                  context +=
                    "\n\n" +
                    step.depends_on
                      .map(
                        (dep: string) =>
                          `--- Output from ${dep} agent ---\n${agentOutputs[dep]}\n--- End ${dep} output ---`,
                      )
                      .join("\n");
                }

                const agenticConfig = agenticAgentRegistry[agent];
                const useAgentic = process.env.CEREBRO_AGENTIC !== "false";

                let agentFileChanges: FileChange[] = [];
                let tokenCount = 0;
                let agentCost = 0;

                if (useAgentic && agenticConfig) {
                  // AGENTIC MODE: use tool-calling loop
                  const executor = new ToolExecutor({ workspaceRoot });
                  const modelName = getModelForStep(step);
                  const modelPricing = getPricingForModel(modelName);
                  const loopResult = await runAgentLoop({
                    systemPrompt: agenticConfig.systemPrompt
                      .replace("{workspaceContext}", contextString)
                      .replace("{context}", context),
                    userMessage: `Execute your task: ${description}\n\nOriginal user request: ${ticket.task}`,
                    toolExecutor: executor,
                    maxIterations: 15,
                    onToolCall: async (name, input) => {
                      // Compact: "↳ read_file Makefile" not "read_file({"path":"Makefile"})"
                      let summary = name;
                      try {
                        const parsed =
                          typeof input === "string" ? JSON.parse(input) : input;
                        if (parsed.path) summary += ` ${parsed.path}`;
                        else if (parsed.command)
                          summary += ` ${String(parsed.command).slice(0, 40)}`;
                        else if (parsed.query)
                          summary += ` "${String(parsed.query).slice(0, 25)}"`;
                        else if (parsed.summary) summary += ` (completing)`;
                      } catch {
                        summary += ` ${JSON.stringify(input).slice(0, 40)}`;
                      }
                      console.log(
                        color.cyan(`[Mesh]`) +
                          ` ` +
                          color.dim(`  ↳ ${summary}`),
                      );
                      const toolCallEvent: ToolCallEvent = {
                        type: "tool_call",
                        agent,
                        tool: name,
                        input: JSON.stringify(input).slice(0, 200),
                      };
                      await emitEvent(stream, toolCallEvent);
                    },
                    onToolResult: async (_name, result) => {
                      // Silent on success — the tool_call log already told us what happened.
                      // Only log errors to the engine console.
                      if (
                        result.includes('"error"') ||
                        result.startsWith("Error:")
                      ) {
                        console.log(
                          color.cyan(`[Mesh]`) +
                            ` ` +
                            color.red(`  ✖ ${result.slice(0, 80)}`),
                        );
                      }
                      const toolResultEvent: ToolResultEvent = {
                        type: "tool_result",
                        agent,
                        tool: _name,
                        result: result.slice(0, 200),
                      };
                      await emitEvent(stream, toolResultEvent);
                    },
                    agentType: step.agent,
                    lightweight: step.lightweight,
                  });
                  agentFileChanges = executor.getPendingWrites();
                  tokenCount = loopResult.totalTokens;
                  agentCost =
                    (loopResult.inputTokens / 1_000_000) * modelPricing.input +
                    (loopResult.outputTokens / 1_000_000) * modelPricing.output;
                } else {
                  // FALLBACK: single-shot mode (old behavior)
                  const agentInstance =
                    agentRegistry[agent as keyof typeof agentRegistry];
                  if (!agentInstance) {
                    console.log(
                      color.cyan(`[Mesh]`) +
                        ` ` +
                        color.red(
                          `[Control Plane] Warning: Unknown agent type '${agent}'`,
                        ),
                    );
                    await emitLog(
                      stream,
                      `[Control Plane] Warning: Unknown agent type '${agent}'`,
                      "error",
                    );
                    throw new Error(`Unknown agent type '${agent}'`);
                  }
                  const result: any = await agentInstance.invoke({
                    context,
                    workspaceContext: contextString,
                  });
                  const tokenDetails = extractTokenDetails(result);
                  tokenCount = tokenDetails.totalTokens;
                  agentCost = tokenDetails.cost;
                }

                console.log(
                  color.cyan(`[Mesh]`) +
                    ` ` +
                    color.green(
                      `[Tier 2 ${agent.charAt(0).toUpperCase() + agent.slice(1)}] ` +
                        `${description} completed`,
                    ),
                );
                const agentCompletedEvent: AgentCompletedEvent = {
                  type: "agent_completed",
                  agent,
                  tokens: tokenCount,
                  cost: agentCost,
                  duration: 0, // TODO: track actual duration
                };
                await emitEvent(stream, agentCompletedEvent);

                return {
                  agent,
                  output: `${description} completed`,
                  fileChanges: agentFileChanges,
                  tokenDetails: { totalTokens: tokenCount, cost: agentCost },
                };
              }),
            );

            // Process results: store outputs and file changes from successful agents
            for (const r of results) {
              if (r.status === "fulfilled") {
                const { agent, output, fileChanges, tokenDetails } = r.value;
                agentOutputs[agent] = output;
                allFileChanges.push(...fileChanges);
                processedAgents.add(agent);

                // Track tokens per agent
                switch (agent) {
                  case "frontend":
                    frontendTokens += tokenDetails.totalTokens;
                    frontendCost += tokenDetails.cost;
                    break;
                  case "backend":
                    backendTokens += tokenDetails.totalTokens;
                    backendCost += tokenDetails.cost;
                    break;
                  case "quality":
                    qualityTokens += tokenDetails.totalTokens;
                    qualityCost += tokenDetails.cost;
                    break;
                  case "security":
                    securityTokens += tokenDetails.totalTokens;
                    securityCost += tokenDetails.cost;
                    break;
                  case "tester":
                    testerTokens += tokenDetails.totalTokens;
                    testerCost += tokenDetails.cost;
                    break;
                  case "ops":
                    opsTokens += tokenDetails.totalTokens;
                    opsCost += tokenDetails.cost;
                    break;
                }
              } else {
                const reason =
                  r.reason instanceof Error
                    ? r.reason.message
                    : String(r.reason);
                console.log(
                  color.cyan(`[Mesh]`) +
                    ` ` +
                    color.red(`[Wave ${wi + 1}] Agent failed: ${reason}`),
                );
                // Find which agent failed from the wave
                const failedStep = wave[results.indexOf(r)];
                if (failedStep) {
                  failedAgents.push({ agent: failedStep.agent, error: reason });
                  const agentFailedEvent: AgentFailedEvent = {
                    type: "agent_failed",
                    agent: failedStep.agent,
                    error: reason,
                  };
                  await emitEvent(stream, agentFailedEvent);
                }
              }
            }

            // Handle partial failures: mark downstream agents as skipped
            for (const failed of failedAgents) {
              const downstream = getDownstreamAgents(
                plan.content,
                failed.agent,
              );
              for (const downstreamAgent of downstream) {
                // Skip if already processed or already skipped
                if (processedAgents.has(downstreamAgent)) continue;
                if (skippedAgents.some((s) => s.agent === downstreamAgent))
                  continue;

                console.log(
                  color.cyan(`[Mesh]`) +
                    ` ` +
                    color.yellow(
                      `[Control Plane] Skipping ${downstreamAgent} — dependency ${failed.agent} failed`,
                    ),
                );
                await emitLog(
                  stream,
                  `[Control Plane] Skipping ${downstreamAgent} — dependency ${failed.agent} failed`,
                  "warn",
                );
                skippedAgents.push({
                  agent: downstreamAgent,
                  reason: `depends on ${failed.agent} which failed`,
                });
              }
            }
          }

          // Deduplicate: last writer wins per path
          const dedupMap = new Map<string, FileChange>();
          for (const fc of allFileChanges) {
            dedupMap.set(fc.path, fc);
          }
          const fileChanges = Array.from(dedupMap.values());

          // If there are file changes, request approval
          if (fileChanges.length > 0) {
            ticket.status = "awaiting-approval";
            await saveStateTicket(ticket);

            console.log(
              color.cyan(`[Mesh]`) +
                ` ` +
                color.yellow(
                  `[Approval] Generated ${fileChanges.length} file change(s). Awaiting user approval...`,
                ),
            );
            await emitLog(
              stream,
              `[Approval] Generated ${fileChanges.length} file change(s). Awaiting user approval...`,
              "warn",
            );

            // Send approval request via SSE
            const approvalEvent: ApprovalRequestedEvent = {
              type: "approval_requested",
              ticketId: ticket.id,
              files: fileChanges as any,
              summary: `Generated ${fileChanges.length} file(s) by ${Object.keys(agentOutputs).join(", ")} agents`,
            };
            await emitEvent(stream, approvalEvent);

            // Wait for user approval
            let approval: ApprovalResponse;
            try {
              approval = await waitForApproval(ticket.id);
            } catch (_timeoutError) {
              ticket.status = "halted";
              await saveStateTicket(ticket);
              const timeoutMsg =
                "No approval response in 5 minutes. Re-run the command to try again.";
              console.log(
                color.cyan(`[Mesh]`) +
                  ` ` +
                  color.red(`[Approval] Timeout: ${timeoutMsg}`),
              );
              await emitLog(
                stream,
                `[Approval] Timeout: ${timeoutMsg}`,
                "error",
              );
              const ticketFailedEvent: TicketFailedEvent = {
                type: "ticket_failed",
                error: timeoutMsg,
                ticket: ticket as any,
              };
              await emitEvent(stream, ticketFailedEvent);
              return;
            }

            // Handle approval response
            if (approval.approved) {
              ticket.status = "completed";
              await saveStateTicket(ticket);

              // Filter out rejected files
              const filesToWrite = approval.rejectedFiles
                ? fileChanges.filter(
                    (f) => !approval.rejectedFiles!.includes(f.path),
                  )
                : fileChanges;

              console.log(
                color.cyan(`[Mesh]`) +
                  ` ` +
                  color.green(
                    `[Approval] Approved. Writing ${filesToWrite.length} file(s)...`,
                  ),
              );
              await emitLog(
                stream,
                `[Approval] Approved. Writing ${filesToWrite.length} file(s)...`,
              );

              // Write files
              for (const fileChange of filesToWrite) {
                const fullPath = path.join(workspaceRoot, fileChange.path);

                if (fileChange.operation === "delete") {
                  await fs.unlink(fullPath);
                  console.log(
                    color.cyan(`[Mesh]`) +
                      ` ` +
                      color.dim(`[Files] Deleted: ${fileChange.path}`),
                  );
                  await emitLog(stream, `[Files] Deleted: ${fileChange.path}`);
                } else {
                  await fs.mkdir(path.dirname(fullPath), { recursive: true });
                  await fs.writeFile(fullPath, fileChange.content, "utf-8");
                  console.log(
                    color.cyan(`[Mesh]`) +
                      ` ` +
                      color.dim(`[Files] Written: ${fileChange.path}`),
                  );
                  await emitLog(stream, `[Files] Written: ${fileChange.path}`);
                }
              }

              console.log(
                color.cyan(`[Mesh]`) +
                  ` ` +
                  color.green(`[Files] All files written successfully.`),
              );
              await emitLog(stream, `[Files] All files written successfully.`);
            } else {
              ticket.status = "failed";
              ticket.error = approval.reason || "User rejected changes";
              await saveStateTicket(ticket);

              console.log(
                color.cyan(`[Mesh]`) +
                  ` ` +
                  color.red(
                    `[Approval] Rejected: ${approval.reason || "No reason provided"}`,
                  ),
              );
              await emitLog(
                stream,
                `[Approval] Rejected: ${approval.reason || "No reason provided"}`,
                "error",
              );
              const ticketFailedEvent: TicketFailedEvent = {
                type: "ticket_failed",
                error: "Changes rejected by user",
                ticket: ticket as any,
              };
              await emitEvent(stream, ticketFailedEvent);
              return;
            }
          }

          ticket.status = "completed";
          ticket.context = {
            code: agentOutputs.backend || agentOutputs.ops || "",
            tests: agentOutputs.tester || "",
            outputs: agentOutputs,
          };
          await saveStateTicket(ticket);

          console.log(
            color.cyan(`[Mesh]`) +
              ` ` +
              color.cyan(
                `[Mesh] Pipeline successfully achieved consensus. Halting.`,
              ),
          );
          await emitLog(
            stream,
            `[Mesh] Pipeline successfully achieved consensus. Halting.`,
          );

          const totalTokens =
            orchestratorTokens +
            backendTokens +
            frontendTokens +
            qualityTokens +
            securityTokens +
            testerTokens +
            opsTokens;
          const totalCost =
            orchestratorCost +
            backendCost +
            frontendCost +
            qualityCost +
            securityCost +
            testerCost +
            opsCost;
          console.log(
            color.bgBlue(
              color.white(
                `\n 📊 Total Tokens Consumed: ${totalTokens} | Cost: ${formatCost(totalCost)} \n`,
              ),
            ),
          );

          const tokenUsage = {
            orchestrator: {
              tokens: orchestratorTokens,
              cost: orchestratorCost,
            },
            frontend: { tokens: frontendTokens, cost: frontendCost },
            backend: { tokens: backendTokens, cost: backendCost },
            quality: { tokens: qualityTokens, cost: qualityCost },
            security: { tokens: securityTokens, cost: securityCost },
            tester: { tokens: testerTokens, cost: testerCost },
            ops: { tokens: opsTokens, cost: opsCost },
            total: { tokens: totalTokens, cost: totalCost },
            model: currentModel,
          };

          const ticketCompletedEvent: TicketCompletedEvent = {
            type: "ticket_completed",
            ticket: ticket as any,
            usage: tokenUsage,
          };
          await emitEvent(stream, ticketCompletedEvent);

          // Also send legacy 'done' event for backward compatibility
          const doneEvent: DoneEvent = {
            success: true,
            partial: failedAgents.length > 0,
            failedAgents,
            skippedAgents,
            ticket,
            usage: tokenUsage,
          };
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify(doneEvent),
          });
          break;
        } catch (agentError: any) {
          const rawMsg = agentError?.message || String(agentError);
          const cleanMsg = cleanErrorMessage(rawMsg);
          const actionable = getActionableError(cleanMsg);
          const userFacingMsg = actionable.debugHint
            ? `${actionable.message}\n  ${actionable.debugHint}`
            : actionable.message;
          console.log(
            color.cyan(`[Mesh]`) +
              ` ` +
              color.red(`[Mesh Error] ${userFacingMsg}`),
          );
          await emitLog(stream, `[Mesh Error] ${userFacingMsg}`, "error");
          // Log raw error at debug level if available
          if (process.env.CEREBRO_LOG_LEVEL === "debug") {
            log.debug(`Raw error: ${rawMsg}`);
          }
          CircuitBreaker.recordFailure(ticket, cleanMsg);
          await saveStateTicket(ticket);

          if ((ticket.status as string) === "halted") {
            const circuitMsg =
              "Task failed after 3 retries. The error may require manual intervention. Check .cerebro/logs/ for details.";
            log.error(
              `Circuit Breaker tripped: Terminal failure for ${ticket.id}.`,
            );
            const errorEvent: ErrorEvent = {
              success: false,
              error: circuitMsg,
            };
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify(errorEvent),
            });
            return;
          }
          console.log(
            color.cyan(`[Mesh]`) +
              ` ` +
              color.yellow(`[Mesh] Triggering fail-safe retry.`),
          );
          await emitLog(stream, `[Mesh] Triggering fail-safe retry.`, "warn");
        }
      }
    } catch (error: any) {
      const rawMsg = error?.message || String(error);
      const cleanMsg = cleanErrorMessage(rawMsg);
      const actionable = getActionableError(cleanMsg);
      const userFacingMsg = actionable.debugHint
        ? `${actionable.message}\n  ${actionable.debugHint}`
        : actionable.message;
      log.error(`Fatal Error: ${cleanMsg}`);
      if (process.env.CEREBRO_LOG_LEVEL === "debug") {
        log.debug(`Raw error: ${rawMsg}`);
      }
      const errorEvent: ErrorEvent = {
        success: false,
        error: userFacingMsg,
      };
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify(errorEvent),
      });
    }
  });
});

// --- Approval Endpoint ---
app.post("/mesh/approve", async (c) => {
  try {
    const body = await c.req.json();
    const approval = ApprovalResponseSchema.parse(body);
    approvalResponses.set(approval.ticketId, approval);
    return c.json({ success: true, message: "Approval recorded" });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const actionable = getActionableError(errorMsg);
    return c.json({ success: false, error: actionable.message }, 400);
  }
});

// --- Review Endpoint ---
app.post("/mesh/review", async (c) => {
  const body = await c.req.json();
  const ticket = StateTicketSchema.parse(body);
  const workspaceRoot = (body as any).workspaceRoot || process.cwd();
  const diff = (body as any).diff || "";
  const reviewTarget = (body as any).reviewTarget || "workspace";
  const lightweight = (body as any).lightweight || false;

  return streamSSE(c, async (stream) => {
    let orchestratorTokens = 0;
    let qualityTokens = 0;
    let securityTokens = 0;
    let orchestratorCost = 0;
    let qualityCost = 0;
    let securityCost = 0;

    // Pricing configuration (per 1M tokens as of 2025)
    const MODEL_PRICING: Record<string, { input: number; output: number }> = {
      "claude-opus-4-6": { input: 15.0, output: 75.0 },
      "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
      "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
    };

    // Helper to get pricing for a model
    const getPricingForModel = (modelName: string) => {
      return MODEL_PRICING[modelName] || MODEL_PRICING["claude-opus-4-6"];
    };

    const currentModel = process.env.ANTHROPIC_MODEL || "claude-opus-4-6";
    const currentPricing =
      MODEL_PRICING[currentModel] || MODEL_PRICING["claude-opus-4-6"];

    // Extract input/output tokens and calculate cost
    const extractTokenDetails = (res: any) => {
      const usage = res?.usage_metadata || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const totalTokens = usage.total_tokens || inputTokens + outputTokens;

      const cost =
        (inputTokens / 1_000_000) * currentPricing.input +
        (outputTokens / 1_000_000) * currentPricing.output;

      return { inputTokens, outputTokens, totalTokens, cost };
    };

    // Format cost for display
    const formatCost = (cost: number) => `$${cost.toFixed(4)}`;

    try {
      console.log(
        color.cyan(`[Review]`) +
          ` ` +
          color.gray(`Starting Code Review for Ticket: ${ticket.id}`),
      );
      await emitLog(stream, `Starting Code Review for Ticket: ${ticket.id}`);
      console.log(
        color.cyan(`[Review]`) +
          ` ` +
          color.bold(`Review target: "${reviewTarget}"`),
      );
      await emitLog(stream, `Review target: "${reviewTarget}"`);

      // Build workspace context for agent awareness
      let contextString = "";
      try {
        const wsContext = await buildWorkspaceContext(
          workspaceRoot,
          ticket.task,
        );
        contextString = formatContextForPrompt(wsContext);
        console.log(
          color.cyan(`[Review]`) +
            ` ` +
            color.cyan(
              `[Context] Workspace scanned: ${wsContext.profile.framework} / ${wsContext.profile.language}`,
            ),
        );
        await emitLog(
          stream,
          `[Context] Workspace scanned: ${wsContext.profile.framework} / ${wsContext.profile.language}`,
        );
      } catch (scanError: any) {
        console.log(
          color.cyan(`[Review]`) +
            ` ` +
            color.yellow(
              `[Context] Workspace scan failed: ${scanError.message}. Agents will work with empty context.`,
            ),
        );
        await emitLog(
          stream,
          `[Context] Workspace scan failed: ${scanError.message}. Agents will work with empty context.`,
          "warn",
        );
        contextString = "";
      }

      const orchestrator = new OrchestratorAgent();
      console.log(
        color.cyan(`[Review]`) +
          ` ` +
          color.magenta(`[Tier 1 Orchestrator] Analyzing review request...`),
      );
      await emitLog(
        stream,
        `[Tier 1 Orchestrator] Analyzing review request...`,
      );
      const plan: any = await orchestrator.planExecution(ticket.task, "review");
      const orchestratorTokenDetails = extractTokenDetails(plan.raw);
      orchestratorTokens += orchestratorTokenDetails.totalTokens;
      orchestratorCost += orchestratorTokenDetails.cost;
      console.log(
        color.cyan(`[Review]`) +
          ` ` +
          color.green(
            `[Tier 1 Orchestrator] Plan generated successfully. (${orchestratorTokenDetails.totalTokens} tokens, ${formatCost(orchestratorTokenDetails.cost)})`,
          ),
      );
      await emitLog(
        stream,
        `[Tier 1 Orchestrator] Plan generated successfully. (${orchestratorTokenDetails.totalTokens} tokens, ${formatCost(orchestratorTokenDetails.cost)})`,
      );

      ticket.status = "in-progress";

      // --- Review Mode: Only run quality and security agents ---
      const reviewAgents = ["quality", "security"];

      // Agentic agent registry (tool-calling loop mode)
      const agenticAgentRegistry: Record<
        string,
        { systemPrompt: string; roleDescription: string }
      > = {
        quality: agenticQualityAgent,
        security: agenticSecurityAgent,
      };

      const agentDescriptions: Record<string, string> = {
        quality: "Auditing code formatting and AST rules...",
        security: "Scanning for OWASP vulnerabilities...",
      };

      // Collect findings from both agents
      const allFindings: Array<{
        severity: "critical" | "warning" | "info";
        file: string;
        line: number;
        message: string;
        suggestion?: string;
      }> = [];

      for (const agent of reviewAgents) {
        console.log(
          color.cyan(`[Review]`) +
            ` ` +
            color.magenta(
              `[Tier 2 ${agent.charAt(0).toUpperCase() + agent.slice(1)}] ${agentDescriptions[agent]}`,
            ),
        );
        const agentStartedEvent: AgentStartedEvent = {
          type: "agent_started",
          agent,
          description: agentDescriptions[agent],
          wave: 1,
        };
        await emitEvent(stream, agentStartedEvent);

        const agenticConfig = agenticAgentRegistry[agent];
        const useAgentic = process.env.CEREBRO_AGENTIC !== "false";

        let agentFindings: any[] = [];
        let tokenCount = 0;
        let agentCost = 0;

        if (useAgentic && agenticConfig) {
          // AGENTIC MODE: For review, we use a custom single-shot prompt for structured JSON output
          const { ChatAnthropic } = await import("@langchain/anthropic");
          const reviewModelName = lightweight
            ? getModelForAgent("lightweight")
            : process.env.ANTHROPIC_MODEL || "claude-opus-4-6";
          const reviewModel = new ChatAnthropic({
            model: reviewModelName,
            temperature: 0,
            apiKey: process.env.ANTHROPIC_API_KEY || "not_provided",
          });

          const reviewPrompt = `${contextString}

You are conducting a code review for the following changes:

GIT DIFF:
${diff}

${
  agent === "quality"
    ? `
You are a CODE QUALITY REVIEWER. Analyze the diff for:
1. Code style issues (formatting, naming conventions)
2. Code complexity (cyclomatic complexity, nesting)
3. Potential bugs or logic errors
4. Code duplication
5. Missing error handling
6. TypeScript/typing issues
`
    : `
You are a SECURITY REVIEWER. Analyze the diff for:
1. SQL injection vulnerabilities
2. XSS (cross-site scripting) vectors
3. CSRF protection issues
4. Insecure direct object references
5. Hardcoded secrets or credentials
6. Missing input validation
7. Insecure dependencies
`
}

OUTPUT STRICTLY VALID JSON (no markdown, no explanation):
[
  {
    "severity": "critical|warning|info",
    "file": "path/to/file.ext",
    "line": 42,
    "message": "Description of the issue",
    "suggestion": "How to fix it (optional)"
  }
]

Severity levels:
- critical: Security vulnerabilities, major bugs that could crash the system
- warning: Code quality issues, potential bugs, deprecated patterns
- info: Minor issues, suggestions for improvement

If you find no issues, return an empty array: []`;

          const result: any = await reviewModel.invoke(reviewPrompt);
          const tokenDetails = extractTokenDetails(result);
          tokenCount = tokenDetails.totalTokens;
          const modelPricing = getPricingForModel(reviewModelName);
          agentCost =
            (tokenDetails.inputTokens / 1_000_000) * modelPricing.input +
            (tokenDetails.outputTokens / 1_000_000) * modelPricing.output;

          try {
            const content = result.content as string;
            // Try to extract JSON from the response
            const jsonMatch = content.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              agentFindings = JSON.parse(jsonMatch[0]);
            } else {
              // Try to parse entire content as JSON
              agentFindings = JSON.parse(content);
            }
          } catch (_parseError) {
            console.log(
              color.cyan(`[Review]`) +
                ` ` +
                color.yellow(
                  `[Tier 2 ${agent}] Failed to parse findings as JSON`,
                ),
            );
            await emitLog(
              stream,
              `[Tier 2 ${agent}] Failed to parse findings as JSON`,
              "warn",
            );
          }
        }

        console.log(
          color.cyan(`[Review]`) +
            ` ` +
            color.green(
              `[Tier 2 ${agent.charAt(0).toUpperCase() + agent.slice(1)}] Analysis complete (${tokenCount} tokens, ${formatCost(agentCost)})`,
            ),
        );
        const agentCompletedEvent: AgentCompletedEvent = {
          type: "agent_completed",
          agent,
          tokens: tokenCount,
          cost: agentCost,
          duration: 0,
        };
        await emitEvent(stream, agentCompletedEvent);

        // Track tokens
        if (agent === "quality") {
          qualityTokens += tokenCount;
          qualityCost += agentCost;
        } else {
          securityTokens += tokenCount;
          securityCost += agentCost;
        }

        // Merge findings
        allFindings.push(...agentFindings);
      }

      ticket.status = "completed";
      await saveStateTicket(ticket);

      // Send review result
      const reviewResultEvent: ReviewResultEvent = {
        type: "review_result",
        findings: allFindings,
        summary: `Found ${allFindings.length} issue(s)`,
      };
      await emitEvent(stream, reviewResultEvent);

      const totalTokens = orchestratorTokens + qualityTokens + securityTokens;
      const totalCost = orchestratorCost + qualityCost + securityCost;
      console.log(
        color.bgBlue(
          color.white(
            `\n 📊 Total Tokens Consumed: ${totalTokens} | Cost: ${formatCost(totalCost)} \n`,
          ),
        ),
      );

      const tokenUsage = {
        orchestrator: {
          tokens: orchestratorTokens,
          cost: orchestratorCost,
        },
        quality: { tokens: qualityTokens, cost: qualityCost },
        security: { tokens: securityTokens, cost: securityCost },
        total: { tokens: totalTokens, cost: totalCost },
        model: currentModel,
      };

      // Also send legacy 'done' event for backward compatibility
      const doneEvent: DoneEvent = {
        success: true,
        ticket,
        usage: tokenUsage,
      };
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify(doneEvent),
      });

      console.log(
        color.cyan(`[Review]`) +
          ` ` +
          color.cyan(`[Review] Analysis complete. Halting.`),
      );
      await emitLog(stream, `[Review] Analysis complete. Halting.`);
    } catch (error: any) {
      const rawMsg = error?.message || String(error);
      const cleanMsg = cleanErrorMessage(rawMsg);
      const actionable = getActionableError(cleanMsg);
      const userFacingMsg = actionable.debugHint
        ? `${actionable.message}\n  ${actionable.debugHint}`
        : actionable.message;
      log.error(`Review Fatal Error: ${cleanMsg}`);
      if (process.env.CEREBRO_LOG_LEVEL === "debug") {
        log.debug(`Raw error: ${rawMsg}`);
      }
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          success: false,
          error: userFacingMsg,
        }),
      });
    }
  });
});

export default {
  port: 8080,
  idleTimeout: 255, // 255 seconds max limit in Bun
  fetch: app.fetch,
};
