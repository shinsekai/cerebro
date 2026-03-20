import "dotenv/config";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import color from "picocolors";
import {
  saveStateTicket,
  getStateTicket,
  saveMemoryTicket,
  searchSimilarMemory,
} from "@cerebro/database";
import {
  StateTicketSchema,
  MemoryTicketSchema,
  CircuitBreaker,
  ApprovalResponseSchema,
  ApprovalResponse,
  FileChange,
} from "@cerebro/core";
import {
  OrchestratorAgent,
  frontendAgent,
  backendAgent,
  testerAgent,
  qualityAgent,
  securityAgent,
  opsAgent,
} from "@cerebro/agents";
import path from "path";
import fs from "fs/promises";

const app = new Hono();

app.use("*", logger());

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
      reject(new Error("Approval timeout"));
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
    return c.json({ success: false, error: error.message }, 400);
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
    return c.json({ success: false, error: error.message }, 400);
  }
});

app.post("/memory/search", async (c) => {
  try {
    const { embedding, threshold, limit } = await c.req.json();
    const results = await searchSimilarMemory(embedding, threshold, limit);
    return c.json({ success: true, results });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
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
  } catch (e) {}
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

    // Helper to log beautifully and pipe to CLI
    const pushLog = async (
      msg: string,
      engineColor: (str: string) => string = color.white,
    ) => {
      console.log(color.cyan(`[Mesh]`) + ` ` + engineColor(msg));
      await stream.writeSSE({ data: msg });
    };

    try {
      await pushLog(
        `Initializing Mesh Loop for Ticket: ${ticket.id}`,
        color.gray,
      );
      await pushLog(`Task: "${ticket.task}"`, color.bold);

      const orchestrator = new OrchestratorAgent();
      await pushLog(
        `[Tier 1 Orchestrator] Analyzing request and planning constraints...`,
        color.magenta,
      );
      const plan: any = await orchestrator.planExecution(ticket.task);
      const orchestratorTokenDetails = extractTokenDetails(plan.raw);
      orchestratorTokens += orchestratorTokenDetails.totalTokens;
      orchestratorCost += orchestratorTokenDetails.cost;
      await pushLog(
        `[Tier 1 Orchestrator] Plan generated successfully. (${orchestratorTokenDetails.totalTokens} tokens, ${formatCost(orchestratorTokenDetails.cost)})`,
        color.green,
      );

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

      while (CircuitBreaker.check(ticket)) {
        try {
          await pushLog(
            `[Circuit Breaker] Starting Iteration ${ticket.retry_count + 1}/3...`,
            color.yellow,
          );
          await pushLog(
            `[Control Plane] Plan: ${plan.content.summary}`,
            color.cyan,
          );

          // Execute agents according to the plan
          const { steps } = plan.content;

          for (const step of steps) {
            const { agent, description } = step;

            // Check dependencies are met
            const pendingDeps = step.depends_on.filter(
              (dep: string) => !agentOutputs[dep],
            );
            if (pendingDeps.length > 0) {
              await pushLog(
                `[Control Plane] Skipping ${agent}: waiting for ${pendingDeps.join(", ")}`,
                color.yellow,
              );
              continue;
            }

            const agentInstance =
              agentRegistry[agent as keyof typeof agentRegistry];
            if (!agentInstance) {
              await pushLog(
                `[Control Plane] Warning: Unknown agent type '${agent}'`,
                color.red,
              );
              continue;
            }

            await pushLog(
              `[Tier 2 ${agent.charAt(0).toUpperCase() + agent.slice(1)}] ${agentDescriptions[agent]}`,
              color.magenta,
            );

            // Build context from previous agent outputs
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

            const result: any = await agentInstance.invoke({ context });
            const tokenDetails = extractTokenDetails(result);
            agentOutputs[agent] = String(result.content);

            // Track token usage per agent
            if (agent === "frontend") {
              frontendTokens += tokenDetails.totalTokens;
              frontendCost += tokenDetails.cost;
            }
            if (agent === "backend") {
              backendTokens += tokenDetails.totalTokens;
              backendCost += tokenDetails.cost;
            }
            if (agent === "quality") {
              qualityTokens += tokenDetails.totalTokens;
              qualityCost += tokenDetails.cost;
            }
            if (agent === "security") {
              securityTokens += tokenDetails.totalTokens;
              securityCost += tokenDetails.cost;
            }
            if (agent === "tester") {
              testerTokens += tokenDetails.totalTokens;
              testerCost += tokenDetails.cost;
            }
            if (agent === "ops") {
              opsTokens += tokenDetails.totalTokens;
              opsCost += tokenDetails.cost;
            }

            await pushLog(
              `[Tier 2 ${agent.charAt(0).toUpperCase() + agent.slice(1)}] ` +
                `${description} (${String(result.content).length} chars, ${tokenDetails.totalTokens} tokens, ${formatCost(tokenDetails.cost)})`,
              color.green,
            );
          }

          // Extract file changes from agent outputs
          const fileChanges: FileChange[] = [];

          for (const [agent, output] of Object.entries(agentOutputs)) {
            // Parse file paths from agent output format: "// FILE: path/to/file.ts\ncontent"
            const fileMatches = output.matchAll(
              /\/\/ FILE: ([^\n]+)\n([\s\S]*?)(?=\n\/\/ FILE:|\n$|$)/g,
            );

            for (const match of fileMatches) {
              const filePath = match[1].trim();
              const content = match[2].trim();
              const fullPath = path.join(workspaceRoot, filePath);
              const exists = await fs
                .access(fullPath)
                .then(() => true)
                .catch(() => false);

              fileChanges.push({
                path: filePath,
                content,
                operation: exists ? "update" : "create",
                isNew: !exists,
              });
            }
          }

          // If there are file changes, request approval
          if (fileChanges.length > 0) {
            ticket.status = "awaiting-approval";
            await saveStateTicket(ticket);

            await pushLog(
              `[Approval] Generated ${fileChanges.length} file change(s). Awaiting user approval...`,
              color.yellow,
            );

            // Send approval request via SSE
            await stream.writeSSE({
              event: "approval_request",
              data: JSON.stringify({
                ticketId: ticket.id,
                files: fileChanges,
                summary: `Generated ${fileChanges.length} file(s) by ${Object.keys(agentOutputs).join(", ")} agents`,
              }),
            });

            // Wait for user approval
            let approval: ApprovalResponse;
            try {
              approval = await waitForApproval(ticket.id);
            } catch (timeoutError) {
              ticket.status = "halted";
              await saveStateTicket(ticket);
              await pushLog(
                `[Approval] Timeout: No response within 5 minutes. Halting.`,
                color.red,
              );
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  success: false,
                  error: "Approval timeout",
                }),
              });
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

              await pushLog(
                `[Approval] Approved. Writing ${filesToWrite.length} file(s)...`,
                color.green,
              );

              // Write files
              for (const fileChange of filesToWrite) {
                const fullPath = path.join(workspaceRoot, fileChange.path);

                if (fileChange.operation === "delete") {
                  await fs.unlink(fullPath);
                  await pushLog(
                    `[Files] Deleted: ${fileChange.path}`,
                    color.dim,
                  );
                } else {
                  await fs.mkdir(path.dirname(fullPath), { recursive: true });
                  await fs.writeFile(fullPath, fileChange.content, "utf-8");
                  await pushLog(
                    `[Files] Written: ${fileChange.path}`,
                    color.dim,
                  );
                }
              }

              await pushLog(
                `[Files] All files written successfully.`,
                color.green,
              );
            } else {
              ticket.status = "failed";
              ticket.error = approval.reason || "User rejected changes";
              await saveStateTicket(ticket);

              await pushLog(
                `[Approval] Rejected: ${approval.reason || "No reason provided"}`,
                color.red,
              );
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  success: false,
                  error: "Changes rejected by user",
                  reason: approval.reason,
                  ticket,
                }),
              });
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

          await pushLog(
            `[Mesh] Pipeline successfully achieved consensus. Halting.`,
            color.cyan,
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
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify({ success: true, ticket, usage: tokenUsage }),
          });
          break;
        } catch (agentError: any) {
          const cleanMsg = cleanErrorMessage(agentError?.message);
          await pushLog(`[Mesh Error] ${cleanMsg}`, color.red);
          CircuitBreaker.recordFailure(ticket, cleanMsg);
          await saveStateTicket(ticket);

          if ((ticket.status as string) === "halted") {
            console.error(
              `[Mesh] Circuit Breaker tripped: Terminal failure for ${ticket.id}.`,
            );
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                success: false,
                error: "Circuit Breaker broken: Infinite Loop Stopped.",
                ticket,
              }),
            });
            return;
          }
          await pushLog(`[Mesh] Triggering fail-safe retry.`, color.yellow);
        }
      }
    } catch (error: any) {
      console.error(color.red(`[Mesh] Fatal Error:`), error);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          success: false,
          error: cleanErrorMessage(error?.message),
        }),
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
    return c.json({ success: false, error: error.message }, 400);
  }
});

export default {
  port: 8080,
  idleTimeout: 255, // 255 seconds max limit in Bun
  fetch: app.fetch,
};
