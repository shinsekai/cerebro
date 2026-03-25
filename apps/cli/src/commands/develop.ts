import { randomUUID } from "node:crypto";
import { confirm, isCancel, type spinner } from "@clack/prompts";
import color from "picocolors";
import { getActionableError } from "../lib/errors.js";
import { clearSession, loadSession, saveSession } from "../lib/session.js";
import { streamEngineResponse } from "../lib/stream.js";
import { findWorkspaceRoot } from "../lib/workspace.js";
import { renderTokenSummary } from "../ui/display.js";

export interface DevelopOptions {
  taskDesc: string;
  action: "develop" | "fix" | "ops";
  newSession: boolean;
  spinnerInstance: ReturnType<typeof spinner>;
}

export async function runDevelop(options: DevelopOptions): Promise<void> {
  const workspaceRoot = await findWorkspaceRoot(process.cwd());
  let sessionContext: Record<string, unknown> = {};

  // Check for existing session unless --new-session is set
  if (!options.newSession) {
    const existingSession = await loadSession(workspaceRoot);
    if (existingSession) {
      const continueSession = await confirm({
        message: `Continue previous session? (task: '${existingSession.lastTask}')`,
        initialValue: true,
      });

      if (isCancel(continueSession)) {
        console.log(color.red("Canceled."));
        process.exit(0);
      }

      if (continueSession) {
        sessionContext = {
          sessionId: existingSession.sessionId,
          lastTicketId: existingSession.lastTicketId,
          agentOutputs: existingSession.agentOutputs,
          fileChanges: existingSession.fileChanges,
        };
        console.log(
          color.dim(`\nContinuing session ${existingSession.sessionId}\n`),
        );
      } else {
        // Start fresh, clear old session
        await clearSession(workspaceRoot);
      }
    }
  }

  try {
    const startTime = Date.now();
    const { success, data: finalData } = await streamEngineResponse({
      url: "http://localhost:8080/mesh/loop",
      body: {
        id: randomUUID(),
        task: options.taskDesc,
        retry_count: 0,
        status: "pending",
        workspaceRoot,
        mode: options.action,
        sessionContext,
        previousContext:
          Object.keys(sessionContext).length > 0
            ? {
                task: (sessionContext.lastTask as string) || "",
                agentOutputs:
                  (sessionContext.agentOutputs as Record<string, string>) || {},
                fileChanges: (sessionContext.fileChanges as string[]) || [],
              }
            : undefined,
      },
      spinner: options.spinnerInstance,
      workspaceRoot,
    });

    if (success) {
      // Save session state after successful completion
      await saveSession(workspaceRoot, {
        lastTicketId: finalData.ticket.id,
        lastTask: options.taskDesc || "",
        agentOutputs: finalData.ticket.context?.outputs || {},
        fileChanges: finalData.ticket.context?.fileChanges || [],
      });
      if (finalData.partial) {
        const actionLabel =
          options.action === "fix" ? "Bug fixed" : "Feature developed";
        options.spinnerInstance.stop(
          color.yellow(`⚠ ${actionLabel} with partial failures.`),
        );
        console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));

        // Show which agents succeeded, failed, and were skipped
        console.log(color.bold(`⚠  Execution Results:`));

        // Show successful agents (processed)
        const allAgents = [
          "frontend",
          "backend",
          "quality",
          "security",
          "tester",
          "ops",
        ];
        const failedAgentSet = new Set(
          finalData.failedAgents?.map((f: { agent: string }) => f.agent) || [],
        );
        const skippedAgentSet = new Set(
          finalData.skippedAgents?.map((s: { agent: string }) => s.agent) || [],
        );
        const succeededAgents = allAgents.filter(
          (a) => !failedAgentSet.has(a) && !skippedAgentSet.has(a),
        );

        for (const agent of succeededAgents) {
          console.log(`  ${color.green("✔")} ${color.cyan(agent)} completed`);
        }

        for (const failed of finalData.failedAgents || []) {
          console.log(
            `  ${color.red("✖")} ${color.cyan(failed.agent)} failed: ${color.red(failed.error)}`,
          );
        }

        for (const skipped of finalData.skippedAgents || []) {
          console.log(
            `  ${color.yellow("⊘")} ${color.cyan(skipped.agent)} skipped (${color.yellow(skipped.reason)})`,
          );
        }

        console.log();
      } else {
        const actionLabel =
          options.action === "fix" ? "Bug fixed" : "Feature developed";
        options.spinnerInstance.stop(
          color.green(`✔ ${actionLabel} successfully.`),
        );
        console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));
      }

      if (finalData.usage) {
        renderTokenSummary(finalData.usage, startTime);
      }
    } else if (finalData) {
      options.spinnerInstance.stop(color.red(`✖ Failed: ${finalData.error}`));
    } else {
      options.spinnerInstance.stop(
        color.yellow(`⚠ Stream ended without final status.`),
      );
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const actionableError = getActionableError(errorMsg);
    options.spinnerInstance.stop(color.red(`✖ ${actionableError.message}`));
    if (actionableError.debugHint) {
      console.log(color.dim(`  ${actionableError.debugHint}`));
    }
  }
}
