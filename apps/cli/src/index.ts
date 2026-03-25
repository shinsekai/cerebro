import { cwd } from "node:process";
import { parseArgs } from "node:util";
import { isCancel, outro, select, spinner, text } from "@clack/prompts";
import color from "picocolors";

// Command modules
import { runChat } from "./commands/chat.js";
import { runDevelop } from "./commands/develop.js";
import { runInit } from "./commands/init.js";
import { runLogs, runReplay } from "./commands/logs.js";
import { runOps } from "./commands/ops.js";
import { runReview } from "./commands/review.js";

// Lib modules
import { getActionableError } from "./lib/errors.js";

// UI modules
import { checkEnvironment } from "./ui/checks.js";
import { renderHeader } from "./ui/header.js";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: {
      type: "boolean",
      short: "h",
    },
    "new-session": {
      type: "boolean",
      default: false,
    },
  },
  allowPositionals: true,
  strict: false, // Prevents throwing when unexpected flags are passed
});

const isHelp = values.help || positionals[0] === "help";
const command = isHelp ? "help" : positionals[0];
const target = positionals.slice(1).join(" "); // e.g. "my new feature"

async function main() {
  let action: string | null = command;
  let taskDesc: string | null = target;

  if (action === "help") {
    await renderHeader(cwd());
    console.log(`  ${color.bold("USAGE")}`);
    console.log(`    cerebro <command> [options]\n`);
    console.log(`  ${color.bold("COMMANDS")}`);
    console.log(
      `    ${color.cyan("develop".padEnd(20))} <feature>    Scaffold a new feature with AI agents`,
    );
    console.log(
      `    ${color.cyan("fix".padEnd(20))} <description> Diagnose and patch bugs automatically`,
    );
    console.log(
      `    ${color.cyan("review".padEnd(20))} [branch]      Deep code quality & security analysis`,
    );
    console.log(
      `    ${color.cyan("ops".padEnd(20))} <task>         Generate Docker, CI/CD, infrastructure`,
    );
    console.log(
      `    ${color.cyan("chat".padEnd(20))}               Interactive REPL for iterative development`,
    );
    console.log(
      `    ${color.cyan("init".padEnd(20))}               Scan workspace and initialize context`,
    );
    console.log(
      `    ${color.cyan("logs".padEnd(20))}               List recent execution logs`,
    );
    console.log(
      `    ${color.cyan("replay".padEnd(20))} <id>          Replay a past execution\n`,
    );
    console.log(`  ${color.bold("OPTIONS")}`);
    console.log(`    -h, --help           Show this help message`);
    console.log(`    --new-session        Force a fresh session`);
    console.log(
      `    --fast               Instant replay (no simulated delays)\n`,
    );
    console.log(`  ${color.bold("EXAMPLES")}`);
    console.log(
      `    ${color.dim('cerebro develop "Add JWT auth with refresh tokens"')}`,
    );
    console.log(
      `    ${color.dim('cerebro fix "TypeError in src/api/users.ts:42"')}`,
    );
    console.log(`    ${color.dim("cerebro review main")}`);
    console.log(`    ${color.dim('cerebro ops "Generate GitHub Actions CI"')}`);
    console.log(`    ${color.dim("cerebro chat")}`);
    process.exit(0);
  }

  await renderHeader(cwd());

  // Skip environment checks for logs and replay commands
  if (command !== "logs" && command !== "replay") {
    await checkEnvironment(cwd());
  }

  // Main loop - keeps CLI running until user quits
  while (true) {
    if (!action) {
      action = (await select({
        message: "What would you like to do?",
        options: [
          {
            value: "init",
            label: "Initialize Cerebro context in this repository",
          },
          { value: "develop", label: "Develop a new feature" },
          { value: "fix", label: "Fix a bug or issue" },
          { value: "review", label: "Review code / PR" },
          { value: "ops", label: "Perform Infrastructure Tasks" },
          { value: "chat", label: "Open Chat REPL" },
          { value: "quit", label: "Quit" },
        ],
      })) as string;

      if (isCancel(action)) {
        outro("Goodbye!");
        process.exit(0);
      }
    }

    if (action === "quit") {
      outro("Goodbye!");
      process.exit(0);
    }

    if (action === "develop" && !taskDesc) {
      taskDesc = (await text({
        message: "Describe the feature you want to develop:",
        placeholder: "e.g., authentication system using JWT",
        validate: (value) => {
          if (!value) return "Please provide a description.";
        },
      })) as string;

      if (isCancel(taskDesc)) {
        outro("Canceled.");
        process.exit(0);
      }
    }

    if (action === "fix" && !taskDesc) {
      taskDesc = (await text({
        message: "Describe the bug or paste the error/stack trace:",
        placeholder: "e.g., TypeError in src/api/users.ts:42",
        validate: (value) => {
          if (!value) return "Please provide a description.";
        },
      })) as string;

      if (isCancel(taskDesc)) {
        outro("Canceled.");
        process.exit(0);
      }
    }

    if (action === "ops" && !taskDesc) {
      taskDesc = (await select({
        message: "Select infrastructure task:",
        options: [
          {
            value:
              "Generate Dockerfile and docker-compose.yml for the current project",
            label: "Generate Dockerfile + docker-compose",
          },
          {
            value:
              "Generate GitHub Actions CI/CD pipeline for the current project",
            label: "Generate CI/CD pipeline (GitHub Actions)",
          },
          {
            value:
              "Generate deployment configuration (Kubernetes manifests, Terraform, or cloud provider configs)",
            label: "Generate deployment config",
          },
          {
            value: "custom",
            label: "Custom ops task",
          },
        ],
      })) as string;

      if (isCancel(taskDesc)) {
        outro("Canceled.");
        process.exit(0);
      }

      if (taskDesc === "custom") {
        taskDesc = (await text({
          message: "Describe the infrastructure task:",
          placeholder: "e.g., Add nginx reverse proxy config",
          validate: (value) => {
            if (!value) return "Please provide a description.";
          },
        })) as string;

        if (isCancel(taskDesc)) {
          outro("Canceled.");
          process.exit(0);
        }
      }
    }

    const s = spinner();
    s.start(`Starting cerebro ${action}...`);

    // Dispatch logic
    switch (action) {
      case "init": {
        await runInit(s);
        break;
      }
      case "chat": {
        await runChat();
        break;
      }
      case "develop":
      case "fix": {
        if (!taskDesc) {
          s.stop(color.red("✖ Task description is required"));
          break;
        }
        await runDevelop({
          taskDesc,
          action: action as "develop" | "fix",
          newSession: values["new-session"] as boolean,
          spinnerInstance: s,
        });
        break;
      }
      case "review": {
        try {
          await runReview(taskDesc || "", s);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const actionableError = getActionableError(errorMsg);
          s.stop(color.red(`✖ ${actionableError.message}`));
          if (actionableError.debugHint) {
            console.log(color.dim(`  ${actionableError.debugHint}`));
          }
        }
        break;
      }
      case "ops": {
        if (!taskDesc) {
          s.stop(color.red("✖ Task description is required"));
          taskDesc = null;
          break;
        }
        try {
          await runOps(taskDesc, s);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const actionableError = getActionableError(errorMsg);
          s.stop(color.red(`✖ ${actionableError.message}`));
          if (actionableError.debugHint) {
            console.log(color.dim(`  ${actionableError.debugHint}`));
          }
        }
        break;
      }
      case "logs": {
        await runLogs(s);
        break;
      }
      case "replay": {
        await runReplay(taskDesc, s);
        break;
      }
      default:
        s.stop(color.red(`✖ Unknown command: ${action}`));
        process.exit(1);
    }

    // Reset for next loop iteration
    action = null;
    taskDesc = null;
  }
}

main().catch((err) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  const actionableError = getActionableError(errorMsg);
  console.error(color.red(`\n✖ ${actionableError.message}`));
  if (actionableError.debugHint) {
    console.error(color.dim(`  ${actionableError.debugHint}`));
  }
  process.exit(1);
});
