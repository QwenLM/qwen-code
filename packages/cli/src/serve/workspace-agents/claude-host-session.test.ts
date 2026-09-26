/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { runClaudeHostTurn } from './claude-host-session.js';
import type { AgentTurnUpdate } from './stream-agent-turn.js';

// A scripted ACP agent standing in for claude-agent-acp.
const fixture = String.raw`
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
const scenario = process.argv[1];
if (scenario === 'ignore-term') process.on('SIGTERM', () => {});
let mode;
let connection;
const send = (update) => connection.sessionUpdate({ sessionId: 's', update });
connection = new AgentSideConnection(() => ({
  initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
  newSession: async () => ({
    sessionId: 's',
    modes: {
      currentModeId: 'default',
      availableModes: scenario === 'no-plan'
        ? [{ id: 'default', name: 'Ask' }, { id: 'acceptEdits', name: 'Edits' }]
        : [{ id: 'default', name: 'Ask' }, { id: 'plan', name: 'Plan' }],
    },
  }),
  setSessionMode: async (params) => { mode = params.modeId; return {}; },
  authenticate: async () => ({}),
  cancel: async () => {},
  prompt: async () => {
    if (scenario === 'ignore-term') {
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(process.pid) } });
      await new Promise(() => {});
    }
    await send({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.ts', status: 'pending' });
    const answer = await connection.requestPermission({
      sessionId: 's',
      toolCall: { toolCallId: 't1', title: 'Edit a.ts' },
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
    const chosen = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled';
    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'MODE:' + mode + ' PERMISSION:' + chosen } });
    return { stopReason: 'end_turn' };
  },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`;

const command = (scenario: string) =>
  [process.execPath, '--input-type=module', '-e', fixture, scenario] as const;

describe.skipIf(process.platform === 'win32')('runClaudeHostTurn', () => {
  it('runs in plan mode, refuses every permission, and returns the reply', async () => {
    const updates: AgentTurnUpdate[] = [];
    const reply = await runClaudeHostTurn({
      cwd: process.cwd(),
      prompt: 'Explain a.ts',
      signal: new AbortController().signal,
      onUpdate: (update) => updates.push(update),
      command: command('ok'),
    });

    expect(reply).toBe('MODE:plan PERMISSION:no');
    expect(updates.findLast((update) => update.steps)?.steps).toEqual([
      { id: 't1', title: 'Edit a.ts', status: 'failed' },
    ]);
  });

  it('refuses to run an agent that offers no plan mode', async () => {
    await expect(
      runClaudeHostTurn({
        cwd: process.cwd(),
        prompt: 'Explain a.ts',
        signal: new AbortController().signal,
        onUpdate: () => {},
        command: command('no-plan'),
      }),
    ).rejects.toThrow(/no plan mode/);
  });

  it('cancels a running adapter that ignores SIGTERM', async () => {
    const controller = new AbortController();
    let pid: number | undefined;
    const turn = runClaudeHostTurn({
      cwd: process.cwd(),
      prompt: 'Wait until cancelled',
      signal: controller.signal,
      command: command('ignore-term'),
      onUpdate: (update) => {
        if (update.outputText) {
          pid = Number(update.outputText);
          controller.abort();
        }
      },
    });
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      if (pid) process.kill(-pid, 'SIGKILL');
    }, 5000);
    try {
      await expect(turn).rejects.toThrow(/SIGKILL|closed/i);
      expect(timedOut).toBe(false);
      expect(pid).toBeTypeOf('number');
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      clearTimeout(watchdog);
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  }, 10000);
});
