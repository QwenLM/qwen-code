/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionAuthority } from './managed-session-authority.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';

// channel_route and channel_delivery stay disabled for submission until the
// slices that ship their producers (H5b/H5c); this suite runs the
// commit/rebuild path ahead of enablement, like the child_run suite does
// for the H3 enablement slice.
const enablement = vi.hoisted(() => ({ route: true, delivery: true }));

vi.mock('./managed-session-records.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-session-records.js')>();
  return {
    ...actual,
    assertManagedSessionDomainEnabled: (
      domain: Parameters<typeof actual.assertManagedSessionDomainEnabled>[0],
    ) => {
      if (domain === 'channel_route' && enablement.route) return;
      if (domain === 'channel_delivery' && enablement.delivery) return;
      actual.assertManagedSessionDomainEnabled(domain);
    },
  };
});

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  enablement.route = true;
  enablement.delivery = true;
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
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-managed-channel-'),
  );
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
      now: () => harness.now,
      resources: harness.store,
      cwd: '/workspace',
      version: 'test',
      ...(create === undefined ? {} : { create }),
    });
    return await run(authority);
  } finally {
    await lease.release().catch(() => undefined);
  }
}

interface ChannelRefs {
  readonly policy: ManagedSessionDurableRef;
  readonly result: ManagedSessionDurableRef;
  readonly seg1: ManagedSessionDurableRef;
  readonly seg2: ManagedSessionDurableRef;
  readonly proof: ManagedSessionDurableRef;
}

// The writer-side closure reads every reference a body names, so the test
// publishes real content and builds records from the returned refs.
async function publishRefs(harness: Harness): Promise<ChannelRefs> {
  return {
    policy: await harness.store.publish(
      'channel-policy',
      Buffer.from('{"allowed":["sender-1"]}', 'utf8'),
    ),
    result: await harness.store.publish(
      'managed-tool-result',
      Buffer.from('{"text":"ok"}', 'utf8'),
    ),
    seg1: await harness.store.publish(
      'channel-delivery-segment',
      Buffer.from('part one', 'utf8'),
    ),
    seg2: await harness.store.publish(
      'channel-delivery-segment',
      Buffer.from('part two', 'utf8'),
    ),
    proof: await harness.store.publish(
      'channel-delivery-receipt',
      Buffer.from('{"250":"ok"}', 'utf8'),
    ),
  };
}

const RECEIPT_1 = {
  providerMessageId: 'provider-msg-1',
  acceptedAt: 1_750_000_000_000,
  proofRef: null,
};

function route(
  refs: ChannelRefs,
  overrides: Record<string, unknown> = {},
  runOverrides: Record<string, unknown> = {},
) {
  return {
    routeId: 'route-1',
    channelInstanceId: 'instance-1',
    accountId: 'account-1',
    accountGeneration: 7,
    routeRevision: 3,
    rootSessionId: sessionId,
    sessionId,
    scope: {
      kind: 'user',
      senderId: 'sender-1',
      chatId: 'chat-1',
      threadId: null,
    },
    policyRef: refs.policy,
    run: {
      state: 'admitted',
      reason: null,
      definition: null,
      executionCallId: null,
      effectId: 'route-1',
      dispatchId: null,
      deliveryId: null,
      execution: null,
      runtime: null,
      delivery: null,
      ...runOverrides,
    },
    ...overrides,
  };
}

function delivery(
  refs: ChannelRefs,
  receipts: ReadonlyArray<object | null>,
  runState: string,
  lineState: string,
  overrides: Record<string, unknown> = {},
  runOverrides: Record<string, unknown> = {},
) {
  return {
    deliveryId: 'delivery-1',
    routeId: 'route-1',
    routeRevision: 3,
    sourceTurnId: 'turn-1',
    contentRef: refs.result,
    segments: [refs.seg1, refs.seg2].map((contentRef, index) => ({
      segmentId: `seg-${index + 1}`,
      ordinal: index,
      contentRef,
      receipt: receipts[index] ?? null,
    })),
    cancelRequested: false,
    run: {
      state: runState,
      reason: null,
      definition: null,
      executionCallId: null,
      effectId: 'delivery-1',
      dispatchId: null,
      deliveryId: 'delivery-1',
      execution: null,
      runtime: null,
      delivery: { target: 'channel', state: lineState },
      ...runOverrides,
    },
    ...overrides,
  };
}

function command(
  domain: 'channel_route' | 'channel_delivery',
  commandId: string,
) {
  return {
    operation:
      domain === 'channel_route'
        ? 'commitChannelRoute'
        : 'commitChannelDelivery',
    commandId,
    sessionKey,
    contentDigest: 'd'.repeat(64),
  };
}

const TRUSTED = { class: 'trusted_entry' } as const;

describe('managed session authority channel records', () => {
  it('chains route revisions including a generation rollover and projects no task', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      const first = await authority.commitExtensionRecord(
        command('channel_route', 'route-1:1'),
        { domain: 'channel_route', record: route(refs) },
        TRUSTED,
      );
      expect(first).toMatchObject({
        domain: 'channel_route',
        recordId: 'route-1',
        revision: 1,
        receipt: { replayed: false },
      });
      expect(first.recordRef.kind).toBe('managed-channel_route');
      expect(authority.taskViews()).toEqual([]);

      harness.now = 2_000;
      await authority.commitExtensionRecord(
        command('channel_route', 'route-1:2'),
        {
          domain: 'channel_route',
          record: route(refs, {}, { state: 'running' }),
        },
        TRUSTED,
      );

      // A provider re-key rolls the account generation forward with the
      // binding revision; the old generation admits nothing new because the
      // chain keying forbids a rollback.
      harness.now = 3_000;
      const rolled = await authority.commitExtensionRecord(
        command('channel_route', 'route-1:3'),
        {
          domain: 'channel_route',
          record: route(
            refs,
            { routeRevision: 4, accountGeneration: 8 },
            { state: 'running' },
          ),
        },
        TRUSTED,
      );
      expect(rolled.revision).toBe(3);
      expect(
        authority.extensionRecord('channel_route', 'route-1'),
      ).toMatchObject({
        revision: 3,
        operationId: 'route-1:1',
      });
      expect(authority.taskViews()).toEqual([]);
    });
  });

  it('refuses a route rollover that moves the generation backwards', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        command('channel_route', 'route-1:1'),
        { domain: 'channel_route', record: route(refs) },
        TRUSTED,
      );
      const before = authority.committedSequence;
      await expect(
        authority.commitExtensionRecord(
          command('channel_route', 'route-1:2'),
          {
            domain: 'channel_route',
            record: route(refs, { routeRevision: 4, accountGeneration: 6 }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/cannot follow|successor|revision/im);
      expect(authority.committedSequence).toBe(before);
    });
  });

  it('refuses a same-revision rebind', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        command('channel_route', 'route-1:1'),
        { domain: 'channel_route', record: route(refs) },
        TRUSTED,
      );
      await expect(
        authority.commitExtensionRecord(
          command('channel_route', 'route-1:2'),
          {
            domain: 'channel_route',
            record: route(refs, { sessionId: 'session-2' }),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/cannot follow|successor|revision/im);
    });
  });

  it('chains a delivery from plan through a lost ACK to proven delivery', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        command('channel_delivery', 'delivery-1:1'),
        {
          domain: 'channel_delivery',
          record: delivery(refs, [null, null], 'admitted', 'planned'),
        },
        TRUSTED,
      );
      harness.now = 2_000;
      await authority.commitExtensionRecord(
        command('channel_delivery', 'delivery-1:2'),
        {
          domain: 'channel_delivery',
          record: delivery(refs, [RECEIPT_1, null], 'running', 'sending'),
        },
        TRUSTED,
      );
      // The second segment's ACK is lost: the record says the provider may
      // hold it, and nothing may resend it.
      harness.now = 3_000;
      await authority.commitExtensionRecord(
        command('channel_delivery', 'delivery-1:3'),
        {
          domain: 'channel_delivery',
          record: delivery(refs, [RECEIPT_1, null], 'waiting', 'unknown'),
        },
        TRUSTED,
      );
      harness.now = 4_000;
      const last = await authority.commitExtensionRecord(
        command('channel_delivery', 'delivery-1:4'),
        {
          domain: 'channel_delivery',
          record: delivery(
            refs,
            [RECEIPT_1, { ...RECEIPT_1, providerMessageId: 'provider-msg-2' }],
            'settled',
            'delivered',
          ),
        },
        TRUSTED,
      );
      expect(last.revision).toBe(4);
      expect(authority.taskViews()).toEqual([]);
      expect(
        authority.extensionRecord('channel_delivery', 'delivery-1'),
      ).toMatchObject({ revision: 4 });
    });
  });

  it('never lets an unknown delivery return to sending', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      for (const [index, record] of [
        delivery(refs, [null, null], 'admitted', 'planned'),
        delivery(refs, [RECEIPT_1, null], 'running', 'sending'),
        delivery(refs, [RECEIPT_1, null], 'waiting', 'unknown'),
      ].entries()) {
        await authority.commitExtensionRecord(
          command('channel_delivery', `delivery-1:${index + 1}`),
          { domain: 'channel_delivery', record },
          TRUSTED,
        );
      }
      const before = authority.committedSequence;
      await expect(
        authority.commitExtensionRecord(
          command('channel_delivery', 'delivery-1:4'),
          {
            domain: 'channel_delivery',
            record: delivery(refs, [RECEIPT_1, null], 'running', 'sending'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/cannot follow|successor|revision/im);
      expect(authority.committedSequence).toBe(before);
    });
  });

  it('rebuilds both chains on reopen and replays a repeated command', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        command('channel_route', 'route-1:1'),
        { domain: 'channel_route', record: route(refs) },
        TRUSTED,
      );
      await authority.commitExtensionRecord(
        command('channel_delivery', 'delivery-1:1'),
        {
          domain: 'channel_delivery',
          record: delivery(refs, [null, null], 'admitted', 'planned'),
        },
        TRUSTED,
      );
      const replay = await authority.commitExtensionRecord(
        command('channel_route', 'route-1:1'),
        { domain: 'channel_route', record: route(refs) },
        TRUSTED,
      );
      expect(replay.revision).toBe(1);
      expect(replay.receipt.replayed).toBe(true);
    });
    await withAuthority(
      harness,
      async (authority) => {
        expect(
          authority.extensionRecord('channel_route', 'route-1'),
        ).toMatchObject({ revision: 1 });
        expect(
          authority.extensionRecord('channel_delivery', 'delivery-1'),
        ).toMatchObject({ revision: 1 });
        expect(authority.taskViews()).toEqual([]);
      },
      { create: false },
    );
  });

  it('refuses a record whose reference was never published', async () => {
    const harness = await createHarness();
    const unpublished: ManagedSessionDurableRef = {
      resourceId: 'never-published',
      kind: 'channel-delivery-segment',
      schemaVersion: 1,
      byteLength: 2,
      digest: 'f'.repeat(64),
    };
    const refs: ChannelRefs = {
      policy: unpublished,
      result: unpublished,
      seg1: unpublished,
      seg2: unpublished,
      proof: unpublished,
    };
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('channel_route', 'route-1:1'),
          { domain: 'channel_route', record: route(refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(/never-published|channel-policy|resource|reference/im);
      await expect(
        authority.commitExtensionRecord(
          command('channel_delivery', 'delivery-1:1'),
          {
            domain: 'channel_delivery',
            record: delivery(refs, [null, null], 'admitted', 'planned'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(
        /never-published|channel-delivery-segment|resource|reference/im,
      );
    });
  });

  it('commits a delivery whose receipt carries a proof reference', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await authority.commitExtensionRecord(
        command('channel_delivery', 'delivery-1:1'),
        {
          domain: 'channel_delivery',
          record: delivery(refs, [null, null], 'admitted', 'planned'),
        },
        TRUSTED,
      );
      harness.now = 2_000;
      await authority.commitExtensionRecord(
        command('channel_delivery', 'delivery-1:2'),
        {
          domain: 'channel_delivery',
          record: delivery(
            refs,
            [{ ...RECEIPT_1, proofRef: refs.proof }, null],
            'running',
            'sending',
          ),
        },
        TRUSTED,
      );
      harness.now = 3_000;
      const last = await authority.commitExtensionRecord(
        command('channel_delivery', 'delivery-1:3'),
        {
          domain: 'channel_delivery',
          record: delivery(
            refs,
            [
              { ...RECEIPT_1, proofRef: refs.proof },
              { ...RECEIPT_1, providerMessageId: 'provider-msg-2' },
            ],
            'settled',
            'delivered',
          ),
        },
        TRUSTED,
      );
      expect(last.revision).toBe(3);
    });
    await withAuthority(
      harness,
      async (authority) => {
        expect(
          authority.extensionRecord('channel_delivery', 'delivery-1'),
        ).toMatchObject({ revision: 3 });
      },
      { create: false },
    );
  });

  it('refuses each unpublished reference kind on its own', async () => {
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    const unpublished = (resourceId: string, kind: string) => ({
      resourceId,
      kind,
      schemaVersion: 1,
      byteLength: 2,
      digest: 'f'.repeat(64),
    });
    await withAuthority(harness, async (authority) => {
      // Only the formal result is missing.
      const noResult = {
        ...refs,
        result: unpublished('no-result', 'managed-tool-result'),
      };
      await expect(
        authority.commitExtensionRecord(
          command('channel_delivery', 'delivery-no-result'),
          {
            domain: 'channel_delivery',
            record: delivery(noResult, [null, null], 'admitted', 'planned'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/no-result|resource|reference/im);
      // Only one segment's bytes are missing.
      const noSeg = {
        ...refs,
        seg2: unpublished('no-seg-2', 'channel-delivery-segment'),
      };
      await expect(
        authority.commitExtensionRecord(
          command('channel_delivery', 'delivery-no-seg'),
          {
            domain: 'channel_delivery',
            record: delivery(noSeg, [null, null], 'admitted', 'planned'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/no-seg-2|resource|reference/im);
      // Only the receipt's proof is missing.
      const noProof = {
        ...refs,
        proof: unpublished('no-proof', 'channel-delivery-receipt'),
      };
      await expect(
        authority.commitExtensionRecord(
          command('channel_delivery', 'delivery-no-proof'),
          {
            domain: 'channel_delivery',
            record: delivery(
              noProof,
              [{ ...RECEIPT_1, proofRef: noProof.proof }, null],
              'running',
              'sending',
            ),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(/no-proof|resource|reference/im);
      // Only the route's policy is missing.
      const noPolicy = {
        ...refs,
        policy: unpublished('no-policy', 'channel-policy'),
      };
      await expect(
        authority.commitExtensionRecord(
          command('channel_route', 'route-no-policy'),
          { domain: 'channel_route', record: route(noPolicy) },
          TRUSTED,
        ),
      ).rejects.toThrow(/no-policy|resource|reference/im);
    });
  });

  it('refuses both domains while they stay disabled', async () => {
    enablement.route = false;
    enablement.delivery = false;
    const harness = await createHarness();
    const refs = await publishRefs(harness);
    await withAuthority(harness, async (authority) => {
      await expect(
        authority.commitExtensionRecord(
          command('channel_route', 'route-1:1'),
          { domain: 'channel_route', record: route(refs) },
          TRUSTED,
        ),
      ).rejects.toThrow(ManagedSessionRecordError);
      await expect(
        authority.commitExtensionRecord(
          command('channel_delivery', 'delivery-1:1'),
          {
            domain: 'channel_delivery',
            record: delivery(refs, [null, null], 'admitted', 'planned'),
          },
          TRUSTED,
        ),
      ).rejects.toThrow(ManagedSessionRecordError);
    });
  });
});
