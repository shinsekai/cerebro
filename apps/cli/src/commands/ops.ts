import { randomUUID } from "node:crypto";
import type { Spinner } from "@clack/prompts";
import color from "picocolors";
import { streamEngineResponse } from "../lib/stream.js";
import { findWorkspaceRoot } from "../lib/workspace.js";

export async function runOps(taskDesc: string, s: Spinner): Promise<void> {
  const opsWorkspaceRoot = await findWorkspaceRoot(process.cwd());
  const { success, data: finalData } = await streamEngineResponse({
    url: "http://localhost:8080/mesh/loop",
    body: {
      id: randomUUID(),
      task: taskDesc,
      retry_count: 0,
      status: "pending",
      workspaceRoot: opsWorkspaceRoot,
      mode: "ops",
    },
    spinner: s,
    workspaceRoot: opsWorkspaceRoot,
  });

  if (success) {
    if (finalData.partial) {
      s.stop(color.yellow(`⚠ Infrastructure generated with partial failures.`));
      console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));

      // Show which agents succeeded, failed, and were skipped
      console.log(color.bold(`⚠  Execution Results:`));

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
      s.stop(color.green(`✔ Infrastructure generated.`));
      console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));
    }

    if (finalData.usage) {
      const u = finalData.usage;
      console.log(color.cyan(`\n📊 Token Consumption:`));
      console.log(
        `  Orchestrator : ${color.yellow(u.orchestrator?.tokens)} tokens`,
      );
      console.log(
        `  Frontend     : ${color.yellow(u.frontend?.tokens)} tokens`,
      );
      console.log(`  Backend      : ${color.yellow(u.backend?.tokens)} tokens`);
      console.log(`  Quality      : ${color.yellow(u.quality?.tokens)} tokens`);
      console.log(
        `  Security     : ${color.yellow(u.security?.tokens)} tokens`,
      );
      console.log(`  Tester       : ${color.yellow(u.tester?.tokens)} tokens`);
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
}
