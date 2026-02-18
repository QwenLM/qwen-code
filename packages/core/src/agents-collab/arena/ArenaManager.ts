/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitWorktreeService } from '../../services/gitWorktreeService.js';
import type { Config } from '../../config/config.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { isNodeError } from '../../utils/errors.js';
import type { AnsiOutput } from '../../utils/terminalSerializer.js';
import { ArenaEventEmitter, ArenaEventType } from './arena-events.js';
import type { AgentSpawnConfig, Backend, DisplayMode } from '../index.js';
import { detectBackend } from '../index.js';
import {
  type ArenaConfig,
  type ArenaConfigFile,
  type ArenaControlSignal,
  type ArenaStartOptions,
  type ArenaAgentResult,
  type ArenaSessionResult,
  type ArenaAgentState,
  type ArenaCallbacks,
  type ArenaStatusFile,
  ArenaAgentStatus,
  ArenaSessionStatus,
  ARENA_MAX_AGENTS,
  safeAgentId,
} from './types.js';

const debugLogger = createDebugLogger('ARENA');

const ARENA_POLL_INTERVAL_MS = 500;

/**
 * Generates a unique Arena session ID.
 */
function generateArenaSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `arena-${timestamp}-${random}`;
}

/**
 * ArenaManager orchestrates multi-model competitive execution.
 *
 * It manages:
 * - Git worktree creation for isolated environments
 * - Parallel agent execution via PTY subprocesses (through Backend)
 * - Event emission for UI updates
 * - Result collection and comparison
 * - Active agent switching, input routing, and screen capture
 */
export class ArenaManager {
  private readonly config: Config;
  private readonly eventEmitter: ArenaEventEmitter;
  private readonly worktreeService: GitWorktreeService;
  private readonly callbacks: ArenaCallbacks;
  private backend: Backend | null = null;
  private cachedResult: ArenaSessionResult | null = null;

  private sessionId: string | undefined;
  private sessionStatus: ArenaSessionStatus = ArenaSessionStatus.INITIALIZING;
  private agents: Map<string, ArenaAgentState> = new Map();
  private arenaConfig: ArenaConfig | undefined;
  private wasRepoInitialized = false;
  private startedAt: number | undefined;
  private masterAbortController: AbortController | undefined;
  private terminalCols: number;
  private terminalRows: number;
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private lifecyclePromise: Promise<void> | null = null;

  constructor(config: Config, callbacks: ArenaCallbacks = {}) {
    this.config = config;
    this.callbacks = callbacks;
    this.eventEmitter = new ArenaEventEmitter();
    const arenaSettings = config.getAgentsSettings().arena;
    this.worktreeService = new GitWorktreeService(
      config.getWorkingDir(),
      arenaSettings?.worktreeBaseDir,
    );
    this.terminalCols = process.stdout.columns || 120;
    this.terminalRows = process.stdout.rows || 40;
  }

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Get the event emitter for subscribing to Arena events.
   */
  getEventEmitter(): ArenaEventEmitter {
    return this.eventEmitter;
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Get the current session status.
   */
  getSessionStatus(): ArenaSessionStatus {
    return this.sessionStatus;
  }

  /**
   * Get the current task description (available while session is active).
   */
  getTask(): string | undefined {
    return this.arenaConfig?.task;
  }

  /**
   * Get all agent states.
   */
  getAgentStates(): ArenaAgentState[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get a specific agent state.
   */
  getAgentState(agentId: string): ArenaAgentState | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get the cached session result (available after session completes).
   */
  getResult(): ArenaSessionResult | null {
    return this.cachedResult;
  }

  /**
   * Get the underlying backend for direct access.
   * Returns null before the session initializes a backend.
   */
  getBackend(): Backend | null {
    return this.backend;
  }

  /**
   * Store the outer lifecycle promise so cancel/stop can wait for start()
   * to fully unwind before proceeding with cleanup.
   */
  setLifecyclePromise(p: Promise<void>): void {
    this.lifecyclePromise = p;
  }

  /**
   * Wait for the start lifecycle to fully settle (including error handling
   * and listener teardown). Resolves immediately if no lifecycle is active.
   */
  async waitForSettled(): Promise<void> {
    if (this.lifecyclePromise) {
      await this.lifecyclePromise;
    }
  }

  // ─── PTY Interaction ───────────────────────────────────────────

  /**
   * Switch the active agent for screen display and input routing.
   */
  switchToAgent(agentId: string): void {
    this.backend?.switchTo(agentId);
  }

  /**
   * Switch to the next agent in order.
   */
  switchToNextAgent(): void {
    this.backend?.switchToNext();
  }

  /**
   * Switch to the previous agent in order.
   */
  switchToPreviousAgent(): void {
    this.backend?.switchToPrevious();
  }

  /**
   * Get the ID of the currently active agent.
   */
  getActiveAgentId(): string | null {
    return this.backend?.getActiveAgentId() ?? null;
  }

  /**
   * Get the screen snapshot for the currently active agent.
   */
  getActiveSnapshot(): AnsiOutput | null {
    return this.backend?.getActiveSnapshot() ?? null;
  }

  /**
   * Get the screen snapshot for a specific agent.
   */
  getAgentSnapshot(
    agentId: string,
    scrollOffset: number = 0,
  ): AnsiOutput | null {
    return this.backend?.getAgentSnapshot(agentId, scrollOffset) ?? null;
  }

  /**
   * Get the maximum scrollback length for an agent's terminal buffer.
   */
  getAgentScrollbackLength(agentId: string): number {
    return this.backend?.getAgentScrollbackLength(agentId) ?? 0;
  }

  /**
   * Forward keyboard input to the currently active agent.
   */
  forwardInput(data: string): boolean {
    return this.backend?.forwardInput(data) ?? false;
  }

  /**
   * Resize all agent terminals.
   */
  resizeAgents(cols: number, rows: number): void {
    this.terminalCols = cols;
    this.terminalRows = rows;
    this.backend?.resizeAll(cols, rows);
  }

  // ─── Session Lifecycle ─────────────────────────────────────────

  /**
   * Start an Arena session.
   *
   * @param options - Arena start options
   * @returns Promise resolving to the session result
   */
  async start(options: ArenaStartOptions): Promise<ArenaSessionResult> {
    // Validate options
    this.validateStartOptions(options);

    // Use caller-provided terminal size if available
    if (options.cols && options.cols > 0) {
      this.terminalCols = options.cols;
    }
    if (options.rows && options.rows > 0) {
      this.terminalRows = options.rows;
    }

    this.sessionId = generateArenaSessionId();
    this.startedAt = Date.now();
    this.sessionStatus = ArenaSessionStatus.INITIALIZING;
    this.masterAbortController = new AbortController();

    const sourceRepoPath = this.config.getWorkingDir();

    this.arenaConfig = {
      sessionId: this.sessionId,
      task: options.task,
      models: options.models,
      maxRoundsPerAgent: options.maxRoundsPerAgent ?? 50,
      timeoutSeconds: options.timeoutSeconds ?? 600,
      approvalMode: options.approvalMode,
      sourceRepoPath,
    };

    debugLogger.info(`Starting Arena session: ${this.sessionId}`);
    debugLogger.info(`Task: ${options.task}`);
    debugLogger.info(
      `Models: ${options.models.map((m) => m.modelId).join(', ')}`,
    );

    // Emit session start event
    this.eventEmitter.emit(ArenaEventType.SESSION_START, {
      sessionId: this.sessionId,
      task: options.task,
      models: options.models,
      timestamp: Date.now(),
    });

    try {
      // Detect and initialize the backend.
      // Priority: explicit option > agents.displayMode setting > auto-detect
      const displayMode =
        options.displayMode ??
        (this.config.getAgentsSettings().displayMode as
          | DisplayMode
          | undefined);
      await this.initializeBackend(displayMode);

      // If cancelled during backend init, bail out early
      if (this.masterAbortController?.signal.aborted) {
        this.sessionStatus = ArenaSessionStatus.CANCELLED;
        return this.collectResults();
      }

      // Set up worktrees for all agents
      this.emitProgress(`Setting up environment for agents…`);
      await this.setupWorktrees();

      // If cancelled during worktree setup, bail out early
      if (this.masterAbortController?.signal.aborted) {
        this.sessionStatus = ArenaSessionStatus.CANCELLED;
        return this.collectResults();
      }

      // Start all agents in parallel via PTY
      this.emitProgress('Environment ready. Launching agents…');
      this.sessionStatus = ArenaSessionStatus.RUNNING;
      await this.runAgents();

      // Only mark as completed if not already cancelled/timed out
      if (this.sessionStatus === ArenaSessionStatus.RUNNING) {
        this.sessionStatus = ArenaSessionStatus.COMPLETED;
      }

      // Collect results (uses this.sessionStatus for result status)
      const result = await this.collectResults();
      this.cachedResult = result;

      // Emit session complete event
      this.eventEmitter.emit(ArenaEventType.SESSION_COMPLETE, {
        sessionId: this.sessionId,
        result,
        timestamp: Date.now(),
      });

      this.callbacks.onArenaComplete?.(result);

      return result;
    } catch (error) {
      this.sessionStatus = ArenaSessionStatus.FAILED;

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Emit session error event
      this.eventEmitter.emit(ArenaEventType.SESSION_ERROR, {
        sessionId: this.sessionId,
        error: errorMessage,
        timestamp: Date.now(),
      });

      this.callbacks.onArenaError?.(
        error instanceof Error ? error : new Error(errorMessage),
      );

      throw error;
    }
  }

  /**
   * Cancel the current Arena session.
   */
  async cancel(): Promise<void> {
    if (!this.sessionId) {
      return;
    }

    debugLogger.info(`Cancelling Arena session: ${this.sessionId}`);

    // Stop polling
    this.stopPolling();

    // Abort the master controller
    this.masterAbortController?.abort();

    const isTerminal = (s: ArenaAgentStatus) =>
      s === ArenaAgentStatus.TERMINATED || s === ArenaAgentStatus.CANCELLED;

    // Force stop all PTY processes (sends Ctrl-C)
    this.backend?.stopAll();

    // Update agent statuses
    for (const agent of this.agents.values()) {
      if (!isTerminal(agent.status)) {
        agent.abortController.abort();
        this.updateAgentStatus(agent.agentId, ArenaAgentStatus.TERMINATED);
      }
    }

    this.sessionStatus = ArenaSessionStatus.CANCELLED;
  }

  /**
   * Clean up the Arena session (remove worktrees, kill processes, etc.).
   */
  async cleanup(): Promise<void> {
    if (!this.sessionId) {
      return;
    }

    debugLogger.info(`Cleaning up Arena session: ${this.sessionId}`);

    // Stop polling in case cleanup is called without cancel
    this.stopPolling();

    // Clean up backend resources
    if (this.backend) {
      await this.backend.cleanup();
    }

    // Clean up worktrees
    await this.worktreeService.cleanupArenaSession(this.sessionId);

    this.agents.clear();
    this.cachedResult = null;
    this.sessionId = undefined;
    this.arenaConfig = undefined;
    this.backend = null;
  }

  /**
   * Clean up runtime resources (processes, backend, memory) without removing
   * worktrees or session files on disk. Used when preserveArtifacts is enabled.
   */
  async cleanupRuntime(): Promise<void> {
    if (!this.sessionId) {
      return;
    }

    debugLogger.info(
      `Cleaning up Arena runtime (preserving artifacts): ${this.sessionId}`,
    );

    this.stopPolling();

    if (this.backend) {
      await this.backend.cleanup();
    }

    this.agents.clear();
    this.cachedResult = null;
    this.sessionId = undefined;
    this.arenaConfig = undefined;
    this.backend = null;
  }

  /**
   * Apply the result from a specific agent to the main working directory.
   */
  async applyAgentResult(
    agentId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, error: `Agent ${agentId} not found` };
    }

    if (agent.status !== ArenaAgentStatus.COMPLETED) {
      return {
        success: false,
        error: `Agent ${agentId} has not completed (current status: ${agent.status})`,
      };
    }

    return this.worktreeService.applyWorktreeChanges(agent.worktree.path);
  }

  /**
   * Get the diff for a specific agent's changes.
   */
  async getAgentDiff(agentId: string): Promise<string> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return `Agent ${agentId} not found`;
    }

    return this.worktreeService.getWorktreeDiff(agent.worktree.path);
  }

  // ─── Private: Progress ─────────────────────────────────────────

  /**
   * Emit a progress message via SESSION_UPDATE so the UI can display
   * setup status.
   */
  private emitProgress(message: string): void {
    if (!this.sessionId) return;
    this.eventEmitter.emit(ArenaEventType.SESSION_UPDATE, {
      sessionId: this.sessionId,
      type: 'info',
      message,
      timestamp: Date.now(),
    });
  }

  // ─── Private: Validation ───────────────────────────────────────

  private validateStartOptions(options: ArenaStartOptions): void {
    if (!options.models || options.models.length < 2) {
      throw new Error('Arena requires at least 2 models to compare');
    }

    if (options.models.length > ARENA_MAX_AGENTS) {
      throw new Error(`Arena supports a maximum of ${ARENA_MAX_AGENTS} models`);
    }

    if (!options.task || options.task.trim().length === 0) {
      throw new Error('Arena requires a task/prompt');
    }

    // Check for duplicate model IDs
    const modelIds = options.models.map((m) => m.modelId);
    const uniqueIds = new Set(modelIds);
    if (uniqueIds.size !== modelIds.length) {
      throw new Error('Arena models must have unique identifiers');
    }

    // Check for collisions after filesystem-safe normalization.
    // safeAgentId replaces characters like / \ : to '--', so distinct
    // model IDs (e.g. "org/model" and "org--model") can map to the same
    // status/control file path and corrupt each other's state.
    const safeIds = modelIds.map((id) => safeAgentId(id));
    const uniqueSafeIds = new Set(safeIds);
    if (uniqueSafeIds.size !== safeIds.length) {
      const collisions = modelIds.filter(
        (id, i) => safeIds.indexOf(safeIds[i]!) !== i,
      );
      throw new Error(
        `Arena model IDs collide after path normalization: ${collisions.join(', ')}. ` +
          'Choose model IDs that remain unique when special characters (/ \\ : etc.) are replaced.',
      );
    }
  }

  // ─── Private: Backend Initialization ───────────────────────────

  /**
   * Initialize the backend.
   */
  private async initializeBackend(displayMode?: DisplayMode): Promise<void> {
    const { backend, warning } = await detectBackend(displayMode);
    await backend.init();
    this.backend = backend;

    if (warning && this.sessionId) {
      this.eventEmitter.emit(ArenaEventType.SESSION_UPDATE, {
        sessionId: this.sessionId,
        type: 'warning',
        message: warning,
        timestamp: Date.now(),
      });
    }

    // Surface attach hint for external tmux sessions
    const attachHint = backend.getAttachHint();
    if (attachHint && this.sessionId) {
      this.eventEmitter.emit(ArenaEventType.SESSION_UPDATE, {
        sessionId: this.sessionId,
        type: 'info',
        message: `To view agent panes, run: ${attachHint}`,
        timestamp: Date.now(),
      });
    }
  }

  // ─── Private: Worktree Setup ───────────────────────────────────

  private async setupWorktrees(): Promise<void> {
    if (!this.arenaConfig) {
      throw new Error('Arena config not initialized');
    }

    debugLogger.info('Setting up worktrees for Arena agents');

    const worktreeNames = this.arenaConfig.models.map(
      (m) => m.displayName || m.modelId,
    );

    const result = await this.worktreeService.setupArenaWorktrees({
      arenaSessionId: this.arenaConfig.sessionId,
      sourceRepoPath: this.arenaConfig.sourceRepoPath,
      worktreeNames,
    });

    this.wasRepoInitialized = result.wasRepoInitialized;

    if (!result.success) {
      const errorMessages = result.errors
        .map((e) => `${e.name}: ${e.error}`)
        .join('; ');
      throw new Error(`Failed to set up worktrees: ${errorMessages}`);
    }

    // Create agent states
    for (let i = 0; i < this.arenaConfig.models.length; i++) {
      const model = this.arenaConfig.models[i]!;
      const worktreeName = worktreeNames[i]!;
      const worktree = result.worktreesByName[worktreeName];

      if (!worktree) {
        throw new Error(
          `No worktree created for model ${model.modelId} (name: ${worktreeName})`,
        );
      }

      const agentId = model.modelId;

      const agentState: ArenaAgentState = {
        agentId,
        model,
        status: ArenaAgentStatus.INITIALIZING,
        worktree,
        abortController: new AbortController(),
        stats: {
          rounds: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          toolCalls: 0,
          successfulToolCalls: 0,
          failedToolCalls: 0,
        },
        startedAt: 0,
        accumulatedText: '',
      };

      this.agents.set(agentId, agentState);
    }

    debugLogger.info(`Created ${this.agents.size} agent worktrees`);
  }

  // ─── Private: Agent Execution ──────────────────────────────────

  private async runAgents(): Promise<void> {
    if (!this.arenaConfig) {
      throw new Error('Arena config not initialized');
    }

    debugLogger.info('Starting Arena agents sequentially via backend');

    const backend = this.requireBackend();

    // Wire up exit handler on the backend
    backend.setOnAgentExit((agentId, exitCode, signal) => {
      this.handleAgentExit(agentId, exitCode, signal);
    });

    // Spawn agents sequentially — each spawn completes before starting the next.
    // This creates a visual effect where panes appear one by one.
    for (const agent of this.agents.values()) {
      await this.spawnAgentPty(agent);
    }

    // Start polling agent status files
    this.startPolling();

    // Set up timeout
    const timeoutMs = (this.arenaConfig.timeoutSeconds ?? 600) * 1000;

    // Wait for all agents to reach IDLE or TERMINATED, or timeout.
    // Unlike waitForAll (which waits for PTY exit), this resolves as soon
    // as every agent has finished its first task in interactive mode.
    const allSettled = await this.waitForAllAgentsSettled(timeoutMs);

    // Stop polling when all agents are done
    this.stopPolling();

    if (!allSettled) {
      debugLogger.info('Arena session timed out, stopping remaining agents');
      this.sessionStatus = ArenaSessionStatus.CANCELLED;

      // Terminate remaining active agents
      for (const agent of this.agents.values()) {
        if (
          agent.status !== ArenaAgentStatus.COMPLETED &&
          agent.status !== ArenaAgentStatus.CANCELLED &&
          agent.status !== ArenaAgentStatus.TERMINATED
        ) {
          backend.stopAgent(agent.agentId);
          agent.abortController.abort();
          this.updateAgentStatus(agent.agentId, ArenaAgentStatus.TERMINATED);
        }
      }
    }

    debugLogger.info('All Arena agents settled or timed out');
  }

  private async spawnAgentPty(agent: ArenaAgentState): Promise<void> {
    if (!this.arenaConfig) {
      return;
    }

    const backend = this.requireBackend();

    const { agentId, model, worktree } = agent;

    debugLogger.info(`Spawning agent PTY: ${agentId}`);

    agent.startedAt = Date.now();
    this.updateAgentStatus(agentId, ArenaAgentStatus.RUNNING);

    // Emit agent start event
    this.eventEmitter.emit(ArenaEventType.AGENT_START, {
      sessionId: this.arenaConfig.sessionId,
      agentId,
      model,
      worktreePath: worktree.path,
      timestamp: Date.now(),
    });

    this.callbacks.onAgentStart?.(agentId, model);

    // Build the CLI command to spawn the agent as a full interactive instance
    const spawnConfig = this.buildAgentSpawnConfig(agent);

    try {
      await backend.spawnAgent(spawnConfig);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      agent.error = errorMessage;
      this.updateAgentStatus(agentId, ArenaAgentStatus.TERMINATED);

      this.eventEmitter.emit(ArenaEventType.AGENT_ERROR, {
        sessionId: this.requireConfig().sessionId,
        agentId,
        error: errorMessage,
        timestamp: Date.now(),
      });

      debugLogger.error(`Failed to spawn agent: ${agentId}`, error);
    }
  }

  private requireBackend(): Backend {
    if (!this.backend) {
      throw new Error('Arena backend not initialized.');
    }
    return this.backend;
  }

  private requireConfig(): ArenaConfig {
    if (!this.arenaConfig) {
      throw new Error('Arena config not initialized');
    }
    return this.arenaConfig;
  }

  private handleAgentExit(
    agentId: string,
    exitCode: number | null,
    _signal: number | null,
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    // Already terminated (e.g. via cancel)
    if (agent.status === ArenaAgentStatus.TERMINATED) {
      return;
    }

    agent.stats.durationMs = Date.now() - agent.startedAt;

    if (
      exitCode !== 0 &&
      exitCode !== null &&
      !agent.abortController.signal.aborted
    ) {
      agent.error = `Process exited with code ${exitCode}`;
      this.eventEmitter.emit(ArenaEventType.AGENT_ERROR, {
        sessionId: this.requireConfig().sessionId,
        agentId,
        error: agent.error,
        timestamp: Date.now(),
      });
    }

    this.updateAgentStatus(agentId, ArenaAgentStatus.TERMINATED);
    debugLogger.info(`Agent terminated: ${agentId} (exit code: ${exitCode})`);
  }

  /**
   * Build the spawn configuration for an agent subprocess.
   *
   * The agent is launched as a full interactive CLI instance, running in
   * its own worktree with the specified model. The task is passed via
   * the --prompt argument so the CLI enters interactive mode and
   * immediately starts working on the task.
   */
  private buildAgentSpawnConfig(agent: ArenaAgentState): AgentSpawnConfig {
    const { agentId, model, worktree } = agent;

    // Build CLI args for spawning an interactive agent.
    // Note: --cwd is NOT a valid CLI flag; the working directory is set
    // via AgentSpawnConfig.cwd which becomes the PTY's cwd.
    const args: string[] = [];

    // Set the model and auth type
    args.push('--model', model.modelId);
    args.push('--auth-type', model.authType);

    // Pass the task via --prompt-interactive (-i) so the CLI enters
    // interactive mode AND immediately starts working on the task.
    // (--prompt runs non-interactively and would exit after completion.)
    if (this.arenaConfig?.task) {
      args.push('--prompt-interactive', this.arenaConfig.task);
    }

    // Set approval mode if specified
    if (this.arenaConfig?.approvalMode) {
      args.push('--approval-mode', this.arenaConfig.approvalMode);
    }

    // Construct env vars for the agent
    const arenaSessionDir = this.getArenaSessionDir();
    const env: Record<string, string> = {
      QWEN_CODE: '1',
      ARENA_AGENT_ID: agentId,
      ARENA_SESSION_ID: this.arenaConfig?.sessionId ?? '',
      ARENA_SESSION_DIR: arenaSessionDir,
    };

    // If the model has auth overrides, pass them via env
    if (model.apiKey) {
      env['QWEN_API_KEY'] = model.apiKey;
    }
    if (model.baseUrl) {
      env['QWEN_BASE_URL'] = model.baseUrl;
    }

    const spawnConfig = {
      agentId,
      command: process.execPath, // Use the same Node.js binary
      args: [path.resolve(process.argv[1]!), ...args], // Re-launch the CLI entry point (must be absolute path since cwd changes)
      cwd: worktree.path,
      env,
      cols: this.terminalCols,
      rows: this.terminalRows,
    };

    debugLogger.info(
      `[buildAgentSpawnConfig] agentId=${agentId}, command=${spawnConfig.command}, cliEntry=${process.argv[1]}, resolvedEntry=${path.resolve(process.argv[1]!)}`,
    );
    debugLogger.info(
      `[buildAgentSpawnConfig] args=${JSON.stringify(spawnConfig.args)}`,
    );
    debugLogger.info(
      `[buildAgentSpawnConfig] cwd=${spawnConfig.cwd}, env keys=${Object.keys(env).join(',')}`,
    );

    return spawnConfig;
  }

  // ─── Private: Status & Results ─────────────────────────────────

  private updateAgentStatus(
    agentId: string,
    newStatus: ArenaAgentStatus,
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    const previousStatus = agent.status;
    agent.status = newStatus;

    this.eventEmitter.emit(ArenaEventType.AGENT_STATUS_CHANGE, {
      sessionId: this.requireConfig().sessionId,
      agentId,
      previousStatus,
      newStatus,
      timestamp: Date.now(),
    });

    // Emit AGENT_COMPLETE when agent reaches COMPLETED, CANCELLED, or TERMINATED
    if (
      newStatus === ArenaAgentStatus.COMPLETED ||
      newStatus === ArenaAgentStatus.CANCELLED ||
      newStatus === ArenaAgentStatus.TERMINATED
    ) {
      const result = this.buildAgentResult(agent);

      this.eventEmitter.emit(ArenaEventType.AGENT_COMPLETE, {
        sessionId: this.requireConfig().sessionId,
        agentId,
        result,
        timestamp: Date.now(),
      });

      this.callbacks.onAgentComplete?.(result);
    }
  }

  private buildAgentResult(agent: ArenaAgentState): ArenaAgentResult {
    return {
      agentId: agent.agentId,
      model: agent.model,
      status: agent.status,
      worktree: agent.worktree,
      finalText: agent.accumulatedText || undefined,
      error: agent.error,
      stats: { ...agent.stats },
      startedAt: agent.startedAt,
      endedAt: Date.now(),
    };
  }

  // ─── Private: Arena Session Directory ─────────────────────────

  /**
   * Get the arena session directory for the current session.
   * All status and control files are stored here.
   */
  private getArenaSessionDir(): string {
    if (!this.arenaConfig) {
      throw new Error('Arena config not initialized');
    }
    return GitWorktreeService.getArenaSessionDir(
      this.arenaConfig.sessionId,
      this.config.getAgentsSettings().arena?.worktreeBaseDir,
    );
  }

  // ─── Private: Polling & Control Signals ──────────────────────

  /**
   * Wait for all agents to reach IDLE or TERMINATED state.
   * Returns true if all agents settled, false if timeout was reached.
   */
  private waitForAllAgentsSettled(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const checkSettled = () => {
        for (const agent of this.agents.values()) {
          if (
            agent.status !== ArenaAgentStatus.COMPLETED &&
            agent.status !== ArenaAgentStatus.CANCELLED &&
            agent.status !== ArenaAgentStatus.TERMINATED
          ) {
            return false;
          }
        }
        return true;
      };

      if (checkSettled()) {
        resolve(true);
        return;
      }

      const timeoutHandle = setTimeout(() => {
        clearInterval(pollHandle);
        resolve(false);
      }, timeoutMs);

      // Re-check periodically (piggybacks on the same polling interval)
      const pollHandle = setInterval(() => {
        if (checkSettled()) {
          clearInterval(pollHandle);
          clearTimeout(timeoutHandle);
          resolve(true);
        }
      }, ARENA_POLL_INTERVAL_MS);
    });
  }

  /**
   * Start polling agent status files at a fixed interval.
   */
  private startPolling(): void {
    if (this.pollingInterval) {
      return;
    }

    this.pollingInterval = setInterval(() => {
      this.pollAgentStatuses().catch((error) => {
        debugLogger.error('Error polling agent statuses:', error);
      });
    }, ARENA_POLL_INTERVAL_MS);
  }

  /**
   * Stop the polling interval.
   */
  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  /**
   * Read per-agent status files from `<arenaSessionDir>/agents/` directory.
   * Updates agent stats, emits AGENT_STATS_UPDATE events, and writes a
   * consolidated `status.json` at the arena session root.
   */
  private async pollAgentStatuses(): Promise<void> {
    const sessionDir = this.getArenaSessionDir();
    const agentsDir = path.join(sessionDir, 'agents');
    const consolidatedAgents: Record<string, ArenaStatusFile> = {};

    for (const agent of this.agents.values()) {
      // Only poll agents that are still alive (RUNNING or IDLE)
      if (
        agent.status === ArenaAgentStatus.TERMINATED ||
        agent.status === ArenaAgentStatus.CANCELLED ||
        agent.status === ArenaAgentStatus.INITIALIZING
      ) {
        continue;
      }

      try {
        const statusPath = path.join(
          agentsDir,
          `${safeAgentId(agent.agentId)}.json`,
        );
        const content = await fs.readFile(statusPath, 'utf-8');
        const statusFile = JSON.parse(content) as ArenaStatusFile;

        // Collect for consolidated file
        consolidatedAgents[agent.agentId] = statusFile;

        // Update agent stats from the status file, but preserve locally
        // calculated durationMs (the child process doesn't track it).
        const { durationMs: _childDuration, ...fileStats } = statusFile.stats;
        agent.stats = {
          ...agent.stats,
          ...fileStats,
        };

        // Detect state transitions from the sideband status file
        if (
          statusFile.status === 'completed' &&
          agent.status === ArenaAgentStatus.RUNNING
        ) {
          // Agent finished its task successfully
          agent.stats.durationMs = Date.now() - agent.startedAt;
          this.updateAgentStatus(agent.agentId, ArenaAgentStatus.COMPLETED);
        } else if (
          statusFile.status === 'cancelled' &&
          agent.status === ArenaAgentStatus.RUNNING
        ) {
          // Agent was cancelled by user
          agent.stats.durationMs = Date.now() - agent.startedAt;
          this.updateAgentStatus(agent.agentId, ArenaAgentStatus.CANCELLED);
        } else if (
          statusFile.status === 'error' &&
          agent.status === ArenaAgentStatus.RUNNING
        ) {
          // Agent hit an error
          agent.stats.durationMs = Date.now() - agent.startedAt;
          if (statusFile.error) {
            agent.error = statusFile.error;
          }
          this.updateAgentStatus(agent.agentId, ArenaAgentStatus.TERMINATED);
        } else if (
          statusFile.status === 'running' &&
          agent.status === ArenaAgentStatus.COMPLETED
        ) {
          // Agent received new input and is working again
          this.updateAgentStatus(agent.agentId, ArenaAgentStatus.RUNNING);
        }

        this.callbacks.onAgentStatsUpdate?.(agent.agentId, statusFile.stats);
      } catch (error: unknown) {
        // File may not exist yet (agent hasn't written first status)
        if (isNodeError(error) && error.code === 'ENOENT') {
          continue;
        }
        debugLogger.error(
          `Error reading status for agent ${agent.agentId}:`,
          error,
        );
      }
    }

    // Write consolidated status.json at the arena session root
    if (Object.keys(consolidatedAgents).length > 0) {
      await this.writeConsolidatedStatus(consolidatedAgents);
    }
  }

  /**
   * Merge agent status data into the arena session's config.json.
   * Reads the existing config, adds/updates `updatedAt` and `agents`,
   * then writes back atomically (temp file → rename).
   */
  private async writeConsolidatedStatus(
    agents: Record<string, ArenaStatusFile>,
  ): Promise<void> {
    const sessionDir = this.getArenaSessionDir();
    const configPath = path.join(sessionDir, 'config.json');

    try {
      // Read existing config.json written by GitWorktreeService
      let config: ArenaConfigFile;
      try {
        const content = await fs.readFile(configPath, 'utf-8');
        config = JSON.parse(content) as ArenaConfigFile;
      } catch {
        // If config.json doesn't exist yet, create a minimal one
        const arenaConfig = this.requireConfig();
        config = {
          arenaSessionId: arenaConfig.sessionId,
          sourceRepoPath: arenaConfig.sourceRepoPath,
          worktreeNames: arenaConfig.models.map(
            (m) => m.displayName || m.modelId,
          ),
          createdAt: this.startedAt!,
        };
      }

      // Merge in the agent status data
      config.updatedAt = Date.now();
      config.agents = agents;

      // Atomic write
      const tmpPath = `${configPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
        await fs.rename(tmpPath, configPath);
      } catch (writeError) {
        try {
          await fs.unlink(tmpPath);
        } catch {
          // Ignore cleanup errors
        }
        throw writeError;
      }
    } catch (error) {
      debugLogger.error(
        'Failed to write consolidated status to config.json:',
        error,
      );
    }
  }

  /**
   * Write a control signal to the arena session's control/ directory.
   * The child agent consumes (reads + deletes) this file.
   */
  async sendControlSignal(
    agentId: string,
    type: ArenaControlSignal['type'],
    reason: string,
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      debugLogger.error(
        `Cannot send control signal: agent ${agentId} not found`,
      );
      return;
    }

    const controlSignal: ArenaControlSignal = {
      type,
      reason,
      timestamp: Date.now(),
    };

    const sessionDir = this.getArenaSessionDir();
    const controlDir = path.join(sessionDir, 'control');
    const controlPath = path.join(controlDir, `${safeAgentId(agentId)}.json`);

    try {
      await fs.mkdir(controlDir, { recursive: true });
      await fs.writeFile(
        controlPath,
        JSON.stringify(controlSignal, null, 2),
        'utf-8',
      );
      debugLogger.info(
        `Sent ${type} control signal to agent ${agentId}: ${reason}`,
      );
    } catch (error) {
      debugLogger.error(
        `Failed to send control signal to agent ${agentId}:`,
        error,
      );
    }
  }

  private async collectResults(): Promise<ArenaSessionResult> {
    if (!this.arenaConfig) {
      throw new Error('Arena config not initialized');
    }

    const agents: ArenaAgentResult[] = [];

    for (const agent of this.agents.values()) {
      const result = this.buildAgentResult(agent);

      // Get diff for completed agents (they finished their task)
      if (agent.status === ArenaAgentStatus.COMPLETED) {
        try {
          result.diff = await this.worktreeService.getWorktreeDiff(
            agent.worktree.path,
          );
        } catch (error) {
          debugLogger.error(
            `Failed to get diff for agent ${agent.agentId}:`,
            error,
          );
        }
      }

      agents.push(result);
    }

    const endedAt = Date.now();

    return {
      sessionId: this.arenaConfig.sessionId,
      task: this.arenaConfig.task,
      status: this.sessionStatus,
      agents,
      startedAt: this.startedAt!,
      endedAt,
      totalDurationMs: endedAt - this.startedAt!,
      wasRepoInitialized: this.wasRepoInitialized,
    };
  }
}
