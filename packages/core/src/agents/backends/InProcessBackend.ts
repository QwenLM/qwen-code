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
import { AUTH_ENV_MAPPINGS } from '../../models/constants.js';
import { AgentStatus } from '../runtime/agent-types.js';
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
import { WorkspaceContext } from '../../utils/workspaceContext.js';
import { FileDiscoveryService } from '../../services/fileDiscoveryService.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';

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
    const agentContext = await createPerAgentConfig(
      this.runtimeContext,
      config.cwd,
      inProcessConfig.runtimeConfig.modelConfig.model,
      inProcessConfig.authOverrides,
    );

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

      // Watch for completion and fire exit callback
      void interactive.waitForCompletion().then(() => {
        const status = interactive.getStatus();
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
    // Wait briefly for loops to settle
    const promises = Array.from(this.agents.values()).map((a) =>
      a.waitForCompletion().catch(() => {}),
    );
    await Promise.allSettled(promises);

    // Stop per-agent tool registries so tools like TaskTool can release
    // listeners registered on shared managers (e.g. SubagentManager).
    for (const registry of this.agentRegistries) {
      await registry.stop().catch(() => {});
    }
    this.agentRegistries.length = 0;

    this.agents.clear();
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
 *   (so .qwenignore checks resolve against the agent's worktree)
 * - `getToolRegistry()` → per-agent tool registry with core tools bound to
 *   the agent Config (so tools resolve paths against the agent's worktree)
 * - `getContentGenerator()` / `getContentGeneratorConfig()` / `getAuthType()`
 *   → per-agent ContentGenerator when `authOverrides` is provided, enabling
 *   agents to target different model providers in the same Arena session
 *
 * Uses prototypal delegation so all other Config methods/properties resolve
 * against the original instance transparently.
 */
async function createPerAgentConfig(
  base: Config,
  cwd: string,
  modelId?: string,
  authOverrides?: InProcessSpawnConfig['authOverrides'],
): Promise<Config> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const override = Object.create(base) as any;

  override.getWorkingDir = () => cwd;
  override.getTargetDir = () => cwd;
  override.getProjectRoot = () => cwd;

  const agentWorkspace = new WorkspaceContext(cwd);
  override.getWorkspaceContext = () => agentWorkspace;

  const agentFileService = new FileDiscoveryService(cwd);
  override.getFileService = () => agentFileService;

  // Build a per-agent tool registry: core tools are constructed with
  // the per-agent Config so they resolve paths against cwd. Discovered
  // (MCP/command) tools are copied from the parent registry as-is.
  const agentRegistry: ToolRegistry = await override.createToolRegistry(
    undefined,
    { skipDiscovery: true },
  );
  agentRegistry.copyDiscoveredToolsFrom(base.getToolRegistry());
  override.getToolRegistry = () => agentRegistry;

  // Build a per-agent ContentGenerator when auth overrides are provided.
  // This enables Arena agents to use different providers (OpenAI, Anthropic,
  // Gemini, etc.) than the parent process.
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

  return override as Config;
}

/**
 * Build a ContentGeneratorConfig for a per-agent ContentGenerator.
 * Inherits operational settings (timeout, retries, proxy, sampling, etc.)
 * from the parent's config and overlays the agent-specific auth fields.
 *
 * For cross-provider agents the parent's API key / base URL are invalid,
 * so we resolve credentials from the provider-specific environment
 * variables (e.g. ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL). This mirrors
 * what a PTY subprocess does during its own initialization.
 */
function buildAgentContentGeneratorConfig(
  base: Config,
  modelId: string | undefined,
  authOverrides: NonNullable<InProcessSpawnConfig['authOverrides']>,
): ContentGeneratorConfig {
  const parentConfig = base.getContentGeneratorConfig();
  const sameProvider = authOverrides.authType === parentConfig.authType;

  const resolvedApiKey = resolveCredentialField(
    authOverrides.apiKey,
    sameProvider ? parentConfig.apiKey : undefined,
    authOverrides.authType,
    'apiKey',
  );

  const resolvedBaseUrl = resolveCredentialField(
    authOverrides.baseUrl,
    sameProvider ? parentConfig.baseUrl : undefined,
    authOverrides.authType,
    'baseUrl',
  );

  return {
    ...parentConfig,
    model: modelId ?? parentConfig.model,
    authType: authOverrides.authType as AuthType,
    apiKey: resolvedApiKey,
    baseUrl: resolvedBaseUrl,
  };
}

/**
 * Resolve a credential field (apiKey or baseUrl) with the following
 * priority: explicit override → same-provider parent value → env var.
 */
function resolveCredentialField(
  explicitValue: string | undefined,
  inheritedValue: string | undefined,
  authType: string,
  field: 'apiKey' | 'baseUrl',
): string | undefined {
  if (explicitValue) return explicitValue;
  if (inheritedValue) return inheritedValue;

  const envMapping =
    AUTH_ENV_MAPPINGS[authType as keyof typeof AUTH_ENV_MAPPINGS];
  if (!envMapping) return undefined;

  for (const envKey of envMapping[field]) {
    const value = process.env[envKey];
    if (value) return value;
  }
  return undefined;
}
