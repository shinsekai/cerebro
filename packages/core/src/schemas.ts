import { z } from "zod";

export const StateTicketSchema = z.object({
  id: z.string().uuid(),
  task: z.string(),
  retry_count: z.number().int().min(0).max(3),
  status: z.enum([
    "pending",
    "in-progress",
    "awaiting-approval",
    "completed",
    "failed",
    "halted",
  ]),
  context: z.record(z.any()).optional(),
  error: z.string().optional(),
});

export type StateTicket = z.infer<typeof StateTicketSchema>;

export const MemoryTicketSchema = z.object({
  id: z.string().uuid(),
  task_hash: z.string(),
  task_summary: z.string(),
  solution_code: z.string(),
  embedding: z.array(z.number()).optional(),
  created_at: z.date(),
});

export type MemoryTicket = z.infer<typeof MemoryTicketSchema>;

// --- Mesh Execution Plan Schema ---
export const AgentTypeSchema = z.enum([
  "frontend",
  "backend",
  "quality",
  "security",
  "tester",
  "ops",
]);

export type AgentType = z.infer<typeof AgentTypeSchema>;

export const AgentStepSchema = z.object({
  agent: AgentTypeSchema,
  description: z.string(),
  depends_on: z.array(AgentTypeSchema).default([]),
  lightweight: z.boolean().default(false),
});

export type AgentStep = z.infer<typeof AgentStepSchema>;

export const ExecutionPlanSchema = z.object({
  summary: z.string(),
  steps: z.array(AgentStepSchema),
});

export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

// --- File Changes and Approval Schemas ---

export const FileChangeSchema = z.object({
  path: z.string(),
  content: z.string(),
  operation: z.enum(["create", "update", "delete"]),
  isNew: z.boolean().default(true),
  diff: z.string().optional(),
});

export type FileChange = z.infer<typeof FileChangeSchema>;

export const ApprovalResponseSchema = z.object({
  ticketId: z.string().uuid(),
  approved: z.boolean(),
  rejectedFiles: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

// --- Session State Schema ---

export const SessionStateSchema = z.object({
  sessionId: z.string().uuid(),
  lastTicketId: z.string(),
  lastTask: z.string(),
  agentOutputs: z.record(z.string()),
  fileChanges: z.array(z.string()),
  timestamp: z.string().datetime(),
});

export type SessionState = z.infer<typeof SessionStateSchema>;
