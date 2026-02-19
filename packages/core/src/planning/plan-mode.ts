/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodebaseGraph } from '../intelligence/codebase-graph.js';
import type { ProjectMemory } from '../intelligence/project-memory.js';

/**
 * Impact assessment for a plan step
 */
export interface ImpactAssessment {
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  affectedFiles: number;
  affectedComponents: string[];
  reversible: boolean;
  requiresBackup: boolean;
}

/**
 * Validation criteria for a step
 */
export interface ValidationCriteria {
  type: 'tests' | 'linting' | 'build' | 'manual-review' | 'custom';
  description: string;
  command?: string;
  expectedOutput?: string;
}

/**
 * A single step in a plan
 */
export interface PlanStep {
  id: string;
  description: string;
  dependencies: string[]; // IDs of previous steps that must complete first
  tools: string[]; // Tools needed for this step (e.g., ['Edit', 'Write', 'Bash'])
  estimatedImpact: ImpactAssessment;
  validation: ValidationCriteria[];
  completed: boolean;
  result?: {
    success: boolean;
    output?: string;
    error?: string;
    timestamp: Date;
  };
}

/**
 * Rollback step to undo changes
 */
export interface RollbackStep {
  stepId: string;
  description: string;
  action: 'restore-file' | 'run-command' | 'manual';
  details: Record<string, unknown>;
}

/**
 * Point where user approval is required
 */
export interface ApprovalPoint {
  afterStepId: string;
  reason: string;
  requiresExplicitApproval: boolean;
}

/**
 * Complete execution plan
 */
export interface Plan {
  id: string;
  objective: string;
  steps: PlanStep[];
  estimatedComplexity: 'simple' | 'medium' | 'complex';
  requiredApprovals: ApprovalPoint[];
  rollbackStrategy: RollbackStep[];
  metadata: {
    createdAt: Date;
    estimatedDuration?: number; // milliseconds
    totalSteps: number;
    completedSteps: number;
  };
}

/**
 * Context for planning
 */
export interface ProjectContext {
  codebaseGraph: CodebaseGraph;
  projectMemory: ProjectMemory;
  currentBranch?: string;
  hasUncommittedChanges?: boolean;
  workingDirectory: string;
}

/**
 * Result of plan execution
 */
export interface ExecutionResult {
  plan: Plan;
  success: boolean;
  completedSteps: number;
  failedStep?: PlanStep;
  error?: string;
  duration: number; // milliseconds
}

/**
 * Planning engine that creates and executes plans
 */
export class PlanningEngine {
  /**
   * Create a plan for a given task
   */
  async createPlan(task: string, context: ProjectContext): Promise<Plan> {
    // Parse task to understand intent
    const intent = this.parseIntent(task);

    // Decompose into steps
    const steps = await this.decomposeTask(task, intent, context);

    // Calculate complexity
    const complexity = this.estimateComplexity(steps);

    // Identify approval points
    const approvalPoints = this.identifyApprovalPoints(steps);

    // Create rollback strategy
    const rollbackStrategy = this.createRollbackStrategy(steps);

    const plan: Plan = {
      id: this.generatePlanId(),
      objective: task,
      steps,
      estimatedComplexity: complexity,
      requiredApprovals: approvalPoints,
      rollbackStrategy,
      metadata: {
        createdAt: new Date(),
        totalSteps: steps.length,
        completedSteps: 0,
      },
    };

    return plan;
  }

  /**
   * Parse user intent from task description
   */
  private parseIntent(task: string): {
    type: 'create' | 'modify' | 'delete' | 'refactor' | 'debug' | 'optimize';
    scope: 'file' | 'component' | 'feature' | 'system';
  } {
    const taskLower = task.toLowerCase();

    // Determine type
    let type:
      | 'create'
      | 'modify'
      | 'delete'
      | 'refactor'
      | 'debug'
      | 'optimize' = 'modify';

    if (
      taskLower.includes('create') ||
      taskLower.includes('add') ||
      taskLower.includes('new')
    ) {
      type = 'create';
    } else if (taskLower.includes('delete') || taskLower.includes('remove')) {
      type = 'delete';
    } else if (taskLower.includes('refactor')) {
      type = 'refactor';
    } else if (taskLower.includes('fix') || taskLower.includes('debug')) {
      type = 'debug';
    } else if (
      taskLower.includes('optimize') ||
      taskLower.includes('improve')
    ) {
      type = 'optimize';
    }

    // Determine scope
    let scope: 'file' | 'component' | 'feature' | 'system' = 'component';

    if (
      taskLower.includes('file') ||
      taskLower.match(/\.(ts|js|tsx|jsx|py|go)/)
    ) {
      scope = 'file';
    } else if (
      taskLower.includes('feature') ||
      taskLower.includes('functionality')
    ) {
      scope = 'feature';
    } else if (
      taskLower.includes('system') ||
      taskLower.includes('architecture')
    ) {
      scope = 'system';
    }

    return { type, scope };
  }

  /**
   * Decompose task into atomic steps
   */
  private async decomposeTask(
    task: string,
    intent: { type: string; scope: string },
    _context: ProjectContext,
  ): Promise<PlanStep[]> {
    const steps: PlanStep[] = [];

    // Step 1: Analysis phase
    steps.push({
      id: 'step-1',
      description: 'Analyze codebase and identify relevant files',
      dependencies: [],
      tools: ['Grep', 'Glob', 'Read'],
      estimatedImpact: {
        riskLevel: 'low',
        affectedFiles: 0,
        affectedComponents: [],
        reversible: true,
        requiresBackup: false,
      },
      validation: [
        {
          type: 'manual-review',
          description: 'Review identified files for relevance',
        },
      ],
      completed: false,
    });

    // Step 2: Planning phase
    if (intent.type === 'create' || intent.type === 'modify') {
      steps.push({
        id: 'step-2',
        description: 'Design changes and identify dependencies',
        dependencies: ['step-1'],
        tools: ['Read'],
        estimatedImpact: {
          riskLevel: 'low',
          affectedFiles: 0,
          affectedComponents: [],
          reversible: true,
          requiresBackup: false,
        },
        validation: [
          {
            type: 'manual-review',
            description: 'Validate design approach',
          },
        ],
        completed: false,
      });
    }

    // Step 3: Backup phase (if high risk)
    if (intent.scope === 'feature' || intent.scope === 'system') {
      steps.push({
        id: 'step-3',
        description: 'Create backup of affected files',
        dependencies: ['step-2'],
        tools: ['Bash'],
        estimatedImpact: {
          riskLevel: 'low',
          affectedFiles: 0,
          affectedComponents: [],
          reversible: true,
          requiresBackup: false,
        },
        validation: [
          {
            type: 'custom',
            description: 'Verify backup was created',
          },
        ],
        completed: false,
      });
    }

    // Step 4: Implementation phase
    const implementationStep: PlanStep = {
      id: 'step-4',
      description: 'Implement changes',
      dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
      tools: ['Edit', 'Write'],
      estimatedImpact: {
        riskLevel: intent.scope === 'system' ? 'high' : 'medium',
        affectedFiles: 1,
        affectedComponents: [task],
        reversible: true,
        requiresBackup: intent.scope !== 'file',
      },
      validation: [
        {
          type: 'linting',
          description: 'Run linter on modified files',
          command: 'npm run lint',
        },
        {
          type: 'build',
          description: 'Ensure code builds successfully',
          command: 'npm run build',
        },
      ],
      completed: false,
    };

    steps.push(implementationStep);

    // Step 5: Testing phase
    steps.push({
      id: 'step-5',
      description: 'Run tests to verify changes',
      dependencies: ['step-4'],
      tools: ['Bash'],
      estimatedImpact: {
        riskLevel: 'low',
        affectedFiles: 0,
        affectedComponents: [],
        reversible: true,
        requiresBackup: false,
      },
      validation: [
        {
          type: 'tests',
          description: 'All tests pass',
          command: 'npm test',
        },
      ],
      completed: false,
    });

    // Step 6: Review phase
    if (intent.scope === 'feature' || intent.scope === 'system') {
      steps.push({
        id: 'step-6',
        description: 'Review all changes for quality and correctness',
        dependencies: ['step-5'],
        tools: ['Read'],
        estimatedImpact: {
          riskLevel: 'low',
          affectedFiles: 0,
          affectedComponents: [],
          reversible: true,
          requiresBackup: false,
        },
        validation: [
          {
            type: 'manual-review',
            description: 'Human review of changes',
          },
        ],
        completed: false,
      });
    }

    return steps;
  }

  /**
   * Estimate complexity based on steps
   */
  private estimateComplexity(
    steps: PlanStep[],
  ): 'simple' | 'medium' | 'complex' {
    if (steps.length <= 3) return 'simple';
    if (steps.length <= 6) return 'medium';
    return 'complex';
  }

  /**
   * Identify points where approval is needed
   */
  private identifyApprovalPoints(steps: PlanStep[]): ApprovalPoint[] {
    const approvalPoints: ApprovalPoint[] = [];

    for (const step of steps) {
      // Require approval before high-risk steps
      if (
        step.estimatedImpact.riskLevel === 'high' ||
        step.estimatedImpact.riskLevel === 'critical'
      ) {
        const previousStep = steps.find((s) =>
          step.dependencies.includes(s.id),
        );
        if (previousStep) {
          approvalPoints.push({
            afterStepId: previousStep.id,
            reason: `Next step has ${step.estimatedImpact.riskLevel} risk`,
            requiresExplicitApproval: true,
          });
        }
      }

      // Require approval before irreversible changes
      if (!step.estimatedImpact.reversible) {
        const previousStep = steps.find((s) =>
          step.dependencies.includes(s.id),
        );
        if (previousStep) {
          approvalPoints.push({
            afterStepId: previousStep.id,
            reason: 'Next step contains irreversible changes',
            requiresExplicitApproval: true,
          });
        }
      }
    }

    return approvalPoints;
  }

  /**
   * Create rollback strategy for the plan
   */
  private createRollbackStrategy(steps: PlanStep[]): RollbackStep[] {
    const rollbackSteps: RollbackStep[] = [];

    for (const step of steps) {
      if (step.tools.includes('Edit') || step.tools.includes('Write')) {
        rollbackSteps.push({
          stepId: step.id,
          description: `Restore files modified in: ${step.description}`,
          action: 'restore-file',
          details: {
            step: step.id,
          },
        });
      }
    }

    return rollbackSteps.reverse(); // Reverse order for rollback
  }

  /**
   * Execute a plan with feedback loop
   */
  async executePlanWithFeedback(
    plan: Plan,
    executor: (step: PlanStep) => Promise<boolean>,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    let completedSteps = 0;

    for (const step of plan.steps) {
      // Check if dependencies are met
      const dependenciesMet = step.dependencies.every((depId) => {
        const depStep = plan.steps.find((s) => s.id === depId);
        return depStep?.completed;
      });

      if (!dependenciesMet) {
        return {
          plan,
          success: false,
          completedSteps,
          failedStep: step,
          error: 'Dependencies not met',
          duration: Date.now() - startTime,
        };
      }

      // Check for approval point
      const approvalPoint = plan.requiredApprovals.find(
        (ap) => ap.afterStepId === step.id,
      );

      if (approvalPoint && approvalPoint.requiresExplicitApproval) {
        // In real implementation, this would pause and wait for user approval
      }

      // Execute step
      try {
        const success = await executor(step);

        step.completed = success;
        step.result = {
          success,
          timestamp: new Date(),
        };

        if (!success) {
          return {
            plan,
            success: false,
            completedSteps,
            failedStep: step,
            error: 'Step execution failed',
            duration: Date.now() - startTime,
          };
        }

        completedSteps++;
        plan.metadata.completedSteps = completedSteps;
      } catch (_error) {
        step.result = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date(),
        };

        return {
          plan,
          success: false,
          completedSteps,
          failedStep: step,
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime,
        };
      }
    }

    return {
      plan,
      success: true,
      completedSteps,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Rollback a plan to a specific step
   */
  async rollbackToStep(
    plan: Plan,
    stepId: string,
    executor: (rollbackStep: RollbackStep) => Promise<boolean>,
  ): Promise<boolean> {
    const stepIndex = plan.steps.findIndex((s) => s.id === stepId);
    if (stepIndex === -1) return false;

    // Get rollback steps for all steps after the target
    const relevantRollbacks = plan.rollbackStrategy.filter((rs) => {
      const rsIndex = plan.steps.findIndex((s) => s.id === rs.stepId);
      return rsIndex > stepIndex;
    });

    // Execute rollback steps
    for (const rollbackStep of relevantRollbacks) {
      const success = await executor(rollbackStep);
      if (!success) {
        return false;
      }
    }

    // Mark steps as not completed
    for (let i = stepIndex + 1; i < plan.steps.length; i++) {
      plan.steps[i].completed = false;
      plan.steps[i].result = undefined;
    }

    plan.metadata.completedSteps = stepIndex + 1;

    return true;
  }

  /**
   * Generate unique plan ID
   */
  private generatePlanId(): string {
    return `plan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Create a new planning engine instance
 */
export function createPlanningEngine(): PlanningEngine {
  return new PlanningEngine();
}
