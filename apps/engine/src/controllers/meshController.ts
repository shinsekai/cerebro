import {
  type AgentCompletedEvent,
  type AgentFailedEvent,
  type AgentStartedEvent,
  type ApprovalRequestedEvent,
  type ApprovalResponse,
  type CircuitBreaker,
  type FileChange,
  type StateTicket,
  type TicketCompletedEvent,
  type TicketFailedEvent,
  type DoneEvent,
  type TokenUsage,
  buildExecutionWaves,
  getDownstreamAgents,
  getModelForAgent,
} from "@cerebro/core";
import { color } from "picocolors";
import type { MeshPipelineConfig, MeshPipelineDeps } from "../services/meshPipeline.js";
import { buildWorkspaceContext, formatContextForPrompt, ToolExecutor } from "@cerebro/workspace";
import { approvalService } from "../services/approvalService.js";
import {
  emitEvent,
  emitLog,
} from "./utils.js";
import { cleanErrorMessage, getActionableError } from "./utils.js";
import {
  extractTokenDetails,
  formatCost,
  getPricingForModel,
} from "../services/pricing.js";
import { TokenTracker } from "../services/tokenTracker.js";
import { color } from "picocolors";
import fs from "fs/promises";

export interface MeshControllerDeps {
  saveStateTicket: (ticket: StateTicket) => Promise<void>;
}

export interface MeshControllerOptions {
  deps: MeshControllerDeps;
  approvalService: typeof approvalService;
}

export async function handleMeshLoop(c: any, options: MeshControllerOptions): Promise<Response> {
  const { deps, approvalService } = options;
  const stream = c;
  const log = console;

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
    approvalService.setWorkspaceRoot(ticket.id, workspaceRoot);

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
    } catch (scanError: any) {
      log(
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

    // Import MeshPipeline
    const { MeshPipeline } = await import("../services/meshPipeline.js");

    // Create MeshPipeline configuration
    const plan = {
      content: {
        summary: plan.summary,
        steps: plan.steps,
      },
      raw: plan.raw,
    };

    const config: MeshPipelineConfig = {
      workspaceRoot,
      contextString,
      ticket,
      plan,
      mode: (body as any).mode || "develop",
      approvalService,
      saveStateTicket: deps.saveStateTicket,
      orchestratorPlanResult: plan.raw
        ? {
          tokens: plan.usage_metadata?.total_tokens || 0,
          cost: plan.usage_metadata?.total_cost || 0,
        }
        : undefined,
    };

    // Create and execute pipeline
    const pipeline = new MeshPipeline(config);

    // Execute pipeline and get results
    await pipeline.executeWaves();

    // Send final completion event
    const totals = pipeline.getTokenTracker().getTotals();
    log(
      color.bgBlue(
        color.white(
          `\n 📊 Total Tokens Consumed: ${totals.tokens} | Cost: ${formatCost(totals.cost)} \n`,
        ),
      ),
    );

    const tokenUsage = pipeline.getTokenTracker().toUsageReport(currentModel);
    const doneEvent: DoneEvent = {
      success: true,
      partial: pipeline.getFailedAgents().length > 0,
      failedAgents: pipeline.getFailedAgents(),
      skippedAgents: pipeline.getSkippedAgents(),
      ticket,
      usage: tokenUsage,
    };
    await stream.writeSSE({
      event: "done",
      data: JSON.stringify(doneEvent),
    });

    return c.json({ success: true });
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

    const errorEvent = {
      success: false,
      error: userFacingMsg,
    };
    await stream.writeSSE({
      event: "error",
      data: JSON.stringify(errorEvent),
    });

    return c.json({ success: false, error: userFacingMsg });
  }
}
