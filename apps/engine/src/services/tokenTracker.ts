/**
 * Track token usage and costs across multiple agents
 */
export class TokenTracker {
  private usage: Map<string, { tokens: number; cost: number }>;

  constructor() {
    this.usage = new Map();
  }

  /**
   * Add token usage for a specific agent
   */
  addUsage(agent: string, tokens: number, cost: number): void {
    const existing = this.usage.get(agent) || { tokens: 0, cost: 0 };
    this.usage.set(agent, {
      tokens: existing.tokens + tokens,
      cost: existing.cost + cost,
    });
  }

  /**
   * Get usage for a specific agent
   */
  getUsage(agent: string): { tokens: number; cost: number } {
    return this.usage.get(agent) || { tokens: 0, cost: 0 };
  }

  /**
   * Get total usage across all agents
   */
  getTotals(): { tokens: number; cost: number } {
    let totalTokens = 0;
    let totalCost = 0;
    for (const { tokens, cost } of this.usage.values()) {
      totalTokens += tokens;
      totalCost += cost;
    }
    return { tokens: totalTokens, cost: totalCost };
  }

  /**
   * Generate a usage report in the expected format
   * Returns an object with per-agent breakdown and total
   */
  toUsageReport(currentModel: string): Record<string, any> {
    const { tokens, cost } = this.getTotals();

    const report: Record<string, any> = {
      model: currentModel,
      total: { tokens, cost },
    };

    for (const [agent, data] of this.usage.entries()) {
      report[agent] = { tokens: data.tokens, cost: data.cost };
    }

    return report;
  }

  /**
   * Get list of all tracked agent names
   */
  getAgents(): string[] {
    return Array.from(this.usage.keys());
  }

  /**
   * Reset all tracking
   */
  reset(): void {
    this.usage.clear();
  }
}
