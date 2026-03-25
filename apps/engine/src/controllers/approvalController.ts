import { ApprovalResponseSchema } from "@cerebro/core";
import { approvalService } from "../services/approvalService.js";
import { getActionableError } from "./utils.js";

export interface ApprovalControllerDeps {
  // No deps needed - using singleton approvalService
}

export async function handleMeshApprove(
  c: any,
  _deps: ApprovalControllerDeps,
): Promise<Response> {
  try {
    const body = await c.req.json();
    const approval = ApprovalResponseSchema.parse(body);
    approvalService.recordResponse(approval.ticketId, approval);
    return c.json({ success: true, message: "Approval recorded" });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const actionable = getActionableError(errorMsg);
    return c.json({ success: false, error: actionable.message }, 400);
  }
}
