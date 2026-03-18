import { z } from 'zod';

export const StateTicketSchema = z.object({
  id: z.string().uuid(),
  task: z.string(),
  retry_count: z.number().int().min(0).max(3),
  status: z.enum(['pending', 'in-progress', 'completed', 'failed', 'halted']),
  context: z.record(z.any()).optional(),
  error: z.string().optional()
});

export type StateTicket = z.infer<typeof StateTicketSchema>;

export const MemoryTicketSchema = z.object({
  id: z.string().uuid(),
  task_hash: z.string(),
  task_summary: z.string(),
  solution_code: z.string(),
  embedding: z.array(z.number()).optional(),
  created_at: z.date()
});

export type MemoryTicket = z.infer<typeof MemoryTicketSchema>;
