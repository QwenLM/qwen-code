/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LocalJsonlManagedSessionJournalStore } from './local-jsonl-managed-session-journal-store.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import {
  LocalManagedSessionAuthority,
  ManagedSessionConflictError,
  type ManagedSessionInputRequest,
} from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';

// The self-paced loop wakeup's journal primitive: submitInput with an
// optional replacement settles the replaced unfired input and commits the
// new one in a single transaction (the single-unfired invariant). See
// docs/design/2026-11-10-managed-loop-wakeup.md, decision 4.
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};

interface Harness {
  readonly runtimeBaseDir: string;
  readonly transcriptPath: string;
  readonly store: LocalManagedSessionResourceStore;
  now: number;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-managed-loop-'));
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(root, 'chats', `${sessionId}.jsonl`);
  await fs.mkdir(runtimeBaseDir, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  return {
    runtimeBaseDir,
    transcriptPath,
    store: LocalManagedSessionResourceStore.create({
      runtimeBaseDir,
      sessionKey,
    }),
    now: 1_000,
  };
}

async function withAuthority<T>(
  harness: Harness,
  run: (authority: LocalManagedSessionAuthority) => Promise<T>,
): Promise<T> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: harness.runtimeBaseDir,
    sessionId,
    transcriptPath: harness.transcriptPath,
  });
  try {
    const authority = await LocalManagedSessionAuthority.open({
      journal: LocalJsonlManagedSessionJournalStore.fromLease(
        lease,
        sessionKey,
      ),
      sessionKey,
      now: () => harness.now,
      resources: harness.store,
      cwd: '/workspace',
      version: 'test',
      create: {
        definitionRef: await harness.store.publish(
          'managed-definition',
          Buffer.from('{}', 'utf8'),
        ),
        rootSnapshotRef: await harness.store.publish(
          'managed-root',
          Buffer.from('{}', 'utf8'),
        ),
        createdBy: 'daemon',
      },
    });
    return await run(authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

async function loopInput(
  harness: Harness,
  wakeupId: string,
  notBefore: number | null,
): Promise<ManagedSessionInputRequest> {
  const id = `loop:${wakeupId}`;
  return {
    inputId: id,
    turnId: id,
    source: 'loop',
    contentRef: await harness.store.publish(
      'managed-input',
      Buffer.from(JSON.stringify({ text: '/loop tick' }), 'utf8'),
    ),
    deadline: null,
    admissionRef: await harness.store.publish(
      'managed-admission',
      Buffer.from('{}', 'utf8'),
    ),
    wakeReason: 'input',
    notBefore,
  };
}

/**
 * The replacement's turn-result body, shaped like the close path's
 * model-free settle (settlePendingMonitorInputs): a cancelled turn_result
 * record the reader-facing fence accepts.
 */
async function loopReplacement(
  harness: Harness,
  turnId: string,
  stopReason: string,
) {
  const settle: ChatRecord = {
    uuid: randomUUID(),
    parentUuid: null,
    sessionId,
    timestamp: new Date(harness.now).toISOString(),
    type: 'system',
    cwd: '/workspace',
    version: 'hosted-harness/1',
    subtype: 'turn_result',
    systemPayload: {
      promptId: turnId,
      state: 'cancelled',
      stopReason,
      endedAt: harness.now,
    },
  };
  return {
    turnId,
    stopReason,
    resultRef: await harness.store.publish(
      'managed-turn-result',
      Buffer.from(JSON.stringify(settle), 'utf8'),
    ),
  };
}

function command(commandId: string) {
  return {
    operation: 'submitInput',
    commandId,
    sessionKey,
    contentDigest: 'd'.repeat(64),
  };
}

function events(authority: LocalManagedSessionAuthority) {
  return authority.eventsInSequenceRange(1, authority.committedSequence);
}

describe('submitInput loop wakeup', () => {
  it('commits the input and its wake with notBefore, no replacement', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      const before = authority.committedSequence;
      const input = await loopInput(harness, 'w1', 61_000);
      await authority.submitInput(command('arm-w1'), input);
      const added = events(authority).filter((e) => e.sequence > before);
      expect(added.map((e) => e.kind)).toEqual([
        'input.accepted',
        'wake.requested',
      ]);
      expect(added[0].payload).toMatchObject({
        inputId: 'loop:w1',
        turnId: 'loop:w1',
        source: 'loop',
        notBefore: 61_000,
      });
      expect(added[1].payload['subject']).toEqual({
        type: 'turn',
        turnId: 'loop:w1',
      });
    });
  });

  it('settles the replaced input and arms the new one in one transaction', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.submitInput(
        command('arm-w1'),
        await loopInput(harness, 'w1', 61_000),
      );
      const before = authority.committedSequence;
      const replacement = await loopReplacement(
        harness,
        'loop:w1',
        'loop_replaced',
      );
      await authority.submitInput(
        command('arm-w2'),
        await loopInput(harness, 'w2', 121_000),
        replacement,
      );
      const added = events(authority).filter((e) => e.sequence > before);
      // One contiguous transaction: settle, then the new input and wake.
      expect(added.map((e) => e.kind)).toEqual([
        'turn.settled',
        'input.accepted',
        'wake.requested',
      ]);
      expect(added.map((e) => e.sequence)).toEqual([
        before + 1,
        before + 2,
        before + 3,
      ]);
      expect(added[0].eventId).toBe('turn:loop:w1');
      expect(added[0].payload).toMatchObject({
        turnId: 'loop:w1',
        outcome: 'cancelled',
        stopReason: 'loop_replaced',
        resultRef: replacement.resultRef,
      });
      expect(added[1].payload['notBefore']).toBe(121_000);
      // The wake requires the new input's own sequence, not the settle's.
      expect(added[2].payload['requiredSequence']).toBe(before + 2);
    });
  });

  it('the replacement consumes the old input, leaving only the new one pending', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.submitInput(
        command('arm-w1'),
        await loopInput(harness, 'w1', 61_000),
      );
      await authority.submitInput(
        command('arm-w2'),
        await loopInput(harness, 'w2', 121_000),
        await loopReplacement(harness, 'loop:w1', 'loop_replaced'),
      );
      const all = events(authority);
      const settled = new Set(
        all
          .filter((e) => e.kind === 'turn.settled')
          .map((e) => e.payload['turnId']),
      );
      const pending = all
        .filter((e) => e.kind === 'input.accepted')
        .map((e) => e.payload['turnId'])
        .filter((turnId) => !settled.has(turnId));
      expect(pending).toEqual(['loop:w2']);
    });
  });

  it('refuses to replace a turn that already settled', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.submitInput(
        command('arm-w1'),
        await loopInput(harness, 'w1', 61_000),
      );
      await authority.submitInput(
        command('arm-w2'),
        await loopInput(harness, 'w2', 121_000),
        await loopReplacement(harness, 'loop:w1', 'loop_replaced'),
      );
      // loop:w1 already carries its fixed turn:<turnId> settle.
      await expect(
        authority.submitInput(
          command('arm-w3'),
          await loopInput(harness, 'w3', 181_000),
          await loopReplacement(harness, 'loop:w1', 'loop_replaced'),
        ),
      ).rejects.toBeInstanceOf(ManagedSessionConflictError);
    });
  });

  it('a rejected replacement leaves the journal unchanged', async () => {
    const harness = await createHarness();
    await withAuthority(harness, async (authority) => {
      await authority.submitInput(
        command('arm-w1'),
        await loopInput(harness, 'w1', 61_000),
      );
      await authority.submitInput(
        command('arm-w2'),
        await loopInput(harness, 'w2', 121_000),
        await loopReplacement(harness, 'loop:w1', 'loop_replaced'),
      );
      const before = authority.committedSequence;
      await expect(
        authority.submitInput(
          command('arm-w3'),
          await loopInput(harness, 'w3', 181_000),
          await loopReplacement(harness, 'loop:w1', 'loop_replaced'),
        ),
      ).rejects.toBeInstanceOf(ManagedSessionConflictError);
      expect(authority.committedSequence).toBe(before);
    });
  });
});
