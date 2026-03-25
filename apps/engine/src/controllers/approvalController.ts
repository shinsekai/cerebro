import type { ApprovalResponse } from "@cerebro/core";
import { ApprovalResponseSchema } from "@cerebro/core";
import { getActionableError } from "./utils.js";

export interface ApprovalControllerDeps {
  approvalResponses: Map<string, ApprovalResponse>;
}

export async function handleMeshApprove(
  c: any,
  deps: ApprovalControllerDeps,
): Promise<Response> {
  try {
    const body = await c.req.json();
    const approval = ApprovalResponseSchema.parse(body);
    deps.approvalResponses.set(approval.ticketId, approval);
    return c.json({ success: true, message: "Approval recorded" });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const actionable = getActionableError(errorMsg);
    return c.json({ success: false, error: actionable.message }, 400);
  }
}
