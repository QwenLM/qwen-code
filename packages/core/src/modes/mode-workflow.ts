/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode Workflow Pipelines — chain modes sequentially
 * for complex development workflows.
 *
 * Workflows define a sequence of mode transitions with prompts and optional
 * quality gates between steps. Built-in pipelines cover common workflows
 * like full-stack feature development, bug fixes, and feature additions.
 */

import { EventEmitter } from 'node:events';
import type { Config } from '../config/config.js';
import { ModeQualityGateManager } from './mode-quality-gates.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODE_WORKFLOW');

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single step in a workflow pipeline.
 */
export interface WorkflowStep {
  /** Mode to switch to for this step */
  mode: string;

  /** Prompt to execute in this mode */
  prompt: string;

  /** Maximum time in minutes for this step */
  maxTimeMinutes?: number;

  /** Quality gate IDs to run before moving to next step */
  qualityGates?: string[];

  /** Optional progress callback */
  onProgress?: (text: string) => void;
}

/**
 * A complete workflow pipeline definition.
 */
export interface ModeWorkflow {
  /** Pipeline name */
  name: string;

  /** Pipeline description */
  description: string;

  /** Icon for visual identification */
  icon: string;

  /** Sequence of workflow steps */
  steps: WorkflowStep[];

  /** Optional abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Result of running a workflow pipeline.
 */
export interface PipelineResult {
  /** Whether the pipeline completed successfully */
  success: boolean;

  /** Number of steps completed */
  completedSteps: number;

  /** Index of the step that failed (if applicable) */
  failedStep?: number;

  /** Error message (if applicable) */
  error?: string;
}

/**
 * Workflow pipeline events.
 */
export type ModeWorkflowEvents = {
  'step:start': [step: number, mode: string];
  'step:complete': [step: number, mode: string];
  'pipeline:complete': [];
  'pipeline:failed': [error: Error];
  'progress': [text: string];
};

// ─── Built-in Pipelines ──────────────────────────────────────────────────────

/**
 * Built-in workflow pipelines for common development scenarios.
 */
export const BUILTIN_PIPELINES: ModeWorkflow[] = [
  {
    name: 'full-stack-feature',
    description: 'End-to-end feature development from requirements to deployment',
    icon: '🚀',
    steps: [
      {
        mode: 'product',
        prompt: 'Analyze requirements for the feature. Define user stories, acceptance criteria, and success metrics.',
        qualityGates: ['noConsoleLogs'],
      },
      {
        mode: 'architect',
        prompt: 'Design the architecture for the feature. Create component diagrams, API contracts, and data models.',
        qualityGates: ['noConsoleLogs'],
      },
      {
        mode: 'developer',
        prompt: 'Implement the feature. Follow the architecture design, write clean code, and ensure all acceptance criteria are met.',
        maxTimeMinutes: 60,
        qualityGates: ['lintCheck', 'typeCheck'],
      },
      {
        mode: 'tester',
        prompt: 'Write comprehensive tests for the feature. Include unit tests, integration tests, and edge cases.',
        qualityGates: ['testCoverage'],
      },
      {
        mode: 'reviewer',
        prompt: 'Review the implementation. Check code quality, architecture adherence, test coverage, and potential bugs.',
        qualityGates: ['noConsoleLogs'],
      },
      {
        mode: 'security',
        prompt: 'Perform a security audit. Check for vulnerabilities, injection risks, and security best practices.',
        qualityGates: ['securityScan'],
      },
      {
        mode: 'devops',
        prompt: 'Prepare for deployment. Update CI/CD pipelines, environment configs, and deployment scripts.',
        qualityGates: ['buildCheck'],
      },
    ],
  },
  {
    name: 'bug-fix',
    description: 'Systematic bug fix with regression tests and review',
    icon: '🐛',
    steps: [
      {
        mode: 'debugger',
        prompt: 'Analyze the bug. Identify the root cause, trace the execution flow, and determine the fix needed.',
        maxTimeMinutes: 30,
      },
      {
        mode: 'developer',
        prompt: 'Implement the fix for the bug. Ensure the fix is minimal and does not introduce regressions.',
        qualityGates: ['lintCheck', 'typeCheck'],
      },
      {
        mode: 'tester',
        prompt: 'Add regression tests for the bug. Write tests that would have caught this bug and verify all existing tests still pass.',
        qualityGates: ['testCoverage'],
      },
      {
        mode: 'reviewer',
        prompt: 'Review the bug fix. Verify the fix is correct, minimal, and does not introduce side effects.',
        qualityGates: ['noConsoleLogs'],
      },
    ],
  },
  {
    name: 'feature-add',
    description: 'Quick feature addition with tests and review',
    icon: '✨',
    steps: [
      {
        mode: 'product',
        prompt: 'Define user stories for the feature. Clarify requirements and acceptance criteria.',
      },
      {
        mode: 'developer',
        prompt: 'Implement the feature according to the user stories. Write clean, well-documented code.',
        qualityGates: ['lintCheck', 'typeCheck'],
      },
      {
        mode: 'tester',
        prompt: 'Add tests for the new feature. Cover happy paths, edge cases, and error handling.',
        qualityGates: ['testCoverage'],
      },
      {
        mode: 'reviewer',
        prompt: 'Review the code for correctness, quality, and adherence to project standards.',
        qualityGates: ['noConsoleLogs'],
      },
    ],
  },
];

// ─── Mode Workflow Runner ────────────────────────────────────────────────────

/**
 * Executes mode workflow pipelines sequentially.
 *
 * The runner manages mode transitions, quality gates, and progress tracking
 * for multi-step development workflows.
 */
export class ModeWorkflowRunner extends EventEmitter {
  private currentStep: number = -1;
  private isRunning = false;
  private abortController: AbortController | null = null;
  private qualityGateManager: ModeQualityGateManager;

  constructor(
    private readonly config: Config,
    qualityGateManager?: ModeQualityGateManager,
  ) {
    super();
    this.qualityGateManager = qualityGateManager ?? new ModeQualityGateManager();
  }

  /**
   * Get the quality gate manager for registering custom gates.
   */
  getQualityGateManager(): ModeQualityGateManager {
    return this.qualityGateManager;
  }

  /**
   * Run a workflow pipeline.
   *
   * @param pipeline - Workflow pipeline definition
   * @param config - Config instance for mode switching
   * @returns Pipeline execution result
   */
  async runPipeline(
    pipeline: ModeWorkflow,
    config: Config,
  ): Promise<PipelineResult> {
    if (this.isRunning) {
      return {
        success: false,
        completedSteps: this.currentStep,
        failedStep: this.currentStep,
        error: 'Pipeline already running',
      };
    }

    this.isRunning = true;
    this.currentStep = -1;

    // Set up abort controller if not provided
    this.abortController = pipeline.abortSignal ?? new AbortController();
    const signal = this.abortController.signal;

    debugLogger.debug(
      `Starting workflow pipeline: ${pipeline.icon} ${pipeline.name}`,
    );

    try {
      for (let i = 0; i < pipeline.steps.length; i++) {
        // Check for abort
        if (signal.aborted) {
          return {
            success: false,
            completedSteps: i,
            failedStep: i,
            error: 'Pipeline aborted',
          };
        }

        const step = pipeline.steps[i];
        this.currentStep = i;

        // Emit step start
        this.emit('step:start', i, step.mode);
        debugLogger.debug(
          `Step ${i + 1}/${pipeline.steps.length}: ${step.icon ?? ''} ${step.mode}`,
        );

        // Run quality gates from previous step before switching
        if (i > 0) {
          const prevStep = pipeline.steps[i - 1];
          if (prevStep.qualityGates && prevStep.qualityGates.length > 0) {
            const gateResult = await this.qualityGateManager.runGates(prevStep.mode);
            if (!gateResult.passed) {
              const errorMsg = `Quality gates failed for step ${i}: ${gateResult.errors.join(', ')}`;
              debugLogger.error(errorMsg);
              this.emit(
                'pipeline:failed',
                new Error(errorMsg),
              );
              return {
                success: false,
                completedSteps: i,
                failedStep: i,
                error: errorMsg,
              };
            }
          }
        }

        // Switch to the mode
        try {
          await config.switchMode(step.mode);
          debugLogger.debug(`Switched to mode: ${step.mode}`);
        } catch (error) {
          const errorMsg = `Failed to switch to mode "${step.mode}": ${error instanceof Error ? error.message : String(error)}`;
          this.emit('pipeline:failed', new Error(errorMsg));
          return {
            success: false,
            completedSteps: i,
            failedStep: i,
            error: errorMsg,
          };
        }

        // Execute the prompt (this would be handled by the agent)
        if (step.prompt) {
          if (step.onProgress) {
            step.onProgress(`[${step.mode}] ${step.prompt}`);
          }
          this.emit('progress', `[${step.mode}] ${step.prompt}`);

          // Note: The actual prompt execution would be handled by the agent
          // The workflow runner manages the orchestration
        }

        // Emit step complete
        this.emit('step:complete', i, step.mode);

        // Check for abort between steps
        if (signal.aborted) {
          return {
            success: false,
            completedSteps: i + 1,
            failedStep: i + 1,
            error: 'Pipeline aborted',
          };
        }
      }

      // Run quality gates for the last step
      const lastStep = pipeline.steps[pipeline.steps.length - 1];
      if (lastStep.qualityGates && lastStep.qualityGates.length > 0) {
        const gateResult = await this.qualityGateManager.runGates(lastStep.mode);
        if (!gateResult.passed) {
          const errorMsg = `Quality gates failed for final step: ${gateResult.errors.join(', ')}`;
          this.emit('pipeline:failed', new Error(errorMsg));
          return {
            success: false,
            completedSteps: pipeline.steps.length,
            failedStep: pipeline.steps.length - 1,
            error: errorMsg,
          };
        }
      }

      // Pipeline complete
      this.currentStep = pipeline.steps.length - 1;
      this.isRunning = false;
      this.emit('pipeline:complete');
      debugLogger.debug(`Pipeline completed: ${pipeline.name}`);

      return {
        success: true,
        completedSteps: pipeline.steps.length,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.isRunning = false;
      this.emit('pipeline:failed', err);
      debugLogger.error(`Pipeline failed: ${pipeline.name}`, err);

      return {
        success: false,
        completedSteps: this.currentStep + 1,
        failedStep: this.currentStep,
        error: err.message,
      };
    }
  }

  /**
   * Cancel the running pipeline.
   */
  cancel(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.abortController) {
      this.abortController.abort();
    }

    this.isRunning = false;
    debugLogger.debug('Pipeline cancelled');
  }

  /**
   * Get the current pipeline status.
   *
   * @param totalSteps - Total number of steps in the pipeline
   * @returns Status object
   */
  getStatus(totalSteps: number): {
    isRunning: boolean;
    currentStep: number;
    totalSteps: number;
  } {
    return {
      isRunning: this.isRunning,
      currentStep: this.currentStep,
      totalSteps,
    };
  }

  /**
   * Check if a pipeline is currently running.
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get the current step index.
   */
  getCurrentStep(): number {
    return this.currentStep;
  }

  /**
   * Get all built-in pipelines.
   */
  static getBuiltinPipelines(): ModeWorkflow[] {
    return BUILTIN_PIPELINES;
  }

  /**
   * Get a built-in pipeline by name.
   *
   * @param name - Pipeline name
   * @returns Pipeline or undefined
   */
  static getBuiltinPipeline(name: string): ModeWorkflow | undefined {
    return BUILTIN_PIPELINES.find((p) => p.name === name);
  }

  /**
   * Get all available built-in pipeline names.
   */
  static getBuiltinPipelineNames(): string[] {
    return BUILTIN_PIPELINES.map((p) => p.name);
  }

  /**
   * Format a pipeline for display.
   *
   * @param pipeline - Workflow pipeline
   * @returns Formatted string
   */
  static formatPipeline(pipeline: ModeWorkflow): string {
    const lines = [
      `${pipeline.icon} **${pipeline.name}**`,
      '',
      pipeline.description,
      '',
      `**Steps:** (${pipeline.steps.length})`,
      '',
    ];

    for (let i = 0; i < pipeline.steps.length; i++) {
      const step = pipeline.steps[i];
      const modeIcon = getModeIcon(step.mode);
      lines.push(
        `${i + 1}. ${modeIcon} **${step.mode}** — ${step.prompt.substring(0, 80)}${step.prompt.length > 80 ? '...' : ''}`,
      );

      if (step.maxTimeMinutes) {
        lines.push(`   Time limit: ${step.maxTimeMinutes} min`);
      }
      if (step.qualityGates && step.qualityGates.length > 0) {
        lines.push(`   Quality gates: ${step.qualityGates.join(', ')}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

/**
 * Get the icon for a mode name.
 */
function getModeIcon(modeName: string): string {
  const iconMap: Record<string, string> = {
    product: '📋',
    architect: '🏗️',
    developer: '💻',
    tester: '🧪',
    reviewer: '🔍',
    debugger: '🐛',
    devops: '🚀',
    security: '🔒',
    optimizer: '⚡',
    general: '🤖',
  };
  return iconMap[modeName] ?? '📌';
}
