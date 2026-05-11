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
import { type ContentGenerator } from '../../core/contentGenerator.js';
import type { RuntimeContentGeneratorView } from '../runtime/agent-context.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { WorkspaceContext } from '../../utils/workspaceContext.js';
import { FileDiscoveryService } from '../../services/fileDiscoveryService.js';
import { createRuntimeContentGeneratorView } from '../../models/content-generator-config.js';
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
  // Per-agent tool registries keyed by agentId so `stopAgent` can
  // dispose just that agent's registry (releasing tool listeners on
  // shared managers like SkillManager / SubagentManager) without
  // waiting for backend shutdown. The previous flat-array form leaked
  // listeners — every spawn-then-stop cycle accumulated another stale
  // SkillTool listener on the parent SkillManager, and
  // `notifyChangeListeners` (now parallel via Promise.allSettled)
  // still pays a per-listener round trip even when the underlying
  // subagent no longer exists.
  private readonly agentRegistries: Map<string, ToolRegistry> = new Map();
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

    this.agentRegistries.set(config.agentId, agentContext.getToolRegistry());

    const core = new AgentCore(
      inProcessConfig.agentName,
      agentContext,
      promptConfig,
      modelConfig,
      runConfig,
      toolConfig,
      eventEmitter,
      undefined,
      perAgent.runtimeView,
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
    // Release this agent's per-agent tool registry — including its
    // SkillTool's listener registration on the shared SkillManager —
    // immediately, instead of accumulating until backend cleanup() at
    // process exit. Fire-and-forget the async stop(); errors are
    // already logged inside.
    const registry = this.agentRegistries.get(agentId);
    if (registry) {
      this.agentRegistries.delete(agentId);
      void registry.stop().catch((error) => {
        debugLogger.error(
          `Failed to stop tool registry for agent "${agentId}":`,
          error,
        );
      });
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

    // Stop any still-attached per-agent tool registries so tools like
    // AgentTool / SkillTool release listeners registered on shared
    // managers (SubagentManager / SkillManager). `stopAgent` already
    // releases registries for cleanly stopped agents; this loop covers
    // the fast-path shutdown case where agents are still in flight.
    for (const registry of this.agentRegistries.values()) {
      await registry.stop().catch(() => {});
    }
    this.agentRegistries.clear();

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
   * Get the ContentGenerator this agent can use for summary generation.
   * If auth overrides created an isolated generator, this returns that
   * generator. If no override was requested, this returns the inherited
   * generator the agent already runs with. If override creation failed, this is
   * undefined so callers can avoid sending agent data through a fallback
   * provider.
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
 *
 * When `authOverrides` is provided, also returns a `runtimeView` describing
 * the per-agent ContentGenerator. The agent runtime publishes the view via
 * AsyncLocalStorage so the CG-related Config getters resolve to the
 * agent's values during the run.
 */
async function createPerAgentConfig(
  base: Config,
  cwd: string,
  modelId?: string,
  authOverrides?: InProcessSpawnConfig['authOverrides'],
): Promise<{
  config: Config;
  contentGenerator?: ContentGenerator;
  runtimeView?: RuntimeContentGeneratorView;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const override = Object.create(base) as any;
  let dedicatedContentGenerator: ContentGenerator | undefined;
  let runtimeView: RuntimeContentGeneratorView | undefined;

  override.getWorkingDir = () => cwd;
  override.getTargetDir = () => cwd;
  override.getProjectRoot = () => cwd;

  const agentWorkspace = new WorkspaceContext(cwd);
  override.getWorkspaceContext = () => agentWorkspace;

  const agentFileService = new FileDiscoveryService(cwd);
  override.getFileService = () => agentFileService;

  const agentRegistry: ToolRegistry = await override.createToolRegistry(
    undefined,
    { skipDiscovery: true, forSubAgent: true },
  );
  agentRegistry.copyDiscoveredToolsFrom(base.getToolRegistry());
  override.getToolRegistry = () => agentRegistry;

  if (authOverrides?.authType) {
    try {
      runtimeView = await createRuntimeContentGeneratorView(
        base,
        override as Config,
        modelId,
        authOverrides,
      );
      dedicatedContentGenerator = runtimeView.contentGenerator;

      debugLogger.info(
        `Created per-agent ContentGenerator: authType=${authOverrides.authType}, model=${runtimeView.contentGeneratorConfig.model}`,
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
    contentGenerator:
      dedicatedContentGenerator ??
      (authOverrides?.authType ? undefined : base.getContentGenerator()),
    runtimeView,
  };
}
