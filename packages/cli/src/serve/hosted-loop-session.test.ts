/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { LocalJsonlManagedSessionJournalStore } from '@qwen-code/qwen-code-core/managed-runtime/local-jsonl-managed-session-journal-store.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { AUTONOMOUS_SENTINEL_DYNAMIC } from '@qwen-code/qwen-code-core/skills/bundled/loop/loop-tick-resolver.js';

// The self-paced loop funnel drives the real journal. The deployment gate
// gates arming, so these arming-semantics tests run with it on. See
// docs/design/2026-11-10-managed-loop-wakeup.md.
const sessionId = '550e8400-e29b-41d4-a716-446655440000';
const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId,
};

const temporaryDirectories = new Set<string>();
const gateKey = 'QWEN_MANAGED_AGENT_LOOP_ENABLED';
let gateBefore: string | undefined;

beforeEach(() => {
  gateBefore = process.env[gateKey];
  process.env[gateKey] = 'true';
});

afterEach(async () => {
  if (gateBefore === undefined) delete process.env[gateKey];
  else process.env[gateKey] = gateBefore;
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
  classifyFire?: HostedLoopClassifier,
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
      { classify, classifyFire, cwd: '/workspace', now: () => harness.now },
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
  it('refuses to arm when the deployment gate is off', async () => {
    process.env[gateKey] = 'false';
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      await expect(
        loops.arm({ delaySeconds: 60, prompt: '/loop tick' }),
      ).rejects.toBeInstanceOf(LoopWakeupError);
      expect(loopPending(authority)).toHaveLength(0);
    });
  });

  it('refuses to arm when the deployment gate is unset (default off)', async () => {
    delete process.env[gateKey];
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      await expect(
        loops.arm({ delaySeconds: 60, prompt: '/loop tick' }),
      ).rejects.toBeInstanceOf(LoopWakeupError);
      expect(loopPending(authority)).toHaveLength(0);
    });
  });

  it('the gate gates arming only: list and cancel still work when off', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      const arm = await loops.arm({ delaySeconds: 60, prompt: 'one' });
      process.env[gateKey] = 'false';
      // An already-armed wakeup stays listable and cancellable with the gate
      // off; the pump delivers journal inputs regardless of the tool surface.
      const listed = await loops.list();
      expect(listed.map((wakeup) => wakeup.id)).toEqual([arm.id]);
      expect(await loops.cancel(arm.id)).toBe(true);
      expect(loopPending(authority)).toHaveLength(0);
      // A new arm, however, is refused.
      await expect(
        loops.arm({ delaySeconds: 60, prompt: 'two' }),
      ).rejects.toBeInstanceOf(LoopWakeupError);
    });
  });

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

  it('a denied re-arm keeps the previously armed wakeup', async () => {
    const harness = await createHarness();
    let deny = false;
    const classify: HostedLoopClassifier = async () =>
      deny
        ? { allowed: false, reason: 'second arm denied' }
        : { allowed: true, reason: null };
    await withLoop(
      harness,
      async (loops, authority) => {
        const first = await loops.arm({ delaySeconds: 60, prompt: 'one' });
        deny = true;
        await expect(
          loops.arm({ delaySeconds: 120, prompt: 'two' }),
        ).rejects.toBeInstanceOf(LoopWakeupError);
        // The denial lands before any replacement: the first wakeup stays the
        // single unfired pending, untouched.
        const pending = loopPending(authority);
        expect(pending.map((input) => input.turnId)).toEqual([first.id]);
      },
      classify,
    );
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

describe('HostedLoopSession list', () => {
  it('lists the pending unfired wakeup with id, fire time, and prompt', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops) => {
      expect(await loops.list()).toEqual([]);
      const arm = await loops.arm({
        delaySeconds: 60,
        prompt: '/loop check the deploy',
      });
      expect(await loops.list()).toEqual([
        { id: arm.id, fireAt: arm.fireAt, prompt: '/loop check the deploy' },
      ]);
      expect(await loops.cancel(arm.id)).toBe(true);
      expect(await loops.list()).toEqual([]);
    });
  });

  it('does not list a wakeup whose turn already started', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops) => {
      const arm = await loops.arm({ delaySeconds: 60, prompt: 'one' });
      harness.records.push({ daemonPromptId: arm.id } as ChatRecord);
      expect(await loops.list()).toEqual([]);
    });
  });
});

describe('HostedLoopSession concurrency and restart', () => {
  it('serializes concurrent arms to a single pending wakeup', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      const [a, b] = await Promise.all([
        loops.arm({ delaySeconds: 60, prompt: 'one' }),
        loops.arm({ delaySeconds: 60, prompt: 'two' }),
      ]);
      // Without the serial() gate both arms read the same empty state and
      // commit two pending wakeups; serialized, one replaces the other.
      expect(loopPending(authority)).toHaveLength(1);
      expect(
        [a.replacedId, b.replacedId].filter((id) => id !== null),
      ).toHaveLength(1);
    });
  });

  it('keeps the 24h chain anchor across a journal reopen', async () => {
    const harness = await createHarness();
    let anchor = 0;
    await withLoop(harness, async (loops) => {
      await loops.arm({ delaySeconds: 60, prompt: 'one' });
      anchor = harness.now;
    });
    // A fresh authority reopens the same journal: the anchor must come from
    // the first committed loop input, not reset to the reopen time.
    harness.now = anchor + LOOP_CHAIN_MAX_AGE_MS + 5_000;
    await withLoop(harness, async (loops, authority) => {
      await expect(
        loops.arm({ delaySeconds: 60, prompt: 'two' }),
      ).rejects.toBeInstanceOf(LoopWakeupError);
      expect(loopPending(authority)).toHaveLength(0);
    });
  });
});

describe('HostedLoopSession fire-time sentinel expansion', () => {
  it('passes a non-sentinel prompt through untouched without re-review', async () => {
    const harness = await createHarness();
    let fireReviews = 0;
    const classifyFire: HostedLoopClassifier = async () => {
      fireReviews += 1;
      return { allowed: true, reason: null };
    };
    await withLoop(
      harness,
      async (loops) => {
        const expanded = await loops.expandFireText('loop:x', '/loop tick');
        expect(expanded).toEqual({ text: '/loop tick', expanded: false });
        expect(fireReviews).toBe(0);
      },
      allow,
      classifyFire,
    );
  });

  it('expands an autonomous sentinel and re-reviews the full delivery', async () => {
    const harness = await createHarness();
    const reviewed: string[] = [];
    const classifyFire: HostedLoopClassifier = async ({ prompt }) => {
      reviewed.push(prompt);
      return { allowed: true, reason: null };
    };
    await withLoop(
      harness,
      async (loops) => {
        const expanded = await loops.expandFireText(
          'loop:x',
          AUTONOMOUS_SENTINEL_DYNAMIC,
        );
        expect(expanded).not.toBeNull();
        // The literal sentinel is gone; the autonomous preamble is delivered.
        expect(expanded!.text).not.toBe(AUTONOMOUS_SENTINEL_DYNAMIC);
        expect(expanded!.text.length).toBeGreaterThan(
          AUTONOMOUS_SENTINEL_DYNAMIC.length,
        );
        expect(reviewed).toHaveLength(1);
        expect(reviewed[0]).toBe(expanded!.text);
      },
      allow,
      classifyFire,
    );
  });

  it('a denied re-review settles loop_admission_denied and skips the fire', async () => {
    const harness = await createHarness();
    const deny: HostedLoopClassifier = async () => ({
      allowed: false,
      reason: 'deny rule',
    });
    await withLoop(
      harness,
      async (loops, authority) => {
        const expanded = await loops.expandFireText(
          'loop:denied',
          AUTONOMOUS_SENTINEL_DYNAMIC,
        );
        expect(expanded).toBeNull();
        const settled = authority
          .eventsInSequenceRange(1, authority.committedSequence)
          .filter((event) => event.kind === 'turn.settled');
        expect(settled).toHaveLength(1);
        expect(settled[0].payload).toMatchObject({
          turnId: 'loop:denied',
          outcome: 'cancelled',
          stopReason: 'loop_admission_denied',
        });
      },
      allow,
      deny,
    );
  });

  it('without a fire-time classifier a full delivery is refused (fail closed)', async () => {
    const harness = await createHarness();
    await withLoop(harness, async (loops, authority) => {
      const expanded = await loops.expandFireText(
        'loop:noclass',
        AUTONOMOUS_SENTINEL_DYNAMIC,
      );
      expect(expanded).toBeNull();
      const settled = authority
        .eventsInSequenceRange(1, authority.committedSequence)
        .filter((event) => event.kind === 'turn.settled');
      expect(settled[0].payload).toMatchObject({
        stopReason: 'loop_admission_denied',
      });
    });
  });

  it('steady-state unchanged content delivers a short reminder without re-review', async () => {
    const harness = await createHarness();
    let fireReviews = 0;
    const classifyFire: HostedLoopClassifier = async () => {
      fireReviews += 1;
      return { allowed: true, reason: null };
    };
    await withLoop(
      harness,
      async (loops) => {
        const first = await loops.expandFireText(
          'loop:1',
          AUTONOMOUS_SENTINEL_DYNAMIC,
        );
        expect(first).not.toBeNull();
        expect(fireReviews).toBe(1);
        loops.markLoopDelivered();
        const second = await loops.expandFireText(
          'loop:2',
          AUTONOMOUS_SENTINEL_DYNAMIC,
        );
        expect(second).not.toBeNull();
        // The unchanged second fire is a short reminder, not re-reviewed.
        expect(fireReviews).toBe(1);
        expect(second!.text.length).toBeLessThan(first!.text.length);
        // A compaction resets the cache: the next fire re-delivers full and
        // is re-reviewed again.
        loops.resetResolverCache();
        const third = await loops.expandFireText(
          'loop:3',
          AUTONOMOUS_SENTINEL_DYNAMIC,
        );
        expect(third).not.toBeNull();
        expect(fireReviews).toBe(2);
        expect(third!.text).toBe(first!.text);
      },
      allow,
      classifyFire,
    );
  });

  it('a non-sentinel turn does not commit an orphaned expansion (F7)', async () => {
    const harness = await createHarness();
    const classifyFire: HostedLoopClassifier = async () => ({
      allowed: true,
      reason: null,
    });
    await withLoop(
      harness,
      async (loops) => {
        // A sentinel resolved but never delivered (held/aborted): pending set.
        const first = await loops.expandFireText(
          'loop:a',
          AUTONOMOUS_SENTINEL_DYNAMIC,
        );
        expect(first!.expanded).toBe(true);
        // A non-sentinel loop turn passes through; the delivery commits the
        // cache only when expanded, so the orphaned pending is not committed.
        const second = await loops.expandFireText('loop:b', '/loop tick');
        expect(second!.expanded).toBe(false);
        if (second!.expanded) loops.markLoopDelivered();
        // The next sentinel still delivers the full preamble, not a dangling
        // short reminder referencing content the model never received.
        const third = await loops.expandFireText(
          'loop:c',
          AUTONOMOUS_SENTINEL_DYNAMIC,
        );
        expect(third!.text).toBe(first!.text);
      },
      allow,
      classifyFire,
    );
  });

  it('a transient classifier outage delivers a no-op re-arm, not a dead loop (F8)', async () => {
    const harness = await createHarness();
    let unavailable = true;
    const classifyFire: HostedLoopClassifier = async () =>
      unavailable
        ? {
            allowed: false,
            unavailable: true,
            reason: 'classifier api timeout',
          }
        : { allowed: true, reason: null };
    await withLoop(
      harness,
      async (loops, authority) => {
        const outage = await loops.expandFireText(
          'loop:outage',
          AUTONOMOUS_SENTINEL_DYNAMIC,
        );
        // Not settled dead: the loop survives with a no-op re-arm tick.
        expect(outage).not.toBeNull();
        const settled = authority
          .eventsInSequenceRange(1, authority.committedSequence)
          .filter((event) => event.kind === 'turn.settled');
        expect(settled).toHaveLength(0);
        // The no-op tick carries the re-arm instruction so the loop continues.
        expect(outage!.text).toContain(AUTONOMOUS_SENTINEL_DYNAMIC);
        // The guidance was not delivered, so the delivery must not commit the
        // resolver cache for this tick.
        expect(outage!.expanded).toBe(false);
        if (outage!.expanded) loops.markLoopDelivered();
        // Once the classifier recovers, the next fire re-delivers the FULL
        // preamble — not a dangling short reminder for content never received.
        unavailable = false;
        const recovery = await loops.expandFireText(
          'loop:recovery',
          AUTONOMOUS_SENTINEL_DYNAMIC,
        );
        expect(recovery!.text).toContain('# Autonomous loop check');
      },
      allow,
      classifyFire,
    );
  });
});
