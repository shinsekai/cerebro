import { describe, it, expect } from 'bun:test';
import { StateTicketSchema, MemoryTicketSchema } from './schemas.js';

describe('StateTicketSchema', () => {
  describe('validation', () => {
    it('should accept a valid state ticket', () => {
      const validTicket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task: 'Create a login component',
        retry_count: 0,
        status: 'pending' as const,
        context: { framework: 'react' },
        error: undefined
      };
      const result = StateTicketSchema.parse(validTicket);
      expect(result).toEqual(validTicket);
    });

    it('should reject invalid UUID format', () => {
      const invalidTicket = {
        id: 'not-a-uuid',
        task: 'Create a login component',
        retry_count: 0,
        status: 'pending' as const
      };
      expect(() => StateTicketSchema.parse(invalidTicket)).toThrow();
    });

    it('should reject negative retry_count', () => {
      const invalidTicket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task: 'Create a login component',
        retry_count: -1,
        status: 'pending' as const
      };
      expect(() => StateTicketSchema.parse(invalidTicket)).toThrow();
    });

    it('should reject retry_count greater than 3', () => {
      const invalidTicket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task: 'Create a login component',
        retry_count: 4,
        status: 'pending' as const
      };
      expect(() => StateTicketSchema.parse(invalidTicket)).toThrow();
    });

    it('should reject invalid status values', () => {
      const invalidTicket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task: 'Create a login component',
        retry_count: 0,
        status: 'invalid' as const
      };
      expect(() => StateTicketSchema.parse(invalidTicket)).toThrow();
    });

    it('should accept valid status values', () => {
      const validStatuses: const[] = ['pending', 'in-progress', 'completed', 'failed', 'halted'];
      validStatuses.forEach(status => {
        const validTicket = {
          id: '550e8400-e29b-41d4-a716-446655440000',
          task: 'Create a login component',
          retry_count: 0,
          status: status as any
        };
        const result = StateTicketSchema.parse(validTicket);
        expect(result.status).toBe(status);
      });
    });

    it('should allow optional context and error fields', () => {
      const ticketWithoutOptional = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task: 'Create a login component',
        retry_count: 0,
        status: 'pending' as const
      };
      const result = StateTicketSchema.parse(ticketWithoutOptional);
      expect(result.context).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it('should allow any record type for context', () => {
      const ticketWithComplexContext = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task: 'Create a login component',
        retry_count: 0,
        status: 'pending' as const,
        context: {
          framework: 'react',
          version: 18,
          features: ['hooks', 'context'],
          config: { theme: 'dark' }
        }
      };
      const result = StateTicketSchema.parse(ticketWithComplexContext);
      expect(result.context).toEqual(ticketWithComplexContext.context);
    });
  });
});

describe('MemoryTicketSchema', () => {
  describe('validation', () => {
    it('should accept a valid memory ticket', () => {
      const validTicket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task_hash: 'a1b2c3d4e5f6',
        task_summary: 'Create a login component',
        solution_code: 'const Login = () => { return <div>Login</div>; };',
        embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
        created_at: new Date('2024-01-01T00:00:00.000Z')
      };
      const result = MemoryTicketSchema.parse(validTicket);
      expect(result).toEqual(validTicket);
    });

    it('should reject invalid UUID format', () => {
      const invalidTicket = {
        id: 'not-a-uuid',
        task_hash: 'a1b2c3d4e5f6',
        task_summary: 'Create a login component',
        solution_code: 'const Login = () => { return <div>Login</div>; };',
        created_at: new Date()
      };
      expect(() => MemoryTicketSchema.parse(invalidTicket)).toThrow();
    });

    it('should require task_hash field', () => {
      const invalidTicket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task_summary: 'Create a login component',
        solution_code: 'const Login = () => { return <div>Login</div>; };',
        created_at: new Date()
      };
      expect(() => MemoryTicketSchema.parse(invalidTicket)).toThrow();
    });

    it('should require task_summary field', () => {
      const invalidTicket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task_hash: 'a1b2c3d4e5f6',
        solution_code: 'const Login = () => { return <div>Login</div>; };',
        created_at: new Date()
      };
      expect(() => MemoryTicketSchema.parse(invalidTicket)).toThrow();
    });

    it('should require solution_code field', () => {
      const invalidTicket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task_hash: 'a1b2c3d4e5f6',
        task_summary: 'Create a login component',
        created_at: new Date()
      };
      expect(() => MemoryTicketSchema.parse(invalidTicket)).toThrow();
    });

    it('should require created_at field', () => {
      const invalidTicket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task_hash: 'a1b2c3d4e5f6',
        task_summary: 'Create a login component',
        solution_code: 'const Login = () => { return <div>Login</div>; };'
      };
      expect(() => MemoryTicketSchema.parse(invalidTicket)).toThrow();
    });

    it('should allow optional embedding field', () => {
      const ticketWithoutEmbedding = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task_hash: 'a1b2c3d4e5f6',
        task_summary: 'Create a login component',
        solution_code: 'const Login = () => { return <div>Login</div>; };',
        created_at: new Date()
      };
      const result = MemoryTicketSchema.parse(ticketWithoutEmbedding);
      expect(result.embedding).toBeUndefined();
    });

    it('should accept array of numbers for embedding', () => {
      const ticketWithEmbedding = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task_hash: 'a1b2c3d4e5f6',
        task_summary: 'Create a login component',
        solution_code: 'const Login = () => { return <div>Login</div>; };',
        embedding: [0.1, -0.2, 0.3, 1.0, -1.0],
        created_at: new Date()
      };
      const result = MemoryTicketSchema.parse(ticketWithEmbedding);
      expect(result.embedding).toEqual([0.1, -0.2, 0.3, 1.0, -1.0]);
    });

    it('should accept empty array for embedding', () => {
      const ticketWithEmptyEmbedding = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task_hash: 'a1b2c3d4e5f6',
        task_summary: 'Create a login component',
        solution_code: 'const Login = () => { return <div>Login</div>; };',
        embedding: [],
        created_at: new Date()
      };
      const result = MemoryTicketSchema.parse(ticketWithEmptyEmbedding);
      expect(result.embedding).toEqual([]);
    });

    it('should reject non-array embedding', () => {
      const invalidTicket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        task_hash: 'a1b2c3d4e5f6',
        task_summary: 'Create a login component',
        solution_code: 'const Login = () => { return <div>Login</div>; };',
        embedding: 'not-an-array' as any,
        created_at: new Date()
      };
      expect(() => MemoryTicketSchema.parse(invalidTicket)).toThrow();
    });
  });
});
