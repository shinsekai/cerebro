import type { AgentStep, AgentType, ExecutionPlan } from "./schemas.js";

/**
 * Build execution waves from an ExecutionPlan using Kahn's algorithm.
 * Groups steps that can run in parallel (same depth level).
 *
 * @throws {Error} If circular dependencies are detected
 * @throws {Error} If a step depends on an agent not in the plan
 */
export function buildExecutionWaves(plan: ExecutionPlan): AgentStep[][] {
  const { steps } = plan;
  if (steps.length === 0) return [];

  // Build adjacency list and in-degree map
  const agentToStep = new Map<AgentType, AgentStep>();
  const adjacency = new Map<AgentType, Set<AgentType>>();
  const inDegree = new Map<AgentType, number>();

  for (const step of steps) {
    agentToStep.set(step.agent, step);
    adjacency.set(step.agent, new Set());
    inDegree.set(step.agent, 0);
  }

  // Build graph edges: dependency -> dependent
  for (const step of steps) {
    const missingDeps: AgentType[] = [];

    for (const dep of step.depends_on) {
      // Validate that dependency exists in the plan
      if (!agentToStep.has(dep)) {
        missingDeps.push(dep);
        continue;
      }

      // Add edge from dependency to step
      // This means dep must complete before step
      const deps = adjacency.get(dep);
      if (deps) {
        deps.add(step.agent);
      }

      // Increment in-degree of the dependent agent
      inDegree.set(step.agent, (inDegree.get(step.agent) ?? 0) + 1);
    }

    // Throw if any dependencies are missing
    if (missingDeps.length > 0) {
      throw new Error(
        `Agent '${step.agent}' depends on ${missingDeps.map((d) => `'${d}'`).join(", ")} which ${missingDeps.length === 1 ? "is" : "are"} not in the execution plan`,
      );
    }
  }

  // Kahn's algorithm with wave tracking
  const waves: AgentStep[][] = [];
  const processed = new Set<AgentType>();

  while (processed.size < steps.length) {
    const currentWave: AgentStep[] = [];

    // Find all agents with in-degree 0 that haven't been processed
    for (const [agent, degree] of inDegree.entries()) {
      if (degree === 0 && !processed.has(agent)) {
        const step = agentToStep.get(agent);
        if (step) {
          currentWave.push(step);
        }
      }
    }

    // If no agents found but not all processed, we have a cycle
    if (currentWave.length === 0 && processed.size < steps.length) {
      // Find the cycle for helpful error message
      const cycle = findCycle(adjacency, inDegree, processed);
      throw new Error(`Circular dependency detected: ${cycle.join(" -> ")}`);
    }

    // Process current wave
    for (const step of currentWave) {
      processed.add(step.agent);

      // Decrement in-degree of all dependent agents
      const dependents = adjacency.get(step.agent);
      if (dependents) {
        for (const dependent of dependents) {
          const currentDegree = inDegree.get(dependent) ?? 1;
          inDegree.set(dependent, currentDegree - 1);
        }
      }
    }

    waves.push(currentWave);
  }

  return waves;
}

/**
 * Find a cycle in the remaining graph for error reporting.
 */
function findCycle(
  adjacency: Map<AgentType, Set<AgentType>>,
  _inDegree: Map<AgentType, number>,
  processed: Set<AgentType>,
): AgentType[] {
  const remaining = new Set(adjacency.keys()).difference(processed);
  const start = Array.from(remaining)[0];
  if (!start) {
    return [];
  }

  const path: AgentType[] = [];
  const visited = new Set<AgentType>();

  function dfs(agent: AgentType): AgentType | null {
    path.push(agent);
    visited.add(agent);

    const neighbors = adjacency.get(agent);
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (processed.has(neighbor)) continue;

        const idx = path.indexOf(neighbor);
        if (idx !== -1) {
          // Found a cycle
          return path[idx];
        }

        if (!visited.has(neighbor)) {
          const cycleStart = dfs(neighbor);
          if (cycleStart) return cycleStart;
        }
      }
    }

    path.pop();
    return null;
  }

  const cycleStart = dfs(start);
  if (cycleStart) {
    const idx = path.indexOf(cycleStart);
    return [...path.slice(idx), cycleStart];
  }

  return [start]; // Fallback
}

/**
 * Validate an ExecutionPlan.
 * Checks for circular dependencies and missing dependencies.
 */
export function validateExecutionPlan(plan: ExecutionPlan): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  try {
    buildExecutionWaves(plan);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get all agents that transitively depend on the failed agent.
 * Returns an array of agent types that cannot run until the failed agent is resolved.
 */
export function getDownstreamAgents(
  plan: ExecutionPlan,
  failedAgent: string,
): string[] {
  const { steps } = plan;

  // Build adjacency list: agent -> set of agents that depend on it
  const adjacency = new Map<AgentType, Set<AgentType>>();
  for (const step of steps) {
    adjacency.set(step.agent, new Set());
  }

  for (const step of steps) {
    for (const dep of step.depends_on) {
      const deps = adjacency.get(dep);
      if (deps) {
        deps.add(step.agent);
      }
    }
  }

  // BFS to find all downstream agents
  const visited = new Set<AgentType>();
  const queue: AgentType[] = [];
  const downstream: AgentType[] = [];

  // Start from the failed agent
  const start = failedAgent as AgentType;
  const dependents = adjacency.get(start);
  if (!dependents || dependents.size === 0) {
    return [];
  }

  for (const dependent of dependents) {
    queue.push(dependent);
    visited.add(dependent);
  }

  while (queue.length > 0) {
    const agent = queue.shift();
    if (!agent) break;

    downstream.push(agent);

    const agentDependents = adjacency.get(agent);
    if (agentDependents) {
      for (const dependent of agentDependents) {
        if (!visited.has(dependent)) {
          visited.add(dependent);
          queue.push(dependent);
        }
      }
    }
  }

  return downstream;
}
