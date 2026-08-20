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

  it('stamps the dispatch marker from the sink into the in_flight record', async () => {
    const handle = makeChannel();
    const records: PromptLedgerRecord[] = [];
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      promptLedger: {
        appendSync: (_sessionId, record) => {
          records.push(record);
        },
        transcriptTailUuid: () => 'tail-at-admission',
      },
    });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await bridge.sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hello' }],
        },
        undefined,
        { promptId: 'p-marker' },
      );
      expect(records).toContainEqual({
        v: 1,
        promptId: 'p-marker',
        state: 'in_flight',
        tailUuid: 'tail-at-admission',
        at: expect.any(Number),
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it('keeps admitting when the dispatch marker lookup fails', async () => {
    const handle = makeChannel();
    const records: PromptLedgerRecord[] = [];
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      promptLedger: {
        appendSync: (_sessionId, record) => {
          records.push(record);
        },
        transcriptTailUuid: () => {
          throw new Error('transcript unreadable');
        },
      },
    });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const result = await bridge.sendPrompt(
        session.sessionId,
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'hello' }],
        },
        undefined,
        { promptId: 'p-no-marker' },
      );
      expect(result.stopReason).toBe('end_turn');
      expect(records).toContainEqual({
        v: 1,
        promptId: 'p-no-marker',
        state: 'in_flight',
        at: expect.any(Number),
      });
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

  it('records in_flight for queued admissions and flushes both on shutdown', async () => {
    const handle = makeChannel({
      promptImpl: () => new Promise(() => {}),
    });
    const ledger = recordingLedger();
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      promptLedger: ledger.sink,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const first = bridge.sendPrompt(
      session.sessionId,
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'never resolves' }],
      },
      undefined,
      { promptId: 'p-queued-a' },
    );
    void first.catch(() => undefined);
    const second = bridge.sendPrompt(
      session.sessionId,
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'queued behind' }],
      },
      undefined,
      { promptId: 'p-queued-b' },
    );
    void second.catch(() => undefined);

    // Admission is synchronous (write-ahead): both in_flight records are
    // on the ledger before either prompt settles — the queued one included.
    const inFlight = ledger.records.filter((record) => !('terminal' in record));
    expect(inFlight).toHaveLength(2);
    expect(inFlight.map((record) => record.promptId)).toEqual([
      'p-queued-a',
      'p-queued-b',
    ]);

    await bridge.shutdown();
    await first.catch(() => undefined);
    await second.catch(() => undefined);

    const terminals = terminalRecords(ledger.records);
    expect(terminals.map((record) => record.promptId).sort()).toEqual([
      'p-queued-a',
      'p-queued-b',
    ]);
    for (const terminal of terminals) {
      expect(terminal.terminal).toBe('error');
      expect(terminal.code).toBe('daemon_shutdown');
    }
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
