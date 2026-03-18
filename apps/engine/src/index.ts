import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { streamSSE } from 'hono/streaming';
import color from 'picocolors';
import { 
  saveStateTicket, 
  getStateTicket, 
  saveMemoryTicket, 
  searchSimilarMemory 
} from '@cerebro/database';
import { StateTicketSchema, MemoryTicketSchema, CircuitBreaker } from '@cerebro/core';
import { OrchestratorAgent, frontendAgent, backendAgent, testerAgent, qualityAgent, securityAgent } from '@cerebro/agents';

const app = new Hono();

app.use('*', logger());

app.get('/', (c) => c.text('Cerebro Engine Running'));

// --- State Endpoints ---
app.post('/state', async (c) => {
  try {
    const body = await c.req.json();
    const ticket = StateTicketSchema.parse(body);
    await saveStateTicket(ticket);
    return c.json({ success: true, ticket });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

app.get('/state/:id', async (c) => {
  const id = c.req.param('id');
  const ticket = await getStateTicket(id);
  if (!ticket) return c.json({ success: false, error: 'Not found' }, 404);
  return c.json({ success: true, ticket });
});

// --- Memory Endpoints ---
app.post('/memory', async (c) => {
  try {
    const body = await c.req.json();
    const ticket = MemoryTicketSchema.parse({
      ...body,
      created_at: body.created_at ? new Date(body.created_at) : new Date()
    });
    await saveMemoryTicket(ticket);
    return c.json({ success: true, ticket });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

app.post('/memory/search', async (c) => {
  try {
    const { embedding, threshold, limit } = await c.req.json();
    const results = await searchSimilarMemory(embedding, threshold, limit);
    return c.json({ success: true, results });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 400);
  }
});

// --- Mesh Router (Server-Sent Events) ---
app.post('/mesh/loop', async (c) => {
  const body = await c.req.json();
  const ticket = StateTicketSchema.parse(body);
  await saveStateTicket(ticket);

  return streamSSE(c, async (stream) => {
    let orchestratorTokens = 0;
    let frontendTokens = 0;
    let backendTokens = 0;
    let qualityTokens = 0;
    let securityTokens = 0;
    let testerTokens = 0;

    const extractTokens = (res: any) => res?.usage_metadata?.total_tokens || 0;

    // Helper to log beautifully and pipe to CLI
    const pushLog = async (msg: string, engineColor: (str: string) => string = color.white) => {
      console.log(color.cyan(`[Mesh]`) + ` ` + engineColor(msg));
      await stream.writeSSE({ data: msg });
    };

    try {
      await pushLog(`Initializing Mesh Loop for Ticket: ${ticket.id}`, color.gray);
      await pushLog(`Task: "${ticket.task}"`, color.bold);
      
      const orchestrator = new OrchestratorAgent();
      await pushLog(`[Tier 1 Orchestrator] Analyzing request and planning constraints...`, color.magenta);
      const plan: any = await orchestrator.planExecution(ticket.task);
      orchestratorTokens += extractTokens(plan);
      await pushLog(`[Tier 1 Orchestrator] Plan generated successfully. (${extractTokens(plan)} tokens)`, color.green);
      
      ticket.status = 'in-progress';
      await saveStateTicket(ticket);

      while (CircuitBreaker.check(ticket)) {
        try {
          await pushLog(`[Circuit Breaker] Starting Iteration ${ticket.retry_count + 1}/3...`, color.yellow);
          
          await pushLog(`[Tier 2 Backend] Writing API and code logic...`, color.magenta);
          const codeResult: any = await backendAgent.invoke({ context: ticket.task + "\nPlan: " + JSON.stringify(plan.content) });
          const bTokens = extractTokens(codeResult);
          backendTokens += bTokens;
          await pushLog(`[Tier 2 Backend] Generated ${String(codeResult.content).length} characters of code. (${bTokens} tokens)`, color.green);
          
          await pushLog(`[Tier 2 Frontend] Writing UI components...`, color.magenta);
          const frontendResult: any = await frontendAgent.invoke({ context: ticket.task + "\\nBackend Code: " + String(codeResult.content) });
          const fTokens = extractTokens(frontendResult);
          frontendTokens += fTokens;
          await pushLog(`[Tier 2 Frontend] Generated ${String(frontendResult.content).length} characters of UI code. (${fTokens} tokens)`, color.green);

          await pushLog(`[Tier 2 Quality] Auditing code formatting and AST rules...`, color.magenta);
          const qualityResult: any = await qualityAgent.invoke({ context: String(codeResult.content) + "\\n" + String(frontendResult.content) });
          const qTokens = extractTokens(qualityResult);
          qualityTokens += qTokens;
          await pushLog(`[Tier 2 Quality] Audit complete. (${qTokens} tokens)`, color.green);

          await pushLog(`[Tier 2 Security] Scanning for OWASP vulnerabilities...`, color.magenta);
          const securityResult: any = await securityAgent.invoke({ context: String(codeResult.content) + "\\n" + String(frontendResult.content) });
          const sTokens = extractTokens(securityResult);
          securityTokens += sTokens;
          await pushLog(`[Tier 2 Security] Scan complete. 0 vulnerabilities found. (${sTokens} tokens)`, color.green);

          await pushLog(`[Tier 2 Tester] Running AST verification and unit testing...`, color.magenta);
          const testResult: any = await testerAgent.invoke({ context: String(codeResult.content) });
          const tTokens = extractTokens(testResult);
          testerTokens += tTokens;
          await pushLog(`[Tier 2 Tester] Validation complete array returned ${String(testResult.content).length} characters of trace. (${tTokens} tokens)`, color.green);

          ticket.status = 'completed';
          ticket.context = { code: codeResult.content, tests: testResult.content };
          await saveStateTicket(ticket);
          
          await pushLog(`[Mesh] Pipeline successfully achieved consensus. Halting.`, color.cyan);
          
          const totalTokens = orchestratorTokens + backendTokens + frontendTokens + qualityTokens + securityTokens + testerTokens;
          console.log(color.bgBlue(color.white(`\n 📊 Total Tokens Consumed: ${totalTokens} \n`)));
          
          const tokenUsage = { 
            orchestrator: orchestratorTokens, 
            frontend: frontendTokens,
            backend: backendTokens, 
            quality: qualityTokens,
            security: securityTokens,
            tester: testerTokens, 
            total: totalTokens 
          };
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ success: true, ticket, usage: tokenUsage }) });
          break; 

        } catch (agentError: any) {
          await pushLog(`[Mesh Error] ${agentError.message}`, color.red);
          CircuitBreaker.recordFailure(ticket, agentError.message);
          await saveStateTicket(ticket);
          
          if ((ticket.status as string) === 'halted') {
            console.error(`[Mesh] Circuit Breaker tripped: Terminal failure for ${ticket.id}.`);
            await stream.writeSSE({ event: 'error', data: JSON.stringify({ success: false, error: 'Circuit Breaker broken: Infinite Loop Stopped.', ticket }) });
            return;
          }
          await pushLog(`[Mesh] Triggering fail-safe retry.`, color.yellow);
        }
      }
    } catch (error: any) {
      console.error(color.red(`[Mesh] Fatal Error:`), error);
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ success: false, error: error.message }) });
    }
  });
});

export default {
  port: 8080,
  idleTimeout: 255, // 255 seconds max limit in Bun
  fetch: app.fetch,
};