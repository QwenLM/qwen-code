/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { SessionService, type ChatRecord } from '@qwen-code/qwen-code-core';
import {
  appendPromptLedgerRecord,
  readPromptLedgerRecords,
  type PromptLedgerRecord,
} from '@qwen-code/acp-bridge/promptLedger';
import {
  createPromptLedgerSink,
  readRecentPromptTerminals,
  reconcileDanglingPromptTerminals,
  withPromptTerminals,
} from './prompt-terminal-ledger.js';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'prompt-terminals-test-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface Fixture {
  workspaceDir: string;
  runtimeBaseDir: string;
  sessionService: SessionService;
  sessionId: string;
  transcriptPath: string;
  ledgerPath: string;
}

function makeFixture(): Fixture {
  const workspaceDir = path.join(tmpRoot, randomUUID());
  mkdirSync(workspaceDir, { recursive: true });
  const runtimeBaseDir = path.join(tmpRoot, randomUUID());
  const sessionService = new SessionService(workspaceDir, {
    runtimeBaseDir,
  });
  const sessionId = randomUUID();
  const ledgerPath = sessionService.getPromptLedgerPath(sessionId);
  const transcriptPath = path.join(
    path.dirname(ledgerPath),
    `${sessionId}.jsonl`,
  );
  return {
    workspaceDir,
    runtimeBaseDir,
    sessionService,
    sessionId,
    transcriptPath,
    ledgerPath,
  };
}

const RECORD_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
let recordSeq = 0;
function record(
  fixture: Fixture,
  uuid: string,
  parentUuid: string | null,
  text: string,
): ChatRecord {
  const isModel = uuid.startsWith('a');
  return {
    uuid,
    parentUuid,
    sessionId: fixture.sessionId,
    timestamp: new Date(RECORD_BASE_MS + recordSeq++ * 1000).toISOString(),
    type: isModel ? 'assistant' : 'user',
    provenance: isModel ? 'assistant_output' : 'real_user',
    cwd: fixture.workspaceDir,
    version: '1.0.0',
    message: {
      role: isModel ? 'model' : 'user',
      parts: [{ text }],
    },
  };
}

function toolCallRecord(
  fixture: Fixture,
  uuid: string,
  parentUuid: string,
  callId: string | null,
): ChatRecord {
  return {
    ...record(fixture, uuid, parentUuid, ''),
    message: {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'run_shell_command',
            ...(callId === null ? {} : { id: callId }),
            args: {},
          },
        },
      ],
    },
  };
}

function writeTranscript(
  fixture: Fixture,
  records: readonly ChatRecord[],
): void {
  mkdirSync(path.dirname(fixture.transcriptPath), { recursive: true });
  writeFileSync(
    fixture.transcriptPath,
    records.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
}

function writeLedger(
  fixture: Fixture,
  records: readonly PromptLedgerRecord[],
): void {
  for (const record of records) {
    appendPromptLedgerRecord(fixture.ledgerPath, record);
  }
}

describe('reconcileDanglingPromptTerminals', () => {
  it('marks a transcript-clean dangling prompt completed', async () => {
    const fixture = makeFixture();
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'completed',
        stopReason: 'reconstructed_from_transcript',
        at: expect.any(Number),
      },
    ]);
  });

  it('marks an interrupted_prompt dangling prompt interrupted', async () => {
    const fixture = makeFixture();
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
      record(fixture, 'u2', 'a1', 'orphaned follow-up'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'interrupted',
        code: 'daemon_lost',
        at: expect.any(Number),
      },
    ]);
  });

  it('marks an interrupted_turn dangling prompt interrupted', async () => {
    const fixture = makeFixture();
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'run something'),
      toolCallRecord(fixture, 'a1', 'u1', 'call-1'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'interrupted',
        code: 'daemon_lost',
        at: expect.any(Number),
      },
    ]);
  });

  it('stays fail-closed when the transcript cannot be read', async () => {
    const fixture = makeFixture();
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }]);
    // No transcript file at all: loadSession yields undefined.

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
    ]);
  });

  it('stays fail-closed when the last transcript write predates the admission', async () => {
    const fixture = makeFixture();
    // The sole dangling prompt was admitted AFTER the transcript's last
    // write: it never produced a transcript entry (still queued when the
    // daemon died), so the visible tail belongs to an earlier settled turn
    // and must not be attributed to it. `at` sits far in the future of the
    // fixture's timestamps so the ordering cannot be accidental.
    const admissionAt = Date.UTC(2030, 0, 1);
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        at: admissionAt,
      },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        at: admissionAt,
      },
    ]);
  });

  it('appends nothing when there is no dangling prompt', async () => {
    const fixture = makeFixture();
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p1', terminal: 'completed', at: 2 },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(2);
  });

  it('appends nothing when several prompts are dangling', async () => {
    const fixture = makeFixture();
    // Queued scenario: p1 never ran, p2 was running when the daemon died.
    // Under FIFO the visible tail belongs to the oldest running prompt,
    // but with both dangling the tail's owner cannot be verified — fail
    // closed and keep both unknown instead of guessing.
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p2', state: 'in_flight', at: 2 },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(2);
  });

  it('attributes the tail to the sole dangling prompt behind a settled one', async () => {
    const fixture = makeFixture();
    // Valid interleave: p1 settled after p2 was admitted, so the tail is
    // p2's turn and p2 gets the verdict even though a terminal record
    // sits after its in_flight line.
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p2', state: 'in_flight', at: 2 },
      { v: 1, promptId: 'p1', terminal: 'completed', at: 3 },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u2', null, 'p2 question'),
      record(fixture, 'a2', 'u2', 'p2 answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    const records = readPromptLedgerRecords(fixture.ledgerPath);
    expect(records).toHaveLength(4);
    expect(records[3]).toMatchObject({
      promptId: 'p2',
      terminal: 'completed',
      stopReason: 'reconstructed_from_transcript',
    });
  });

  it('attributes the tail to the running prompt behind a cancelled queued one', async () => {
    const fixture = makeFixture();
    // S3 shape: A was running, B queued behind it, B was cancelled from
    // the queue, then the daemon died while A still ran. A is the only
    // dangling prompt and the interrupted tail belongs to it — B's
    // settled in_flight must not veto A.
    writeLedger(fixture, [
      { v: 1, promptId: 'A', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'B', state: 'in_flight', at: 2 },
      { v: 1, promptId: 'B', terminal: 'cancelled', at: 3 },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'A question'),
      record(fixture, 'a1', 'u1', 'partial answer'),
      record(fixture, 'u2', 'a1', 'orphaned follow-up'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    const records = readPromptLedgerRecords(fixture.ledgerPath);
    expect(records).toHaveLength(4);
    expect(records[3]).toEqual({
      v: 1,
      promptId: 'A',
      terminal: 'interrupted',
      code: 'daemon_lost',
      at: expect.any(Number),
    });
  });

  it('marks a dangling prompt interrupted on an id-less functionCall tail', async () => {
    const fixture = makeFixture();
    // detectTurnInterruption ignores functionCalls without an id (no wire
    // pairing), but a model tail holding ANY functionCall still means the
    // daemon died mid tool-run — the reconcile-side guard must upgrade the
    // verdict to interrupted.
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'run something'),
      toolCallRecord(fixture, 'a1', 'u1', null),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'interrupted',
        code: 'daemon_lost',
        at: expect.any(Number),
      },
    ]);
  });

  it('is idempotent: a second reconcile appends nothing new', async () => {
    const fixture = makeFixture();
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );
    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(2);
  });

  it('stays fail-closed when the dangling prompt was re-admitted after a settled turn', async () => {
    const fixture = makeFixture();
    // Re-admission shape: p1 settled, then the same promptId was admitted
    // again and dangled. The guard skips in_flight records of prompts with
    // a terminal on disk (their settle state is ambiguous), so no verdict
    // is attributed. The old "anomalous interleave" veto (last in_flight
    // must match target) was superseded by this guard: it wrongly vetoed
    // the running prompt behind a cancelled queued one (see the S3-shaped
    // test above).
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p1', terminal: 'completed', at: 2 },
      { v: 1, promptId: 'p1', state: 'in_flight', at: 3 },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(3);
  });
});

describe('readRecentPromptTerminals + withPromptTerminals', () => {
  it('returns undefined without ledger evidence', () => {
    const fixture = makeFixture();
    expect(
      readRecentPromptTerminals(fixture.sessionService, fixture.sessionId),
    ).toBeUndefined();
  });

  it('returns undefined when the ledger holds only in_flight records', () => {
    const fixture = makeFixture();
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }]);
    expect(
      readRecentPromptTerminals(fixture.sessionService, fixture.sessionId),
    ).toBeUndefined();
  });

  it('returns the trailing terminal records', () => {
    const fixture = makeFixture();
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p1', terminal: 'completed', at: 2 },
      { v: 1, promptId: 'p2', state: 'in_flight', at: 3 },
      {
        v: 1,
        promptId: 'p2',
        terminal: 'error',
        code: 'daemon_shutdown',
        at: 4,
      },
    ]);
    expect(
      readRecentPromptTerminals(fixture.sessionService, fixture.sessionId),
    ).toEqual([
      { v: 1, promptId: 'p1', terminal: 'completed', at: 2 },
      {
        v: 1,
        promptId: 'p2',
        terminal: 'error',
        code: 'daemon_shutdown',
        at: 4,
      },
    ]);
  });

  it('reads the trailing terminals from a ledger larger than the tail window', () => {
    const fixture = makeFixture();
    // ~290 KiB of fixed-length terminal records — beyond the 256 KiB read
    // window — written in one shot (the per-record append path is not what
    // this test exercises).
    const lines: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      lines.push(
        `${JSON.stringify({
          v: 1,
          promptId: `p${String(i).padStart(6, '0')}`,
          terminal: 'completed',
          at: i,
        })}\n`,
      );
    }
    mkdirSync(path.dirname(fixture.ledgerPath), { recursive: true });
    writeFileSync(fixture.ledgerPath, lines.join(''), 'utf8');

    const terminals = readRecentPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );
    expect(terminals).toHaveLength(64);
    expect(terminals[63]).toMatchObject({
      promptId: 'p004999',
      terminal: 'completed',
    });
    // The window can only hold the tail, so even the oldest returned
    // terminal must come from near the end of the file.
    expect(terminals[0]?.at).toBeGreaterThan(4900);
  });

  it('leaves the response untouched without terminals', () => {
    const session = {
      sessionId: 's1',
      attached: false,
      state: {},
      workspaceCwd: '/workspace/a',
    };
    expect(withPromptTerminals(session, undefined)).toBe(session);
    expect(withPromptTerminals(session, [])).toBe(session);
  });

  it('attaches the promptTerminals field', () => {
    const session = {
      sessionId: 's1',
      attached: false,
      state: {},
      workspaceCwd: '/workspace/a',
    };
    const terminals = [
      { v: 1 as const, promptId: 'p1', terminal: 'completed' as const, at: 2 },
    ];
    expect(withPromptTerminals(session, terminals)).toMatchObject({
      sessionId: 's1',
      attached: false,
      promptTerminals: terminals,
    });
  });
});

describe('createPromptLedgerSink', () => {
  it('appends through the SessionService path layout', () => {
    const fixture = makeFixture();
    const sink = createPromptLedgerSink(
      fixture.workspaceDir,
      fixture.runtimeBaseDir,
    );
    sink.appendSync(fixture.sessionId, {
      v: 1,
      promptId: 'p1',
      state: 'in_flight',
      at: 1,
    });
    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: 1 },
    ]);
  });
});
