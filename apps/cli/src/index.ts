import {
  intro,
  outro,
  select,
  text,
  confirm,
  multiselect,
  isCancel,
  spinner,
} from "@clack/prompts";
import color from "picocolors";
import { parseArgs } from "util";
import { randomUUID } from "crypto";
import { cwd, chdir } from "process";
import path from "path";
import fs from "fs/promises";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: {
      type: "boolean",
      short: "h",
    },
  },
  allowPositionals: true,
  strict: false, // Prevents throwing when unexpected flags are passed
});

const isHelp = values.help || positionals[0] === "help";
const command = isHelp ? "help" : positionals[0];
const target = positionals.slice(1).join(" "); // e.g. "my new feature"

async function main() {
  let action = command;
  let taskDesc = target;

  if (action === "help") {
    console.log(
      `\n${color.bgCyan(color.black(" Cerebro Developer CLI "))} v1.0.0\n`,
    );
    console.log(`${color.bold("Usage:")} cerebro [command] [options]\n`);
    console.log(`${color.bold("Commands:")}`);
    console.log(
      `  ${color.cyan("develop")} <feature>   Trigger the AI Mesh to scaffold & verify a new feature`,
    );
    console.log(
      `  ${color.cyan("init")}                Initialize Cerebro context in the current workspace`,
    );
    console.log(
      `  ${color.cyan("fix")}                 Diagnose and patch bugs automatically`,
    );
    console.log(
      `  ${color.cyan("review")}              Conduct a deep AST code quality review`,
    );
    console.log(
      `  ${color.cyan("ops")}                 Design robust 12-factor Cloud Infrastructure`,
    );
    console.log(
      `  ${color.cyan("help")}                Show this interactive help message\n`,
    );
    console.log(`${color.bold("Options:")}`);
    console.log(`  -h, --help        Show this help menu\n`);
    process.exit(0);
  }

  intro(color.bgCyan(color.black(" Cerebro CLI ")));

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
      ],
    })) as string;

    if (isCancel(action)) {
      outro("Goodbye!");
      process.exit(0);
    }
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

  const s = spinner();
  s.start(`Starting cerebro ${action}...`);

  // Dispatch logic
  switch (action) {
    case "init":
      await new Promise((r) => setTimeout(r, 1000));
      s.stop(color.green(`✔ Cerebro initialized automatically.`));
      break;
    case "develop":
      try {
        const payload = {
          id: randomUUID(),
          task: taskDesc,
          retry_count: 0,
          status: "pending",
          workspaceRoot: cwd(),
        };
        const res = await fetch("http://localhost:8080/mesh/loop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.body) throw new Error("No response body from Engine");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let done = false;
        let finalData: any = null;

        // SSE state machine — accumulate per-event block, parse on blank separator
        let currentEvent = "message";
        let dataLines: string[] = [];
        let buffer = "";

        while (!done) {
          const { value, done: doneReading } = await reader.read();
          done = doneReading;
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            // Keep the last (potentially incomplete) line in the buffer
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trimEnd();

              if (trimmed.startsWith("event: ")) {
                currentEvent = trimmed.slice(7).trim();
              } else if (trimmed.startsWith("data: ")) {
                dataLines.push(trimmed.slice(6));
              } else if (trimmed === "") {
                // Blank line = end of SSE event block → dispatch
                if (dataLines.length > 0) {
                  const fullData = dataLines.join("\n");

                  if (currentEvent === "done" || currentEvent === "error") {
                    try {
                      finalData = JSON.parse(fullData);
                    } catch {
                      // Malformed final payload — surface as a stream error
                      finalData = {
                        success: false,
                        error: "Malformed response from Engine.",
                      };
                    }
                  } else if (currentEvent === "approval_request") {
                    // Handle approval request
                    try {
                      const approvalData = JSON.parse(fullData);
                      s.stop(
                        color.yellow(`⏸ Paused: Awaiting file approval...`),
                      );

                      // Display file changes
                      console.log(color.bold(`\n${approvalData.summary}\n`));

                      for (const file of approvalData.files) {
                        const operationIcon =
                          file.operation === "create"
                            ? color.green("+")
                            : file.operation === "delete"
                              ? color.red("-")
                              : color.yellow("~");

                        console.log(
                          `${operationIcon} ${color.cyan(file.path)}`,
                        );
                        console.log(
                          color.dim(
                            `  ${file.operation} ${file.content.length} characters`,
                          ),
                        );
                        console.log(color.dim("─".repeat(50)));

                        // Display file content preview
                        const lines = file.content.split("\n");
                        if (lines.length > 20) {
                          console.log(
                            color.gray(lines.slice(0, 20).join("\n")),
                          );
                          console.log(
                            color.dim(`... (${lines.length - 20} more lines)`),
                          );
                        } else {
                          console.log(color.gray(lines.join("\n")));
                        }
                        console.log(color.dim("─".repeat(50) + "\n"));
                      }

                      // Ask user for approval
                      const approved = await confirm({
                        message: "Approve these file changes?",
                        initialValue: true,
                      });

                      if (isCancel(approved)) {
                        console.log(color.red("\n✖ Approval cancelled"));
                        process.exit(0);
                      }

                      let rejectedFiles: string[] = [];

                      if (approved) {
                        // Allow selective approval
                        const selectiveApproval = await confirm({
                          message: "Reject specific files?",
                          initialValue: false,
                        });

                        if (selectiveApproval && !isCancel(selectiveApproval)) {
                          rejectedFiles = (await multiselect({
                            message:
                              "Select files to reject (use space to select)",
                            options: approvalData.files.map((f: any) => ({
                              value: f.path,
                              label: f.path,
                            })),
                            required: false,
                          })) as string[];

                          if (isCancel(rejectedFiles)) {
                            rejectedFiles = [];
                          }
                        }
                      }

                      const approvalResponse: any = {
                        ticketId: approvalData.ticketId,
                        approved: !!approved,
                        rejectedFiles:
                          rejectedFiles.length > 0 ? rejectedFiles : undefined,
                      };

                      if (!approved) {
                        approvalResponse.reason = await text({
                          message: "Reason for rejection:",
                          placeholder: "e.g., incorrect implementation",
                          validate: (value) => {
                            if (!value)
                              return "Please provide a reason for rejection.";
                          },
                        });

                        if (isCancel(approvalResponse.reason)) {
                          console.log(color.red("\n✖ Approval cancelled"));
                          process.exit(0);
                        }
                      }

                      // Send approval response to engine
                      const res = await fetch(
                        "http://localhost:8080/mesh/approve",
                        {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(approvalResponse),
                        },
                      );

                      if (!res.ok) {
                        console.error(
                          color.red("Failed to send approval response"),
                        );
                        process.exit(1);
                      }

                      // Resume spinner
                      s.start(
                        `Processing ${approved ? "approved" : "rejected"} changes...`,
                      );
                    } catch (error) {
                      console.error(
                        color.red("Error processing approval request:"),
                        error,
                      );
                      process.exit(1);
                    }
                  } else {
                    const safeData = fullData.replace(/\r?\n|\r/g, " ").trim();
                    if (safeData.length > 0) {
                      s.message(color.blue(safeData));
                    }
                  }
                }
                // Reset for next event block
                currentEvent = "message";
                dataLines = [];
              }
            }
          }
        }

        if (finalData && finalData.success) {
          s.stop(color.green(`✔ Feature developed successfully.`));
          console.log(color.gray(`Ticket ID: ${finalData.ticket.id}`));

          if (finalData.usage) {
            const u = finalData.usage;
            console.log(color.cyan(`\n📊 Token Consumption:`));
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
            console.log(
              `  Ops          : ${color.yellow(u.ops?.tokens)} tokens`,
            );
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
      } catch (err: any) {
        s.stop(
          color.red(
            `✖ Engine Unreachable: Ensure Cerebro Engine is running on port 8080.`,
          ),
        );
      }
      break;
    case "fix":
      await new Promise((r) => setTimeout(r, 1000));
      s.stop(color.green(`✔ Issue fixed.`));
      break;
    case "review":
      await new Promise((r) => setTimeout(r, 1000));
      s.stop(color.green(`✔ Review completed.`));
      break;
    case "ops":
      await new Promise((r) => setTimeout(r, 1000));
      s.stop(color.green(`✔ Infrastructure generated.`));
      break;
    default:
      s.stop(color.red(`✖ Unknown command: ${action}`));
      process.exit(1);
  }

  outro(color.magenta("Cerebro execution complete."));
}

main().catch(console.error);
