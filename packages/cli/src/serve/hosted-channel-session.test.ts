/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { SessionWriterLease } from '@qwen-code/qwen-code-core/services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import {
  channelInputId,
  channelRouteId,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-channel-operations.js';
import { pendingSessionInputs } from './hosted-wake-intake.js';
import {
  ChannelGenerationStaleError,
  HostedChannelSession,
  type ChannelSubmitInputParams,
} from './hosted-channel-session.js';

// The H5 gates are real: both domains are enabled and the email adapter is
// admitted, so this suite drives the hosted funnel with no enablement mock.
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-hosted-channel-'));
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

async function withSession<T>(
  harness: Harness,
  run: (
    channels: HostedChannelSession,
    authority: LocalManagedSessionAuthority,
  ) => Promise<T>,
  options: { create?: boolean } = {},
): Promise<T> {
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir: harness.runtimeBaseDir,
    sessionId,
    transcriptPath: harness.transcriptPath,
  });
  try {
    const create =
      options.create === false
        ? undefined
        : {
            definitionRef: await harness.store.publish(
              'managed-definition',
              Buffer.from('{}', 'utf8'),
            ),
            rootSnapshotRef: await harness.store.publish(
              'managed-root',
              Buffer.from('{}', 'utf8'),
            ),
            createdBy: 'daemon',
          };
    const authority = await LocalManagedSessionAuthority.open({
      lease,
      sessionKey,
      cwd: '/workspace',
      version: 'test',
      resources: harness.store,
      now: () => harness.now,
      ...(create === undefined ? {} : { create }),
    });
    const channels = new HostedChannelSession(
      {
        authority,
        resources: harness.store,
        sink: { project: async () => [...harness.records] },
      },
      sessionKey,
    );
    return await run(channels, authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

const IDENTITY = {
  tenantId: 'tenant-1',
  channelInstanceId: 'mail-1',
  accountGeneration: 1,
  platformEventId: '1700:42',
  semanticRevision: 1,
};

const SCOPE = {
  kind: 'chat_thread' as const,
  senderId: null,
  chatId: 'alice@example.com',
  threadId: 'thread-1',
};

function inbound(
  overrides: Partial<ChannelSubmitInputParams> = {},
): ChannelSubmitInputParams {
  const identity = {
    ...IDENTITY,
    ...(overrides.accountGeneration !== undefined
      ? { accountGeneration: overrides.accountGeneration }
      : {}),
    ...(overrides.platformEventId !== undefined
      ? { platformEventId: overrides.platformEventId }
      : {}),
  };
  return {
    inputId: channelInputId(identity),
    channelInstanceId: 'mail-1',
    accountId: 'agent@example.com',
    accountGeneration: identity.accountGeneration,
    platformEventId: identity.platformEventId,
    semanticRevision: 1,
    scope: SCOPE,
    policy: {
      adapter: 'email',
      senderPolicy: 'allowlist',
      allowedSenders: ['alice@example.com'],
      dispatchMode: 'followup',
    },
    senderId: 'alice@example.com',
    chatId: 'alice@example.com',
    threadId: 'thread-1',
    subject: 'Build status',
    text: 'Please check the build.',
    attachments: [],
    replyContext: {
      parent: '<a@example.com>',
      references: ['<a@example.com>'],
    },
    ...overrides,
  };
}

const ROUTE_ID = channelRouteId({
  channelInstanceId: 'mail-1',
  accountId: 'agent@example.com',
  scope: SCOPE,
});

/** The turn the wake pump would run, settled as the harness records it. */
function settleTurn(
  harness: Harness,
  turnId: string,
  text: string,
  state: 'completed' | 'error' | 'cancelled' = 'completed',
): void {
  const base = {
    parentUuid: null,
    sessionId,
    timestamp: new Date().toISOString(),
    cwd: '/workspace',
    version: 'hosted-harness/1',
  };
  harness.records.push(
    {
      ...base,
      uuid: `${turnId}:user`,
      type: 'user',
      daemonPromptId: turnId,
      message: { role: 'user', parts: [{ text: 'channel' }] },
    } as ChatRecord,
    {
      ...base,
      uuid: `${turnId}:assistant`,
      type: 'assistant',
      daemonPromptId: turnId,
      message: { role: 'model', parts: [{ text }] },
    } as ChatRecord,
    {
      ...base,
      uuid: `${turnId}:result`,
      type: 'system',
      subtype: 'turn_result',
      systemPayload: {
        promptId: turnId,
        state,
        stopReason: state === 'completed' ? 'end_turn' : state,
        endedAt: Date.now(),
      },
    } as ChatRecord,
  );
}

async function settleInJournal(
  authority: LocalManagedSessionAuthority,
  turnId: string,
): Promise<void> {
  // The wake turn's journal settle, as `commitTurnComplete` records it:
  // the only thing that consumes a pending input.
  await authority.appendExecution(
    {
      operation: 'settleTurn',
      commandId: `${turnId}:settle`,
      sessionKey,
      contentDigest: 'd'.repeat(64),
    },
    [
      {
        v: 1,
        sequence: authority.committedSequence + 1,
        eventId: `${turnId}:settled`,
        sessionKey,
        kind: 'turn.settled',
        occurredAt: 5_000,
        subject: { type: 'turn', turnId },
        payload: {
          turnId,
          outcome: 'completed',
          stopReason: 'end_turn',
          resultRef: null,
          usageRef: null,
          pendingOwnersRef: null,
        },
      },
    ],
    { class: 'authority' },
  );
}

const RECEIPT = {
  providerMessageId: '<reply-1@example.com>',
  acceptedAt: 1_750_000_000_000,
  proofRef: null,
};

describe('HostedChannelSession inbound', () => {
  it('opens the route with the first input, admits a redelivery once, and keeps two events apart', async () => {
    const harness = await createHarness();
    await withSession(harness, async (channels, authority) => {
      const first = await channels.submitInput(inbound());
      expect(first).toMatchObject({
        routeId: ROUTE_ID,
        routeRevision: 1,
        replayed: false,
        turnId: first.inputId,
      });
      const route = channels.route(ROUTE_ID);
      expect(route).toMatchObject({
        accountGeneration: 1,
        routeRevision: 1,
        sessionId,
        rootSessionId: sessionId,
        scope: SCOPE,
        run: { state: 'admitted' },
      });
      const pending = pendingSessionInputs(
        authority.eventsInSequenceRange(1, authority.committedSequence),
      );
      expect(pending.map((input) => [input.inputId, input.source])).toEqual([
        [first.inputId, 'channel'],
      ]);
      expect(await channels.turnText(first.inputId)).toContain(
        '<text>Please check the build.</text>',
      );

      // A provider redelivery: the same identity answers the committed
      // admission, with nothing new in the journal.
      const before = authority.committedSequence;
      const again = await channels.submitInput(inbound());
      expect(again).toMatchObject({ inputId: first.inputId, replayed: true });
      expect(authority.committedSequence).toBe(before);

      // A second real message with identical text is a second input on the
      // same route, committed alone — the binding does not move.
      const second = await channels.submitInput(
        inbound({ platformEventId: '1700:43' }),
      );
      expect(second.inputId).not.toBe(first.inputId);
      expect(second).toMatchObject({ routeId: ROUTE_ID, routeRevision: 1 });
      expect(
        authority.extensionRecord('channel_route', ROUTE_ID)?.revision,
      ).toBe(1);
      expect(
        pendingSessionInputs(
          authority.eventsInSequenceRange(1, authority.committedSequence),
        ).length,
      ).toBe(2);
    });
  });

  it('rolls the route over on a newer generation and refuses an older one', async () => {
    const harness = await createHarness();
    await withSession(harness, async (channels, authority) => {
      await channels.submitInput(inbound());
      const rolled = await channels.submitInput(
        inbound({ accountGeneration: 2, platformEventId: '1800:1' }),
      );
      expect(rolled).toMatchObject({ routeRevision: 2, replayed: false });
      expect(channels.route(ROUTE_ID)).toMatchObject({
        accountGeneration: 2,
        routeRevision: 2,
      });
      expect(
        authority.extensionRecord('channel_route', ROUTE_ID)?.revision,
      ).toBe(2);
      const before = authority.committedSequence;
      await expect(
        channels.submitInput(
          inbound({ accountGeneration: 1, platformEventId: '1700:99' }),
        ),
      ).rejects.toThrow(ChannelGenerationStaleError);
      expect(authority.committedSequence).toBe(before);
    });
  });

  it('refuses an adapter the gate does not admit, committing nothing', async () => {
    const harness = await createHarness();
    await withSession(harness, async (channels, authority) => {
      const before = authority.committedSequence;
      await expect(
        channels.submitInput(
          inbound({
            policy: {
              adapter: 'telegram',
              senderPolicy: 'open',
              allowedSenders: [],
              dispatchMode: 'followup',
            },
          }),
        ),
      ).rejects.toThrow(/adapter telegram is not enabled/);
      expect(authority.committedSequence).toBe(before);
      expect(channels.route(ROUTE_ID)).toBeUndefined();
    });
  });

  it('stages inline attachments and lists oversized ones as omitted', async () => {
    const harness = await createHarness();
    await withSession(harness, async (channels) => {
      const small = Buffer.from('hello');
      const large = Buffer.alloc(64 * 1024 + 1, 1);
      const result = await channels.submitInput(
        inbound({
          attachments: [
            { fileName: 'notes.txt', mimeType: 'text/plain', bytes: small },
            {
              fileName: 'big.bin',
              mimeType: 'application/octet-stream',
              bytes: large,
            },
          ],
        }),
      );
      expect(result.attachments).toHaveLength(2);
      const [staged, omitted] = result.attachments;
      expect(staged).toMatchObject({
        fileName: 'notes.txt',
        byteLength: 5,
        digest: createHash('sha256').update(small).digest('hex'),
      });
      if (!('ref' in staged!)) throw new Error('first attachment not staged');
      expect((await harness.store.read(staged.ref)).toString()).toBe('hello');
      expect(omitted).toMatchObject({
        fileName: 'big.bin',
        byteLength: large.byteLength,
        omitted: 'too_large',
      });
      const text = await channels.turnText(result.inputId);
      expect(text).toContain('name="notes.txt"');
      expect(text).toContain('omitted="too_large"');
    });
  });
});

describe('HostedChannelSession outbound', () => {
  it('plans one reply per settled turn, idempotently, and reconciles on open', async () => {
    const harness = await createHarness();
    const inputId = (await withSession(
      harness,
      async (channels) => (await channels.submitInput(inbound())).inputId,
    ))!;
    await withSession(
      harness,
      async (channels, authority) => {
        // Nothing settled yet: nothing to plan.
        expect(await channels.planReply(inputId)).toBeUndefined();
        settleTurn(harness, inputId, 'The build is green.');
        await settleInJournal(authority, inputId);
        const planned = await channels.planReply(inputId);
        expect(planned).toMatchObject({
          deliveryId: `${inputId}:reply`,
          routeId: ROUTE_ID,
          routeRevision: 1,
          sourceTurnId: inputId,
          run: { state: 'admitted', delivery: { state: 'planned' } },
        });
        expect(planned!.segments).toHaveLength(1);
        // Planning again is the same chain, not a second one.
        const again = await channels.planReply(inputId);
        expect(again).toEqual(planned);
        expect(
          authority.extensionRecord('channel_delivery', planned!.deliveryId)
            ?.revision,
        ).toBe(1);
        expect(channels.pendingDeliveries().map((d) => d.deliveryId)).toEqual([
          planned!.deliveryId,
        ]);
        expect(await channels.reconcileReplies()).toEqual([]);
      },
      { create: false },
    );
  });

  it('plans nothing for a turn that did not complete with an answer', async () => {
    const harness = await createHarness();
    await withSession(harness, async (channels, authority) => {
      const errored = (await channels.submitInput(inbound())).inputId;
      settleTurn(harness, errored, 'partial', 'error');
      await settleInJournal(authority, errored);
      expect(await channels.planReply(errored)).toBeUndefined();
      const empty = (
        await channels.submitInput(inbound({ platformEventId: '1700:50' }))
      ).inputId;
      settleTurn(harness, empty, '   ');
      expect(await channels.planReply(empty)).toBeUndefined();
      expect(await channels.reconcileReplies()).toEqual([]);
    });
  });

  it('reconciles a settle → plan crash window on the next open', async () => {
    const harness = await createHarness();
    const inputId = (await withSession(harness, async (channels, authority) => {
      const id = (await channels.submitInput(inbound())).inputId;
      settleTurn(harness, id, 'Answer.');
      await settleInJournal(authority, id);
      // The process died before planReply ran.
      return id;
    }))!;
    await withSession(
      harness,
      async (channels) => {
        expect(await channels.reconcileReplies()).toEqual([inputId]);
        expect(channels.delivery(`${inputId}:reply`)).toMatchObject({
          run: { delivery: { state: 'planned' } },
        });
        expect(await channels.reconcileReplies()).toEqual([]);
      },
      { create: false },
    );
  });

  it('claims, receipts and delivers; a receipt replay answers the same state', async () => {
    const harness = await createHarness();
    await withSession(harness, async (channels, authority) => {
      const inputId = (await channels.submitInput(inbound())).inputId;
      settleTurn(harness, inputId, 'Done.');
      await settleInJournal(authority, inputId);
      const planned = (await channels.planReply(inputId))!;
      const claimed = await channels.claim(planned.deliveryId);
      expect(claimed.delivery.run).toMatchObject({
        state: 'running',
        delivery: { state: 'sending' },
      });
      expect(claimed.reply).toEqual({
        text: 'Done.',
        replyContext: {
          parent: '<a@example.com>',
          references: ['<a@example.com>'],
        },
      });
      expect(claimed.segments).toEqual([
        { ordinal: 0, segmentId: `${planned.deliveryId}:0`, text: 'Done.' },
      ]);
      // A second claim of a sending delivery restates, never re-revises.
      const revision = authority.extensionRecord(
        'channel_delivery',
        planned.deliveryId,
      )?.revision;
      expect((await channels.claim(planned.deliveryId)).delivery).toEqual(
        claimed.delivery,
      );
      expect(
        authority.extensionRecord('channel_delivery', planned.deliveryId)
          ?.revision,
      ).toBe(revision);
      const delivered = await channels.receipt(planned.deliveryId, 0, RECEIPT);
      expect(delivered.run).toMatchObject({
        state: 'settled',
        delivery: { state: 'delivered' },
      });
      expect(delivered.segments[0]!.receipt).toEqual(RECEIPT);
      expect(await channels.receipt(planned.deliveryId, 0, RECEIPT)).toEqual(
        delivered,
      );
      await expect(
        channels.receipt(planned.deliveryId, 0, {
          ...RECEIPT,
          providerMessageId: '<other@example.com>',
        }),
      ).rejects.toThrow(/already has a receipt/);
      expect(channels.pendingDeliveries()).toEqual([]);
      await expect(channels.claim(planned.deliveryId)).rejects.toThrow(
        /cannot be claimed/,
      );
    });
  });

  it('records unknown after a send, never resends by itself, and resends only on request', async () => {
    const harness = await createHarness();
    await withSession(harness, async (channels, authority) => {
      const inputId = (await channels.submitInput(inbound())).inputId;
      settleTurn(harness, inputId, 'Done.');
      await settleInJournal(authority, inputId);
      const planned = (await channels.planReply(inputId))!;
      await channels.claim(planned.deliveryId);
      const unknown = await channels.settle(planned.deliveryId, 'unknown');
      expect(unknown.run).toMatchObject({
        state: 'waiting',
        reason: null,
        delivery: { state: 'unknown' },
      });
      expect(await channels.settle(planned.deliveryId, 'unknown')).toEqual(
        unknown,
      );
      // Unknown is not pending work: no dispatcher picks it up again.
      expect(channels.pendingDeliveries()).toEqual([]);
      await expect(channels.claim(planned.deliveryId)).rejects.toThrow(
        /cannot be claimed/,
      );
      // An explicit resend is a new chain with the unsent segment.
      const resent = await channels.resend(planned.deliveryId);
      expect(resent.deliveryId).toBe(`${planned.deliveryId}:r1`);
      expect(resent.segments.map((segment) => segment.segmentId)).toEqual([
        `${planned.deliveryId}:0`,
      ]);
      expect(channels.delivery(planned.deliveryId)).toEqual(unknown);
      expect(channels.pendingDeliveries().map((d) => d.deliveryId)).toEqual([
        resent.deliveryId,
      ]);
      const second = await channels.resend(planned.deliveryId);
      expect(second.deliveryId).toBe(`${planned.deliveryId}:r2`);
      // A late provider proof still completes the original chain.
      const late = await channels.receipt(planned.deliveryId, 0, RECEIPT);
      expect(late.run).toMatchObject({
        state: 'settled',
        delivery: { state: 'delivered' },
      });
      await expect(channels.resend(planned.deliveryId)).rejects.toThrow(
        /cannot be resent/,
      );
    });
  });

  it('rejects, cancels a planned delivery, and only records a cancel request while sending', async () => {
    const harness = await createHarness();
    await withSession(harness, async (channels, authority) => {
      const first = (await channels.submitInput(inbound())).inputId;
      settleTurn(harness, first, 'One.');
      await settleInJournal(authority, first);
      const planned = (await channels.planReply(first))!;
      const cancelled = await channels.cancel(planned.deliveryId);
      expect(cancelled.run).toMatchObject({
        state: 'cancelled',
        delivery: { state: 'cancelled' },
      });
      expect(cancelled.cancelRequested).toBe(true);
      expect(await channels.cancel(planned.deliveryId)).toEqual(cancelled);

      const second = (
        await channels.submitInput(inbound({ platformEventId: '1700:60' }))
      ).inputId;
      settleTurn(harness, second, 'Two.');
      await settleInJournal(authority, second);
      const other = (await channels.planReply(second))!;
      await channels.claim(other.deliveryId);
      const requested = await channels.cancel(other.deliveryId);
      expect(requested).toMatchObject({
        cancelRequested: true,
        run: { delivery: { state: 'sending' } },
      });
      const rejected = await channels.settle(other.deliveryId, 'rejected');
      expect(rejected.run).toMatchObject({
        state: 'failed',
        delivery: { state: 'rejected' },
      });
      const resent = await channels.resend(other.deliveryId);
      expect(resent.deliveryId).toBe(`${other.deliveryId}:r1`);
    });
  });

  it('refuses a reply against a route re-keyed since the input', async () => {
    const harness = await createHarness();
    await withSession(harness, async (channels, authority) => {
      const inputId = (await channels.submitInput(inbound())).inputId;
      await channels.submitInput(
        inbound({ accountGeneration: 2, platformEventId: '1800:1' }),
      );
      settleTurn(harness, inputId, 'Late answer.');
      await settleInJournal(authority, inputId);
      // The plan pins the input's revision; the binding has moved on, and
      // the old generation creates no new effect.
      await expect(channels.planReply(inputId)).rejects.toThrow(
        /committed route at the pinned revision/,
      );
      expect(channels.delivery(`${inputId}:reply`)).toBeUndefined();
    });
  });
});
