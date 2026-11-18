/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendPromptLedgerRecord,
  type PromptLedgerRecord,
} from '@qwen-code/acp-bridge/promptLedger';
import {
  MAX_RESTART_RECOVERY_ITEMS,
  scanRestartRecoveries,
} from './restart-recovery-scan.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const WINDOW_START = NOW - 60 * 60 * 1000;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeScanRoot(): {
  ledgerPath(sessionId: string): string;
  sessionService: { getPromptLedgerPath(sessionId: string): string };
} {
  const root = mkdtempSync(path.join(tmpdir(), 'restart-recovery-scan-'));
  roots.push(root);
  const ledgerPath = (sessionId: string) =>
    path.join(root, `${sessionId}.ledger.jsonl`);
  return {
    ledgerPath,
    sessionService: { getPromptLedgerPath: ledgerPath },
  };
}

function writeLedger(
  root: ReturnType<typeof makeScanRoot>,
  sessionId: string,
  records: readonly PromptLedgerRecord[],
): string {
  const ledgerPath = root.ledgerPath(sessionId);
  for (const record of records) {
    appendPromptLedgerRecord(ledgerPath, record);
  }
  return ledgerPath;
}

function inFlight(promptId: string, at: number): PromptLedgerRecord {
  return { v: 1, promptId, state: 'in_flight', at };
}

function terminal(
  promptId: string,
  at: number,
  outcome: 'completed' | 'cancelled' | 'error' | 'interrupted',
  code?: string,
): PromptLedgerRecord {
  return {
    v: 1,
    promptId,
    terminal: outcome,
    ...(code === undefined ? {} : { code }),
    at,
  };
}

describe('scanRestartRecoveries', () => {
  it('lists a crash with no terminal as in_flight', () => {
    const root = makeScanRoot();
    writeLedger(root, 'crashed', [inFlight('p1', NOW)]);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['crashed'],
        sinceMs: WINDOW_START,
      }),
    ).toEqual({
      items: [
        {
          sessionId: 'crashed',
          lastActivityAt: new Date(NOW).toISOString(),
          interruption: 'in_flight',
        },
      ],
      truncated: false,
    });
  });

  it.each([
    ['daemon_shutdown', 'daemon_shutdown'],
    ['daemon_lost', 'daemon_lost'],
    [undefined, 'interrupted'],
  ] as const)(
    'lists an interrupted terminal with code %s',
    (code, expected) => {
      const root = makeScanRoot();
      writeLedger(root, 's1', [
        inFlight('p1', NOW - 1000),
        terminal('p1', NOW, 'interrupted', code),
      ]);

      expect(
        scanRestartRecoveries({
          sessionService: root.sessionService,
          sessionIds: ['s1'],
          sinceMs: WINDOW_START,
        }).items,
      ).toEqual([
        {
          sessionId: 's1',
          lastActivityAt: new Date(NOW).toISOString(),
          interruption: expected,
        },
      ]);
    },
  );

  it.each(['completed', 'cancelled', 'error'] as const)(
    'skips a session whose newest prompt ended %s',
    (outcome) => {
      const root = makeScanRoot();
      writeLedger(root, 'settled', [
        inFlight('p1', NOW - 1000),
        terminal('p1', NOW, outcome),
      ]);

      expect(
        scanRestartRecoveries({
          sessionService: root.sessionService,
          sessionIds: ['settled'],
          sinceMs: WINDOW_START,
        }).items,
      ).toEqual([]);
    },
  );

  it('lists a crash whose newest record sits beyond the bounded tail', () => {
    const root = makeScanRoot();
    const records = Array.from({ length: 1500 }, (_, index) =>
      inFlight(`p${index}`, NOW - (1500 - index)),
    );
    writeLedger(root, 'long-ledger', records);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['long-ledger'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([
      {
        sessionId: 'long-ledger',
        lastActivityAt: new Date(NOW - 1).toISOString(),
        interruption: 'in_flight',
      },
    ]);
  });

  it('lists a terminal error caused by a daemon shutdown', () => {
    const root = makeScanRoot();
    writeLedger(root, 'shutdown-error', [
      inFlight('p1', NOW - 1000),
      terminal('p1', NOW, 'error', 'daemon_shutdown'),
    ]);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['shutdown-error'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([
      {
        sessionId: 'shutdown-error',
        lastActivityAt: new Date(NOW).toISOString(),
        interruption: 'daemon_shutdown',
      },
    ]);
  });

  it('skips an unrelated terminal error with a code', () => {
    const root = makeScanRoot();
    writeLedger(root, 'model-error', [
      inFlight('p1', NOW - 1000),
      terminal('p1', NOW, 'error', 'upstream_error'),
    ]);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['model-error'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([]);
  });

  it('uses the newest prompt, not an older interrupted one', () => {
    const root = makeScanRoot();
    writeLedger(root, 'moved-on', [
      inFlight('p1', NOW - 3000),
      terminal('p1', NOW - 2000, 'interrupted', 'daemon_lost'),
      inFlight('p2', NOW - 1000),
      terminal('p2', NOW, 'completed'),
    ]);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['moved-on'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([]);
  });

  it('lists a session whose newest prompt is interrupted after an older clean one', () => {
    const root = makeScanRoot();
    writeLedger(root, 'latest-interrupted', [
      inFlight('p1', NOW - 3000),
      terminal('p1', NOW - 2000, 'completed'),
      inFlight('p2', NOW - 1000),
      terminal('p2', NOW, 'interrupted', 'daemon_shutdown'),
    ]);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['latest-interrupted'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([
      {
        sessionId: 'latest-interrupted',
        lastActivityAt: new Date(NOW).toISOString(),
        interruption: 'daemon_shutdown',
      },
    ]);
  });

  it('skips a missing ledger', () => {
    const root = makeScanRoot();
    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['never-written'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([]);
  });

  it('skips a ledger whose only record is a torn tail', () => {
    const root = makeScanRoot();
    const ledgerPath = root.ledgerPath('torn');
    writeLedger(root, 'torn', []);
    appendFileSync(ledgerPath, '{"v":1,"promptId":"p1","state":"in_fl', 'utf8');

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['torn'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([]);
  });

  it('keeps an earlier valid record when a later tail is torn', () => {
    const root = makeScanRoot();
    const ledgerPath = writeLedger(root, 'torn-after-flight', [
      inFlight('p1', NOW),
    ]);
    appendFileSync(ledgerPath, '{"v":1,"promptId":"p2', 'utf8');

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['torn-after-flight'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([
      {
        sessionId: 'torn-after-flight',
        lastActivityAt: new Date(NOW).toISOString(),
        interruption: 'in_flight',
      },
    ]);
  });

  it('skips a record whose timestamp cannot become an ISO string', () => {
    const root = makeScanRoot();
    writeLedger(root, 'out-of-range', [inFlight('p1', Number.MAX_VALUE)]);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['out-of-range'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([]);
  });

  it('falls back to `interrupted` for an oversized terminal code', () => {
    const root = makeScanRoot();
    writeLedger(root, 'long-code', [
      inFlight('p1', NOW - 1000),
      terminal('p1', NOW, 'interrupted', 'x'.repeat(65)),
    ]);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['long-code'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([
      {
        sessionId: 'long-code',
        lastActivityAt: new Date(NOW).toISOString(),
        interruption: 'interrupted',
      },
    ]);
  });

  it('falls back to `interrupted` for a code with control characters', () => {
    const root = makeScanRoot();
    writeLedger(root, 'bad-code', [
      inFlight('p1', NOW - 1000),
      terminal('p1', NOW, 'interrupted', 'bad\ncode'),
    ]);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['bad-code'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([
      {
        sessionId: 'bad-code',
        lastActivityAt: new Date(NOW).toISOString(),
        interruption: 'interrupted',
      },
    ]);
  });

  it('drops an entry older than the window', () => {
    const root = makeScanRoot();
    writeLedger(root, 'old', [inFlight('p1', WINDOW_START - 1)]);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['old'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([]);
  });

  it('drops a ledger whose mtime is older than the window without reading it', () => {
    const root = makeScanRoot();
    const ledgerPath = writeLedger(root, 'stale', [inFlight('p1', NOW)]);
    const old = new Date(WINDOW_START - 60_000);
    utimesSync(ledgerPath, old, old);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['stale'],
        sinceMs: WINDOW_START,
      }).items,
    ).toEqual([]);
  });

  it('sorts newest first', () => {
    const root = makeScanRoot();
    writeLedger(root, 'older', [inFlight('p1', NOW - 2000)]);
    writeLedger(root, 'newer', [inFlight('p1', NOW)]);
    writeLedger(root, 'middle', [inFlight('p1', NOW - 1000)]);

    expect(
      scanRestartRecoveries({
        sessionService: root.sessionService,
        sessionIds: ['older', 'newer', 'middle'],
        sinceMs: WINDOW_START,
      }).items.map((item) => item.sessionId),
    ).toEqual(['newer', 'middle', 'older']);
  });

  it('truncates beyond the per-workspace cap', () => {
    const root = makeScanRoot();
    const sessionIds = Array.from(
      { length: MAX_RESTART_RECOVERY_ITEMS + 1 },
      (_, index) => `s${index}`,
    );
    for (const [index, sessionId] of sessionIds.entries()) {
      writeLedger(root, sessionId, [inFlight('p1', NOW - index * 1000)]);
    }

    const result = scanRestartRecoveries({
      sessionService: root.sessionService,
      sessionIds,
      sinceMs: WINDOW_START,
    });
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(MAX_RESTART_RECOVERY_ITEMS);
    expect(result.items[0]?.sessionId).toBe('s0');
    expect(result.items.at(-1)?.sessionId).toBe(
      `s${MAX_RESTART_RECOVERY_ITEMS - 1}`,
    );
  });
});
