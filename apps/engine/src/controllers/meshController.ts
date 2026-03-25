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
  extractTokenDetails,
  formatCost,
  getPricingForModel,
} from "../services/pricing.js";
import { TokenTracker } from "../services/tokenTracker.js";
import {
  type AgentCompletedEvent,
  type AgentFailedEvent,
  type AgentStartedEvent,
  type ApprovalRequestedEvent,
  type ApprovalResponse,
  CircuitBreaker,
  type DoneEvent,
  type ErrorEvent,
  type FileChange,
  getDownstreamAgents,
  getModelForAgent,
  StateTicketSchema,
  type TicketCompletedEvent,
  type TicketFailedEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  buildExecutionWaves,
} from "@cerebro/core";
import {
  buildWorkspaceContext,
  formatContextForPrompt,
  ToolExecutor,
} from "@cerebro/workspace";
import fs from "fs/promises";
import path from "path";
import color from "picocolors";
import { cleanErrorMessage, emitEvent, emitLog, getActionableError, getLog } from "./utils.js";
import { streamSSE } from "hono/streaming";

export interface MeshControllerDeps {
  saveStateTicket: (ticket: any) => Promise<any>;
}

export interface ApprovalState {
  approvalResponses: Map<string, ApprovalResponse>;
  ticketWorkspaceRoots: Map<string, string>;
}

export interface MeshControllerOptions {
  approvalState: ApprovalState;
  deps: MeshControllerDeps;
  waitForApproval: (ticketId: string, timeoutMs?: number) => Promise<ApprovalResponse>;
}

export async function handleMeshLoop(c: any, options: MeshControllerOptions): Promise<Response> {
  const { approvalState, deps, waitForApproval } = options;
  const { approvalResponses, ticketWorkspaceRoots } = approvalState;
  const log = getLog();

  return streamSSE(c, async (stream) => {
    const tokenTracker = new TokenTracker();
    const currentModel = process.env.ANTHROPIC_MODEL || "claude-opus-4-6";
    const currentPricing = getPricingForModel(currentModel);

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

    try {
      const body = await c.req.json();
      const ticket = StateTicketSchema.parse(body);
      await deps.saveStateTicket(ticket);

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
        const orchestratorTokenDetails = extractTokenDetails(
          plan.raw,
          currentPricing,
        );
        tokenTracker.addUsage(
          "orchestrator",
          orchestratorTokenDetails.totalTokens,
          orchestratorTokenDetails.cost,
        );
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
      await deps.saveStateTicket(ticket);

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

                // Get pricing for this step's model
                const modelName = getModelForStep(step);
                const modelPricing = getPricingForModel(modelName);

                let agentFileChanges: FileChange[] = [];
                let tokenCount = 0;
                let agentCost = 0;

                if (useAgentic && agenticConfig) {
                  // AGENTIC MODE: use tool-calling loop
                  const executor = new ToolExecutor({ workspaceRoot });
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
                  const tokenDetails = extractTokenDetails(result, modelPricing);
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
                tokenTracker.addUsage(
                  agent,
                  tokenDetails.totalTokens,
                  tokenDetails.cost,
                );
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
            await deps.saveStateTicket(ticket);

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
              await deps.saveStateTicket(ticket);
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
              await deps.saveStateTicket(ticket);

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
              await deps.saveStateTicket(ticket);

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
          await deps.saveStateTicket(ticket);

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

          const totals = tokenTracker.getTotals();
          console.log(
            color.bgBlue(
              color.white(
                `\n 📊 Total Tokens Consumed: ${totals.tokens} | Cost: ${formatCost(totals.cost)} \n`,
              ),
            ),
          );

          const tokenUsage = tokenTracker.toUsageReport(currentModel);

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
          await deps.saveStateTicket(ticket);

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
}
