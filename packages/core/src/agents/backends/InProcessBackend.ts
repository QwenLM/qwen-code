/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { ContentGenerator } from '../../core/contentGenerator.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import type { AnsiOutput } from '../../utils/terminalSerializer.js';
import { InProcessAgentHost } from '../runtime/inproc/in-process-agent-host.js';
import type { AgentInteractive } from '../runtime/agent-interactive.js';
import type { AgentExitCallback, AgentSpawnConfig, Backend } from './types.js';
import { DISPLAY_MODE } from './types.js';

const debug = createDebugLogger('IN_PROCESS_BACKEND');

/**
 * Legacy display adapter used by Arena until Stage 3. Team coordination uses
 * InProcessRuntime directly and does not depend on this surface.
 */
export class InProcessBackend implements Backend {
  readonly type = DISPLAY_MODE.IN_PROCESS;

  private readonly host: InProcessAgentHost;
  private readonly agentOrder: string[] = [];
  private activeAgentId: string | null = null;

  constructor(runtimeContext: Config) {
    this.host = new InProcessAgentHost(runtimeContext);
  }

  async init(): Promise<void> {
    debug.info('InProcessBackend initialized');
  }

  async spawnAgent(config: AgentSpawnConfig): Promise<void> {
    if (!config.inProcess) {
      throw new Error(
        `InProcessBackend requires inProcess config for agent ${config.agentId}`,
      );
    }
    const agent = await this.host.start(config);
    if (!agent) return;
    this.agentOrder.push(config.agentId);
    this.activeAgentId ??= config.agentId;
  }

  stopAgent(agentId: string): void {
    this.host.stop(agentId);
    debug.info(`Stopped agent: ${agentId}`);
  }

  stopAll(): void {
    this.host.stopAll();
    debug.info('Stopped all in-process agents');
  }

  async cleanup(): Promise<void> {
    await this.host.dispose();
    this.agentOrder.length = 0;
    this.activeAgentId = null;
    debug.info('InProcessBackend cleaned up');
  }

  setOnAgentExit(callback: AgentExitCallback): void {
    this.host.setOnAgentExit(callback);
  }

  waitForAll(timeoutMs?: number): Promise<boolean> {
    return this.host.waitForAll(timeoutMs);
  }

  switchTo(agentId: string): void {
    if (this.host.getAgent(agentId)) this.activeAgentId = agentId;
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

  forwardInput(data: string): boolean {
    return this.activeAgentId
      ? this.writeToAgent(this.activeAgentId, data)
      : false;
  }

  writeToAgent(agentId: string, data: string): boolean {
    const agent = this.host.getAgent(agentId);
    if (!agent) return false;
    agent.enqueueMessage(data);
    return true;
  }

  resizeAll(_cols: number, _rows: number): void {}

  getAttachHint(): string | null {
    return null;
  }

  getAgent(agentId: string): AgentInteractive | undefined {
    return this.host.getAgent(agentId);
  }

  getAgentContentGenerator(agentId: string): ContentGenerator | undefined {
    return this.host.getAgentContentGenerator(agentId);
  }

  getAgentRegistryCount(): number {
    return this.host.getAgentRegistryCount();
  }

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
