import { randomUUID } from "node:crypto";
import { confirm, isCancel, spinner, text } from "@clack/prompts";
import color from "picocolors";
import { streamEngineResponse } from "../lib/stream.js";
import { findWorkspaceRoot } from "../lib/workspace.js";
import type { DoneEvent, ErrorEvent } from "@cerebro/core";

function isDoneEvent(data: DoneEvent | ErrorEvent | null): data is DoneEvent {
  return data !== null && data.success === true;
}

interface ReviewFinding {
  severity: "critical" | "warning" | "info";
  file: string;
  line: number;
  message: string;
  suggestion?: string;
}

export async function runReview(
  taskDesc: string | null,
  s: ReturnType<typeof spinner>,
): Promise<void> {
  s.start("Detecting code changes...");
  const workspaceRoot = await findWorkspaceRoot(process.cwd());

  // Check if we're in a git repository and detect changes
  const { spawn } = await import("node:child_process");

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
          reject(new Error(stderr || `Git command failed with code ${code}`));
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
        console.log(color.red("Review cancelled."));
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
          console.log(color.red("Review cancelled."));
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
        console.log(color.red("Review cancelled."));
        process.exit(0);
      }

      diff = await runGitCommand(["diff", `${branch}...HEAD`]);
      reviewTarget = branch;
    }
  } catch (_gitError) {
    // Not a git repo or git command failed
    s.stop(color.yellow("⚠ Not in a git repository or git unavailable"));
    console.log(
      color.gray("Reviewing current workspace state without git diff...\n"),
    );
    diff = "(No git diff available - reviewing workspace structure)";
    reviewTarget = "workspace";
  }

  if (!diff || diff === "") {
    s.stop(color.yellow("⚠ No changes found to review"));
    console.log(color.red("No changes to review."));
    process.exit(0);
  }

  // Start to review
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
    workspaceRoot,
    onReviewResult: (reviewData) => {
      reviewSpinner.stop("Analysis complete");
      console.log(color.bold(`\n📊 Code Review Results (${reviewTarget})\n`));

      if (!reviewData.findings || reviewData.findings.length === 0) {
        console.log(color.green("✓ No issues found! Code looks clean.\n"));
      } else {
        const { findings } = reviewData;

        // Group by severity
        const critical = findings.filter(
          (f: ReviewFinding) => f.severity === "critical",
        );
        const warnings = findings.filter(
          (f: ReviewFinding) => f.severity === "warning",
        );
        const info = findings.filter(
          (f: ReviewFinding) => f.severity === "info",
        );

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

  if (success && finalData) {
    reviewSpinner.stop(color.green("✔ Review completed."));
    console.log(color.gray(`Ticket ID: ${finalData.ticket?.id}\n`));

    if (isDoneEvent(finalData) && finalData.usage) {
      const u = finalData.usage;
      console.log(color.cyan(`\n📊 Token Consumption:`));
      console.log(
        `  Orchestrator : ${color.yellow(u.orchestrator?.tokens)} tokens`,
      );
      console.log(`  Quality      : ${color.yellow(u.quality?.tokens)} tokens`);
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
    reviewSpinner.stop(color.yellow(`⚠ Stream ended without final status.`));
  }
}
