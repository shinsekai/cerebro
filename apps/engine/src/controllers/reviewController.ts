import {
  agenticQualityAgent,
  agenticSecurityAgent,
  OrchestratorAgent,
} from "@cerebro/agents";
import {
  type AgentCompletedEvent,
  type AgentStartedEvent,
  type DoneEvent,
  getModelForAgent,
  type ReviewResultEvent,
  StateTicketSchema,
} from "@cerebro/core";
import {
  buildWorkspaceContext,
  formatContextForPrompt,
} from "@cerebro/workspace";
import color from "picocolors";
import { cleanErrorMessage, emitEvent, emitLog, getActionableError, getLog } from "./utils.js";
import { streamSSE } from "hono/streaming";

export interface ReviewControllerDeps {
  saveStateTicket: (ticket: any) => Promise<any>;
}

export async function handleMeshReview(c: any, deps: ReviewControllerDeps): Promise<Response> {
  const log = getLog();

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
      const body = await c.req.json();
      const ticket = StateTicketSchema.parse(body);
      const workspaceRoot = (body as any).workspaceRoot || process.cwd();
      const diff = (body as any).diff || "";
      const reviewTarget = (body as any).reviewTarget || "workspace";
      const lightweight = (body as any).lightweight || false;

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
      await deps.saveStateTicket(ticket);

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
}
