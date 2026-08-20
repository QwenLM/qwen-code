/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appendPromptLedgerRecord,
  danglingInFlightPromptIds,
  isPromptLedgerTerminalRecord,
  readPromptLedgerRecords,
  recentPromptTerminalRecords,
  type PromptLedgerRecord,
} from './prompt-ledger.js';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'prompt-ledger-test-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function ledgerPath(name: string): string {
  return path.join(tmpRoot, `${name}.ledger.jsonl`);
}

describe('appendPromptLedgerRecord + readPromptLedgerRecords', () => {
  it('round-trips the in_flight dispatch marker, dropping invalid ones', () => {
    const filePath = ledgerPath('marker');
    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p1',
      state: 'in_flight',
      tailUuid: 'rec-tail',
      at: 1,
    });
    // A non-string marker on disk must be dropped, not fatal.
    writeFileSync(
      filePath,
      `${JSON.stringify({ v: 1, promptId: 'p2', state: 'in_flight', tailUuid: 42, at: 2 })}\n`,
      { flag: 'a' },
    );
    expect(readPromptLedgerRecords(filePath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', tailUuid: 'rec-tail', at: 1 },
      { v: 1, promptId: 'p2', state: 'in_flight', at: 2 },
    ]);
  });

  it('round-trips in_flight and terminal records in order', () => {
    const filePath = ledgerPath('roundtrip');
    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p1',
      state: 'in_flight',
      at: 1,
    });
    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p1',
      terminal: 'completed',
      stopReason: 'end_turn',
      at: 2,
    });
    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p2',
      terminal: 'error',
      code: 'daemon_shutdown',
      at: 3,
    });
    expect(readPromptLedgerRecords(filePath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'completed',
        stopReason: 'end_turn',
        at: 2,
      },
      {
        v: 1,
        promptId: 'p2',
        terminal: 'error',
        code: 'daemon_shutdown',
        at: 3,
      },
    ]);
  });

  it('creates the parent directory on first append', () => {
    const filePath = path.join(
      tmpRoot,
      'nested',
      'dir',
      'created',
      'session.ledger.jsonl',
    );
    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p1',
      state: 'in_flight',
      at: 1,
    });
    expect(readPromptLedgerRecords(filePath)).toHaveLength(1);
  });

  it('creates the ledger owner-only, not umask-default', () => {
    if (process.platform === 'win32') return; // POSIX mode bits only.
    // The ledger holds per-prompt activity metadata and must follow the
    // transcript's 0o600 convention at creation instead of inheriting the
    // umask default (typically 0o644 on shared hosts).
    const filePath = path.join(tmpRoot, 'perm', 'session.ledger.jsonl');
    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p1',
      state: 'in_flight',
      at: 1,
    });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('treats a missing file as an empty ledger', () => {
    expect(readPromptLedgerRecords(ledgerPath('missing'))).toEqual([]);
  });

  it('drops a torn tail and malformed lines, keeps valid ones', () => {
    const filePath = ledgerPath('torn-tail');
    writeFileSync(
      filePath,
      [
        JSON.stringify({ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }),
        '{"v":1,"promptId":"p2","state":"in_fli', // torn mid-append
        JSON.stringify({
          v: 1,
          promptId: 'p2',
          terminal: 'completed',
          at: 2,
        }),
        'not json at all',
        JSON.stringify({ v: 2, promptId: 'p3', at: 3 }), // unknown version
        JSON.stringify({
          v: 1,
          promptId: 'p4',
          terminal: 'bogus',
          at: 4,
        }), // unknown terminal state
        JSON.stringify({ v: 1, promptId: 42, state: 'in_flight', at: 5 }), // bad id
        '',
      ].join('\n'),
      'utf8',
    );
    const records = readPromptLedgerRecords(filePath);
    expect(records.map((record) => record.promptId)).toEqual(['p1', 'p2']);
  });

  it('seals a torn tail so the next appended record survives', () => {
    const filePath = ledgerPath('torn-tail-seal');
    // Production crash shape: a complete record, then an append torn
    // mid-line (no trailing newline).
    writeFileSync(
      filePath,
      `${JSON.stringify({ v: 1, promptId: 'p1', state: 'in_flight', at: 1 })}\n{"v":1,"promptId":"p2","state":"in_fli`,
      'utf8',
    );

    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p2',
      terminal: 'completed',
      at: 2,
    });

    // Without the seal the new record would fuse with the torn fragment
    // into one unparseable line and BOTH would be lost; with it the torn
    // fragment stays droppable and p2's complete record survives.
    const records = readPromptLedgerRecords(filePath);
    expect(records).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p2', terminal: 'completed', at: 2 },
    ]);
  });

  it('does not add a seal when the tail is already newline-terminated', () => {
    const filePath = ledgerPath('torn-tail-clean');
    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p1',
      state: 'in_flight',
      at: 1,
    });

    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p2',
      terminal: 'completed',
      at: 2,
    });

    // No stray blank lines: exactly two records, in order. Assert the raw
    // layout too — the reader skips blank lines, so it cannot see a stray
    // seal newline; a regression that always appends one would keep every
    // read-based assertion green.
    expect(statSync(filePath).size).toBe(
      JSON.stringify({ v: 1, promptId: 'p1', state: 'in_flight', at: 1 })
        .length +
        1 +
        JSON.stringify({ v: 1, promptId: 'p2', terminal: 'completed', at: 2 })
          .length +
        1,
    );
    expect(readPromptLedgerRecords(filePath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p2', terminal: 'completed', at: 2 },
    ]);
  });
});

describe('readPromptLedgerRecords tail window', () => {
  it('returns all records when the file fits inside the window', () => {
    const filePath = ledgerPath('tail-fits');
    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p1',
      state: 'in_flight',
      at: 1,
    });
    appendPromptLedgerRecord(filePath, {
      v: 1,
      promptId: 'p1',
      terminal: 'completed',
      at: 2,
    });

    expect(readPromptLedgerRecords(filePath, { tailBytes: 4096 })).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p1', terminal: 'completed', at: 2 },
    ]);
  });

  it('reads only the trailing window and drops the torn first line', () => {
    const filePath = ledgerPath('tail-window');
    const lines: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      lines.push(
        `${JSON.stringify({
          v: 1,
          promptId: `p${i}`,
          state: 'in_flight',
          at: i,
        })}\n`,
      );
    }
    writeFileSync(filePath, lines.join(''), 'utf8');
    const lineLength = lines[0]?.length ?? 0;
    const fileSize = statSync(filePath).size;
    expect(fileSize).toBe(lineLength * 6);

    // The window starts 10 bytes into p3's line (torn) and must still yield
    // the two fully-contained trailing records.
    const tailBytes = lineLength * 2 + 10;
    expect(readPromptLedgerRecords(filePath, { tailBytes })).toEqual([
      { v: 1, promptId: 'p4', state: 'in_flight', at: 4 },
      { v: 1, promptId: 'p5', state: 'in_flight', at: 5 },
    ]);
  });

  it('drops the first window line even when the window starts on a line boundary', () => {
    const filePath = ledgerPath('tail-window-aligned');
    const lines: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      lines.push(
        `${JSON.stringify({
          v: 1,
          promptId: `p${i}`,
          state: 'in_flight',
          at: i,
        })}\n`,
      );
    }
    writeFileSync(filePath, lines.join(''), 'utf8');
    const lineLength = lines[0]?.length ?? 0;

    // The window aligns exactly with p2's line start; p2 is dropped anyway
    // per the documented "always drop the first window line" contract.
    expect(
      readPromptLedgerRecords(filePath, { tailBytes: lineLength * 2 }),
    ).toEqual([{ v: 1, promptId: 'p3', state: 'in_flight', at: 3 }]);
  });
});

describe('danglingInFlightPromptIds', () => {
  it('reports prompts whose latest record is still in_flight', () => {
    const records: PromptLedgerRecord[] = [
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p2', state: 'in_flight', at: 2 },
      { v: 1, promptId: 'p1', terminal: 'completed', at: 3 },
      { v: 1, promptId: 'p3', state: 'in_flight', at: 4 },
    ];
    expect(danglingInFlightPromptIds(records)).toEqual(['p2', 'p3']);
  });

  it('keeps first-appearance order and drops settled prompts', () => {
    const records: PromptLedgerRecord[] = [
      { v: 1, promptId: 'later', state: 'in_flight', at: 2 },
      { v: 1, promptId: 'first', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'later', terminal: 'error', code: 'x', at: 3 },
    ];
    expect(danglingInFlightPromptIds(records)).toEqual(['first']);
  });

  it('returns empty for an empty ledger', () => {
    expect(danglingInFlightPromptIds([])).toEqual([]);
  });
});

describe('recentPromptTerminalRecords', () => {
  it('filters to terminals and keeps file order', () => {
    const records: PromptLedgerRecord[] = [
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p1', terminal: 'completed', at: 2 },
      { v: 1, promptId: 'p2', state: 'in_flight', at: 3 },
      {
        v: 1,
        promptId: 'p2',
        terminal: 'interrupted',
        code: 'daemon_lost',
        at: 4,
      },
    ];
    const terminals = recentPromptTerminalRecords(records);
    expect(terminals.map((record) => record.promptId)).toEqual(['p1', 'p2']);
    expect(isPromptLedgerTerminalRecord(terminals[0])).toBe(true);
  });

  it('returns only the trailing limit records', () => {
    const records: PromptLedgerRecord[] = [];
    for (let i = 0; i < 70; i += 1) {
      records.push({
        v: 1,
        promptId: `p${i}`,
        state: 'in_flight',
        at: i,
      });
      records.push({
        v: 1,
        promptId: `p${i}`,
        terminal: 'completed',
        at: i + 100,
      });
    }
    const terminals = recentPromptTerminalRecords(records);
    expect(terminals).toHaveLength(64);
    expect(terminals[0]?.promptId).toBe('p6');
    expect(terminals[63]?.promptId).toBe('p69');
  });
});
