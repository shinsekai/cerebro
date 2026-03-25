import {
  type AgentCompletedEvent,
  type AgentFailedEvent,
  type AgentStartedEvent,
  type ApprovalRequestedEvent,
  type ApprovalResponse,
  type CerebroEvent,
  type DoneEvent,
  type ExecutionPlan,
  type FileChange,
  type StateTicket,
  type TicketCompletedEvent,
  type TicketFailedEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  buildExecutionWaves,
  getDownstreamAgents,
  getModelForAgent,
} from "@cerebro/core";
import {
  agenticBackendAgent,
  agenticFrontendAgent,
  agenticOpsAgent,
  agenticQualityAgent,
  agenticSecurityAgent,
  agenticTesterAgent,
  backendAgent,
  frontendAgent,
  opsAgent,
  qualityAgent,
  runAgentLoop,
  securityAgent,
  testerAgent,
} from "@cerebro/agents";
import { ToolExecutor, type ToolExecutor as ToolExecutorClass } from "@cerebro/workspace";
import {
  extractTokenDetails,
  formatCost,
  getPricingForModel,
} from "./pricing.js";
import { TokenTracker } from "./tokenTracker.js";
import fs from "fs/promises";
import path from "path";
import color from "picocolors";

/**
 * Result from executing a single agent step
 */
interface AgentStepResult {
  agent: string;
  output: string;
  fileChanges: FileChange[];
  tokenDetails: { totalTokens: number; cost: number };
}

/**
 * Agent configuration for single-shot execution
 */
interface AgentConfig {
  systemPrompt?: string;
  roleDescription?: string;
  invoke?(args: { context: string; workspaceContext: string }): Promise<any>;
}

/**
 * Dependency injection container for testability
 */
export interface MeshPipelineDeps {
  // Agent registries (allow injection for tests)
  agentRegistry?: Record<string, AgentConfig>;
  agenticAgentRegistry?: Record<string, { systemPrompt: string; roleDescription: string }>;
  // Core dependencies
  ToolExecutor?: new (options: { workspaceRoot: string }) => {
    execute(name: string, input: Record<string, unknown>): Promise<string>;
    getPendingWrites(): FileChange[];
  };
  runAgentLoop?: typeof runAgentLoop;
  // File system operations (allow injection for tests)
  fs?: {
    mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
    writeFile(path: string, content: string): Promise<void>;
    unlink(path: string): Promise<void>;
  };
}

/**
 * Configuration for the MeshPipeline
 */
export interface MeshPipelineConfig {
  workspaceRoot: string;
  contextString: string;
  ticket: StateTicket;
  plan: { content: ExecutionPlan; raw?: any };
  mode: "develop" | "fix" | "review" | "ops" | "chat";
  approvalService: {
    setWorkspaceRoot(ticketId: string, root: string): void;
    waitForApproval(ticketId: string): Promise<ApprovalResponse>;
  };
  saveStateTicket(ticket: StateTicket): Promise<void>;
  orchestratorPlanResult?: {
    tokens: number;
    cost: number;
  };
  deps?: MeshPipelineDeps;
}

/**
 * Interface for the stream that SSE events are sent to
 */
export interface PipelineStream {
  writeSSE(data: { event: string; data: string }): Promise<void>;
}

/**
 * Callback for emitting events during pipeline execution
 */
export interface EventCallback {
  (event: CerebroEvent | DoneEvent): void | Promise<void>;
}

/**
 * Pipeline for executing the mesh agent dispatch workflow.
 * Handles agent registry setup, wave execution, parallel dispatch,
 * result processing, failure tracking, downstream skip logic,
 * file change deduplication, and approval + file write flow.
 */
export class MeshPipeline {
  private config: MeshPipelineConfig;
  private agentOutputs: Record<string, string> = {};
  private allFileChanges: FileChange[] = [];
  private failedAgents: Array<{ agent: string; error: string }> = [];
  private skippedAgents: Array<{ agent: string; reason: string }> = [];
  private processedAgents = new Set<string>();
  private tokenTracker: TokenTracker;
  private eventQueue: (CerebroEvent | DoneEvent)[] = [];
  private eventHandlers: EventCallback[] = [];

  // Get dependencies with defaults
  private deps: Required<MeshPipelineDeps> & {
    fs: Required<MeshPipelineDeps>["fs"];
  };

  // Agent registries
  private agentRegistry = {
    frontend: frontendAgent,
    backend: backendAgent,
    quality: qualityAgent,
    security: securityAgent,
    tester: testerAgent,
    ops: opsAgent,
  } as const;

  private agenticAgentRegistry: Record<
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

  private agentDescriptions: Record<string, string> = {
    frontend: "Writing UI components...",
    backend: "Writing API and code logic...",
    quality: "Auditing code formatting and AST rules...",
    security: "Scanning for OWASP vulnerabilities...",
    tester: "Running AST verification and unit testing...",
    ops: "Handling DevOps and infrastructure tasks...",
  };

  constructor(config: MeshPipelineConfig) {
    this.config = config;
    this.tokenTracker = new TokenTracker();

    // Add orchestrator tokens if provided
    if (config.orchestratorPlanResult) {
      this.tokenTracker.addUsage(
        "orchestrator",
        config.orchestratorPlanResult.tokens,
        config.orchestratorPlanResult.cost,
      );
    }

    // Set up dependencies with defaults
    const providedDeps = config.deps || {};
    this.deps = {
      agentRegistry: providedDeps.agentRegistry || this.agentRegistry,
      agenticAgentRegistry: providedDeps.agenticAgentRegistry || this.agenticAgentRegistry,
      ToolExecutor: providedDeps.ToolExecutor || ToolExecutor,
      runAgentLoop: providedDeps.runAgentLoop || runAgentLoop,
      fs: providedDeps.fs || { mkdir: fs.mkdir, writeFile: fs.writeFile, unlink: fs.unlink },
    };
  }

  /**
   * Register an event handler to receive events during execution
   */
  onEvent(handler: EventCallback): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Emit an event to all registered handlers
   */
  private async emitEvent(event: CerebroEvent | DoneEvent): Promise<void> {
    this.eventQueue.push(event);
    for (const handler of this.eventHandlers) {
      await handler(event);
    }
  }

  /**
   * Emit a log event
   */
  private async emitLog(message: string, level: string = "info"): Promise<void> {
    await this.emitEvent({ type: "log", message, level });
  }

  /**
   * Execute all waves of the pipeline
   * Returns true on success, false on failure/halt
   */
  async executeWaves(): Promise<boolean> {
    const currentModel = process.env.ANTHROPIC_MODEL || "claude-opus-4-6";

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

    // Build execution waves
    const waves = buildExecutionWaves(this.config.plan.content);

    for (let wi = 0; wi < waves.length; wi++) {
      const wave = waves[wi];
      console.log(
        color.cyan(`[Mesh]`) +
          ` ` +
          color.cyan(
            `[Control Plane] Wave ${wi + 1}/${waves.length}: ${wave.map((s) => s.agent).join(", ")}`,
          ),
      );
      await this.emitLog(
        `[Control Plane] Wave ${wi + 1}/${waves.length}: ${wave.map((s) => s.agent).join(", ")}`,
        "info",
      );

      // Execute agents in this wave in parallel
      const results = await Promise.allSettled(
        wave.map(async (step) => {
          return await this.executeStep(step, wi + 1, getModelForStep);
        }),
      );

      // Process results: store outputs and file changes from successful agents
      await this.processResults(results, wave, wi);

      // Handle partial failures: mark downstream agents as skipped
      await this.handleDownstreamSkips();
    }

    // Deduplicate: last writer wins per path
    const dedupMap = new Map<string, FileChange>();
    for (const fc of this.allFileChanges) {
      dedupMap.set(fc.path, fc);
    }
    const fileChanges = Array.from(dedupMap.values());

    // Handle approval and file writing
    const approvalResult = await this.handleApprovalAndFileWrite(fileChanges);

    if (approvalResult !== "success") {
      return false; // Ticket failed or halted
    }

    // Generate final completion events
    const ticketCompletedEvent: TicketCompletedEvent = {
      type: "ticket_completed",
      ticket: this.config.ticket as any,
      usage: this.tokenTracker.toUsageReport(currentModel),
    };
    await this.emitEvent(ticketCompletedEvent);

    // Also send legacy 'done' event for backward compatibility
    const doneEvent: DoneEvent = {
      success: true,
      partial: this.failedAgents.length > 0,
      failedAgents: this.failedAgents,
      skippedAgents: this.skippedAgents,
      ticket: this.config.ticket as any,
      usage: this.tokenTracker.toUsageReport(currentModel),
    };
    await this.emitEvent(doneEvent);

    return true;
  }

  /**
   * Execute a single agent step
   */
  private async executeStep(
    step: { agent: string; description: string; depends_on: string[]; lightweight?: boolean },
    wave: number,
    getModelForStep: (step: { agent: string; lightweight?: boolean }) => string,
  ): Promise<AgentStepResult> {
    const { agent, description } = step;

    console.log(
      color.cyan(`[Mesh]`) +
        ` ` +
        color.magenta(
          `[Tier 2 ${agent.charAt(0).toUpperCase() + agent.slice(1)}] ${this.agentDescriptions[agent]}`,
        ),
    );
    const agentStartedEvent: AgentStartedEvent = {
      type: "agent_started",
      agent,
      description: this.agentDescriptions[agent],
      wave,
    };
    await this.emitEvent(agentStartedEvent);

    // Build context from previous wave outputs (dependencies already resolved)
    let context = this.config.ticket.task;
    if (step.depends_on.length > 0) {
      context +=
        "\n\n" +
        step.depends_on
          .map(
            (dep: string) =>
              `--- Output from ${dep} agent ---\n${this.agentOutputs[dep]}\n--- End ${dep} output ---`,
          )
          .join("\n");
    }

    const agenticConfig = this.deps.agenticAgentRegistry[agent];
    const useAgentic = process.env.CEREBRO_AGENTIC !== "false";

    // Get pricing for this step's model
    const modelName = getModelForStep(step);
    const modelPricing = getPricingForModel(modelName);

    let agentFileChanges: FileChange[] = [];
    let tokenCount = 0;
    let agentCost = 0;

    if (useAgentic && agenticConfig) {
      // AGENTIC MODE: use tool-calling loop
      const Executor = this.deps.ToolExecutor;
      const executor = new Executor({ workspaceRoot: this.config.workspaceRoot });
      const loopResult = await this.deps.runAgentLoop({
        systemPrompt: agenticConfig.systemPrompt
          .replace("{workspaceContext}", this.config.contextString)
          .replace("{context}", context),
        userMessage: `Execute your task: ${description}\n\nOriginal user request: ${this.config.ticket.task}`,
        toolExecutor: executor as unknown as ToolExecutorClass,
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
            color.cyan(`[Mesh]`) + ` ` + color.dim(`  ↳ ${summary}`),
          );
          const toolCallEvent: ToolCallEvent = {
            type: "tool_call",
            agent,
            tool: name,
            input: JSON.stringify(input).slice(0, 200),
          };
          await this.emitEvent(toolCallEvent);
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
          await this.emitEvent(toolResultEvent);
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
      const agentInstance = this.deps.agentRegistry[agent];
      if (!agentInstance?.invoke) {
        console.log(
          color.cyan(`[Mesh]`) +
            ` ` +
            color.red(
              `[Control Plane] Warning: Unknown agent type '${agent}'`,
            ),
        );
        await this.emitLog(
          `[Control Plane] Warning: Unknown agent type '${agent}'`,
          "error",
        );
        throw new Error(`Unknown agent type '${agent}'`);
      }
      const result: any = await agentInstance.invoke({
        context,
        workspaceContext: this.config.contextString,
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
    await this.emitEvent(agentCompletedEvent);

    return {
      agent,
      output: `${description} completed`,
      fileChanges: agentFileChanges,
      tokenDetails: { totalTokens: tokenCount, cost: agentCost },
    };
  }

  /**
   * Process wave results - store outputs and handle failures
   */
  private async processResults(
    results: PromiseSettledResult<AgentStepResult>[],
    wave: { agent: string; description: string; depends_on: string[]; lightweight?: boolean }[],
    waveIndex: number,
  ): Promise<void> {
    for (const r of results) {
      if (r.status === "fulfilled") {
        const { agent, output, fileChanges, tokenDetails } = r.value;
        this.agentOutputs[agent] = output;
        this.allFileChanges.push(...fileChanges);
        this.processedAgents.add(agent);

        // Track tokens per agent
        this.tokenTracker.addUsage(
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
            color.red(`[Wave ${waveIndex + 1}] Agent failed: ${reason}`),
        );
        // Find which agent failed from the wave
        const failedStep = wave[results.indexOf(r)];
        if (failedStep) {
          this.failedAgents.push({ agent: failedStep.agent, error: reason });
          const agentFailedEvent: AgentFailedEvent = {
            type: "agent_failed",
            agent: failedStep.agent,
            error: reason,
          };
          await this.emitEvent(agentFailedEvent);
        }
      }
    }
  }

  /**
   * Handle downstream agent skips when dependencies fail
   */
  private async handleDownstreamSkips(): Promise<void> {
    for (const failed of this.failedAgents) {
      const downstream = getDownstreamAgents(
        this.config.plan.content,
        failed.agent,
      );
      for (const downstreamAgent of downstream) {
        // Skip if already processed or already skipped
        if (this.processedAgents.has(downstreamAgent)) continue;
        if (this.skippedAgents.some((s) => s.agent === downstreamAgent))
          continue;

        console.log(
          color.cyan(`[Mesh]`) +
            ` ` +
            color.yellow(
              `[Control Plane] Skipping ${downstreamAgent} — dependency ${failed.agent} failed`,
            ),
        );
        await this.emitLog(
          `[Control Plane] Skipping ${downstreamAgent} — dependency ${failed.agent} failed`,
          "warn",
        );
        this.skippedAgents.push({
          agent: downstreamAgent,
          reason: `depends on ${failed.agent} which failed`,
        });
      }
    }
  }

  /**
   * Handle approval and file writing
   * Returns "success" if approved and files written, "halted" if timeout, "rejected" if rejected
   */
  private async handleApprovalAndFileWrite(
    fileChanges: FileChange[],
  ): Promise<"success" | "halted" | "rejected"> {
    // If there are file changes, request approval
    if (fileChanges.length > 0) {
      this.config.ticket.status = "awaiting-approval";
      await this.config.saveStateTicket(this.config.ticket);

      console.log(
        color.cyan(`[Mesh]`) +
          ` ` +
          color.yellow(
            `[Approval] Generated ${fileChanges.length} file change(s). Awaiting user approval...`,
          ),
      );
      await this.emitLog(
        `[Approval] Generated ${fileChanges.length} file change(s). Awaiting user approval...`,
        "warn",
      );

      // Send approval request via SSE
      const approvalEvent: ApprovalRequestedEvent = {
        type: "approval_requested",
        ticketId: this.config.ticket.id,
        files: fileChanges as any,
        summary: `Generated ${fileChanges.length} file(s) by ${Object.keys(this.agentOutputs).join(", ")} agents`,
      };
      await this.emitEvent(approvalEvent);

      // Wait for user approval
      let approval: ApprovalResponse;
      try {
        approval = await this.config.approvalService.waitForApproval(
          this.config.ticket.id,
        );
      } catch (_timeoutError) {
        this.config.ticket.status = "halted";
        await this.config.saveStateTicket(this.config.ticket);
        const timeoutMsg =
          "No approval response in 5 minutes. Re-run the command to try again.";
        console.log(
          color.cyan(`[Mesh]`) +
            ` ` +
            color.red(`[Approval] Timeout: ${timeoutMsg}`),
        );
        await this.emitLog(
          `[Approval] Timeout: ${timeoutMsg}`,
          "error",
        );
        const ticketFailedEvent: TicketFailedEvent = {
          type: "ticket_failed",
          error: timeoutMsg,
          ticket: this.config.ticket as any,
        };
        await this.emitEvent(ticketFailedEvent);
        return "halted";
      }

      // Handle approval response
      if (approval.approved) {
        this.config.ticket.status = "completed";
        await this.config.saveStateTicket(this.config.ticket);

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
        await this.emitLog(
          `[Approval] Approved. Writing ${filesToWrite.length} file(s)...`,
        );

        // Write files
        for (const fileChange of filesToWrite) {
          const fullPath = path.join(this.config.workspaceRoot, fileChange.path);

          if (fileChange.operation === "delete") {
            await this.deps.fs.unlink(fullPath);
            console.log(
              color.cyan(`[Mesh]`) +
                ` ` +
                color.dim(`[Files] Deleted: ${fileChange.path}`),
            );
            await this.emitLog(`[Files] Deleted: ${fileChange.path}`);
          } else {
            await this.deps.fs.mkdir(path.dirname(fullPath), { recursive: true });
            await this.deps.fs.writeFile(fullPath, fileChange.content);
            console.log(
              color.cyan(`[Mesh]`) +
                ` ` +
                color.dim(`[Files] Written: ${fileChange.path}`),
            );
            await this.emitLog(`[Files] Written: ${fileChange.path}`);
          }
        }

        console.log(
          color.cyan(`[Mesh]`) +
            ` ` +
            color.green(`[Files] All files written successfully.`),
        );
        await this.emitLog(`[Files] All files written successfully.`);
      } else {
        this.config.ticket.status = "failed";
        this.config.ticket.error = approval.reason || "User rejected changes";
        await this.config.saveStateTicket(this.config.ticket);

        console.log(
          color.cyan(`[Mesh]`) +
            ` ` +
            color.red(
              `[Approval] Rejected: ${approval.reason || "No reason provided"}`,
            ),
        );
        await this.emitLog(
          `[Approval] Rejected: ${approval.reason || "No reason provided"}`,
          "error",
        );
        const ticketFailedEvent: TicketFailedEvent = {
          type: "ticket_failed",
          error: "Changes rejected by user",
          ticket: this.config.ticket as any,
        };
        await this.emitEvent(ticketFailedEvent);
        return "rejected";
      }
    }

    // Update ticket context
    this.config.ticket.status = "completed";
    this.config.ticket.context = {
      code: this.agentOutputs.backend || this.agentOutputs.ops || "",
      tests: this.agentOutputs.tester || "",
      outputs: this.agentOutputs,
    };
    await this.config.saveStateTicket(this.config.ticket);

    console.log(
      color.cyan(`[Mesh]`) +
        ` ` +
        color.cyan(
          `[Mesh] Pipeline successfully achieved consensus. Halting.`,
        ),
    );
    await this.emitLog(
      `[Mesh] Pipeline successfully achieved consensus. Halting.`,
    );

    const totals = this.tokenTracker.getTotals();
    console.log(
      color.bgBlue(
        color.white(
          `\n 📊 Total Tokens Consumed: ${totals.tokens} | Cost: ${formatCost(totals.cost)} \n`,
        ),
      ),
    );

    return "success";
  }

  /**
   * Get the processed agent outputs
   */
  getAgentOutputs(): Record<string, string> {
    return this.agentOutputs;
  }

  /**
   * Get all file changes
   */
  getAllFileChanges(): FileChange[] {
    return this.allFileChanges;
  }

  /**
   * Get failed agents
   */
  getFailedAgents(): Array<{ agent: string; error: string }> {
    return this.failedAgents;
  }

  /**
   * Get skipped agents
   */
  getSkippedAgents(): Array<{ agent: string; reason: string }> {
    return this.skippedAgents;
  }

  /**
   * Get processed agents
   */
  getProcessedAgents(): Set<string> {
    return this.processedAgents;
  }

  /**
   * Get token tracker
   */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  /**
   * Get all events that were emitted during execution
   */
  getEventQueue(): (CerebroEvent | DoneEvent)[] {
    return this.eventQueue;
  }

  /**
   * Clear the event queue
   */
  clearEventQueue(): void {
    this.eventQueue = [];
  }
}
