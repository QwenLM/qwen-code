/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import type { PromptLedgerSink } from './bridgeOptions.js';
import type { PromptLedgerRecord } from './prompt-ledger.js';

function recordingLedger(): {
  records: PromptLedgerRecord[];
  sink: PromptLedgerSink;
} {
  const records: PromptLedgerRecord[] = [];
  return {
    records,
    sink: {
      appendSync: (_sessionId, record) => {
        records.push(record);
      },
    },
  };
}

function terminalRecords(records: readonly PromptLedgerRecord[]) {
  return records.filter(
    (record): record is Extract<PromptLedgerRecord, { terminal: string }> =>
      'terminal' in record,
  );
}

describe('bridge prompt terminal ledger writes', () => {
  it('appends in_flight at admission and completed at settle', async () => {
    const handle = makeChannel();
    const ledger = recordingLedger();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      promptLedger: ledger.sink,
    });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const running = bridge.sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hello' }],
        },
        undefined,
        { promptId: 'p-ledger-1' },
      );
      const inFlight = ledger.records.filter(
        (record) => !('terminal' in record),
      );
      expect(inFlight).toHaveLength(1);
      expect(inFlight[0]?.promptId).toBe('p-ledger-1');

      const result = await running;
      expect(result.stopReason).toBe('end_turn');
      expect(terminalRecords(ledger.records)).toEqual([
        {
          v: 1,
          promptId: 'p-ledger-1',
          terminal: 'completed',
          stopReason: 'end_turn',
          at: expect.any(Number),
        },
      ]);
    } finally {
      await bridge.shutdown();
    }
  });

  it('persists the daemon_shutdown error terminal when shutdown flushes a pending prompt', async () => {
    const handle = makeChannel({
      promptImpl: () => new Promise(() => {}),
    });
    const ledger = recordingLedger();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      promptLedger: ledger.sink,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const running = bridge.sendPrompt(
      session.sessionId,
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'long work' }],
      },
      undefined,
      { promptId: 'p-ledger-2' },
    );
    void running.catch(() => undefined);
    await bridge.shutdown();
    await running.catch(() => undefined);
    expect(terminalRecords(ledger.records)).toEqual([
      {
        v: 1,
        promptId: 'p-ledger-2',
        terminal: 'error',
        code: 'daemon_shutdown',
        at: expect.any(Number),
      },
    ]);
  });

  it('maps a cancelled stopReason to a cancelled terminal record', async () => {
    const handle = makeChannel({
      promptImpl: () => ({ stopReason: 'cancelled' }),
    });
    const ledger = recordingLedger();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      promptLedger: ledger.sink,
    });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await bridge.sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'stop early' }],
        },
        undefined,
        { promptId: 'p-ledger-3' },
      );
      expect(terminalRecords(ledger.records)).toEqual([
        {
          v: 1,
          promptId: 'p-ledger-3',
          terminal: 'cancelled',
          at: expect.any(Number),
        },
      ]);
    } finally {
      await bridge.shutdown();
    }
  });

  it('keeps prompt execution working when the ledger sink throws', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      promptLedger: {
        appendSync: () => {
          throw new Error('disk full');
        },
      },
    });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const result = await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      });
      expect(result.stopReason).toBe('end_turn');
    } finally {
      await bridge.shutdown();
    }
  });

  it('writes nothing when no ledger sink is configured', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
    });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await bridge.sendPrompt(session.sessionId, {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      });
      // No assertion target beyond "does not throw"; the interesting
      // guarantee is that omitting the sink is valid, exercised by every
      // other bridge test that never configures one.
      expect(bridge.sessionCount).toBe(1);
    } finally {
      await bridge.shutdown();
    }
  });
});
