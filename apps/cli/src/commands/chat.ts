import { randomUUID } from "node:crypto";
import { isCancel, spinner, text } from "@clack/prompts";
import color from "picocolors";
import { getActionableError } from "../lib/errors.js";
import { saveSession } from "../lib/session.js";
import { streamEngineResponse } from "../lib/stream.js";
import { findWorkspaceRoot } from "../lib/workspace.js";

export async function runChat(): Promise<void> {
  const workspaceRoot = await findWorkspaceRoot(process.cwd());
  const s = spinner();
  const sessionHistory: Array<{
    task: string;
    agentOutputs: Record<string, string>;
    fileChanges: string[];
  }> = [];

  console.log(color.bold(`\n${color.bgCyan(color.black(" Cerebro Chat "))}`));
  console.log(
    color.dim("Type your requests, 'exit' or 'quit' to end the session\n"),
  );

  while (true) {
    const input = (await text({
      message: color.cyan(">"),
      placeholder: "e.g., Add a login page",
    })) as string;

    if (isCancel(input)) {
      console.log(color.red("Goodbye!"));
      process.exit(0);
    }

    const trimmedInput = input.trim();

    if (
      trimmedInput.toLowerCase() === "exit" ||
      trimmedInput.toLowerCase() === "quit"
    ) {
      // Save session state on exit
      if (sessionHistory.length > 0) {
        const lastExchange = sessionHistory[sessionHistory.length - 1];
        await saveSession(workspaceRoot, {
          lastTicketId: randomUUID(),
          lastTask: lastExchange.task,
          agentOutputs: lastExchange.agentOutputs,
          fileChanges: lastExchange.fileChanges,
        });
        console.log(
          color.dim(
            `\nSession saved with ${sessionHistory.length} exchange(s)\n`,
          ),
        );
      }
      console.log(color.red("Goodbye!"));
      process.exit(0);
    }

    if (!trimmedInput) continue;

    s.start(`Processing: ${trimmedInput.slice(0, 40)}...`);

    try {
      const { success, data: finalData } = await streamEngineResponse({
        url: "http://localhost:8080/mesh/loop",
        body: {
          id: randomUUID(),
          task: trimmedInput,
          retry_count: 0,
          status: "pending",
          workspaceRoot,
          mode: "chat",
          previousContext:
            sessionHistory.length > 0
              ? {
                  task: sessionHistory[sessionHistory.length - 1].task,
                  agentOutputs:
                    sessionHistory[sessionHistory.length - 1].agentOutputs,
                  fileChanges:
                    sessionHistory[sessionHistory.length - 1].fileChanges,
                }
              : undefined,
        },
        spinner: s,
        workspaceRoot,
      });

      if (success) {
        // Append this exchange to session history
        sessionHistory.push({
          task: trimmedInput,
          agentOutputs: finalData.ticket.context?.outputs || {},
          fileChanges: finalData.ticket.context?.fileChanges || [],
        });

        if (finalData.partial) {
          s.stop(color.yellow(`⚠ Completed with partial failures.`));
          console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));

          const allAgents = [
            "frontend",
            "backend",
            "quality",
            "security",
            "tester",
            "ops",
          ];
          const failedAgentSet = new Set(
            finalData.failedAgents?.map((f: { agent: string }) => f.agent) ||
              [],
          );
          const skippedAgentSet = new Set(
            finalData.skippedAgents?.map((s: { agent: string }) => s.agent) ||
              [],
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
          s.stop(color.green(`✔ Completed successfully.`));
          console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));
        }

        if (finalData.usage) {
          const u = finalData.usage;
          console.log(color.cyan(`📊 Token Consumption:`));
          console.log(
            `  Orchestrator : ${color.yellow(u.orchestrator?.tokens)} tokens`,
          );
          console.log(
            `  Frontend     : ${color.yellow(u.frontend?.tokens)} tokens`,
          );
          console.log(
            `  Backend      : ${color.yellow(u.backend?.tokens)} tokens`,
          );
          console.log(
            `  Quality      : ${color.yellow(u.quality?.tokens)} tokens`,
          );
          console.log(
            `  Security     : ${color.yellow(u.security?.tokens)} tokens`,
          );
          console.log(
            `  Tester       : ${color.yellow(u.tester?.tokens)} tokens`,
          );
          console.log(`  Ops          : ${color.yellow(u.ops?.tokens)} tokens`);
          console.log(color.dim(`  -----------------------`));
          console.log(
            `  Total        : ${color.magenta(u.total?.tokens)} tokens\n`,
          );
        }
      } else if (finalData) {
        s.stop(color.red(`✖ Failed: ${finalData.error}`));
      } else {
        s.stop(color.yellow(`⚠ Stream ended without final status.`));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const actionableError = getActionableError(errorMsg);
      s.stop(color.red(`✖ ${actionableError.message}`));
      if (actionableError.debugHint) {
        console.log(color.dim(`  ${actionableError.debugHint}`));
      }
    }
  }
}
