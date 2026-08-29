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

import path from 'node:path';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  ApprovalMode,
  type Config,
  type DerivedApprovalModeConfigHooks,
  deriveApprovalModeConfig,
  deriveAgentConfig,
} from '../../config/config.js';
import { Storage } from '../../config/storage.js';
import { type ContentGenerator } from '../../core/contentGenerator.js';
import type { RuntimeContentGeneratorView } from '../runtime/agent-context.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { createRuntimeContentGeneratorView } from '../../models/content-generator-config.js';
import { AgentStatus, isTerminalStatus } from '../runtime/agent-types.js';
import { AgentCore } from '../runtime/agent-core.js';
import { AgentEventEmitter } from '../runtime/agent-events.js';
import { ContextState } from '../runtime/agent-headless.js';
import { AgentInteractive } from '../runtime/agent-interactive.js';
import { runWithTeammateIdentity } from '../team/identity.js';
import type {
  Backend,
  AgentSpawnConfig,
  AgentExitCallback,
  InProcessSpawnConfig,
} from './types.js';
import { DISPLAY_MODE } from './types.js';
import { rebuildToolRegistryOnOverride } from '../../tools/agent/agent.js';
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
  // Why a dedicated per-agent ContentGenerator could not be created,
  // keyed by agentId. The creation failure is swallowed into a debug
  // log (fallback to the parent generator); spawn callers verifying a
  // requested route need the cause to fail with a useful message.
  private readonly agentContentGeneratorErrors = new Map<string, string>();
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
  private readonly agentApprovalCleanups = new Map<string, () => void>();
  // Ids whose agent was stopped via stopAgent. The handle stays in
  // `agents` so post-stop readers keep working (ArenaManager resolves
  // transcripts through getAgent after the arena timeout path stops
  // its agents), but spawn, navigation and input treat these ids as
  // gone. The mark is cleared when the id is respawned and in
  // cleanup().
  private readonly stoppedAgentIds = new Set<string>();
  private readonly agentOrder: string[] = [];
  private activeAgentId: string | null = null;
  private exitCallback: AgentExitCallback | null = null;
  private autoApprovalOverrideCount = 0;
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

    if (
      this.agents.has(config.agentId) &&
      !this.stoppedAgentIds.has(config.agentId)
    ) {
      throw new Error(`Agent "${config.agentId}" already exists.`);
    }
    // Respawn of a stopped id: the retained handle and per-agent
    // records belong to the dead agent. Drop the stale records before
    // the conditional sets below repopulate them (or leave them clear
    // when the respawn requests no dedicated generator); the stopped
    // mark itself is cleared when the respawn commits below.
    const isRespawnOfStoppedAgent = this.stoppedAgentIds.has(config.agentId);
    if (isRespawnOfStoppedAgent) {
      this.agentContentGenerators.delete(config.agentId);
      this.agentContentGeneratorErrors.delete(config.agentId);
    }

    const { promptConfig, modelConfig, runConfig, toolConfig } =
      inProcessConfig.runtimeConfig;
    const runInContext = createRunInContext(inProcessConfig);
    const runWithContext = <T>(fn: () => T): T =>
      runInContext ? runInContext(fn) : fn();

    const eventEmitter = new AgentEventEmitter();

    // Build a per-agent runtime context with isolated working directory,
    // target directory, workspace context, tool registry, and (optionally)
    // a dedicated ContentGenerator for per-agent auth isolation.
    const perAgent = await runWithContext(() =>
      createPerAgentConfig(
        this.runtimeContext,
        config.agentId,
        config.cwd,
        inProcessConfig.runtimeConfig.modelConfig.model,
        inProcessConfig.authOverrides,
        inProcessConfig.approvalMode,
        {
          acquireAutoApprovalOverride: () => this.acquireAutoApprovalOverride(),
          releaseAutoApprovalOverride: () => this.releaseAutoApprovalOverride(),
        },
      ),
    );
    const agentContext = perAgent.config;
    if (perAgent.contentGenerator) {
      this.agentContentGenerators.set(
        config.agentId,
        perAgent.contentGenerator,
      );
    }
    if (perAgent.contentGeneratorError) {
      this.agentContentGeneratorErrors.set(
        config.agentId,
        perAgent.contentGeneratorError,
      );
    }

    this.agentRegistries.set(config.agentId, agentContext.getToolRegistry());
    this.agentApprovalCleanups.set(config.agentId, perAgent.cleanup);

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
      inProcessConfig.initialTask,
      config.agentId,
    );

    const interactive = new AgentInteractive(
      {
        agentId: config.agentId,
        agentName: inProcessConfig.agentName,
        initialTask: inProcessConfig.initialTask,
        maxTurnsPerMessage: runConfig.max_turns,
        maxTimeMinutesPerMessage: runConfig.max_time_minutes,
        completeOnIdle: inProcessConfig.completeOnIdle,
        chatHistory: inProcessConfig.chatHistory,
        runInContext,
      },
      core,
    );

    if (isRespawnOfStoppedAgent) {
      this.stoppedAgentIds.delete(config.agentId);
    }
    this.agents.set(config.agentId, interactive);
    this.agentOrder.push(config.agentId);

    // Route owned monitor notifications into this agent's message queue.
    // AgentInteractive frames every tool body under the agent identity, so a
    // `monitor` started by this agent is stamped with its ownerAgentId — and
    // MonitorRegistry.dispatchNotification routes owned monitors ONLY
    // through agentNotificationCallbacks, with no session fallback. Without
    // this registration (the in-process analogue of AgentTool's
    // registerOwnedMonitorNotifications) those notifications are silently
    // dropped and a start-only Monitor can never report back to the agent.
    // enqueueMessage self-wakes the message pump, so no lifecycle callback
    // is needed. Unregistered in releaseAgentResources.
    this.runtimeContext
      .getMonitorRegistry()
      .setAgentNotificationCallback(config.agentId, (_displayText, modelText) =>
        interactive.enqueueMessage(modelText),
      );

    // Set first agent as active
    if (this.activeAgentId === null) {
      this.activeAgentId = config.agentId;
    }

    try {
      const context = new ContextState();
      await runWithContext(() => interactive.start(context));

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
        this.releaseAgentResources(config.agentId);
        this.exitCallback?.(config.agentId, exitCode, null);
      });

      debugLogger.info(`Spawned in-process agent: ${config.agentId}`);
    } catch (error) {
      debugLogger.error(
        `Failed to start in-process agent "${config.agentId}":`,
        error,
      );
      this.releaseAgentResources(config.agentId);
      this.agents.delete(config.agentId);
      this.agentContentGenerators.delete(config.agentId);
      this.agentContentGeneratorErrors.delete(config.agentId);
      this.removeFromNavigation(config.agentId);
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
    this.releaseAgentResources(agentId, registry);
    // Free the id for respawn — without the stopped mark the
    // `agents.has` gate in spawnAgent would reject it for the life of
    // the backend: a teammate rolled back by TeamManager (route
    // verification failure) could never respawn under the same name,
    // and every retry died with 'Agent "X" already exists.' masking
    // the real cause. The handle itself stays in `this.agents`:
    // ArenaManager still resolves stopped agents through getAgent on
    // the timeout path (transcript, finalText fallback and approach
    // summaries would otherwise degrade silently), and deleting it
    // here dropped those reads. The exit callback is NOT fired here:
    // abort() settles the agent to a terminal status, so the
    // spawn-time completion watcher already reports the exit; firing
    // it again would double-report.
    this.stoppedAgentIds.add(agentId);
    this.removeFromNavigation(agentId);
  }

  stopAll(): void {
    for (const [agentId, agent] of this.agents.entries()) {
      agent.abort();
      this.releaseAgentResources(agentId);
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
    for (const cleanup of this.agentApprovalCleanups.values()) {
      cleanup();
    }
    this.agentApprovalCleanups.clear();

    this.agents.clear();
    this.agentContentGenerators.clear();
    this.agentContentGeneratorErrors.clear();
    this.stoppedAgentIds.clear();
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
    if (this.agents.has(agentId) && !this.stoppedAgentIds.has(agentId)) {
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
    if (!agent || this.stoppedAgentIds.has(agentId)) return false;

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

  /**
   * Why the dedicated ContentGenerator could not be created for this
   * agent, when creation failed and the agent fell back to the parent's
   * generator. Undefined when a dedicated generator exists or none was
   * requested.
   */
  getAgentContentGeneratorError(agentId: string): string | undefined {
    return this.agentContentGeneratorErrors.get(agentId);
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

  /**
   * Roster bookkeeping shared by every path that removes an agent —
   * the spawn-start-failure rollback and stopAgent. Kept in one place
   * so the two teardown paths cannot drift on navigation state.
   */
  private removeFromNavigation(agentId: string): void {
    const index = this.agentOrder.indexOf(agentId);
    if (index >= 0) {
      this.agentOrder.splice(index, 1);
    }
    if (this.activeAgentId === agentId) {
      this.activeAgentId = this.agentOrder[0] ?? null;
    }
  }

  private releaseAgentResources(
    agentId: string,
    registry = this.agentRegistries.get(agentId),
  ): void {
    // Tear down monitor routing registered in spawnAgent: stop any monitors
    // the agent left running and drop its notification callback. Safe to
    // run twice (the terminal watcher and stopAgent both funnel here).
    const monitorRegistry = this.runtimeContext.getMonitorRegistry();
    monitorRegistry.cancelRunningForOwner(agentId, { notify: false });
    monitorRegistry.setAgentNotificationCallback(agentId, undefined);

    const cleanup = this.agentApprovalCleanups.get(agentId);
    if (cleanup) {
      this.agentApprovalCleanups.delete(agentId);
      cleanup();
    }

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

  private acquireAutoApprovalOverride(): boolean {
    if (this.runtimeContext.getApprovalMode() === ApprovalMode.AUTO) {
      return false;
    }
    if (this.autoApprovalOverrideCount === 0) {
      this.runtimeContext
        .getPermissionManager?.()
        ?.stripDangerousRulesForAutoMode();
    }
    this.autoApprovalOverrideCount++;
    return true;
  }

  private releaseAutoApprovalOverride(): void {
    if (this.autoApprovalOverrideCount === 0) {
      return;
    }
    this.autoApprovalOverrideCount--;
    if (
      this.autoApprovalOverrideCount === 0 &&
      this.runtimeContext.getApprovalMode() !== ApprovalMode.AUTO
    ) {
      this.runtimeContext.getPermissionManager?.()?.restoreDangerousRules();
    }
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
  agentId: string,
  cwd: string,
  modelId?: string,
  authOverrides?: InProcessSpawnConfig['authOverrides'],
  approvalMode?: ApprovalMode,
  approvalModeHooks?: DerivedApprovalModeConfigHooks,
): Promise<{
  config: Config;
  contentGenerator?: ContentGenerator;
  contentGeneratorError?: string;
  runtimeView?: RuntimeContentGeneratorView;
  cleanup: () => void;
}> {
  // Every per-agent config needs child-local approval state, not just the
  // ones spawned with an explicit mode: tools bind to this config, and
  // teammate mode switches (Shift+Tab) plus "Proceed always" confirmations
  // call `setApprovalMode` on it — which the derived-Config guard rejects
  // unless an approval profile owns the transition. When no mode was
  // requested, snapshot the base's current mode: the initial mode equals
  // the base mode, so no AUTO strip is acquired and cleanup stays a no-op.
  const approvalHandle = deriveApprovalModeConfig(
    base,
    approvalMode ?? base.getApprovalMode(),
    { hooks: approvalModeHooks },
  );
  const handle = deriveAgentConfig(approvalHandle.config, cwd, {
    customIgnoreFiles: base.getFileFilteringOptions().customIgnoreFiles,
    getPlanFilePath: () => {
      const sessionId = Storage.sanitizePlanSessionId(base.getSessionId());
      const scopedAgentId = Storage.sanitizePlanSessionId(agentId);
      return path.join(base.getPlansDir(), `${sessionId}-${scopedAgentId}.md`);
    },
  });
  const override = handle.config;
  const cleanup = approvalHandle.cleanup;
  let dedicatedContentGenerator: ContentGenerator | undefined;
  let contentGeneratorError: string | undefined;
  let runtimeView: RuntimeContentGeneratorView | undefined;
  let agentRegistry: ToolRegistry | undefined;

  try {
    // Delegated rather than re-enacted. The three steps below used to be
    // inlined here, identical to the shared helper — and a second copy is a
    // second place for an invariant to be broken: a change sharing the
    // parent's `McpClientManager`, or propagating server instructions during
    // the copy, would leak them into every in-process-spawned agent's first
    // message while the tests covering the other spawn path stayed green.
    //
    // `markRebuilt: false` keeps the delegation behaviour-identical to the
    // block it replaced. This config is LONG-LIVED — the agent keeps it — and
    // the marker is read through the prototype chain, so stamping it would
    // hand "you may skip your rebuild" to every wrapper built on it later. A
    // dir-scoped workflow dispatch rebinds only the dir getters; its rebuild
    // is the sole re-anchoring that lifts the subagent's tools above the
    // wrapper, and skipping it resolves relative paths against the parent's
    // working directory instead of the provisioned worktree.
    await rebuildToolRegistryOnOverride(override as Config, base, {
      markRebuilt: false,
    });
    agentRegistry = override.getToolRegistry();

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
        // The debug log above is a no-op unless QWEN_DEBUG_LOG_FILE is
        // set; keep the cause so spawn callers verifying a requested
        // route can report it (missing API key, bad base URL, ...)
        // instead of a bare "route did not materialize" (#10071).
        contentGeneratorError =
          error instanceof Error ? error.message : String(error);
      }
    }

    return {
      config: override as Config,
      contentGenerator:
        dedicatedContentGenerator ??
        (authOverrides?.authType ? undefined : base.getContentGenerator()),
      contentGeneratorError,
      runtimeView,
      cleanup,
    };
  } catch (error) {
    cleanup();
    if (agentRegistry) {
      void agentRegistry.stop().catch((stopError) => {
        debugLogger.error(
          'Failed to stop partially created agent tool registry:',
          stopError,
        );
      });
    }
    throw error;
  }
}

function createRunInContext(
  inProcessConfig: InProcessSpawnConfig,
): AgentInteractive['config']['runInContext'] {
  const identity = inProcessConfig.teammateIdentity;
  if (!identity) {
    return undefined;
  }
  return <T>(fn: () => T): T => runWithTeammateIdentity(identity, fn);
}
