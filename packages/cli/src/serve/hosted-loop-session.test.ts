/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';
import {
  HostedLoopSession,
  LOOP_CHAIN_MAX_AGE_MS,
  LOOP_INPUT_SOURCE,
  LoopWakeupError,
  type HostedLoopClassifier,
} from './hosted-loop-session.js';

// The self-paced loop funnel drives the real journal with no enablement
// mock: the gate lives at the tool surface, not here. See
// docs/design/2026-11-10-managed-loop-wakeup.md.
const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

interface Harness {
  readonly runtimeBaseDir: string;
  readonly transcriptPath: string;
  readonly store: LocalManagedSessionResourceStore;
  readonly records: ChatRecord[];
  now: number;
}

async function createHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-hosted-loop-'));
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
    records: [],
    now: 1_000,
  };
}

const allow: HostedLoopClassifier = async () => ({
  allowed: true,
  reason: null,
});

async function withLoop<T>(
  harness: Harness,
  run: (
    loops: HostedLoopSession,
    authority: LocalManagedSessionAuthority,
  ) => Promise<T>,
  classify: HostedLoopClassifier = allow,
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
      cwd: '/workspace',
      version: 'test',
      resources: harness.store,
      now: () => harness.now,
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
    const loops = new HostedLoopSession(
      {
        authority,
        resources: harness.store,
        sink: { project: async () => [...harness.records] },
      },
      sessionKey,
      { classify, cwd: '/workspace', now: () => harness.now },
    );
    return await run(loops, authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

function loopPending(authority: LocalManagedSessionAuthority) {
  return pendingSessionInputs(
    authority.eventsInSequenceRange(1, authority.committedSequence),
  ).filter((input) => input.source === LOOP_INPUT_SOURCE);
}

describe('HostedLoopSession arm', () => {
  it('clamps the delay and commits a loop input due at notBefore', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      const arm = await loops.arm({ delaySeconds: 59, prompt: '/loop tick' });
      expect(arm.clampedDelaySeconds).toBe(60);
      expect(arm.wasClamped).toBe(true);
      expect(arm.fireAt).toBe(harness.now + 60_000);
      expect(arm.replacedId).toBeNull();
      const pending = loopPending(authority);
      expect(pending).toHaveLength(1);
      expect(pending[0].turnId).toBe(arm.id);
      expect(pending[0].notBefore).toBe(arm.fireAt);
      expect(arm.id.startsWith('loop:')).toBe(true);
    });
  });

  it('clamps 3601 to 3600 and a non-finite delay to the 1200 default', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops) => {
      const high = await loops.arm({ delaySeconds: 3601, prompt: 'x' });
      expect(high.clampedDelaySeconds).toBe(3600);
      const nan = await loops.arm({ delaySeconds: NaN, prompt: 'x' });
      expect(nan.clampedDelaySeconds).toBe(1200);
      expect(nan.wasClamped).toBe(true);
    });
  });

  it('refuses an empty or oversized prompt without committing', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      await expect(
        loops.arm({ delaySeconds: 60, prompt: '   ' }),
      ).rejects.toBeInstanceOf(LoopWakeupError);
      await expect(
        loops.arm({ delaySeconds: 60, prompt: 'x'.repeat(10001) }),
      ).rejects.toBeInstanceOf(LoopWakeupError);
      expect(loopPending(authority)).toHaveLength(0);
    });
  });

  it('a denied classifier verdict refuses the arm and commits nothing', async () => {
    const harness = await createHarness();
    const deny: HostedLoopClassifier = async () => ({
      allowed: false,
      reason: 'explicit deny rule',
    });
    await withLoop(
      harness,
      async (loops, authority) => {
        await expect(
          loops.arm({ delaySeconds: 60, prompt: '/loop tick' }),
        ).rejects.toBeInstanceOf(LoopWakeupError);
        expect(loopPending(authority)).toHaveLength(0);
      },
      deny,
    );
  });
});

describe('HostedLoopSession replacement', () => {
  it('a re-arm replaces the unfired input, leaving exactly one pending', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      const first = await loops.arm({ delaySeconds: 60, prompt: 'one' });
      const second = await loops.arm({ delaySeconds: 120, prompt: 'two' });
      expect(second.replacedId).toBe(first.id);
      const pending = loopPending(authority);
      expect(pending.map((input) => input.turnId)).toEqual([second.id]);
      const settled = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .filter((event) => event.kind === 'turn.settled');
      expect(settled).toHaveLength(1);
      expect(settled[0].payload).toMatchObject({
        turnId: first.id,
        outcome: 'cancelled',
        stopReason: 'loop_replaced',
      });
    });
  });

  it('never replaces a firing input (its turn already started)', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      const first = await loops.arm({ delaySeconds: 60, prompt: 'one' });
      // The firing turn left its prompt id in the transcript.
      harness.records.push({ daemonPromptId: first.id } as ChatRecord);
      const second = await loops.arm({ delaySeconds: 120, prompt: 'two' });
      expect(second.replacedId).toBeNull();
      const pending = loopPending(authority);
      expect(pending.map((input) => input.turnId).sort()).toEqual(
        [first.id, second.id].sort(),
      );
    });
  });
});

describe('HostedLoopSession chain budget', () => {
  it('admits an arm at the 24h boundary and refuses one past it, dropping the unfired', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      const first = await loops.arm({ delaySeconds: 60, prompt: 'one' });
      const anchor = harness.now; // first loop input occurredAt
      // Exactly at the boundary: fireAt == anchor + 24h is admitted.
      harness.now = anchor + LOOP_CHAIN_MAX_AGE_MS - 60_000;
      const boundary = await loops.arm({ delaySeconds: 60, prompt: 'two' });
      expect(boundary.fireAt).toBe(anchor + LOOP_CHAIN_MAX_AGE_MS);
      expect(boundary.replacedId).toBe(first.id);
      // Past the boundary: refused, and the unfired pending is dropped.
      harness.now = anchor + LOOP_CHAIN_MAX_AGE_MS + 5_000;
      await expect(
        loops.arm({ delaySeconds: 60, prompt: 'three' }),
      ).rejects.toBeInstanceOf(LoopWakeupError);
      expect(loopPending(authority)).toHaveLength(0);
      const dropped = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .filter((event) => event.kind === 'turn.settled')
        .at(-1);
      expect(dropped?.payload).toMatchObject({
        turnId: boundary.id,
        stopReason: 'loop_chain_expired',
      });
    });
  });

  it('a cancel does not reset the chain anchor', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      const first = await loops.arm({ delaySeconds: 60, prompt: 'one' });
      const anchor = harness.now;
      expect(await loops.cancel(first.id)).toBe(true);
      // Still anchored at the first input: an arm past 24h is refused even
      // though nothing is pending now.
      harness.now = anchor + LOOP_CHAIN_MAX_AGE_MS + 5_000;
      await expect(
        loops.arm({ delaySeconds: 60, prompt: 'two' }),
      ).rejects.toBeInstanceOf(LoopWakeupError);
      expect(loopPending(authority)).toHaveLength(0);
    });
  });
});

describe('HostedLoopSession cancel', () => {
  it('settles a pending wakeup and is idempotent', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      const arm = await loops.arm({ delaySeconds: 60, prompt: 'one' });
      expect(await loops.cancel(arm.id)).toBe(true);
      expect(loopPending(authority)).toHaveLength(0);
      expect(await loops.cancel(arm.id)).toBe(false);
      expect(await loops.cancel('loop:does-not-exist')).toBe(false);
      const settled = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .filter((event) => event.kind === 'turn.settled');
      expect(settled).toHaveLength(1);
      expect(settled[0].payload).toMatchObject({
        turnId: arm.id,
        stopReason: 'loop_cancelled',
      });
    });
  });

  it('refuses to cancel a wakeup whose turn already started', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      const arm = await loops.arm({ delaySeconds: 60, prompt: 'one' });
      harness.records.push({ daemonPromptId: arm.id } as ChatRecord);
      expect(await loops.cancel(arm.id)).toBe(false);
      expect(loopPending(authority)).toHaveLength(1);
    });
  });
});
