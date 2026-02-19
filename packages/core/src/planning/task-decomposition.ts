/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodebaseGraph } from '../intelligence/codebase-graph.js';
import type { ProjectMemory } from '../intelligence/project-memory.js';

/**
 * Task complexity estimation
 */
export interface ComplexityEstimation {
  score: number; // 1-100
  level: 'trivial' | 'simple' | 'medium' | 'complex' | 'very_complex';
  factors: {
    codeSize: number;
    dependencies: number;
    unknowns: number;
    risk: number;
  };
  confidence: number; // 0-1
}

/**
 * Atomic subtask
 */
export interface Subtask {
  id: string;
  description: string;
  type:
    | 'analysis'
    | 'design'
    | 'implementation'
    | 'testing'
    | 'documentation'
    | 'review';
  complexity: ComplexityEstimation;
  prerequisites: string[]; // IDs of subtasks that must complete first
  estimatedDuration: number; // milliseconds
  requiredSkills: string[];
  requiredTools: string[];
  deliverables: string[];
  acceptanceCriteria: string[];
  risks: TaskRisk[];
}

/**
 * Task risk
 */
export interface TaskRisk {
  description: string;
  probability: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  mitigation: string;
}

/**
 * Decomposition strategy
 */
export enum DecompositionStrategy {
  TOP_DOWN = 'top-down', // Break into logical phases
  BOTTOM_UP = 'bottom-up', // Build from smallest units
  FEATURE_BASED = 'feature-based', // Decompose by features
  LAYER_BASED = 'layer-based', // Decompose by architectural layers
  DEPENDENCY_BASED = 'dependency-based', // Order by dependencies
}

/**
 * Decomposition result
 */
export interface DecompositionResult {
  originalTask: string;
  strategy: DecompositionStrategy;
  subtasks: Subtask[];
  dependencies: Map<string, string[]>; // Subtask ID -> Dependency IDs
  criticalPath: string[]; // Subtask IDs in critical path
  estimatedTotalDuration: number;
  parallelizationOpportunities: string[][]; // Groups that can be done in parallel
  metadata: {
    decomposedAt: Date;
    confidence: number;
    alternatives: DecompositionStrategy[];
  };
}

/**
 * Context for decomposition
 */
export interface DecompositionContext {
  task: string;
  codebaseGraph?: CodebaseGraph;
  projectMemory?: ProjectMemory;
  userPreferences?: {
    preferredStrategy?: DecompositionStrategy;
    maxSubtaskSize?: number;
    parallelizationPreference?: 'aggressive' | 'conservative';
  };
  constraints?: {
    maxDuration?: number;
    availableResources?: string[];
    deadlines?: Date;
  };
}

/**
 * Advanced task decomposition engine
 */
export class TaskDecomposer {
  /**
   * Decompose a complex task into atomic subtasks
   */
  async decompose(context: DecompositionContext): Promise<DecompositionResult> {
    // Step 1: Analyze task complexity
    const complexity = await this.analyzeComplexity(context);

    // Step 2: Choose optimal strategy
    const strategy = this.chooseStrategy(complexity, context);

    // Step 3: Decompose using chosen strategy
    const subtasks = await this.decomposeByStrategy(_context, strategy);

    // Step 4: Identify dependencies
    const dependencies = this.identifyDependencies(subtasks, context);

    // Step 5: Find critical path
    const criticalPath = this.findCriticalPath(subtasks, dependencies);

    // Step 6: Identify parallelization opportunities
    const parallelization = this.findParallelizationOpportunities(
      subtasks,
      dependencies,
    );

    // Step 7: Estimate total duration
    const totalDuration = this.estimateTotalDuration(subtasks, criticalPath);

    return {
      originalTask: context.task,
      strategy,
      subtasks,
      dependencies,
      criticalPath,
      estimatedTotalDuration: totalDuration,
      parallelizationOpportunities: parallelization,
      metadata: {
        decomposedAt: new Date(),
        confidence: complexity.confidence,
        alternatives: this.suggestAlternativeStrategies(complexity),
      },
    };
  }

  /**
   * Analyze task complexity
   */
  private async analyzeComplexity(
    context: DecompositionContext,
  ): Promise<ComplexityEstimation> {
    const task = context.task.toLowerCase();
    let score = 0;
    let codeSize = 10;
    let dependencies = 5;
    let unknowns = 3;
    let risk = 2;

    // Analyze based on keywords
    if (task.includes('refactor') || task.includes('rewrite')) {
      score += 30;
      codeSize += 20;
      risk += 3;
    }

    if (
      task.includes('new') ||
      task.includes('create') ||
      task.includes('add')
    ) {
      score += 20;
      unknowns += 5;
    }

    if (task.includes('fix') || task.includes('bug')) {
      score += 15;
      unknowns += 3;
    }

    if (task.includes('optimize') || task.includes('performance')) {
      score += 25;
      risk += 4;
    }

    if (task.includes('security') || task.includes('authentication')) {
      score += 35;
      risk += 5;
    }

    if (task.includes('database') || task.includes('migration')) {
      score += 30;
      risk += 5;
      dependencies += 10;
    }

    if (task.includes('test') || task.includes('testing')) {
      score += 10;
      codeSize += 5;
    }

    if (task.includes('deploy') || task.includes('production')) {
      score += 25;
      risk += 6;
    }

    // Analyze codebase context
    if (context.codebaseGraph) {
      const nodes = context.codebaseGraph.nodes.size;
      if (nodes > 100) score += 10;
      if (nodes > 500) score += 20;

      codeSize = Math.min(100, nodes / 10);
    }

    // Adjust based on project memory
    if (context.projectMemory) {
      // TODO: Implement getIssues method in ProjectMemory
      // const issues = context.projectMemory.getIssues('high');
      // unknowns += issues.length;
      // score += issues.length * 5;
    }

    // Calculate final score and level
    score = Math.min(100, score);

    let level: ComplexityEstimation['level'] = 'simple';
    if (score < 10) level = 'trivial';
    else if (score < 30) level = 'simple';
    else if (score < 50) level = 'medium';
    else if (score < 70) level = 'complex';
    else level = 'very_complex';

    return {
      score,
      level,
      factors: {
        codeSize: Math.min(100, codeSize),
        dependencies: Math.min(100, dependencies),
        unknowns: Math.min(100, unknowns),
        risk: Math.min(100, risk * 10),
      },
      confidence: 0.75,
    };
  }

  /**
   * Choose optimal decomposition strategy
   */
  private chooseStrategy(
    complexity: ComplexityEstimation,
    context: DecompositionContext,
  ): DecompositionStrategy {
    // User preference takes priority
    if (context.userPreferences?.preferredStrategy) {
      return context.userPreferences.preferredStrategy;
    }

    // Choose based on complexity
    if (complexity.level === 'trivial' || complexity.level === 'simple') {
      return DecompositionStrategy.TOP_DOWN;
    }

    if (complexity.factors.dependencies > 50) {
      return DecompositionStrategy.DEPENDENCY_BASED;
    }

    if (complexity.factors.codeSize > 50) {
      return DecompositionStrategy.LAYER_BASED;
    }

    if (context.task.includes('feature')) {
      return DecompositionStrategy.FEATURE_BASED;
    }

    return DecompositionStrategy.TOP_DOWN;
  }

  /**
   * Decompose using specific strategy
   */
  private async decomposeByStrategy(
    context: DecompositionContext,
    strategy: DecompositionStrategy,
  ): Promise<Subtask[]> {
    switch (strategy) {
      case DecompositionStrategy.TOP_DOWN:
        return this.decomposeTopDown(context);
      case DecompositionStrategy.BOTTOM_UP:
        return this.decomposeBottomUp(context);
      case DecompositionStrategy.FEATURE_BASED:
        return this.decomposeFeatureBased(context);
      case DecompositionStrategy.LAYER_BASED:
        return this.decomposeLayerBased(context);
      case DecompositionStrategy.DEPENDENCY_BASED:
        return this.decomposeDependencyBased(context);
      default:
        return this.decomposeTopDown(context);
    }
  }

  /**
   * Top-down decomposition
   */
  private decomposeTopDown(context: DecompositionContext): Subtask[] {
    const subtasks: Subtask[] = [];

    // Phase 1: Analysis
    subtasks.push({
      id: 'analysis-1',
      description: `Analyze requirements for: ${context.task}`,
      type: 'analysis',
      complexity: {
        score: 20,
        level: 'simple',
        factors: { codeSize: 10, dependencies: 5, unknowns: 20, risk: 10 },
        confidence: 0.8,
      },
      prerequisites: [],
      estimatedDuration: 300000, // 5 minutes
      requiredSkills: ['analysis', 'requirements'],
      requiredTools: ['Read', 'Grep'],
      deliverables: ['Requirements document', 'Scope definition'],
      acceptanceCriteria: [
        'All requirements identified',
        'Scope clearly defined',
      ],
      risks: [
        {
          description: 'Incomplete requirements',
          probability: 'medium',
          impact: 'high',
          mitigation: 'Conduct thorough stakeholder interviews',
        },
      ],
    });

    // Phase 2: Design
    subtasks.push({
      id: 'design-1',
      description: 'Design solution architecture',
      type: 'design',
      complexity: {
        score: 40,
        level: 'medium',
        factors: { codeSize: 20, dependencies: 15, unknowns: 30, risk: 25 },
        confidence: 0.7,
      },
      prerequisites: ['analysis-1'],
      estimatedDuration: 600000, // 10 minutes
      requiredSkills: ['architecture', 'design-patterns'],
      requiredTools: ['Read', 'Write'],
      deliverables: ['Architecture document', 'Design diagrams'],
      acceptanceCriteria: [
        'Design is scalable',
        'Design follows best practices',
      ],
      risks: [
        {
          description: 'Over-engineering',
          probability: 'medium',
          impact: 'medium',
          mitigation: 'Keep design simple and focused',
        },
      ],
    });

    // Phase 3: Implementation
    subtasks.push({
      id: 'implementation-1',
      description: 'Implement core functionality',
      type: 'implementation',
      complexity: {
        score: 60,
        level: 'complex',
        factors: { codeSize: 50, dependencies: 30, unknowns: 40, risk: 35 },
        confidence: 0.6,
      },
      prerequisites: ['design-1'],
      estimatedDuration: 1200000, // 20 minutes
      requiredSkills: ['coding', 'problem-solving'],
      requiredTools: ['Edit', 'Write', 'Bash'],
      deliverables: ['Working code', 'Unit tests'],
      acceptanceCriteria: ['Code compiles', 'Tests pass', 'Meets requirements'],
      risks: [
        {
          description: 'Technical blockers',
          probability: 'high',
          impact: 'high',
          mitigation: 'Prototype critical components early',
        },
      ],
    });

    // Phase 4: Testing
    subtasks.push({
      id: 'testing-1',
      description: 'Comprehensive testing',
      type: 'testing',
      complexity: {
        score: 30,
        level: 'medium',
        factors: { codeSize: 25, dependencies: 20, unknowns: 15, risk: 20 },
        confidence: 0.75,
      },
      prerequisites: ['implementation-1'],
      estimatedDuration: 600000, // 10 minutes
      requiredSkills: ['testing', 'qa'],
      requiredTools: ['Bash', 'Read'],
      deliverables: ['Test results', 'Coverage report'],
      acceptanceCriteria: ['All tests pass', 'Coverage > 80%'],
      risks: [
        {
          description: 'Insufficient test coverage',
          probability: 'medium',
          impact: 'high',
          mitigation: 'Define coverage targets upfront',
        },
      ],
    });

    // Phase 5: Review
    subtasks.push({
      id: 'review-1',
      description: 'Code review and quality check',
      type: 'review',
      complexity: {
        score: 20,
        level: 'simple',
        factors: { codeSize: 15, dependencies: 10, unknowns: 10, risk: 15 },
        confidence: 0.85,
      },
      prerequisites: ['testing-1'],
      estimatedDuration: 300000, // 5 minutes
      requiredSkills: ['code-review', 'best-practices'],
      requiredTools: ['Read'],
      deliverables: ['Review comments', 'Approval'],
      acceptanceCriteria: ['No blocking issues', 'Meets quality standards'],
      risks: [],
    });

    return subtasks;
  }

  /**
   * Bottom-up decomposition
   */
  private decomposeBottomUp(context: DecompositionContext): Subtask[] {
    // Start with smallest units and build up
    return this.decomposeTopDown(context).reverse();
  }

  /**
   * Feature-based decomposition
   */
  private decomposeFeatureBased(context: DecompositionContext): Subtask[] {
    const subtasks: Subtask[] = [];

    // Extract features from task description
    const features = this.extractFeatures(context.task);

    features.forEach((feature, idx) => {
      subtasks.push({
        id: `feature-${idx + 1}`,
        description: `Implement ${feature}`,
        type: 'implementation',
        complexity: {
          score: 40,
          level: 'medium',
          factors: { codeSize: 30, dependencies: 20, unknowns: 25, risk: 20 },
          confidence: 0.7,
        },
        prerequisites: idx > 0 ? [`feature-${idx}`] : [],
        estimatedDuration: 900000, // 15 minutes per feature
        requiredSkills: ['coding', 'feature-development'],
        requiredTools: ['Edit', 'Write', 'Bash'],
        deliverables: [`${feature} implementation`, 'Tests'],
        acceptanceCriteria: ['Feature works as expected', 'Tests pass'],
        risks: [
          {
            description: 'Feature creep',
            probability: 'medium',
            impact: 'medium',
            mitigation: 'Stick to defined scope',
          },
        ],
      });
    });

    return subtasks;
  }

  /**
   * Layer-based decomposition
   */
  private decomposeLayerBased(_context: DecompositionContext): Subtask[] {
    const layers = ['data', 'business', 'presentation'];
    const subtasks: Subtask[] = [];

    layers.forEach((layer, idx) => {
      subtasks.push({
        id: `layer-${layer}`,
        description: `Implement ${layer} layer`,
        type: 'implementation',
        complexity: {
          score: 45,
          level: 'medium',
          factors: { codeSize: 35, dependencies: 25, unknowns: 30, risk: 25 },
          confidence: 0.7,
        },
        prerequisites: idx > 0 ? [`layer-${layers[idx - 1]}`] : [],
        estimatedDuration: 1200000, // 20 minutes per layer
        requiredSkills: ['architecture', `${layer}-layer`],
        requiredTools: ['Edit', 'Write'],
        deliverables: [`${layer} layer code`, 'Tests'],
        acceptanceCriteria: ['Layer is functional', 'Properly isolated'],
        risks: [],
      });
    });

    return subtasks;
  }

  /**
   * Dependency-based decomposition
   */
  private decomposeDependencyBased(context: DecompositionContext): Subtask[] {
    // Analyze dependencies from codebase graph
    const subtasks = this.decomposeTopDown(context);

    // Reorder based on dependencies
    return subtasks.sort(
      (a, b) => a.prerequisites.length - b.prerequisites.length,
    );
  }

  /**
   * Extract features from task description
   */
  private extractFeatures(task: string): string[] {
    const features: string[] = [];

    if (task.includes('authentication')) features.push('authentication');
    if (task.includes('authorization')) features.push('authorization');
    if (task.includes('database')) features.push('database-integration');
    if (task.includes('API')) features.push('API-endpoints');
    if (task.includes('UI') || task.includes('interface'))
      features.push('user-interface');
    if (task.includes('test')) features.push('testing');

    // Default if no specific features found
    if (features.length === 0) {
      features.push('core-functionality');
    }

    return features;
  }

  /**
   * Identify dependencies between subtasks
   */
  private identifyDependencies(
    subtasks: Subtask[],
    _context: DecompositionContext,
  ): Map<string, string[]> {
    const dependencies = new Map<string, string[]>();

    for (const subtask of subtasks) {
      dependencies.set(subtask.id, subtask.prerequisites);
    }

    return dependencies;
  }

  /**
   * Find critical path
   */
  private findCriticalPath(
    subtasks: Subtask[],
    dependencies: Map<string, string[]>,
  ): string[] {
    // Simple implementation: longest path through dependency graph
    const criticalPath: string[] = [];
    let currentTask = subtasks[subtasks.length - 1];

    while (currentTask) {
      criticalPath.unshift(currentTask.id);

      // Find predecessor with longest path
      const prereqs = dependencies.get(currentTask.id) || [];
      if (prereqs.length === 0) break;

      currentTask = subtasks.find((t) => t.id === prereqs[0])!;
    }

    return criticalPath;
  }

  /**
   * Find parallelization opportunities
   */
  private findParallelizationOpportunities(
    subtasks: Subtask[],
    dependencies: Map<string, string[]>,
  ): string[][] {
    const opportunities: string[][] = [];

    // Group tasks by dependency level
    const levels = new Map<number, string[]>();

    for (const subtask of subtasks) {
      const level = this.getDependencyLevel(subtask.id, dependencies, subtasks);

      if (!levels.has(level)) {
        levels.set(level, []);
      }
      levels.get(level)!.push(subtask.id);
    }

    // Tasks at same level can be parallelized
    for (const [_level, tasks] of levels.entries()) {
      if (tasks.length > 1) {
        opportunities.push(tasks);
      }
    }

    return opportunities;
  }

  /**
   * Get dependency level for a task
   */
  private getDependencyLevel(
    taskId: string,
    dependencies: Map<string, string[]>,
    subtasks: Subtask[],
  ): number {
    const deps = dependencies.get(taskId) || [];

    if (deps.length === 0) return 0;

    let maxLevel = 0;
    for (const depId of deps) {
      const level = this.getDependencyLevel(depId, dependencies, subtasks);
      maxLevel = Math.max(maxLevel, level + 1);
    }

    return maxLevel;
  }

  /**
   * Estimate total duration
   */
  private estimateTotalDuration(
    subtasks: Subtask[],
    criticalPath: string[],
  ): number {
    let duration = 0;

    for (const taskId of criticalPath) {
      const task = subtasks.find((t) => t.id === taskId);
      if (task) {
        duration += task.estimatedDuration;
      }
    }

    return duration;
  }

  /**
   * Suggest alternative strategies
   */
  private suggestAlternativeStrategies(
    complexity: ComplexityEstimation,
  ): DecompositionStrategy[] {
    const alternatives: DecompositionStrategy[] = [];

    if (complexity.factors.dependencies > 50) {
      alternatives.push(DecompositionStrategy.DEPENDENCY_BASED);
    }

    if (complexity.factors.codeSize > 50) {
      alternatives.push(DecompositionStrategy.LAYER_BASED);
    }

    alternatives.push(DecompositionStrategy.TOP_DOWN);
    alternatives.push(DecompositionStrategy.FEATURE_BASED);

    return alternatives;
  }
}

/**
 * Create a new task decomposer instance
 */
export function createTaskDecomposer(): TaskDecomposer {
  return new TaskDecomposer();
}
