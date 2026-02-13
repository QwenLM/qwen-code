/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookRegistry } from './registry.js';
import type { HookRunner } from './runner.js';
import type { HookPlanner } from './planner.js';
import type {
  MessageBusHookEventHandler,
  HookMessageBus,
} from './messageBusHandler.js';
import type { HookEventName, HookInput, HookExecutionResult } from './types.js';
import type {
  HookExecutionMessageRequest,
  HookExecutionMessageResponse,
} from './messageBusHandler.js';
import { createMessageBusHookEventHandler } from './messageBusHandler.js';

/**
 * Hook system configuration
 */
export interface HookSystemConfig {
  /** Whether hooks are enabled */
  enabled?: boolean;
  /** Hook definitions */
  definitions?: Array<import('./types.js').HookDefinition>;
  /** List of disabled hook names/commands */
  disabled?: string[];
  /** Default timeout for hook execution (ms) */
  defaultTimeout?: number;
  /** Whether to enable telemetry */
  telemetry?: boolean;
  /** Custom message bus (optional) */
  messageBus?: HookMessageBus;
}

/**
 * Hook system state
 */
export interface HookSystemState {
  /** Whether the system is initialized */
  initialized: boolean;
  /** Whether hooks are enabled */
  enabled: boolean;
  /** Number of registered hook definitions */
  definitionCount: number;
  /** Number of hook configs */
  hookConfigCount: number;
  /** Number of disabled hooks */
  disabledCount: number;
}

/**
 * HookSystem is the central orchestration layer for the hook system.
 * It coordinates all hook components and provides a unified interface
 * for hook execution.
 *
 * Architecture:
 * - Registry: Manages hook definitions
 * - Runner: Executes hook commands
 * - Planner: Plans hook execution
 * - EventHandler: Handles event processing via MessageBus
 */
export class HookSystem {
  private registry: HookRegistry;
  private runner: HookRunner;
  private planner: HookPlanner;
  private eventHandler?: MessageBusHookEventHandler;
  private config: HookSystemConfig;
  private initialized = false;
  private disabledHooks: Set<string> = new Set();

  constructor(
    registry: HookRegistry,
    runner: HookRunner,
    planner: HookPlanner,
    config: HookSystemConfig = {},
  ) {
    this.registry = registry;
    this.runner = runner;
    this.planner = planner;
    this.config = config;
  }

  /**
   * Initialize the hook system
   * Automatically enables MessageBus if hooks are configured
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Load definitions from config if provided
    if (this.config.definitions) {
      for (const definition of this.config.definitions) {
        this.registry.register(definition);
      }
    }

    // Update runner config
    if (this.config.defaultTimeout) {
      this.runner.updateConfig({ defaultTimeout: this.config.defaultTimeout });
    }

    // Load disabled hooks from config
    if (this.config.disabled) {
      for (const hookName of this.config.disabled) {
        this.disabledHooks.add(hookName);
      }
    }

    // Initialize message bus handler if message bus is provided
    if (this.config.messageBus) {
      this.initializeMessageBusHandler();
    }

    this.initialized = true;
  }

  /**
   * Initialize the message bus handler
   */
  private initializeMessageBusHandler(): void {
    if (!this.config.messageBus) {
      return;
    }

    this.eventHandler = createMessageBusHookEventHandler({
      registry: this.registry,
      planner: this.planner,
      runner: this.runner,
      messageBus: this.config.messageBus,
      telemetry: this.config.telemetry ?? false,
    });
    this.eventHandler.initialize();
  }

  /**
   * Check if hooks are enabled
   */
  isEnabled(): boolean {
    return this.config.enabled ?? this.registry.count > 0;
  }

  /**
   * Check if the system is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the event handler (if message bus is configured)
   */
  getEventHandler(): MessageBusHookEventHandler | undefined {
    return this.eventHandler;
  }

  /**
   * Get the hook registry
   */
  getRegistry(): HookRegistry {
    return this.registry;
  }

  /**
   * Get the hook runner
   */
  getRunner(): HookRunner {
    return this.runner;
  }

  /**
   * Get the hook planner
   */
  getPlanner(): HookPlanner {
    return this.planner;
  }

  /**
   * Get the current state of the hook system
   */
  getState(): HookSystemState {
    return {
      initialized: this.initialized,
      enabled: this.isEnabled(),
      definitionCount: this.registry.count,
      hookConfigCount: this.registry.getAllHookConfigs().length,
      disabledCount: this.disabledHooks.size,
    };
  }

  /**
   * Check if a specific hook is disabled
   */
  isHookDisabled(hookName: string): boolean {
    return this.disabledHooks.has(hookName);
  }

  /**
   * Get all disabled hook names
   */
  getDisabledHooks(): string[] {
    return Array.from(this.disabledHooks);
  }

  /**
   * Disable a hook by name
   */
  disableHook(hookName: string): boolean {
    if (this.disabledHooks.has(hookName)) {
      return false; // Already disabled
    }
    this.disabledHooks.add(hookName);
    return true;
  }

  /**
   * Enable a hook by name (remove from disabled list)
   */
  enableHook(hookName: string): boolean {
    if (!this.disabledHooks.has(hookName)) {
      return false; // Not disabled
    }
    this.disabledHooks.delete(hookName);
    return true;
  }

  /**
   * Execute hooks for a specific event
   * Direct execution without message bus
   */
  async executeHooks(
    eventName: HookEventName,
    input: HookInput,
    options?: {
      toolName?: string;
      displayName?: string;
    },
  ): Promise<HookExecutionResult[]> {
    if (!this.isEnabled()) {
      return [];
    }

    // Create execution plan
    let plan = this.planner.createPlan({
      eventName,
      toolName: options?.toolName ?? options?.displayName,
      hookDefinitions: this.registry.getAllDefinitions(),
      deduplicate: true,
    });

    // Filter out disabled hooks
    plan = {
      ...plan,
      hookConfigs: plan.hookConfigs.filter((config) => {
        const hookName =
          config.type === 'command' ? config.command : JSON.stringify(config);
        return !this.disabledHooks.has(hookName);
      }),
    };

    if (plan.hookConfigs.length === 0) {
      return [];
    }

    // Execute hooks
    const results: HookExecutionResult[] = [];

    if (plan.sequential) {
      for (const hookConfig of plan.hookConfigs) {
        const result = await this.runner.run(hookConfig, input, eventName);
        results.push(result);

        // Early termination on blocking decision
        if (this.isBlockingResult(result)) {
          break;
        }
      }
    } else {
      const promises = plan.hookConfigs.map((hookConfig) =>
        this.runner.run(hookConfig, input, eventName),
      );
      const parallelResults = await Promise.all(promises);
      results.push(...parallelResults);
    }

    return results;
  }

  /**
   * Send a hook execution request via message bus
   */
  async sendRequest(
    request: HookExecutionMessageRequest,
  ): Promise<HookExecutionMessageResponse | undefined> {
    if (!this.eventHandler) {
      return undefined;
    }

    return this.eventHandler.handleRequest(request);
  }

  /**
   * Update the configuration
   * Can enable/disable message bus dynamically
   */
  updateConfig(config: Partial<HookSystemConfig>): void {
    this.config = { ...this.config, ...config };

    // Re-initialize message bus handler if message bus is newly provided
    if (config.messageBus && !this.eventHandler) {
      this.initializeMessageBusHandler();
    }

    // Update runner config
    if (config.defaultTimeout) {
      this.runner.updateConfig({ defaultTimeout: config.defaultTimeout });
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): HookSystemConfig {
    return { ...this.config };
  }

  /**
   * Shutdown the hook system
   */
  async shutdown(): Promise<void> {
    this.initialized = false;
    this.eventHandler = undefined;
  }

  /**
   * Check if a hook result indicates blocking
   */
  private isBlockingResult(result: HookExecutionResult): boolean {
    if (!result.output) return false;

    const output = result.output;

    // Check top-level decision
    if (output.decision === 'block' || output.decision === 'deny') {
      return true;
    }

    // Check hook-specific outputs
    if (output.hookSpecificOutput) {
      // Check permissionDecision (PreToolUse style)
      if (
        'permissionDecision' in output.hookSpecificOutput &&
        (output.hookSpecificOutput['permissionDecision'] === 'deny' ||
          output.hookSpecificOutput['permissionDecision'] === 'block')
      ) {
        return true;
      }

      // Check decision.behavior (PermissionRequest style)
      if (
        'decision' in output.hookSpecificOutput &&
        typeof output.hookSpecificOutput['decision'] === 'object' &&
        output.hookSpecificOutput['decision'] !== null
      ) {
        const decision = output.hookSpecificOutput['decision'] as Record<
          string,
          unknown
        >;
        if (decision['behavior'] === 'deny') {
          return true;
        }
      }
    }

    return false;
  }
}

/**
 * Options for creating a hook system
 */
export interface CreateHookSystemOptions {
  /** Hook system configuration */
  config?: HookSystemConfig;
  /** Pre-created components (optional) */
  components?: {
    registry?: HookRegistry;
    runner?: HookRunner;
    planner?: HookPlanner;
  };
}

/**
 * Create a new hook system
 */
export async function createHookSystem(
  options: CreateHookSystemOptions = {},
): Promise<HookSystem> {
  const { createHookRegistry } = await import('./registry.js');
  const { createHookRunner } = await import('./runner.js');
  const { createHookPlanner } = await import('./planner.js');

  const registry = options.components?.registry ?? createHookRegistry();
  const runner = options.components?.runner ?? createHookRunner();
  const planner = options.components?.planner ?? createHookPlanner();

  const system = new HookSystem(registry, runner, planner, options.config);
  await system.initialize();

  return system;
}
