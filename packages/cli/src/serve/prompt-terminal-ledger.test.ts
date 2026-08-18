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
  callId: string,
): ChatRecord {
  return {
    ...record(fixture, uuid, parentUuid, ''),
    message: {
      role: 'model',
      parts: [
        { functionCall: { name: 'run_shell_command', id: callId, args: {} } },
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

  it('reconciles only the most recent of several dangling prompts', async () => {
    const fixture = makeFixture();
    // Queued scenario: p1 never ran, p2 was running when the daemon died.
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

    const records = readPromptLedgerRecords(fixture.ledgerPath);
    expect(records).toHaveLength(3);
    const reconciled = records[2];
    expect(reconciled).toMatchObject({
      promptId: 'p2',
      terminal: 'completed',
      stopReason: 'reconstructed_from_transcript',
    });
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

  it('skips attribution when an anomalous interleave breaks the tail mapping', async () => {
    const fixture = makeFixture();
    // p2 was admitted after p1 but p1's terminal landed later: under FIFO
    // this is impossible, so the tail cannot be attributed to dangling p2
    // and the guard must keep it unknown.
    writeLedger(fixture, [
      { v: 1, promptId: 'p2', state: 'in_flight', at: 1 },
      { v: 1, promptId: 'p1', state: 'in_flight', at: 2 },
      { v: 1, promptId: 'p1', terminal: 'completed', at: 3 },
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
