import type {
  ApprovalRequestedEvent,
  ApprovalResponse,
  CerebroEvent,
  DoneEvent,
  ErrorEvent,
  FileChange,
  ReviewResultEvent,
} from "@cerebro/core";
import { Logger } from "@cerebro/core";
import { confirm, isCancel, multiselect, text } from "@clack/prompts";
import color from "picocolors";
import { displayFileContent } from "../ui/display.js";
import { handleTypedEvent, resetProgressState } from "../ui/events.js";
import { ensureLogsDir, writeLogEntry } from "./log-store.js";

const log = new Logger("cli");

export interface StreamEngineResponsePayload {
  url: string;
  body: object;
  spinner: ReturnType<typeof import("@clack/prompts").spinner>;
  onReviewResult?: (data: ReviewResultEvent) => void;
  workspaceRoot?: string;
}

/**
 * Shared SSE streaming function for engine responses
 */
export async function streamEngineResponse(
  payload: StreamEngineResponsePayload,
): Promise<{ success: boolean; data: DoneEvent | ErrorEvent | null }> {
  // Reset progress state for new execution
  resetProgressState();

  const res = await fetch(payload.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload.body),
  });

  if (!res.body) throw new Error("No response body from Engine");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let finalData: DoneEvent | ErrorEvent | null = null;
  let ticketId: string | undefined;

  // Start logging if workspace root provided
  if (payload.workspaceRoot && "id" in payload.body) {
    ticketId = String((payload.body as Record<string, unknown>).id);
    await ensureLogsDir(payload.workspaceRoot);
  }

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

            // Try to parse as typed event first
            let handledAsTyped = false;
            let eventData: CerebroEvent | null = null;
            if (currentEvent !== "message") {
              try {
                eventData = JSON.parse(fullData) as CerebroEvent;
                // Check if it's a CerebroEvent by checking for 'type' field
                // Do NOT consume approval events as typed — they need the legacy handler
                // which stops the spinner, shows file diffs, and prompts the user
                if (
                  eventData &&
                  typeof eventData === "object" &&
                  "type" in eventData &&
                  eventData.type !== "approval_requested"
                ) {
                  handleTypedEvent(eventData, payload.spinner, undefined);
                  handledAsTyped = true;

                  // Log typed event
                  if (payload.workspaceRoot && ticketId) {
                    await writeLogEntry(payload.workspaceRoot, ticketId, {
                      type: currentEvent,
                      data: eventData as Record<string, unknown>,
                    });
                  }
                }
              } catch {
                // Not a typed event or malformed JSON, fall through to legacy handlers
              }
            }

            // Legacy event handlers (skip if already handled as typed event)
            if (
              !handledAsTyped &&
              (currentEvent === "done" || currentEvent === "error")
            ) {
              try {
                finalData = JSON.parse(fullData);
              } catch {
                // Malformed final payload — surface as a stream error
                finalData = {
                  success: false,
                  error: "Malformed response from Engine.",
                };
              }

              // Log final event
              if (payload.workspaceRoot && ticketId && finalData) {
                await writeLogEntry(payload.workspaceRoot, ticketId, {
                  type: currentEvent,
                  data: finalData as Record<string, unknown>,
                });
              }
            } else if (!handledAsTyped && currentEvent === "review_result") {
              // Handle review result
              if (payload.onReviewResult) {
                try {
                  const reviewData = JSON.parse(fullData);
                  payload.onReviewResult(reviewData);

                  // Log review result
                  if (payload.workspaceRoot && ticketId) {
                    await writeLogEntry(payload.workspaceRoot, ticketId, {
                      type: "review_result",
                      data: reviewData,
                    });
                  }
                } catch (error) {
                  log.error(`Error processing review result: ${error}`);
                }
              }
            } else if (
              !handledAsTyped &&
              currentEvent === "approval_requested"
            ) {
              // Handle approval request
              try {
                const approvalData = JSON.parse(
                  fullData,
                ) as ApprovalRequestedEvent;

                // Log approval request
                if (payload.workspaceRoot && ticketId) {
                  await writeLogEntry(payload.workspaceRoot, ticketId, {
                    type: "approval_request",
                    data: approvalData as Record<string, unknown>,
                  });
                }
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
                  displayFileContent(file);

                  // For updates with diff, offer to view full file
                  if (file.operation === "update" && file.diff) {
                    const viewFull = await text({
                      message: "View full file instead of diff? (y/N)",
                      placeholder: "",
                    });

                    if (
                      typeof viewFull === "string" &&
                      viewFull.toLowerCase() === "y" &&
                      !isCancel(viewFull)
                    ) {
                      console.log(
                        color.bold(
                          `\n${color.cyan(file.path)} — Full Content\n`,
                        ),
                      );
                      console.log(color.dim("─".repeat(50)));
                      const lines = file.content.split("\n");
                      if (lines.length > 20) {
                        console.log(color.gray(lines.slice(0, 20).join("\n")));
                        console.log(
                          color.dim(`... (${lines.length - 20} more lines)`),
                        );
                      } else {
                        console.log(color.gray(lines.join("\n")));
                      }
                      console.log(color.dim(`${"─".repeat(50)}\n`));
                    }
                  }
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
                      options: approvalData.files.map((f: FileChange) => ({
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

                const approvalResponse: ApprovalResponse = {
                  ticketId: approvalData.ticketId,
                  approved: !!approved,
                  rejectedFiles:
                    rejectedFiles.length > 0 ? rejectedFiles : undefined,
                };

                if (!approved) {
                  const reason = await text({
                    message: "Reason for rejection:",
                    placeholder: "e.g., incorrect implementation",
                    validate: (value) => {
                      if (!value)
                        return "Please provide a reason for rejection.";
                    },
                  });

                  if (isCancel(reason)) {
                    console.log(color.red("\n✖ Approval cancelled"));
                    process.exit(0);
                  }

                  approvalResponse.reason = reason;
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
                  log.error("Failed to send approval response");
                  process.exit(1);
                }

                // Resume spinner
                payload.spinner.start(
                  `Processing ${approved ? "approved" : "rejected"} changes...`,
                );
              } catch (error) {
                log.error(`Error processing approval request: ${error}`);
                process.exit(1);
              }
            } else {
              // Unrecognized event — log at debug level only, don't spam the spinner
              // Typed events are handled by handleTypedEvent in ui/events.ts
              // Only done/error/approval_request/review_result reach this block
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
