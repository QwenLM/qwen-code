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
import {
  SessionService,
  TURN_INTERRUPTION_HISTORY_TAIL_COUNT,
  type ChatRecord,
} from '@qwen-code/qwen-code-core';
import {
  appendPromptLedgerRecord,
  readPromptLedgerRecords,
  type PromptLedgerRecord,
} from '@qwen-code/acp-bridge/promptLedger';
import {
  createPromptLedgerSink,
  readRecentPromptTerminals,
  readTranscriptTailUuid,
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

function recordAt(
  fixture: Fixture,
  uuid: string,
  parentUuid: string | null,
  text: string,
  atMs: number,
): ChatRecord {
  return {
    ...record(fixture, uuid, parentUuid, text),
    timestamp: new Date(atMs).toISOString(),
  };
}

function toolCallRecord(
  fixture: Fixture,
  uuid: string,
  parentUuid: string,
  callId: string | null,
  atMs?: number,
): ChatRecord {
  const base =
    atMs === undefined
      ? record(fixture, uuid, parentUuid, '')
      : recordAt(fixture, uuid, parentUuid, '', atMs);
  return {
    ...base,
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

function systemRecord(
  fixture: Fixture,
  uuid: string,
  parentUuid: string,
  subtype: NonNullable<ChatRecord['subtype']>,
  systemPayload: ChatRecord['systemPayload'],
): ChatRecord {
  return {
    ...record(fixture, uuid, parentUuid, ''),
    type: 'system',
    subtype,
    systemPayload,
  };
}

/**
 * A system-injected background notification, shaped like
 * `createNotificationRecord` (packages/core/src/services/chatRecordingService.ts):
 * a user-role record with `subtype: 'notification'`, `provenance: 'system'`
 * and a real `message`, so it enters the api history projection as a plain
 * user entry whose text is the `<task-notification>` envelope.
 */
function notificationRecord(
  fixture: Fixture,
  uuid: string,
  parentUuid: string,
  atMs?: number,
): ChatRecord {
  const base =
    atMs === undefined
      ? record(fixture, uuid, parentUuid, '')
      : recordAt(fixture, uuid, parentUuid, '', atMs);
  return {
    ...base,
    type: 'user',
    subtype: 'notification',
    provenance: 'system',
    message: {
      role: 'user',
      parts: [
        {
          text:
            '<task-notification><task-id>agent-1</task-id>' +
            '<status>completed</status>' +
            '<summary>Agent "explore" completed.</summary>' +
            '</task-notification>',
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

  it('reconstructs a completed Goal tool turn from its recorded boundary', async () => {
    const fixture = makeFixture();
    const permit = { goalId: 'goal-1', revision: 1, turnId: 'turn-1' };
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'finish the goal'),
      {
        ...toolCallRecord(fixture, 'a1', 'u1', 'finish'),
        goalContext: permit,
      },
      {
        ...record(fixture, 'result', 'a1', ''),
        type: 'tool_result',
        goalContext: permit,
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'finish',
                name: 'run_shell_command',
                response: { readyForVerification: true },
              },
            },
          ],
        },
      },
      {
        ...systemRecord(fixture, 'end', 'result', 'goal_turn_end', {
          toolCallId: 'finish',
        }),
        goalContext: permit,
      },
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath).at(-1)).toEqual({
      v: 1,
      promptId: 'p1',
      terminal: 'completed',
      stopReason: 'reconstructed_from_transcript',
      at: expect.any(Number),
    });
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
    // Valid interleave on a real time axis: p2 was admitted (queued) while
    // p1 still ran, p1 settled, then p2 dispatched and produced the visible
    // tail before the daemon died. p1's terminal postdates p1's own turn
    // but predates p2's writes (transcript timestamps start at
    // RECORD_BASE_MS), so the FIFO evidence attributes the tail to p2 even
    // though a terminal record sits after its in_flight line.
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        at: RECORD_BASE_MS - 3000,
      },
      {
        v: 1,
        promptId: 'p2',
        state: 'in_flight',
        at: RECORD_BASE_MS - 2000,
      },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'completed',
        at: RECORD_BASE_MS - 1000,
      },
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

  it('stays fail-closed for a queued prompt that never dispatched', async () => {
    const fixture = makeFixture();
    // B was admitted (its in_flight written at admission) and queued while
    // A still ran; A settled and the daemon died before B dispatched. The
    // visible tail is A's turn — it predates A's own settled terminal, so
    // the FIFO evidence cannot attribute it to B.
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'A',
        state: 'in_flight',
        at: RECORD_BASE_MS - 3000,
      },
      {
        v: 1,
        promptId: 'B',
        state: 'in_flight',
        at: RECORD_BASE_MS - 2000,
      },
      // A's settle postdates its turn's writes (the real ordering).
      { v: 1, promptId: 'A', terminal: 'completed', at: Date.now() },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'A question'),
      record(fixture, 'a1', 'u1', 'A answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(3);
  });

  it('stays fail-closed for a stale dangling behind a later settled prompt', async () => {
    const fixture = makeFixture();
    // A restore path that skips reconciliation left p1's in_flight
    // dangling; prompt c1 later ran to completion. c1's clean tail
    // predates c1's own settled terminal, so it must not be attributed to
    // the stale p1.
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        at: RECORD_BASE_MS - 5000,
      },
      {
        v: 1,
        promptId: 'c1',
        state: 'in_flight',
        at: RECORD_BASE_MS - 4000,
      },
      { v: 1, promptId: 'c1', terminal: 'completed', at: Date.now() },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'c1 question'),
      record(fixture, 'a1', 'u1', 'c1 answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(3);
  });

  it('attributes the outcome when a visible write lands beyond the dispatch marker', async () => {
    const fixture = makeFixture();
    // The admission marker points at u1: a1 was written after admission,
    // so the clean tail can be attributed to p1.
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        tailUuid: 'u1',
        at: RECORD_BASE_MS - 1000,
      },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'p1 question'),
      record(fixture, 'a1', 'u1', 'p1 answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    const records = readPromptLedgerRecords(fixture.ledgerPath);
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual(
      expect.objectContaining({ promptId: 'p1', terminal: 'completed' }),
    );
  });

  it('stays fail-closed when nothing was written beyond the dispatch marker', async () => {
    const fixture = makeFixture();
    // The marker is the transcript's last record: the admitted turn never
    // wrote anything visible, so no outcome may be synthesized even though
    // every temporal guard passes.
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        tailUuid: 'a1',
        at: RECORD_BASE_MS - 1000,
      },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'p1 question'),
      record(fixture, 'a1', 'u1', 'p1 answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(1);
  });

  it('stays fail-closed when the dispatch marker is absent from the transcript', async () => {
    const fixture = makeFixture();
    // A marker that the projection does not contain (e.g. a restore that
    // rewrote the transcript) cannot prove any write postdates admission.
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        tailUuid: 'gone-uuid',
        at: RECORD_BASE_MS - 1000,
      },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'p1 question'),
      record(fixture, 'a1', 'u1', 'p1 answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(1);
  });

  it('stays fail-closed when the visible tail shares a millisecond with the FIFO clocks', async () => {
    const fixture = makeFixture();
    // Both compared clocks are 1 ms-granularity `Date.now()` reads: p1's
    // final transcript write and p1's settled terminal can land in the same
    // millisecond T. Equality must veto — a strict `<` never fires on
    // `T < T`, and attributing p1's clean tail to the queued p2 would
    // synthesize a terminal for a prompt that never executed.
    const t = RECORD_BASE_MS + 60_000;
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: t - 3000 },
      { v: 1, promptId: 'p2', state: 'in_flight', at: t - 2000 },
      { v: 1, promptId: 'p1', terminal: 'completed', at: t },
    ]);
    writeTranscript(fixture, [
      recordAt(fixture, 'u1', null, 'p1 question', t),
      recordAt(fixture, 'a1', 'u1', 'p1 answer', t),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(3);
  });

  it('stays fail-closed when the visible tail shares a millisecond with the admission', async () => {
    const fixture = makeFixture();
    // A transcript record persisted in the same millisecond the prompt was
    // admitted cannot prove the admitted prompt's turn wrote it.
    const t = RECORD_BASE_MS + 60_000;
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: t }]);
    writeTranscript(fixture, [
      recordAt(fixture, 'u1', null, 'earlier turn question', t),
      recordAt(fixture, 'a1', 'u1', 'earlier turn answer', t),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(1);
  });

  it('stays fail-closed behind a prompt_deadline_exceeded terminal', async () => {
    const fixture = makeFixture();
    // The deadline path releases the FIFO while the wedged agent is
    // explicitly allowed to keep streaming (DAEMON-003): p1's stale writes
    // postdate both its deadline terminal and p2's admission, so the
    // temporal comparisons alone cannot veto them — the deadline code
    // itself must.
    const deadlineAt = RECORD_BASE_MS + 30_000;
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        at: RECORD_BASE_MS - 10_000,
      },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'error',
        code: 'prompt_deadline_exceeded',
        at: deadlineAt,
      },
      {
        v: 1,
        promptId: 'p2',
        state: 'in_flight',
        at: deadlineAt + 1000,
      },
    ]);
    writeTranscript(fixture, [
      recordAt(fixture, 'u1', null, 'p1 stale write', deadlineAt + 2000),
      recordAt(fixture, 'a1', 'u1', 'p1 stale answer', deadlineAt + 3000),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(3);
  });

  it('stays fail-closed behind a stale prompt_deadline_exceeded terminal', async () => {
    const fixture = makeFixture();
    // The deadline veto is intentionally unconditional: the append-only
    // ledger never expires records, so a stale deadline terminal (here one
    // hour before the target's admission, with a clean post-admission tail)
    // still keeps the session permanently fail-closed. The trade is missing
    // terminals over wrong ones; pin the behavior so any future recency
    // bound is a deliberate change.
    const staleDeadlineAt = RECORD_BASE_MS - 3_600_000;
    const admissionAt = RECORD_BASE_MS - 1000;
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: staleDeadlineAt - 1000 },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'error',
        code: 'prompt_deadline_exceeded',
        at: staleDeadlineAt,
      },
      { v: 1, promptId: 'p2', state: 'in_flight', at: admissionAt },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'p2 question'),
      record(fixture, 'a1', 'u1', 'p2 answer'),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(3);
  });

  it('stays fail-closed when a prompt is admitted during the reconciliation window', async () => {
    const fixture = makeFixture();
    writeLedger(fixture, [
      { v: 1, promptId: 'p-old', state: 'in_flight', at: 1 },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
    ]);

    // Race: a new prompt is admitted while `loadSession` runs, so its
    // `in_flight` lands after reconcile's ledger snapshot — the visible
    // tail may now belong to it, and the verdict computed from the
    // snapshot must not be stamped onto p-old.
    class RacingSessionService extends SessionService {
      override async loadSession(sessionId: string) {
        appendPromptLedgerRecord(this.getPromptLedgerPath(sessionId), {
          v: 1,
          promptId: 'p-new',
          state: 'in_flight',
          // The admission must predate the visible tail (fixture records
          // sit just past RECORD_BASE_MS): a wall-clock admission ~months
          // after the tail could never own it, so the race would not
          // actually threaten the verdict.
          at: RECORD_BASE_MS + 26_000,
        });
        return super.loadSession(sessionId);
      }
    }
    const racing = new RacingSessionService(fixture.workspaceDir, {
      runtimeBaseDir: fixture.runtimeBaseDir,
    });

    await reconcileDanglingPromptTerminals(racing, fixture.sessionId);

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(2);
  });

  it('stays fail-closed when a compression checkpoint postdates the admission', async () => {
    const fixture = makeFixture();
    // A chat_compression record written after p1's admission replaces the
    // api history wholesale; the verdict's projection no longer carries
    // p1's turn, so nothing may be attributed.
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        at: RECORD_BASE_MS - 1000,
      },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
      systemRecord(fixture, 'c1', 'a1', 'chat_compression', {
        info: {
          originalTokenCount: 100,
          newTokenCount: 50,
          // CompressionStatus.COMPRESSED is not exported from the core
          // barrel; reconcile only reads compressedHistory.
          compressionStatus: 1,
        },
        compressedHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
      } as ChatRecord['systemPayload']),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(1);
  });

  it('stays fail-closed when a backward clock step hides a post-marker compression', async () => {
    const fixture = makeFixture();
    // The compression checkpoint sits past p1's dispatch marker but its
    // wall clock stepped backward below the admission time. A marker
    // admission must fence compression by position (anything past the
    // marker postdates admission), or the clock step hides the reset and
    // the compressed tail is wrongly attributed to p1.
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        tailUuid: 'u1',
        at: RECORD_BASE_MS - 1000,
      },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
      {
        ...systemRecord(fixture, 'c1', 'a1', 'chat_compression', {
          info: {
            originalTokenCount: 100,
            newTokenCount: 50,
            compressionStatus: 1,
          },
          compressedHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
        } as ChatRecord['systemPayload']),
        // Backward clock step: pre-admission wall time, post-marker
        // position.
        timestamp: new Date(RECORD_BASE_MS - 60_000).toISOString(),
      },
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(1);
  });

  it('stays fail-closed when only post-admission system records follow', async () => {
    const fixture = makeFixture();
    // After p1's admission the transcript gains only a system record
    // (custom_title here) that stays outside the api history; the raw tail
    // postdates the admission but the projection the verdict runs on holds
    // no evidence of p1's turn.
    writeLedger(fixture, [
      {
        v: 1,
        promptId: 'p1',
        state: 'in_flight',
        at: RECORD_BASE_MS + 3_600_000,
      },
    ]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'earlier question'),
      record(fixture, 'a1', 'u1', 'earlier answer'),
      systemRecord(fixture, 's1', 'a1', 'custom_title', {
        customTitle: 'Later title',
      }),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toHaveLength(1);
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

  it('keeps an id-less functionCall tail interrupted when a notification follows it', async () => {
    // Both guards have to read the SAME tail. `detectTurnInterruption` trims
    // the trailing notification, so the id-less guard must look at the trimmed
    // tail as well: reading the raw last entry lets the notification hide the
    // model entry from the guard while the trim hides the notification from
    // detection — both miss at once and a prompt that died mid tool-run gets
    // stamped `completed`. An ID'd call is unaffected (`danglingCalls` catches
    // it), which is why the case above does not cover this shape.
    const fixture = makeFixture();
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }]);
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'run something'),
      toolCallRecord(fixture, 'a1', 'u1', null),
      notificationRecord(fixture, 'n1', 'a1'),
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

  it('keeps an id-less functionCall interrupted when notifications fill the window', async () => {
    // The bounded tail has to be cut AFTER the notification trim. Slicing the
    // raw projection first lets TURN_INTERRUPTION_HISTORY_TAIL_COUNT trailing
    // notifications fill the whole window: the classifiable tail comes back
    // empty, detection reads `none` (`boundary >= end` with `end === 0`) and
    // the id-less guard has nothing to upgrade — while the attribution loop,
    // which walks the WHOLE transcript rather than the window, still reports
    // `a1` as the last visible non-system write, so the provenance-bound guard
    // stamps `completed` for a prompt that died mid tool-run. One notification
    // short of the window recovered correctly even before the trim-first
    // window; the boundary is exactly the constant. Notification runs are
    // unbounded (`MAX_BACKGROUND_NOTIFICATION_QUEUE` caps the pending queue,
    // not the persisted records), so this is a real shape, not a limit probe.
    const fixture = makeFixture();
    writeLedger(fixture, [{ v: 1, promptId: 'p1', state: 'in_flight', at: 1 }]);
    const notifications: ChatRecord[] = [];
    for (let i = 0; i < TURN_INTERRUPTION_HISTORY_TAIL_COUNT; i++) {
      notifications.push(notificationRecord(fixture, `n${i}`, 'a1'));
    }
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'run something'),
      toolCallRecord(fixture, 'a1', 'u1', null),
      ...notifications,
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

  it('fails closed when the only post-admission write is a system notification', async () => {
    // A notification record is user-role with a real `message`, so it does
    // enter the projection — but the daemon persists it BEFORE the automatic
    // turn runs, so it is not evidence that the target's own turn wrote
    // anything. Counting it lets a notification-only post-admission tail pass
    // attribution for a prompt that never ran. This shape now fails closed for
    // TWO independent reasons: the `provenance === 'system'` skip below keeps
    // the tail out of the temporal evidence, and even without that skip the
    // provenance-bound completion guard vetoes the user-role tail. So this
    // case does not witness the skip — the attribution direction (a wrong
    // `interrupted` terminal rather than a missing `completed` one) is pinned
    // by the next case.
    const fixture = makeFixture();
    const admittedAt = RECORD_BASE_MS + 1500;
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: admittedAt },
    ]);
    writeTranscript(fixture, [
      recordAt(fixture, 'u1', null, 'earlier question', RECORD_BASE_MS),
      recordAt(fixture, 'a1', 'u1', 'earlier answer', RECORD_BASE_MS + 1000),
      notificationRecord(fixture, 'n1', 'a1', RECORD_BASE_MS + 2000),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: admittedAt },
    ]);
  });

  it("fails closed when a notification postdates an earlier turn's dangling tool call", async () => {
    // The ATTRIBUTION direction of the `provenance === 'system'` skip: p1 was
    // queued and never dispatched, and the only write after its admission is a
    // system-injected notification. Counting that notification as p1's own
    // write passes the temporal gate, and the classifier — which trims the
    // notification — is then left looking at the PREVIOUS turn's dangling
    // id-less `functionCall`, so the tool-call guard appends
    // `interrupted / daemon_lost`: a WRONG terminal for a prompt that never
    // ran, served by every later load because the ledger is append-only. The
    // notification-only case above cannot cover this (its assistant tail makes
    // the completion guard veto independently). Deleting the skip reddens this
    // case AND the assistant-tail case below, which pins the skip's other
    // direction — see the design doc's test plan
    // (docs/design/2026-08-19-prompt-terminal-ledger-design.md).
    const fixture = makeFixture();
    const admittedAt = RECORD_BASE_MS + 1500;
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: admittedAt },
    ]);
    writeTranscript(fixture, [
      recordAt(fixture, 'u1', null, 'earlier question', RECORD_BASE_MS),
      toolCallRecord(fixture, 'a1', 'u1', null, RECORD_BASE_MS + 1000),
      notificationRecord(fixture, 'n1', 'a1', RECORD_BASE_MS + 3000),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: admittedAt },
    ]);
  });

  it('stamps a completed turn whose assistant tail is followed by a notification', async () => {
    // The `provenance === 'system'` skip in the attribution loop is
    // load-bearing in BOTH directions. The case immediately above pins one
    // direction (a notification must not count as the target's own
    // post-admission write). This one pins the other: a notification must not
    // become the LAST visible non-system write either. Without the skip, `n1`
    // (user-role, with a real `message`) overwrites `a1` as the tail type, so
    // the provenance-bound completion guard vetoes a turn the model actually
    // answered — and since the ledger is append-only, that prompt stays
    // `unknown` on every later load. Deleting the skip therefore reddens both
    // cases.
    const fixture = makeFixture();
    const admittedAt = RECORD_BASE_MS + 1500;
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: admittedAt },
    ]);
    writeTranscript(fixture, [
      recordAt(fixture, 'u1', null, 'question', RECORD_BASE_MS),
      recordAt(fixture, 'a1', 'u1', 'answer', RECORD_BASE_MS + 2000),
      notificationRecord(fixture, 'n1', 'a1', RECORD_BASE_MS + 3000),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: admittedAt },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'completed',
        stopReason: 'reconstructed_from_transcript',
        at: expect.any(Number),
      },
    ]);
  });

  it('fails closed when the visible tail is a real prompt shaped like a notification', async () => {
    // Reconciliation classifies one tail with two models of "system-injected":
    // record `provenance` for attribution (above) and rendered text shape for
    // the verdict (`effectiveHistoryEnd`). A real prompt whose whole text
    // happens to be an envelope — pasted out of a transcript, or forwarded
    // verbatim by a channel/SDK client — is `provenance: 'real_user'`, so it
    // counts as the target's own write; the classifier then trims that same
    // entry, exposing the previous turn's model text as the tail and returning
    // `none`. Without a provenance-bound guard the ledger synthesizes
    // `completed` for a prompt the model never answered, and because the
    // ledger is append-only that wrong terminal is what every later load
    // serves. `main` stamped `interrupted / daemon_lost` here.
    const fixture = makeFixture();
    const admittedAt = RECORD_BASE_MS + 1500;
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: admittedAt },
    ]);
    writeTranscript(fixture, [
      recordAt(fixture, 'u1', null, 'earlier question', RECORD_BASE_MS),
      recordAt(fixture, 'a1', 'u1', 'earlier answer', RECORD_BASE_MS + 1000),
      recordAt(
        fixture,
        'u2',
        'a1',
        '<task-notification><task-id>agent-1</task-id>' +
          '<status>completed</status>' +
          '<summary>Agent "explore" completed.</summary>' +
          '</task-notification>',
        RECORD_BASE_MS + 2000,
      ),
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: admittedAt },
    ]);
  });

  it('stamps a locally handled slash command completed', async () => {
    // A local command (`/help`, `/docs`, `/export md`, ...) never reaches the
    // model: `Session.prompt()` records the prompt as an ordinary user message
    // and the command answers with a `system` / `slash_command`
    // `phase: 'result'` record, which `SessionApiHistoryAccumulator` uses to
    // pop that user entry back out of the projection
    // (session-api-history.test.ts asserts the projection is `[]` for exactly
    // these commands). Detection therefore reads `none` while the last visible
    // non-system write is `type: 'user'`, so without recognising the result
    // record the completion guard vetoes and the promptId reports `unknown` on
    // every later load — where `main` stamped `completed`. The result record is
    // authoritative evidence rather than a text shape, so accepting it does not
    // re-open the envelope-shaped real prompt case above.
    const fixture = makeFixture();
    const admittedAt = RECORD_BASE_MS + 500;
    writeLedger(fixture, [
      { v: 1, promptId: 'p1', state: 'in_flight', at: admittedAt },
    ]);
    writeTranscript(fixture, [
      recordAt(fixture, 'u1', null, '/help', RECORD_BASE_MS + 1000),
      {
        ...systemRecord(fixture, 's1', 'u1', 'slash_command', {
          phase: 'result',
          rawCommand: '/help',
          outputHistoryItems: [{ type: 'assistant', text: 'Done.' }],
        }),
        timestamp: new Date(RECORD_BASE_MS + 2000).toISOString(),
      },
    ]);

    await reconcileDanglingPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );

    expect(readPromptLedgerRecords(fixture.ledgerPath)).toEqual([
      { v: 1, promptId: 'p1', state: 'in_flight', at: admittedAt },
      {
        v: 1,
        promptId: 'p1',
        terminal: 'completed',
        stopReason: 'reconstructed_from_transcript',
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

  it('reads only the trailing window, not the whole ledger', () => {
    const fixture = makeFixture();
    // A distinctive sentinel terminal, then >256 KiB of in_flight filler,
    // then <64 trailing terminals. A full read would return the sentinel
    // too (every terminal fits under the 64-record response cap); the
    // windowed call-site read cannot see it — dropping tailBytes from
    // readRecentPromptTerminals flips this assertion.
    const lines: string[] = [
      `${JSON.stringify({
        v: 1,
        promptId: 'sentinel',
        terminal: 'completed',
        at: 0,
      })}\n`,
    ];
    for (let i = 0; i < 5000; i += 1) {
      lines.push(
        `${JSON.stringify({
          v: 1,
          promptId: `filler${String(i).padStart(6, '0')}`,
          state: 'in_flight',
          at: i + 1,
        })}\n`,
      );
    }
    for (let i = 0; i < 10; i += 1) {
      lines.push(
        `${JSON.stringify({
          v: 1,
          promptId: `tail${String(i).padStart(2, '0')}`,
          terminal: 'completed',
          at: 5001 + i,
        })}\n`,
      );
    }
    mkdirSync(path.dirname(fixture.ledgerPath), { recursive: true });
    writeFileSync(fixture.ledgerPath, lines.join(''), 'utf8');

    const terminals = readRecentPromptTerminals(
      fixture.sessionService,
      fixture.sessionId,
    );
    expect(terminals).toHaveLength(10);
    expect(terminals!.map((t) => t.promptId)).not.toContain('sentinel');
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

  it('reads the transcript tail uuid through the same path layout', () => {
    const fixture = makeFixture();
    const sink = createPromptLedgerSink(
      fixture.workspaceDir,
      fixture.runtimeBaseDir,
    );
    expect(sink.transcriptTailUuid?.(fixture.sessionId)).toBeUndefined();
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
    ]);
    expect(sink.transcriptTailUuid?.(fixture.sessionId)).toBe('a1');
  });
});

describe('readTranscriptTailUuid', () => {
  it('returns the last record uuid, degrading on missing or torn evidence', () => {
    const fixture = makeFixture();
    expect(readTranscriptTailUuid(fixture.transcriptPath)).toBeUndefined();
    writeTranscript(fixture, [
      record(fixture, 'u1', null, 'question'),
      record(fixture, 'a1', 'u1', 'answer'),
    ]);
    expect(readTranscriptTailUuid(fixture.transcriptPath)).toBe('a1');
    // A crash mid-append leaves a truncated final line: no reliable marker.
    writeFileSync(
      fixture.transcriptPath,
      '{"uuid":"u1"}\n{"uuid":"a1","text":"answ',
      'utf8',
    );
    expect(readTranscriptTailUuid(fixture.transcriptPath)).toBeUndefined();
  });
});
