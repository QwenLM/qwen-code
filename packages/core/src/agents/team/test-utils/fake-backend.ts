/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview FakeBackend — test double for the Backend interface.
 *
 * Creates FakeAgent instances instead of real PTY subprocesses.
 * Implements the full Backend interface with no-op stubs for
 * navigation and screen capture methods.
 */

import type { AnsiOutput } from '../../../utils/terminalSerializer.js';
import {
  DISPLAY_MODE,
  type Backend,
  type AgentSpawnConfig,
  type AgentExitCallback,
} from '../../backends/types.js';
import { isTerminalStatus } from '../../runtime/agent-types.js';
import { AgentStatus } from '../../runtime/agent-types.js';
import { FakeAgent, type FakeAgentScript } from './fake-agent.js';

/**
 * FakeBackend — Backend implementation that creates FakeAgent
 * instances for deterministic testing of multi-agent coordination.
 */
export class FakeBackend implements Backend {
  readonly type = DISPLAY_MODE.IN_PROCESS;

  private readonly agents = new Map<string, FakeAgent>();
  private readonly scripts = new Map<string, FakeAgentScript>();
  private readonly spawnedConfigs = new Map<string, AgentSpawnConfig>();
  private exitCallback: AgentExitCallback | null = null;

  // ─── Test setup ─────────────────────────────────────────────

  /** Pre-register a script for an agent ID. */
  setScript(agentId: string, script: FakeAgentScript): void {
    this.scripts.set(agentId, script);
  }

  // ─── Backend interface ──────────────────────────────────────

  async init(): Promise<void> {
    // Nothing to initialize.
  }

  async spawnAgent(config: AgentSpawnConfig): Promise<void> {
    if (this.agents.has(config.agentId)) {
      throw new Error(`Agent "${config.agentId}" already exists.`);
    }

    this.spawnedConfigs.set(config.agentId, config);

    const script = this.scripts.get(config.agentId) ?? {};
    const name = config.inProcess?.agentName ?? config.agentId;
    const agent = new FakeAgent(config.agentId, name, script);
    this.agents.set(config.agentId, agent);

    await agent.start();

    // Watch for terminal status to fire exit callback.
    void agent.waitForCompletion().then(() => {
      const status = agent.getStatus();
      if (!isTerminalStatus(status)) return;
      const exitCode =
        status === AgentStatus.COMPLETED
          ? 0
          : status === AgentStatus.FAILED
            ? 1
            : null;
      this.exitCallback?.(config.agentId, exitCode, null);
    });
  }

  stopAgent(agentId: string): void {
    this.agents.get(agentId)?.abort();
  }

  stopAll(): void {
    for (const agent of this.agents.values()) {
      agent.abort();
    }
  }

  async cleanup(): Promise<void> {
    this.stopAll();
    this.agents.clear();
    this.scripts.clear();
  }

  setOnAgentExit(callback: AgentExitCallback): void {
    this.exitCallback = callback;
  }

  async waitForAll(timeoutMs?: number): Promise<boolean> {
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

  async waitForAgent(agentId: string, timeoutMs?: number): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    const completion = agent.waitForCompletion();

    if (timeoutMs === undefined) {
      await completion;
      return true;
    }

    let timerId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<'timeout'>((resolve) => {
      timerId = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const result = await Promise.race([
      completion.then(() => 'done' as const),
      timeout,
    ]);

    clearTimeout(timerId!);
    return result === 'done';
  }

  // ─── Navigation & screen capture: no-op stubs ──────────────

  switchTo(_agentId: string): void {}
  switchToNext(): void {}
  switchToPrevious(): void {}
  getActiveAgentId(): string | null {
    return null;
  }
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

  forwardInput(_data: string): boolean {
    return false;
  }

  writeToAgent(agentId: string, data: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.enqueueMessage(data);
    return true;
  }

  // ─── Resize ────────────────────────────────────────────────

  resizeAll(_cols: number, _rows: number): void {}

  // ─── External session ──────────────────────────────────────

  getAttachHint(): string | null {
    return null;
  }

  // ─── Extra: matches InProcessBackend.getAgent() ────────────

  /**
   * Get a FakeAgent by agent ID.
   * Matches InProcessBackend.getAgent() so TeamManager's event
   * bridge works unchanged.
   */
  getAgent(agentId: string): FakeAgent | undefined {
    return this.agents.get(agentId);
  }

  /** Get all spawned agent IDs. */
  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /** Get the spawn config for an agent (for test assertions). */
  getSpawnConfig(agentId: string): AgentSpawnConfig | undefined {
    return this.spawnedConfigs.get(agentId);
  }
}
