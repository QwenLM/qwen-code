/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Plan, PlanStep } from '../planning/plan-mode.js';
import type { CodebaseGraph } from '../intelligence/codebase-graph.js';

/**
 * Agent role and specialization
 */
export enum AgentRole {
  COORDINATOR = 'coordinator',
  ARCHITECT = 'architect',
  DEVELOPER = 'developer',
  TESTER = 'tester',
  REVIEWER = 'reviewer',
  SECURITY = 'security',
  PERFORMANCE = 'performance',
  DOCUMENTATION = 'documentation',
}

/**
 * Agent capabilities and skills
 */
export interface AgentCapabilities {
  roles: AgentRole[];
  skills: string[];
  tools: string[];
  maxConcurrentTasks: number;
  priority: number; // 1-10, higher = more priority
}

/**
 * Individual agent in the team
 */
export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  capabilities: AgentCapabilities;
  status: 'idle' | 'busy' | 'blocked' | 'error';
  currentTask?: AgentTask;
  completedTasks: string[];
  metrics: {
    tasksCompleted: number;
    tasksFailed: number;
    averageCompletionTime: number;
    successRate: number;
  };
}

/**
 * Task assigned to an agent
 */
export interface AgentTask {
  id: string;
  description: string;
  assignedTo: string; // Agent ID
  dependencies: string[]; // Task IDs
  priority: 'low' | 'medium' | 'high' | 'critical';
  estimatedDuration: number; // milliseconds
  actualDuration?: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
  result?: unknown;
  error?: string;
  startTime?: Date;
  endTime?: Date;
}

/**
 * Team of collaborating agents
 */
export interface AgentTeam {
  coordinator: Agent;
  specialists: Agent[];
  sharedContext: {
    codebaseGraph?: CodebaseGraph;
    projectGoals: string[];
    constraints: string[];
    sharedKnowledge: Map<string, unknown>;
  };
}

/**
 * Result of collaborative work
 */
export interface CollaboratedResult {
  success: boolean;
  outputs: Map<string, unknown>; // Agent ID -> Output
  timeline: AgentTask[];
  conflicts: Conflict[];
  resolution: ConflictResolution[];
  totalDuration: number;
  metrics: {
    parallelization: number; // 0-1, how much work was done in parallel
    efficiency: number; // 0-1, actual vs estimated time
    qualityScore: number; // 0-100
  };
}

/**
 * Conflict between agents
 */
export interface Conflict {
  id: string;
  type:
    | 'output_mismatch'
    | 'resource_contention'
    | 'dependency_cycle'
    | 'priority_clash';
  involvedAgents: string[];
  description: string;
  severity: 'low' | 'medium' | 'high';
  detectedAt: Date;
}

/**
 * Resolution for a conflict
 */
export interface ConflictResolution {
  conflictId: string;
  strategy: 'vote' | 'priority' | 'merge' | 'manual';
  resolution: string;
  resolvedBy: string; // Agent ID
  resolvedAt: Date;
}

/**
 * Multi-agent collaboration engine
 */
export class CollaborationEngine {
  private agents: Map<string, Agent> = new Map();
  private tasks: Map<string, AgentTask> = new Map();

  /**
   * Create a new agent
   */
  createAgent(
    name: string,
    role: AgentRole,
    capabilities: AgentCapabilities,
  ): Agent {
    const agent: Agent = {
      id: this.generateAgentId(),
      name,
      role,
      capabilities,
      status: 'idle',
      completedTasks: [],
      metrics: {
        tasksCompleted: 0,
        tasksFailed: 0,
        averageCompletionTime: 0,
        successRate: 1.0,
      },
    };

    this.agents.set(agent.id, agent);
    return agent;
  }

  /**
   * Create a specialized team for a task
   */
  async createTeam(
    task: string,
    complexity: 'simple' | 'medium' | 'complex',
  ): Promise<AgentTeam> {
    // Create coordinator
    const coordinator = this.createAgent('Coordinator', AgentRole.COORDINATOR, {
      roles: [AgentRole.COORDINATOR],
      skills: ['planning', 'delegation', 'conflict-resolution', 'integration'],
      tools: ['all'],
      maxConcurrentTasks: 10,
      priority: 10,
    });

    // Create specialists based on complexity
    const specialists: Agent[] = [];

    // Always need architect and developer
    specialists.push(
      this.createAgent('Architect', AgentRole.ARCHITECT, {
        roles: [AgentRole.ARCHITECT],
        skills: ['design', 'system-architecture', 'patterns', 'scalability'],
        tools: ['Read', 'Grep', 'Glob'],
        maxConcurrentTasks: 3,
        priority: 9,
      }),
    );

    specialists.push(
      this.createAgent('Developer', AgentRole.DEVELOPER, {
        roles: [AgentRole.DEVELOPER],
        skills: ['coding', 'refactoring', 'debugging', 'implementation'],
        tools: ['Edit', 'Write', 'Read', 'Bash'],
        maxConcurrentTasks: 5,
        priority: 8,
      }),
    );

    // Add tester for medium+ complexity
    if (complexity === 'medium' || complexity === 'complex') {
      specialists.push(
        this.createAgent('Tester', AgentRole.TESTER, {
          roles: [AgentRole.TESTER],
          skills: [
            'testing',
            'test-generation',
            'quality-assurance',
            'validation',
          ],
          tools: ['Bash', 'Read', 'Write'],
          maxConcurrentTasks: 3,
          priority: 7,
        }),
      );
    }

    // Add reviewer and security for complex tasks
    if (complexity === 'complex') {
      specialists.push(
        this.createAgent('Reviewer', AgentRole.REVIEWER, {
          roles: [AgentRole.REVIEWER],
          skills: [
            'code-review',
            'best-practices',
            'mentoring',
            'quality-check',
          ],
          tools: ['Read', 'Grep'],
          maxConcurrentTasks: 2,
          priority: 6,
        }),
      );

      specialists.push(
        this.createAgent('Security', AgentRole.SECURITY, {
          roles: [AgentRole.SECURITY],
          skills: [
            'security-analysis',
            'vulnerability-scanning',
            'penetration-testing',
          ],
          tools: ['Read', 'Grep', 'Bash'],
          maxConcurrentTasks: 2,
          priority: 8,
        }),
      );
    }

    return {
      coordinator,
      specialists,
      sharedContext: {
        projectGoals: [task],
        constraints: [],
        sharedKnowledge: new Map(),
      },
    };
  }

  /**
   * Delegate a complex task to a team
   */
  async delegateTask(
    complexTask: Plan,
    _team: AgentTeam,
  ): Promise<CollaboratedResult> {
    const startTime = Date.now();
    const outputs = new Map<string, unknown>();
    const timeline: AgentTask[] = [];
    const conflicts: Conflict[] = [];
    const resolutions: ConflictResolution[] = [];

    // Phase 1: Coordinator analyzes and breaks down the plan
    const breakdown = await this.coordinatorAnalyze(complexTask, team);

    // Phase 2: Assign tasks to specialists
    const assignments = await this.assignTasks(breakdown, team);

    // Phase 3: Execute tasks in parallel where possible
    const executionResults = await this.executeInParallel(assignments, team);

    outputs.set('execution', executionResults);
    timeline.push(...this.getTasks());

    // Phase 4: Detect conflicts
    const detectedConflicts = this.detectConflicts(executionResults, team);
    conflicts.push(...detectedConflicts);

    // Phase 5: Resolve conflicts
    if (conflicts.length > 0) {
      const resolved = await this.resolveConflicts(conflicts, team);
      resolutions.push(...resolved);
    }

    // Phase 6: Reviewer validates everything
    if (team.specialists.some((a) => a.role === AgentRole.REVIEWER)) {
      const reviewResult = await this.reviewerValidate(executionResults, team);
      outputs.set('review', reviewResult);
    }

    // Phase 7: Coordinator integrates outputs
    const integrated = await this.coordinatorIntegrate(outputs, team);

    const duration = Date.now() - startTime;

    // Calculate metrics
    const parallelization = this.calculateParallelization(timeline);
    const efficiency = this.calculateEfficiency(timeline);
    const qualityScore = await this.calculateQualityScore(integrated);

    return {
      success: conflicts.length === resolutions.length,
      outputs: integrated,
      timeline,
      conflicts,
      resolution: resolutions,
      totalDuration: duration,
      metrics: {
        parallelization,
        efficiency,
        qualityScore,
      },
    };
  }

  /**
   * Coordinator analyzes the plan
   */
  private async coordinatorAnalyze(
    plan: Plan,
    _team: AgentTeam,
  ): Promise<Map<AgentRole, PlanStep[]>> {
    const breakdown = new Map<AgentRole, PlanStep[]>();

    // Categorize steps by required expertise
    for (const step of plan.steps) {
      if (
        step.description.includes('design') ||
        step.description.includes('architect')
      ) {
        if (!breakdown.has(AgentRole.ARCHITECT)) {
          breakdown.set(AgentRole.ARCHITECT, []);
        }
        breakdown.get(AgentRole.ARCHITECT)!.push(step);
      } else if (step.description.includes('test')) {
        if (!breakdown.has(AgentRole.TESTER)) {
          breakdown.set(AgentRole.TESTER, []);
        }
        breakdown.get(AgentRole.TESTER)!.push(step);
      } else if (
        step.description.includes('security') ||
        step.description.includes('vulnerability')
      ) {
        if (!breakdown.has(AgentRole.SECURITY)) {
          breakdown.set(AgentRole.SECURITY, []);
        }
        breakdown.get(AgentRole.SECURITY)!.push(step);
      } else if (
        step.description.includes('implement') ||
        step.description.includes('code')
      ) {
        if (!breakdown.has(AgentRole.DEVELOPER)) {
          breakdown.set(AgentRole.DEVELOPER, []);
        }
        breakdown.get(AgentRole.DEVELOPER)!.push(step);
      } else {
        // Default to developer
        if (!breakdown.has(AgentRole.DEVELOPER)) {
          breakdown.set(AgentRole.DEVELOPER, []);
        }
        breakdown.get(AgentRole.DEVELOPER)!.push(step);
      }
    }

    return breakdown;
  }

  /**
   * Assign tasks to agents
   */
  private async assignTasks(
    breakdown: Map<AgentRole, PlanStep[]>,
    team: AgentTeam,
  ): Promise<Map<string, AgentTask[]>> {
    const assignments = new Map<string, AgentTask[]>();

    for (const [role, steps] of breakdown.entries()) {
      // Find agent with matching role
      const agent = team.specialists.find((a) => a.role === role);

      if (!agent) {
        // No agent found for this role, skip assignment
        continue;
      }

      // Create tasks for this agent
      const tasks: AgentTask[] = steps.map((step) => ({
        id: this.generateTaskId(),
        description: step.description,
        assignedTo: agent.id,
        dependencies: step.dependencies,
        priority:
          step.estimatedImpact.riskLevel === 'critical' ? 'critical' : 'high',
        estimatedDuration: 60000, // 1 minute default
        status: 'pending',
      }));

      assignments.set(agent.id, tasks);

      // Update agent status
      agent.status = 'busy';
    }

    return assignments;
  }

  /**
   * Execute tasks in parallel where possible
   */
  private async executeInParallel(
    assignments: Map<string, AgentTask[]>,
    team: AgentTeam,
  ): Promise<Map<string, unknown>> {
    const results = new Map<string, unknown>();

    // Group tasks by dependencies
    const independentTasks: AgentTask[] = [];
    const dependentTasks: AgentTask[] = [];

    for (const tasks of assignments.values()) {
      for (const task of tasks) {
        if (task.dependencies.length === 0) {
          independentTasks.push(task);
        } else {
          dependentTasks.push(task);
        }
      }
    }

    // Execute independent tasks in parallel
    const independentResults = await Promise.all(
      independentTasks.map((task) => this.executeTask(task, team)),
    );

    independentResults.forEach((result, idx) => {
      results.set(independentTasks[idx].id, result);
    });

    // Execute dependent tasks in order
    for (const task of dependentTasks) {
      const result = await this.executeTask(task, team);
      results.set(task.id, result);
    }

    return results;
  }

  /**
   * Execute a single task
   */
  private async executeTask(
    task: AgentTask,
    _team: AgentTeam,
  ): Promise<unknown> {
    task.status = 'in_progress';
    task.startTime = new Date();

    try {
      // Simulate task execution
      await new Promise((resolve) => setTimeout(resolve, 100));

      task.status = 'completed';
      task.endTime = new Date();
      task.actualDuration = task.endTime.getTime() - task.startTime.getTime();

      // Update agent metrics
      const agent = this.agents.get(task.assignedTo);
      if (agent) {
        agent.metrics.tasksCompleted++;
        agent.completedTasks.push(task.id);

        // Update average completion time
        const total =
          agent.metrics.averageCompletionTime *
          (agent.metrics.tasksCompleted - 1);
        agent.metrics.averageCompletionTime =
          (total + task.actualDuration) / agent.metrics.tasksCompleted;

        // Update success rate
        agent.metrics.successRate =
          agent.metrics.tasksCompleted /
          (agent.metrics.tasksCompleted + agent.metrics.tasksFailed);
      }

      this.tasks.set(task.id, task);

      return { success: true, task: task.description };
    } catch (_error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      task.endTime = new Date();

      // Update agent metrics
      const agent = this.agents.get(task.assignedTo);
      if (agent) {
        agent.metrics.tasksFailed++;
        agent.metrics.successRate =
          agent.metrics.tasksCompleted /
          (agent.metrics.tasksCompleted + agent.metrics.tasksFailed);
      }

      this.tasks.set(task.id, task);

      return { success: false, error: task.error };
    }
  }

  /**
   * Detect conflicts between agent outputs
   */
  private detectConflicts(
    results: Map<string, unknown>,
    _team: AgentTeam,
  ): Conflict[] {
    const conflicts: Conflict[] = [];

    // Check for output mismatches
    const outputs = Array.from(results.values());
    for (let i = 0; i < outputs.length; i++) {
      for (let j = i + 1; j < outputs.length; j++) {
        if (this.hasConflict(outputs[i], outputs[j])) {
          conflicts.push({
            id: this.generateConflictId(),
            type: 'output_mismatch',
            involvedAgents: [team.specialists[i].id, team.specialists[j].id],
            description: 'Conflicting outputs detected',
            severity: 'medium',
            detectedAt: new Date(),
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Check if two outputs conflict
   */
  private hasConflict(_output1: unknown, _output2: unknown): boolean {
    // Simplified conflict detection
    return false; // In real implementation, would compare outputs
  }

  /**
   * Resolve conflicts
   */
  async resolveConflicts(
    conflicts: Conflict[],
    _team: AgentTeam,
  ): Promise<ConflictResolution[]> {
    const resolutions: ConflictResolution[] = [];

    for (const conflict of conflicts) {
      const resolution = await this.resolveConflict(conflict, team);
      resolutions.push(resolution);
    }

    return resolutions;
  }

  /**
   * Resolve a single conflict
   */
  private async resolveConflict(
    conflict: Conflict,
    _team: AgentTeam,
  ): Promise<ConflictResolution> {
    // Use coordinator to resolve
    const resolution: ConflictResolution = {
      conflictId: conflict.id,
      strategy: conflict.severity === 'high' ? 'manual' : 'priority',
      resolution: 'Conflict resolved by coordinator',
      resolvedBy: team.coordinator.id,
      resolvedAt: new Date(),
    };

    return resolution;
  }

  /**
   * Reviewer validates all outputs
   */
  private async reviewerValidate(
    results: Map<string, unknown>,
    _team: AgentTeam,
  ): Promise<{ approved: boolean; issues: string[] }> {
    const issues: string[] = [];

    // Check each result
    for (const [taskId, result] of results.entries()) {
      if (!result.success) {
        issues.push(`Task ${taskId} failed: ${result.error}`);
      }
    }

    return {
      approved: issues.length === 0,
      issues,
    };
  }

  /**
   * Coordinator integrates all outputs
   */
  private async coordinatorIntegrate(
    outputs: Map<string, unknown>,
    _team: AgentTeam,
  ): Promise<Map<string, unknown>> {
    // Merge all outputs
    const integrated = new Map<string, unknown>();

    for (const [key, value] of outputs.entries()) {
      integrated.set(key, value);
    }

    return integrated;
  }

  /**
   * Calculate parallelization efficiency
   */
  private calculateParallelization(timeline: AgentTask[]): number {
    if (timeline.length === 0) return 0;

    const independentTasks = timeline.filter(
      (t) => t.dependencies.length === 0,
    );
    return independentTasks.length / timeline.length;
  }

  /**
   * Calculate execution efficiency
   */
  private calculateEfficiency(timeline: AgentTask[]): number {
    if (timeline.length === 0) return 1;

    let totalEstimated = 0;
    let totalActual = 0;

    for (const task of timeline) {
      totalEstimated += task.estimatedDuration;
      totalActual += task.actualDuration || task.estimatedDuration;
    }

    return totalEstimated / totalActual;
  }

  /**
   * Calculate quality score
   */
  private async calculateQualityScore(
    outputs: Map<string, unknown>,
  ): Promise<number> {
    // Simplified quality calculation
    let score = 100;

    for (const output of outputs.values()) {
      if (output.review && !output.review.approved) {
        score -= output.review.issues.length * 10;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get all tasks
   */
  private getTasks(): AgentTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Generate unique agent ID
   */
  private generateAgentId(): string {
    return `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique task ID
   */
  private generateTaskId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique conflict ID
   */
  private generateConflictId(): string {
    return `conflict-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get agent metrics
   */
  getAgentMetrics(agentId: string): Agent['metrics'] | null {
    const agent = this.agents.get(agentId);
    return agent ? agent.metrics : null;
  }

  /**
   * Get team performance
   */
  getTeamPerformance(_team: AgentTeam): {
    totalTasks: number;
    completedTasks: number;
    averageSuccessRate: number;
    averageCompletionTime: number;
  } {
    const allAgents = [team.coordinator, ...team.specialists];

    const totalTasks = allAgents.reduce(
      (sum, agent) =>
        sum + agent.metrics.tasksCompleted + agent.metrics.tasksFailed,
      0,
    );
    const completedTasks = allAgents.reduce(
      (sum, agent) => sum + agent.metrics.tasksCompleted,
      0,
    );
    const averageSuccessRate =
      allAgents.reduce((sum, agent) => sum + agent.metrics.successRate, 0) /
      allAgents.length;
    const averageCompletionTime =
      allAgents.reduce(
        (sum, agent) => sum + agent.metrics.averageCompletionTime,
        0,
      ) / allAgents.length;

    return {
      totalTasks,
      completedTasks,
      averageSuccessRate,
      averageCompletionTime,
    };
  }
}

/**
 * Create a new collaboration engine instance
 */
export function createCollaborationEngine(): CollaborationEngine {
  return new CollaborationEngine();
}
