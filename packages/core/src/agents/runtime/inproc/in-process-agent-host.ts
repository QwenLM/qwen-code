/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode, type Config } from '../../../config/config.js';
import type { ContentGenerator } from '../../../core/contentGenerator.js';
import type { ToolRegistry } from '../../../tools/tool-registry.js';
import { createDebugLogger } from '../../../utils/debugLogger.js';
import type {
  AgentExitCallback,
  AgentSpawnConfig,
  InProcessSpawnConfig,
} from '../../backends/types.js';
import { runWithTeammateIdentity } from '../../team/identity.js';
import { AgentCore } from '../agent-core.js';
import {
  AgentEventEmitter,
  AgentEventType,
  type AgentStatusChangeEvent,
} from '../agent-events.js';
import { ContextState } from '../agent-headless.js';
import { AgentInteractive } from '../agent-interactive.js';
import { AgentStatus, isTerminalStatus } from '../agent-types.js';
import { createPerAgentConfig } from './per-agent-config.js';

const debug = createDebugLogger('IN_PROCESS_RUNTIME');

export class InProcessAgentHost {
  private readonly agents = new Map<string, AgentInteractive>();
  private readonly agentContentGenerators = new Map<string, ContentGenerator>();
  private readonly agentRegistries = new Map<string, ToolRegistry>();
  private readonly agentApprovalCleanups = new Map<string, () => void>();
  private exitCallback: AgentExitCallback | null = null;
  private autoApprovalOverrideCount = 0;
  private cleanedUp = false;

  constructor(private readonly runtimeContext: Config) {}

  async start(
    config: AgentSpawnConfig,
    onCreated?: (agent: AgentInteractive) => void,
  ): Promise<AgentInteractive | undefined> {
    const inProcessConfig = config.inProcess;
    if (!inProcessConfig) {
      throw new Error(
        `In-process runtime requires inProcess config for agent ${config.agentId}`,
      );
    }
    if (this.agents.has(config.agentId)) {
      throw new Error(`Agent "${config.agentId}" already exists.`);
    }

    const { promptConfig, modelConfig, runConfig, toolConfig } =
      inProcessConfig.runtimeConfig;
    const runInContext = createRunInContext(inProcessConfig);
    const runWithContext = <T>(fn: () => T): T =>
      runInContext ? runInContext(fn) : fn();
    const eventEmitter = new AgentEventEmitter();
    const perAgent = await runWithContext(() =>
      createPerAgentConfig(
        this.runtimeContext,
        config.agentId,
        config.cwd,
        modelConfig.model,
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
    const lifecycleEmitter = interactive.getEventEmitter();
    this.agents.set(config.agentId, interactive);
    onCreated?.(interactive);

    this.runtimeContext
      .getMonitorRegistry()
      .setAgentNotificationCallback(config.agentId, (_displayText, modelText) =>
        interactive.enqueueMessage(modelText),
      );

    let exitReported = false;
    const reportExit = (status: AgentStatus) => {
      if (exitReported || !isTerminalStatus(status)) return;
      exitReported = true;
      lifecycleEmitter.off(AgentEventType.STATUS_CHANGE, onStatusChange);
      this.releaseAgentResources(config.agentId);
      this.exitCallback?.(
        config.agentId,
        status === AgentStatus.COMPLETED
          ? 0
          : status === AgentStatus.FAILED
            ? 1
            : null,
        null,
      );
    };
    const onStatusChange = (event: AgentStatusChangeEvent) =>
      reportExit(event.newStatus);
    lifecycleEmitter.on(AgentEventType.STATUS_CHANGE, onStatusChange);

    try {
      await runWithContext(() => interactive.start(new ContextState()));
      void interactive.waitForCompletion().then(async () => {
        await Promise.resolve();
        reportExit(interactive.getStatus());
      });
      debug.info(`Spawned in-process agent: ${config.agentId}`);
      return interactive;
    } catch (error) {
      debug.error(
        `Failed to start in-process agent "${config.agentId}":`,
        error,
      );
      reportExit(AgentStatus.FAILED);
      this.agents.delete(config.agentId);
      this.agentContentGenerators.delete(config.agentId);
      return undefined;
    }
  }

  getAgent(agentId: string): AgentInteractive | undefined {
    return this.agents.get(agentId);
  }

  getAgentContentGenerator(agentId: string): ContentGenerator | undefined {
    return this.agentContentGenerators.get(agentId);
  }

  stop(agentId: string): void {
    this.agents.get(agentId)?.abort();
    this.releaseAgentResources(agentId);
  }

  stopAll(): void {
    for (const [agentId, agent] of this.agents) {
      agent.abort();
      this.releaseAgentResources(agentId);
    }
  }

  async dispose(): Promise<void> {
    this.cleanedUp = true;
    for (const agent of this.agents.values()) agent.abort();

    const promises = Array.from(this.agents.values()).map((agent) =>
      agent.waitForCompletion().catch(() => {}),
    );
    let timerId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((resolve) => {
      timerId = setTimeout(resolve, 3000);
    });
    await Promise.race([Promise.allSettled(promises), timeout]);
    clearTimeout(timerId!);

    for (const registry of this.agentRegistries.values()) {
      await registry.stop().catch(() => {});
    }
    this.agentRegistries.clear();
    for (const cleanup of this.agentApprovalCleanups.values()) cleanup();
    this.agentApprovalCleanups.clear();
    this.agents.clear();
    this.agentContentGenerators.clear();
  }

  setOnAgentExit(callback: AgentExitCallback): void {
    this.exitCallback = callback;
  }

  async waitForAll(timeoutMs?: number): Promise<boolean> {
    if (this.cleanedUp) return true;
    const promises = Array.from(this.agents.values()).map((agent) =>
      agent.waitForCompletion(),
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

  getAgentRegistryCount(): number {
    return this.agentRegistries.size;
  }

  private releaseAgentResources(
    agentId: string,
    registry = this.agentRegistries.get(agentId),
  ): void {
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
        debug.error(
          `Failed to stop tool registry for agent "${agentId}":`,
          error,
        );
      });
    }
  }

  private acquireAutoApprovalOverride(): boolean {
    if (this.runtimeContext.getApprovalMode() === ApprovalMode.AUTO)
      return false;
    if (this.autoApprovalOverrideCount === 0) {
      this.runtimeContext
        .getPermissionManager?.()
        ?.stripDangerousRulesForAutoMode();
    }
    this.autoApprovalOverrideCount++;
    return true;
  }

  private releaseAutoApprovalOverride(): void {
    if (this.autoApprovalOverrideCount === 0) return;
    this.autoApprovalOverrideCount--;
    if (
      this.autoApprovalOverrideCount === 0 &&
      this.runtimeContext.getApprovalMode() !== ApprovalMode.AUTO
    ) {
      this.runtimeContext.getPermissionManager?.()?.restoreDangerousRules();
    }
  }
}

function createRunInContext(
  inProcessConfig: InProcessSpawnConfig,
): AgentInteractive['config']['runInContext'] {
  const identity = inProcessConfig.teammateIdentity;
  if (!identity) return undefined;
  return <T>(fn: () => T): T => runWithTeammateIdentity(identity, fn);
}
