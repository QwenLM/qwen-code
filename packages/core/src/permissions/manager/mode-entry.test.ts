/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionManager } from './permission-manager.js';
import { AutoClassifier } from '../permission-modes/auto/auto-classifier.js';
import { LlmAutoJudge } from '../permission-modes/auto/auto-judge.js';
import { createEmptyToolLookup } from '../permission-modes/auto/classifier.js';
import { createEagerMcpToolChecker } from '../config-checker-deps.js';
import { createUserMessage } from '../../protocol/transcript/conversions.js';
import type { SessionMcpManager } from '../../mcp/sessionMcpManager/sessionMcpManager.js';
import type { LazyMcpToolEntry } from '../../mcp/sessionMcpManager/types.js';
import type { SessionPermissionManager } from './session-permission-manager.js';
import type { AskHandleResult, PermissionMode } from './decision/index.js';

class LlmClassifier extends AutoClassifier {
  protected override readJevSettings() {
    return { classifier: 'llm' as const };
  }
}
class Manager extends PermissionManager {
  override initialize() {
    super.initialize();
    this.autoClassifier = new LlmClassifier();
  }
}

const name = 'mcp__files__inspect';
const identity = { serverName: 'files', toolName: 'inspect' };
const sessions: SessionPermissionManager[] = [];
const managers: Manager[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  for (const manager of managers.splice(0)) await manager.dispose();
});

function setup(
  entry: 'injected' | 'registered' | 'lazy',
  mode: PermissionMode,
) {
  const manager = new Manager();
  manager.initialize();
  managers.push(manager);
  const invoke = vi.fn(async () => ({ shouldBlock: false, reason: 'safe' }));
  // Only tool discovery is simulated; checker, Permission, View and LLM Judge are real.
  const tool = {
    ...identity,
    qualifiedName: name,
    tool: {},
  } as LazyMcpToolEntry;
  const mcp = {
    getInjectedMcpTools: () => ({ tools: entry === 'injected' ? [tool] : [] }),
    getLazyDiscoveredMcpToolByQualifiedName: () => tool,
    onToolListChange: () => () => {},
  } as unknown as SessionMcpManager;
  if (entry === 'registered') {
    manager.registerChecker(name, createEagerMcpToolChecker(identity));
  }
  const session = manager.createSessionPermissionManager({
    getSessionId: () => 'mode-entry',
    getWorkingDir: () => '/repo',
    flagSettings: {
      initialMode: mode,
      rules: { allow: {}, deny: {}, ask: {} },
      additionalDirectories: [],
    },
    sessionMcpManager: mcp,
    createMcpToolChecker: (entry) => createEagerMcpToolChecker(entry),
    createSessionJudges: () => ({ llm: new LlmAutoJudge(invoke) }),
    classifierInputs: {
      getMessages: () => [createUserMessage('parent-only')],
      getToolLookup: createEmptyToolLookup,
    },
  });
  sessions.push(session);
  const ask = vi.fn(
    async (): Promise<AskHandleResult> => ({ kind: 'rejected' }),
  );
  session.setAskHandler(ask);
  const resolve = vi.spyOn(manager.getModes()[mode], 'resolve');
  return { session, invoke, ask, resolve };
}

describe.each(['injected', 'registered', 'lazy'] as const)(
  '%s MCP mode entry',
  (entry) => {
    it.each(['default', 'auto', 'yolo', 'dontAsk', 'acceptEdits'] as const)(
      '%s goes through Permission exactly once',
      async (mode) => {
        const { session, invoke, ask, resolve } = setup(entry, mode);
        const decision = await session.check(
          {
            toolName: entry === 'lazy' ? 'mcp_call' : name,
            input: entry === 'lazy' ? { toolName: name, arguments: {} } : {},
            toolUseId: 'mcp-1',
            agentId: 'child',
          },
          { messages: [createUserMessage('child-only')] },
        );
        expect(decision.kind).toBe(
          mode === 'auto' || mode === 'yolo' ? 'allow' : 'deny',
        );
        expect(resolve).toHaveBeenCalledOnce();
        expect(ask).toHaveBeenCalledTimes(
          mode === 'default' || mode === 'acceptEdits' ? 1 : 0,
        );
        if (mode === 'auto') {
          expect(invoke).toHaveBeenCalledOnce();
          expect(JSON.stringify(invoke.mock.calls)).toContain('child-only');
          expect(JSON.stringify(invoke.mock.calls)).not.toContain(
            'parent-only',
          );
        } else {
          expect(invoke).not.toHaveBeenCalled();
        }
      },
    );

    it.each([false, true])(
      'does not repeat Auto after manual fallback (amended=%s)',
      async (amended) => {
        const { session, invoke, ask, resolve } = setup(entry, 'auto');
        invoke.mockRejectedValue(new Error('offline'));
        let callsAtApproval = 0;
        const input = entry === 'lazy' ? { toolName: name, arguments: {} } : {};
        ask.mockImplementation(async () => {
          callsAtApproval = invoke.mock.calls.length;
          return {
            kind: 'approved',
            ...(amended ? { input: { ...input } } : {}),
          };
        });
        const result = await session.check({
          toolName: entry === 'lazy' ? 'mcp_call' : name,
          input,
          toolUseId: 'fallback-approval',
          agentId: 'child',
        });
        expect(result.kind).toBe('allow');
        expect(ask).toHaveBeenCalledOnce();
        expect(resolve).toHaveBeenCalledOnce();
        expect(callsAtApproval).toBeGreaterThan(0);
        expect(invoke).toHaveBeenCalledTimes(callsAtApproval);
      },
    );

    it('keeps explicit denials ahead of mode resolution', async () => {
      const { session, invoke, ask, resolve } = setup(entry, 'auto');
      session.setRules({ allow: {}, deny: { session: [name] }, ask: {} });
      const decision = await session.check({
        toolName: name,
        input: {},
        toolUseId: 'denied',
      });
      expect(decision.kind).toBe('deny');
      expect(resolve).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(ask).not.toHaveBeenCalled();
    });
  },
);
