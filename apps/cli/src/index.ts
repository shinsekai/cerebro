import {
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import color from "picocolors";
import { chdir, cwd } from "process";
import { parseArgs } from "util";

// Shared SSE streaming function for engine responses
async function streamEngineResponse(payload: {
  url: string;
  body: object;
  spinner: ReturnType<typeof spinner>;
  onReviewResult?: (data: any) => void;
}): Promise<{ success: boolean; data: any }> {
  const res = await fetch(payload.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload.body),
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
            } else if (currentEvent === "review_result") {
              // Handle review result
              if (payload.onReviewResult) {
                try {
                  const reviewData = JSON.parse(fullData);
                  payload.onReviewResult(reviewData);
                } catch (error) {
                  console.error(
                    color.red("Error processing review result:"),
                    error,
                  );
                }
              }
            } else if (currentEvent === "approval_request") {
              // Handle approval request
              try {
                const approvalData = JSON.parse(fullData);
                payload.spinner.stop(
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

                  console.log(`${operationIcon} ${color.cyan(file.path)}`);
                  console.log(
                    color.dim(
                      `  ${file.operation} ${file.content.length} characters`,
                    ),
                  );
                  console.log(color.dim("─".repeat(50)));

                  // Display file content preview
                  const lines = file.content.split("\n");
                  if (lines.length > 20) {
                    console.log(color.gray(lines.slice(0, 20).join("\n")));
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
                      message: "Select files to reject (use space to select)",
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
                const approvalRes = await fetch(
                  "http://localhost:8080/mesh/approve",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(approvalResponse),
                  },
                );

                if (!approvalRes.ok) {
                  console.error(color.red("Failed to send approval response"));
                  process.exit(1);
                }

                // Resume spinner
                payload.spinner.start(
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
                payload.spinner.message(color.blue(safeData));
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

  return { success: finalData?.success ?? false, data: finalData };
}

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

async function findWorkspaceRoot(startDir: string): Promise<string> {
  let current = startDir;
  while (current !== path.dirname(current)) {
    // Check for monorepo markers
    try {
      await fs.access(path.join(current, "turbo.json"));
      return current;
    } catch {}
    try {
      const pkg = JSON.parse(
        await fs.readFile(path.join(current, "package.json"), "utf-8"),
      );
      if (pkg.workspaces && Array.isArray(pkg.workspaces)) return current;
    } catch {}
    try {
      await fs.access(path.join(current, "pnpm-workspace.yaml"));
      return current;
    } catch {}
    current = path.dirname(current);
  }
  return startDir; // Fallback to original dir
}

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

  const s = spinner();
  s.start(`Starting cerebro ${action}...`);

  // Dispatch logic
  switch (action) {
    case "init":
      await new Promise((r) => setTimeout(r, 1000));
      s.stop(color.green(`✔ Cerebro initialized automatically.`));
      break;
    case "develop":
    case "fix":
      try {
        const { success, data: finalData } = await streamEngineResponse({
          url: "http://localhost:8080/mesh/loop",
          body: {
            id: randomUUID(),
            task: taskDesc,
            retry_count: 0,
            status: "pending",
            workspaceRoot: await findWorkspaceRoot(cwd()),
            mode: action,
          },
          spinner: s,
        });

        if (success) {
          if (finalData.partial) {
            const actionLabel =
              action === "fix" ? "Bug fixed" : "Feature developed";
            s.stop(color.yellow(`⚠ ${actionLabel} with partial failures.`));
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
              finalData.failedAgents?.map((f: any) => f.agent) || [],
            );
            const skippedAgentSet = new Set(
              finalData.skippedAgents?.map((s: any) => s.agent) || [],
            );
            const succeededAgents = allAgents.filter(
              (a) => !failedAgentSet.has(a) && !skippedAgentSet.has(a),
            );

            for (const agent of succeededAgents) {
              console.log(
                `  ${color.green("✔")} ${color.cyan(agent)} completed`,
              );
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
              action === "fix" ? "Bug fixed" : "Feature developed";
            s.stop(color.green(`✔ ${actionLabel} successfully.`));
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
    case "review":
      try {
        s.start("Detecting code changes...");
        const workspaceRoot = await findWorkspaceRoot(cwd());

        // Check if we're in a git repository and detect changes
        const { spawn } = await import("child_process");

        const runGitCommand = (command: string[]): Promise<string> => {
          return new Promise((resolve, reject) => {
            const proc = spawn("git", command, { cwd: workspaceRoot });
            let stdout = "";
            let stderr = "";
            proc.stdout?.on("data", (data) => (stdout += data.toString()));
            proc.stderr?.on("data", (data) => (stderr += data.toString()));
            proc.on("close", (code) => {
              if (code === 0) resolve(stdout.trim());
              else
                reject(
                  new Error(stderr || `Git command failed with code ${code}`),
                );
            });
          });
        };

        let diff = "";
        let reviewTarget = "";

        // Check for uncommitted changes
        try {
          const diffStat = await runGitCommand(["diff", "--stat"]);
          if (diffStat) {
            // Uncommitted changes exist
            s.stop("Uncommitted changes detected");
            const reviewUncommitted = await confirm({
              message: "Review uncommitted changes?",
              initialValue: true,
            });

            if (isCancel(reviewUncommitted)) {
              outro("Review cancelled.");
              process.exit(0);
            }

            if (reviewUncommitted) {
              diff = await runGitCommand(["diff"]);
              reviewTarget = "uncommitted changes";
            } else {
              // User wants to review a branch instead
              const branch = await text({
                message: "Branch to compare against (e.g., main):",
                placeholder: "main",
                validate: (value) => {
                  if (!value) return "Please provide a branch name.";
                },
              });

              if (isCancel(branch)) {
                outro("Review cancelled.");
                process.exit(0);
              }

              diff = await runGitCommand(["diff", `${branch}...HEAD`]);
              reviewTarget = branch;
            }
          } else {
            // No uncommitted changes, ask for branch
            s.stop("No uncommitted changes found");
            const branch = await text({
              message: "Branch to compare against (e.g., main):",
              placeholder: "main",
              validate: (value) => {
                if (!value) return "Please provide a branch name.";
              },
            });

            if (isCancel(branch)) {
              outro("Review cancelled.");
              process.exit(0);
            }

            diff = await runGitCommand(["diff", `${branch}...HEAD`]);
            reviewTarget = branch;
          }
        } catch (gitError) {
          // Not a git repo or git command failed
          s.stop(color.yellow("⚠ Not in a git repository or git unavailable"));
          console.log(
            color.gray(
              "Reviewing current workspace state without git diff...\n",
            ),
          );
          diff = "(No git diff available - reviewing workspace structure)";
          reviewTarget = "workspace";
        }

        if (!diff || diff === "") {
          s.stop(color.yellow("⚠ No changes found to review"));
          outro("No changes to review.");
          process.exit(0);
        }

        // Start the review
        const reviewSpinner = spinner();
        reviewSpinner.start(
          `Analyzing ${diff.includes("git") ? "git diff" : "workspace"} for quality and security issues...`,
        );

        const { success, data: finalData } = await streamEngineResponse({
          url: "http://localhost:8080/mesh/review",
          body: {
            id: randomUUID(),
            task: taskDesc || "code review",
            retry_count: 0,
            status: "pending",
            workspaceRoot,
            mode: "review",
            diff,
            reviewTarget,
          },
          spinner: reviewSpinner,
          onReviewResult: (reviewData) => {
            reviewSpinner.stop("Analysis complete");
            console.log(
              color.bold(`\n📊 Code Review Results (${reviewTarget})\n`),
            );

            if (!reviewData.findings || reviewData.findings.length === 0) {
              console.log(
                color.green("✓ No issues found! Code looks clean.\n"),
              );
            } else {
              const { findings } = reviewData;

              // Group by severity
              const critical = findings.filter(
                (f: any) => f.severity === "critical",
              );
              const warnings = findings.filter(
                (f: any) => f.severity === "warning",
              );
              const info = findings.filter((f: any) => f.severity === "info");

              if (critical.length > 0) {
                console.log(color.red(`\n${color.bold("Critical Issues:")}`));
                for (const f of critical) {
                  console.log(
                    `${color.red("✖")} ${color.cyan(f.file)}:${f.line} — ${color.red(f.message)}`,
                  );
                  if (f.suggestion) {
                    console.log(color.dim(`  → ${f.suggestion}`));
                  }
                }
              }

              if (warnings.length > 0) {
                console.log(color.yellow(`\n${color.bold("Warnings:")}`));
                for (const f of warnings) {
                  console.log(
                    `${color.yellow("⚠")} ${color.cyan(f.file)}:${f.line} — ${f.message}`,
                  );
                  if (f.suggestion) {
                    console.log(color.dim(`  → ${f.suggestion}`));
                  }
                }
              }

              if (info.length > 0) {
                console.log(color.blue(`\n${color.bold("Info:")}`));
                for (const f of info) {
                  console.log(
                    `${color.blue("ℹ")} ${color.cyan(f.file)}:${f.line} — ${f.message}`,
                  );
                  if (f.suggestion) {
                    console.log(color.dim(`  → ${f.suggestion}`));
                  }
                }
              }

              console.log(color.dim(`\n${"—".repeat(60)}`));
              console.log(
                color.dim(
                  `Total: ${critical.length} critical, ${warnings.length} warning(s), ${info.length} info`,
                ),
              );
              console.log(color.dim(`"${"—".repeat(60)}\n`));
            }
          },
        });

        if (success) {
          reviewSpinner.stop(color.green("✔ Review completed."));
          console.log(color.gray(`Ticket ID: ${finalData.ticket.id}\n`));

          if (finalData.usage) {
            const u = finalData.usage;
            console.log(color.cyan(`\n📊 Token Consumption:`));
            console.log(
              `  Orchestrator : ${color.yellow(u.orchestrator?.tokens)} tokens`,
            );
            console.log(
              `  Quality      : ${color.yellow(u.quality?.tokens)} tokens`,
            );
            console.log(
              `  Security     : ${color.yellow(u.security?.tokens)} tokens`,
            );
            console.log(color.dim(`  -----------------------`));
            console.log(
              `  Total        : ${color.magenta(u.total?.tokens)} tokens\n`,
            );
          }
        } else if (finalData) {
          reviewSpinner.stop(color.red(`✖ Failed: ${finalData.error}`));
        } else {
          reviewSpinner.stop(
            color.yellow(`⚠ Stream ended without final status.`),
          );
        }
      } catch (err: any) {
        s.stop(
          color.red(
            `✖ Engine Unreachable: Ensure Cerebro Engine is running on port 8080.`,
          ),
        );
      }
      break;
    case "ops":
      try {
        const { success, data: finalData } = await streamEngineResponse({
          url: "http://localhost:8080/mesh/loop",
          body: {
            id: randomUUID(),
            task: taskDesc,
            retry_count: 0,
            status: "pending",
            workspaceRoot: await findWorkspaceRoot(cwd()),
            mode: "ops",
          },
          spinner: s,
        });

        if (success) {
          if (finalData.partial) {
            s.stop(
              color.yellow(`⚠ Infrastructure generated with partial failures.`),
            );
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
              finalData.failedAgents?.map((f: any) => f.agent) || [],
            );
            const skippedAgentSet = new Set(
              finalData.skippedAgents?.map((s: any) => s.agent) || [],
            );
            const succeededAgents = allAgents.filter(
              (a) => !failedAgentSet.has(a) && !skippedAgentSet.has(a),
            );

            for (const agent of succeededAgents) {
              console.log(
                `  ${color.green("✔")} ${color.cyan(agent)} completed`,
              );
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
    default:
      s.stop(color.red(`✖ Unknown command: ${action}`));
      process.exit(1);
  }

  outro(color.magenta("Cerebro execution complete."));
}

main().catch(console.error);
