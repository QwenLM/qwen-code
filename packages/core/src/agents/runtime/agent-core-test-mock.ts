/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared AgentCore mock for spawn-path test suites.
 *
 * Both `InProcessBackend.test.ts` and `TeamManager.model-routing.test.ts`
 * spawn agents through a real InProcessBackend while mocking `AgentCore`
 * to avoid real model calls. The mock must expose the same
 * observable-state accessors AgentInteractive delegates to (getMessages,
 * pendingApprovals, liveOutputs, shellPids, pushMessage, ...) —
 * lifecycle methods like abort() / addMessage() fail on missing
 * accessors. Keeping one factory here means a change to the real
 * AgentCore/AgentInteractive surface is made once instead of
 * synchronized across copies that can silently drift.
 *
 * `vi.mock` factories are hoisted and cannot close over test-file
 * variables, so suites wire this module in with a dynamic import:
 *
 * ```ts
 * vi.mock('<path>/agent-core.js', async () =>
 *   (await import('<path>/agent-core-test-mock.js')).agentCoreMockModule(),
 * );
 * ```
 */

import { vi } from 'vitest';

/**
 * Shared reasoning-loop mock. Suites reset or re-implement it per test;
 * the default resolves one uneventful turn.
 */
export const runReasoningLoopMock = vi.fn().mockResolvedValue({
  text: 'Done',
  terminateMode: null,
  turnsUsed: 1,
});

/** Build the observable mock state one mocked AgentCore instance owns. */
export function createAgentCoreMock(): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const pendingApprovals = new Map<string, unknown>();
  const liveOutputs = new Map<string, unknown>();
  const shellPids = new Map<string, number>();
  const emitter = {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  };
  return {
    subagentId: 'mock-id',
    name: 'mock-agent',
    eventEmitter: emitter,
    stats: {
      start: vi.fn(),
      getSummary: vi.fn().mockReturnValue({}),
    },
    createChat: vi.fn().mockResolvedValue({}),
    prepareTools: vi.fn().mockReturnValue([]),
    runReasoningLoop: runReasoningLoopMock,
    getEventEmitter: vi.fn().mockReturnValue(emitter),
    getExecutionSummary: vi.fn().mockReturnValue({}),
    getMessages: () => messages,
    getPendingApprovals: () => pendingApprovals,
    getLiveOutputs: () => liveOutputs,
    getShellPids: () => shellPids,
    pushMessage: (
      role: string,
      content: string,
      options?: { thought?: boolean; metadata?: Record<string, unknown> },
    ) => {
      const message: Record<string, unknown> = {
        role,
        content,
        timestamp: Date.now(),
      };
      if (options?.thought) message['thought'] = true;
      if (options?.metadata) message['metadata'] = options.metadata;
      messages.push(message);
    },
    setPendingApproval: (callId: string, details: unknown) =>
      pendingApprovals.set(callId, details),
    deletePendingApproval: (callId: string) => pendingApprovals.delete(callId),
    clearPendingApprovals: () => pendingApprovals.clear(),
  };
}

/**
 * Module shape for `vi.mock('<path>/agent-core.js', ...)`: a fresh mock
 * AgentCore instance per construction.
 */
export function agentCoreMockModule(): { AgentCore: unknown } {
  return {
    AgentCore: vi.fn().mockImplementation(() => createAgentCoreMock()),
  };
}

/**
 * Positional AgentCore constructor parameters, destructured by name so a
 * new parameter cannot silently shift assertions onto the wrong slot.
 */
export function destructureAgentCoreCall(call: unknown[]) {
  return {
    name: call[0] as string,
    runtimeContext: call[1] as Record<string, unknown>,
    promptConfig: call[2],
    modelConfig: call[3] as { model?: string },
    runConfig: call[4],
    toolConfig: call[5],
    eventEmitter: call[6],
    hooks: call[7],
    runtimeView: call[8] as
      | {
          contentGenerator: unknown;
          contentGeneratorConfig: { authType?: string; model?: string };
        }
      | undefined,
  };
}

/** Mock ToolRegistry covering the surface spawn paths exercise. */
export function createMockToolRegistry() {
  return {
    getFunctionDeclarations: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    getAllToolNames: vi.fn().mockReturnValue([]),
    registerTool: vi.fn(),
    copyDiscoveredToolsFrom: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    tools: new Map(),
  };
}
