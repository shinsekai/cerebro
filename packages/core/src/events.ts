import { z } from "zod";

// --- Token Usage Schema ---

export const TokenUsageSchema = z.object({
  orchestrator: z
    .object({
      tokens: z.number(),
      cost: z.number(),
    })
    .optional(),
  frontend: z
    .object({
      tokens: z.number(),
      cost: z.number(),
    })
    .optional(),
  backend: z
    .object({
      tokens: z.number(),
      cost: z.number(),
    })
    .optional(),
  quality: z
    .object({
      tokens: z.number(),
      cost: z.number(),
    })
    .optional(),
  security: z
    .object({
      tokens: z.number(),
      cost: z.number(),
    })
    .optional(),
  tester: z
    .object({
      tokens: z.number(),
      cost: z.number(),
    })
    .optional(),
  ops: z
    .object({
      tokens: z.number(),
      cost: z.number(),
    })
    .optional(),
  total: z
    .object({
      tokens: z.number(),
      cost: z.number(),
    })
    .optional(),
  model: z.string().optional(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

// --- FileChange Schema (defined here to avoid circular imports) ---

export const FileChangeInlineSchema = z.object({
  path: z.string(),
  content: z.string(),
  operation: z.enum(["create", "update", "delete"]),
  isNew: z.boolean().default(true),
  diff: z.string().optional(),
});

// --- StateTicket Schema (defined here to avoid circular imports) ---

export const StateTicketInlineSchema = z.object({
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

// --- Agent Event Schemas ---

export const AgentStartedEventSchema = z.object({
  type: z.literal("agent_started"),
  agent: z.string(),
  description: z.string(),
  wave: z.number(),
});

export type AgentStartedEvent = z.infer<typeof AgentStartedEventSchema>;

export const AgentCompletedEventSchema = z.object({
  type: z.literal("agent_completed"),
  agent: z.string(),
  tokens: z.number(),
  cost: z.number(),
  duration: z.number(),
});

export type AgentCompletedEvent = z.infer<typeof AgentCompletedEventSchema>;

export const AgentFailedEventSchema = z.object({
  type: z.literal("agent_failed"),
  agent: z.string(),
  error: z.string(),
});

export type AgentFailedEvent = z.infer<typeof AgentFailedEventSchema>;

// --- Tool Event Schemas ---

export const ToolCallEventSchema = z.object({
  type: z.literal("tool_call"),
  agent: z.string(),
  tool: z.string(),
  input: z.string(),
});

export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

export const ToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  agent: z.string(),
  tool: z.string(),
  result: z.string(),
});

export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

// --- Approval Event Schema ---

export const ApprovalRequestedEventSchema = z.object({
  type: z.literal("approval_requested"),
  ticketId: z.string(),
  files: z.array(FileChangeInlineSchema),
  summary: z.string(),
});

export type ApprovalRequestedEvent = z.infer<
  typeof ApprovalRequestedEventSchema
>;

// --- Ticket Event Schemas ---

export const TicketCompletedEventSchema = z.object({
  type: z.literal("ticket_completed"),
  ticket: StateTicketInlineSchema,
  usage: TokenUsageSchema,
});

export type TicketCompletedEvent = z.infer<typeof TicketCompletedEventSchema>;

export const TicketFailedEventSchema = z.object({
  type: z.literal("ticket_failed"),
  error: z.string(),
  ticket: StateTicketInlineSchema,
});

export type TicketFailedEvent = z.infer<typeof TicketFailedEventSchema>;

// --- Log Event Schema ---

export const LogEventSchema = z.object({
  type: z.literal("log"),
  message: z.string(),
  level: z.string(),
});

export type LogEvent = z.infer<typeof LogEventSchema>;

// --- Review Result Event Schema ---

export const ReviewResultEventSchema = z.object({
  type: z.literal("review_result"),
  findings: z.array(
    z.object({
      severity: z.enum(["critical", "warning", "info"]),
      file: z.string(),
      line: z.number(),
      message: z.string(),
      suggestion: z.string().optional(),
    }),
  ),
  summary: z.string(),
});

export type ReviewResultEvent = z.infer<typeof ReviewResultEventSchema>;

// --- CerebroEvent Discriminated Union ---

export const CerebroEventSchema = z.discriminatedUnion("type", [
  AgentStartedEventSchema,
  AgentCompletedEventSchema,
  AgentFailedEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ApprovalRequestedEventSchema,
  TicketCompletedEventSchema,
  TicketFailedEventSchema,
  LogEventSchema,
  ReviewResultEventSchema,
]);

export type CerebroEvent = z.infer<typeof CerebroEventSchema>;

// --- Legacy Event Types (for backward compatibility) ---

export const DoneEventSchema = z.object({
  success: z.boolean(),
  partial: z.boolean().optional(),
  failedAgents: z
    .array(
      z.object({
        agent: z.string(),
        error: z.string(),
      }),
    )
    .optional(),
  skippedAgents: z
    .array(
      z.object({
        agent: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  ticket: StateTicketInlineSchema.optional(),
  usage: TokenUsageSchema.optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
});

export type DoneEvent = z.infer<typeof DoneEventSchema>;

export const ErrorEventSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  ticket: StateTicketInlineSchema.optional(),
});

export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
