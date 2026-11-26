/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionDecision } from './manager/decision/index.js';
import {
  emitPermissionRequested,
  emitPermissionResolved,
} from '../utils/diagnosticInterceptors.js';
import {
  logPermissionRequested,
  logPermissionResolved,
} from './permission-diagnostics.js';
import type { ToolPermissionReason } from '../tools/tool-checkers/checker-reasons.js';

vi.mock('../utils/diagnosticInterceptors.js', () => ({
  emitPermissionRequested: vi.fn(),
  emitPermissionResolved: vi.fn(),
  emitPermissionFailed: vi.fn(),
}));

const context = {
  sessionId: 's-1',
  promptId: 'p-1',
  toolCallId: 'call-1',
  toolName: 'Bash',
  input: { command: 'ls' },
};

function decision(
  over: Partial<PermissionDecision<ToolPermissionReason>>,
): PermissionDecision<ToolPermissionReason> {
  const base: PermissionDecision<ToolPermissionReason> = {
    kind: 'allow',
    decidedBy: 'toolCheck',
    toolName: 'Bash',
    input: { command: 'ls' },
    toolCheck: { kind: 'allow' },
    history: [],
    stages: [],
    toolUseId: 'call-1',
    ...over,
  };
  base.stages = [{ stage: 'toolCheck', verdict: base.kind }];
  return base;
}

describe('permission session diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits permission.requested with the prompt facts', () => {
    logPermissionRequested(context, 'Allow this?', 2);

    expect(emitPermissionRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's-1',
        turnId: 'p-1',
        toolCallId: 'call-1',
        toolName: 'Bash',
        askMessage: 'Allow this?',
        suggestionCount: 2,
      }),
    );
  });

  it('emits permission.resolved from a policy decision', () => {
    logPermissionResolved({
      context,
      source: 'policy',
      decision: decision({}),
      durationMs: 12,
    });

    expect(emitPermissionResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'policy',
        allowed: true,
        decisionBehavior: 'allow',
        durationMs: 12,
      }),
    );
  });

  it('carries the ask wording and attribution into resolved', () => {
    const reason: ToolPermissionReason = {
      message: 'Dangerous command',
      attribution: { type: 'other', reason: 'no rule' },
      decisionPoint: 'shell.no_match.ask',
    };
    logPermissionResolved({
      context,
      source: 'user',
      decision: decision({ kind: 'deny', decidedBy: 'ask', reason }),
      outcome: 'user',
    });

    expect(emitPermissionResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'user',
        allowed: false,
        outcome: 'user',
        reason: 'Dangerous command',
        decisionBehavior: 'deny',
      }),
    );
  });

  it('stays silent without a context', () => {
    logPermissionRequested(undefined, 'x', 0);
    logPermissionResolved({
      context: undefined,
      source: 'policy',
      decision: decision({}),
    });
    expect(emitPermissionRequested).not.toHaveBeenCalled();
    expect(emitPermissionResolved).not.toHaveBeenCalled();
  });
});
