/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview InProcessBackend — Backend implementation that runs agents
 * in the current process using AgentInteractive instead of PTY subprocesses.
 *
 * This enables Arena to work without tmux or any external terminal multiplexer.
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import type { Config } from '../../config/config.js';
import {
  type AuthType,
  type ContentGenerator,
  type ContentGeneratorConfig,
  createContentGenerator,
} from '../../core/contentGenerator.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { WorkspaceContext } from '../../utils/workspaceContext.js';
import { FileDiscoveryService } from '../../services/fileDiscoveryService.js';
import { buildAgentContentGeneratorConfig } from '../../models/content-generator-config.js';
import { AgentStatus, isTerminalStatus } from '../runtime/agent-types.js';
import { AgentCore } from '../runtime/agent-core.js';
import { AgentEventEmitter } from '../runtime/agent-events.js';
import { ContextState } from '../runtime/agent-headless.js';
import { AgentInteractive } from '../runtime/agent-interactive.js';
import type {
  Backend,
  AgentSpawnConfig,
  AgentExitCallback,
  InProcessSpawnConfig,
} from './types.js';
import { DISPLAY_MODE } from './types.js';
import type { AnsiOutput } from '../../utils/terminalSerializer.js';

const debugLogger = createDebugLogger('IN_PROCESS_BACKEND');

/**
 * InProcessBackend runs agents in the current Node.js process.
 *
 * Instead of spawning PTY subprocesses, it creates AgentCore + AgentInteractive
 * instances that execute in-process. Screen capture returns null (the UI reads
 * messages directly from AgentInteractive).
 */
export class InProcessBackend implements Backend {
  readonly type = DISPLAY_MODE.IN_PROCESS;

  private readonly runtimeContext: Config;
  private readonly agents = new Map<string, AgentInteractive>();
  private readonly agentContentGenerators = new Map<string, ContentGenerator>();
  private readonly agentRegistries: ToolRegistry[] = [];
  private readonly agentOrder: string[] = [];
  private activeAgentId: string | null = null;
  private exitCallback: AgentExitCallback | null = null;
  /** Whether cleanup() has been called */
  private cleanedUp = false;

  constructor(runtimeContext: Config) {
    this.runtimeContext = runtimeContext;
  }

  // ─── Backend Interface ─────────────────────────────────────

  async init(): Promise<void> {
    debugLogger.info('InProcessBackend initialized');
  }

  async spawnAgent(config: AgentSpawnConfig): Promise<void> {
    const inProcessConfig = config.inProcess;
    if (!inProcessConfig) {
      throw new Error(
        `InProcessBackend requires inProcess config for agent ${config.agentId}`,
      );
    }

    if (this.agents.has(config.agentId)) {
      throw new Error(`Agent "${config.agentId}" already exists.`);
    }

    const { promptConfig, modelConfig, runConfig, toolConfig } =
      inProcessConfig.runtimeConfig;

    const eventEmitter = new AgentEventEmitter();

    // Build a per-agent runtime context with isolated working directory,
    // target directory, workspace context, tool registry, and (optionally)
    // a dedicated ContentGenerator for per-agent auth isolation.
    const perAgent = await createPerAgentConfig(
      this.runtimeContext,
      config.cwd,
      inProcessConfig.runtimeConfig.modelConfig.model,
      inProcessConfig.authOverrides,
    );
    const agentContext = perAgent.config;
    if (perAgent.contentGenerator) {
      this.agentContentGenerators.set(
        config.agentId,
        perAgent.contentGenerator,
      );
    }

    this.agentRegistries.push(agentContext.getToolRegistry());

    const core = new AgentCore(
      inProcessConfig.agentName,
      agentContext,
      promptConfig,
      modelConfig,
      runConfig,
      toolConfig,
      eventEmitter,
    );

    const interactive = new AgentInteractive(
      {
        agentId: config.agentId,
        agentName: inProcessConfig.agentName,
        initialTask: inProcessConfig.initialTask,
        maxTurnsPerMessage: runConfig.max_turns,
        maxTimeMinutesPerMessage: runConfig.max_time_minutes,
        chatHistory: inProcessConfig.chatHistory,
      },
      core,
    );

    this.agents.set(config.agentId, interactive);
    this.agentOrder.push(config.agentId);

    // Set first agent as active
    if (this.activeAgentId === null) {
      this.activeAgentId = config.agentId;
    }

    try {
      const context = new ContextState();
      await interactive.start(context);

      // Watch for completion and fire exit callback — but only for
      // truly terminal statuses. IDLE means the agent is still alive
      // and can accept follow-up messages.
      void interactive.waitForCompletion().then(() => {
        const status = interactive.getStatus();
        if (!isTerminalStatus(status)) {
          return;
        }
        const exitCode =
          status === AgentStatus.COMPLETED
            ? 0
            : status === AgentStatus.FAILED
              ? 1
              : null;
        this.exitCallback?.(config.agentId, exitCode, null);
      });

      debugLogger.info(`Spawned in-process agent: ${config.agentId}`);
    } catch (error) {
      debugLogger.error(
        `Failed to start in-process agent "${config.agentId}":`,
        error,
      );
      this.exitCallback?.(config.agentId, 1, null);
    }
  }

  stopAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.abort();
      debugLogger.info(`Stopped agent: ${agentId}`);
    }
  }

  stopAll(): void {
    for (const agent of this.agents.values()) {
      agent.abort();
    }
    debugLogger.info('Stopped all in-process agents');
  }

  async cleanup(): Promise<void> {
    this.cleanedUp = true;

    for (const agent of this.agents.values()) {
      agent.abort();
    }
    // Wait for loops to settle, but cap at 3s so CLI exit isn't blocked
    // if an agent's reasoning loop doesn't terminate promptly after abort.
    const CLEANUP_TIMEOUT_MS = 3000;
    const promises = Array.from(this.agents.values()).map((a) =>
      a.waitForCompletion().catch(() => {}),
    );
    let timerId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((resolve) => {
      timerId = setTimeout(resolve, CLEANUP_TIMEOUT_MS);
    });
    await Promise.race([Promise.allSettled(promises), timeout]);
    clearTimeout(timerId!);

    // Stop per-agent tool registries so tools like AgentTool can release
    // listeners registered on shared managers (e.g. SubagentManager).
    for (const registry of this.agentRegistries) {
      await registry.stop().catch(() => {});
    }
    this.agentRegistries.length = 0;

    this.agents.clear();
    this.agentContentGenerators.clear();
    this.agentOrder.length = 0;
    this.activeAgentId = null;
    debugLogger.info('InProcessBackend cleaned up');
  }

  setOnAgentExit(callback: AgentExitCallback): void {
    this.exitCallback = callback;
  }

  async waitForAll(timeoutMs?: number): Promise<boolean> {
    if (this.cleanedUp) return true;

    const promises = Array.from(this.agents.values()).map((a) =>
      a.waitForCompletion(),
    );

    if (timeoutMs === undefined) {
      await Promise.allSettled(promises);
      return true;
    }

    let timerId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<'timeout'>((resolve) => {
      timerId = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const result = await Promise.race([
      Promise.allSettled(promises).then(() => 'done' as const),
      timeout,
    ]);

    clearTimeout(timerId!);
    return result === 'done';
  }

  // ─── Navigation ────────────────────────────────────────────

  switchTo(agentId: string): void {
    if (this.agents.has(agentId)) {
      this.activeAgentId = agentId;
    }
  }

  switchToNext(): void {
    this.activeAgentId = this.navigate(1);
  }

  switchToPrevious(): void {
    this.activeAgentId = this.navigate(-1);
  }

  getActiveAgentId(): string | null {
    return this.activeAgentId;
  }

  // ─── Screen Capture (no-op for in-process) ─────────────────

  getActiveSnapshot(): AnsiOutput | null {
    return null;
  }

  getAgentSnapshot(
    _agentId: string,
    _scrollOffset?: number,
  ): AnsiOutput | null {
    return null;
  }

  getAgentScrollbackLength(_agentId: string): number {
    return 0;
  }

  // ─── Input ─────────────────────────────────────────────────

  forwardInput(data: string): boolean {
    if (!this.activeAgentId) return false;
    return this.writeToAgent(this.activeAgentId, data);
  }

  writeToAgent(agentId: string, data: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    agent.enqueueMessage(data);
    return true;
  }

  // ─── Resize (no-op) ───────────────────────────────────────

  resizeAll(_cols: number, _rows: number): void {
    // No terminals to resize in-process
  }

  // ─── External Session ──────────────────────────────────────

  getAttachHint(): string | null {
    return null;
  }

  // ─── Extra: Direct Access ──────────────────────────────────

  /**
   * Get an AgentInteractive instance by agent ID.
   * Used by ArenaManager for direct event subscription.
   */
  getAgent(agentId: string): AgentInteractive | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get the dedicated ContentGenerator created for this agent.
   * Undefined means the agent did not get an isolated generator, so callers
   * should avoid sending agent data through the parent session generator.
   */
  getAgentContentGenerator(agentId: string): ContentGenerator | undefined {
    return this.agentContentGenerators.get(agentId);
  }

  // ─── Private ───────────────────────────────────────────────

  private navigate(direction: 1 | -1): string | null {
    if (this.agentOrder.length === 0) return null;
    if (!this.activeAgentId) return this.agentOrder[0] ?? null;

    const currentIndex = this.agentOrder.indexOf(this.activeAgentId);
    if (currentIndex === -1) return this.agentOrder[0] ?? null;

    const nextIndex =
      (currentIndex + direction + this.agentOrder.length) %
      this.agentOrder.length;
    return this.agentOrder[nextIndex] ?? null;
  }
}

/**
 * Create a per-agent Config that delegates to the shared base Config but
 * overrides key methods to provide per-agent isolation:
 *
 * - `getWorkingDir()` / `getTargetDir()` → agent's worktree cwd
 * - `getWorkspaceContext()` → WorkspaceContext rooted at agent's cwd
 * - `getFileService()` → FileDiscoveryService rooted at agent's cwd
 * - `getToolRegistry()` → per-agent tool registry with core tools bound to
 *   the agent Config
 * - `getContentGenerator()` / `getContentGeneratorConfig()` / `getAuthType()`
 *   → per-agent ContentGenerator when `authOverrides` is provided
 */
async function createPerAgentConfig(
  base: Config,
  cwd: string,
  modelId?: string,
  authOverrides?: InProcessSpawnConfig['authOverrides'],
): Promise<{ config: Config; contentGenerator?: ContentGenerator }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const override = Object.create(base) as any;
  let dedicatedContentGenerator: ContentGenerator | undefined;

  override.getWorkingDir = () => cwd;
  override.getTargetDir = () => cwd;
  override.getProjectRoot = () => cwd;

  const agentWorkspace = new WorkspaceContext(cwd);
  override.getWorkspaceContext = () => agentWorkspace;

  const agentFileService = new FileDiscoveryService(cwd);
  override.getFileService = () => agentFileService;

  const agentRegistry: ToolRegistry = await override.createToolRegistry(
    undefined,
    { skipDiscovery: true },
  );
  agentRegistry.copyDiscoveredToolsFrom(base.getToolRegistry());
  override.getToolRegistry = () => agentRegistry;

  if (authOverrides?.authType) {
    try {
      const agentGeneratorConfig = buildAgentContentGeneratorConfig(
        base,
        modelId,
        authOverrides,
      );
      const agentGenerator = await createContentGenerator(
        agentGeneratorConfig,
        override as Config,
      );
      dedicatedContentGenerator = agentGenerator;
      override.getContentGenerator = (): ContentGenerator => agentGenerator;
      override.getContentGeneratorConfig = (): ContentGeneratorConfig =>
        agentGeneratorConfig;
      override.getAuthType = (): AuthType | undefined =>
        agentGeneratorConfig.authType;
      override.getModel = (): string => agentGeneratorConfig.model;

      debugLogger.info(
        `Created per-agent ContentGenerator: authType=${authOverrides.authType}, model=${agentGeneratorConfig.model}`,
      );
    } catch (error) {
      debugLogger.error(
        'Failed to create per-agent ContentGenerator, falling back to parent:',
        error,
      );
    }
  }

  return {
    config: override as Config,
    contentGenerator: dedicatedContentGenerator,
  };
}
