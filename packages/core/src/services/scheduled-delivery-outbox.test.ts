import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../config/storage.js';
import {
  claimScheduledDelivery,
  completeScheduledDelivery,
  enqueueScheduledDelivery,
  getScheduledDeliveryOutboxPath,
  readScheduledDeliveryOutbox,
} from './scheduled-delivery-outbox.js';

describe('scheduledDeliveryOutbox', () => {
  let scratch: string;
  let workspace: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-outbox-'));
    workspace = path.join(scratch, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    Storage.setRuntimeBaseDir(scratch);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const enqueue = (overrides: Record<string, unknown> = {}) =>
    enqueueScheduledDelivery(workspace, {
      deliveryId: 'task-1:1718000000000',
      taskId: 'task-1',
      firedAt: 1718000000000,
      channelName: 'dingtalk',
      target: { type: 'chat', id: 'group-42' },
      text: 'daily result',
      createdAt: 1718000001000,
      ...overrides,
    });

  const truncationMarker =
    '\n\n[Channel delivery truncated because the result exceeded the outbox size limit.]';

  it('enqueues an idempotent pending record', async () => {
    const first = await enqueue();
    const second = await enqueue();

    expect(second).toEqual(first);
    expect(await readScheduledDeliveryOutbox(workspace)).toEqual([first]);
    expect(first).toMatchObject({
      channelName: 'dingtalk',
      target: { type: 'chat', id: 'group-42' },
      status: 'pending',
      attempts: 0,
      updatedAt: 1718000001000,
    });
  });

  it('preserves delivery text exactly at the outbox limit', async () => {
    const text = 'x'.repeat(100_000);

    const record = await enqueue({ text });

    expect(record.text).toBe(text);
  });

  it('truncates oversized delivery text without splitting a surrogate pair', async () => {
    const prefixLimit = 100_000 - truncationMarker.length;
    const text = `${'x'.repeat(prefixLimit - 1)}😀${'y'.repeat(
      truncationMarker.length + 1,
    )}`;

    const record = await enqueue({ text });

    expect(record.text.length).toBeLessThanOrEqual(100_000);
    expect(record.text).toBe(
      `${'x'.repeat(prefixLimit - 1)}${truncationMarker}`,
    );
  });

  it('keeps repeated oversized enqueue idempotent', async () => {
    const text = 'x'.repeat(100_001);

    const first = await enqueue({ text });
    const second = await enqueue({ text });

    expect(second).toEqual(first);
    expect(await readScheduledDeliveryOutbox(workspace)).toEqual([first]);
  });

  it.skipIf(process.platform === 'win32')(
    'stores recipient data in owner-only files and directories',
    async () => {
      await enqueue();
      const file = getScheduledDeliveryOutboxPath(workspace);
      const directory = path.dirname(file);
      const guard = path.join(directory, 'scheduled_deliveries.guard');

      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(guard)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'heals permissive permissions when a claim does not change the outbox',
    async () => {
      await enqueue();
      await claimScheduledDelivery(workspace, {
        now: 1718000002000,
        leaseMs: 30_000,
      });
      await completeScheduledDelivery(workspace, {
        deliveryId: 'task-1:1718000000000',
        outcome: 'delivered',
        now: 1718000003000,
      });

      const file = getScheduledDeliveryOutboxPath(workspace);
      await fs.chmod(file, 0o644);
      expect(
        await claimScheduledDelivery(workspace, {
          now: 1719000000000,
          leaseMs: 30_000,
        }),
      ).toBeNull();
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    },
  );

  it('rejects a conflicting reuse of a delivery id', async () => {
    await enqueue();
    await expect(enqueue({ text: 'different result' })).rejects.toThrow(
      /conflicting delivery id/,
    );
    await expect(enqueue({ channelName: 'feishu' })).rejects.toThrow(
      /conflicting delivery id/,
    );
  });

  it.each([
    { channelName: '' },
    { target: { type: 'chat', id: '' } },
    { target: { type: 'topic', id: 'topic-1' } },
    { target: { type: 'chat', id: 'group-42', threadId: 'thread-7' } },
    { target: { channelName: 'dingtalk', chatId: 'group-42', isGroup: true } },
  ])('rejects malformed enqueue input %#', async (overrides) => {
    await expect(enqueue(overrides)).rejects.toThrow(
      /Invalid scheduled delivery enqueue input/,
    );
  });

  it('serializes concurrent enqueues without losing records', async () => {
    await Promise.all([
      enqueue(),
      enqueue({
        deliveryId: 'task-2:1718000000000',
        taskId: 'task-2',
        text: 'second',
      }),
    ]);
    expect(await readScheduledDeliveryOutbox(workspace)).toHaveLength(2);
  });

  it('claims the oldest due record with a recoverable lease', async () => {
    await enqueue();
    const claimed = await claimScheduledDelivery(workspace, {
      now: 1718000002000,
      leaseMs: 30_000,
    });
    expect(claimed).toMatchObject({
      deliveryId: 'task-1:1718000000000',
      status: 'sending',
      attempts: 1,
      leaseExpiresAt: 1718000032000,
    });
    expect(
      await claimScheduledDelivery(workspace, {
        now: 1718000003000,
        leaseMs: 30_000,
      }),
    ).toBeNull();

    const recovered = await claimScheduledDelivery(workspace, {
      now: 1718000032001,
      leaseMs: 30_000,
    });
    expect(recovered).toMatchObject({ status: 'sending', attempts: 2 });
  });

  it('retries at nextAttemptAt without rerunning the task', async () => {
    await enqueue();
    await claimScheduledDelivery(workspace, {
      now: 1718000002000,
      leaseMs: 30_000,
    });
    await completeScheduledDelivery(workspace, {
      deliveryId: 'task-1:1718000000000',
      outcome: 'retryable',
      now: 1718000003000,
      nextAttemptAt: 1718000063000,
      error: { code: 'channel_delivery_timeout', message: 'timed out' },
    });

    expect(
      await claimScheduledDelivery(workspace, {
        now: 1718000062999,
        leaseMs: 30_000,
      }),
    ).toBeNull();
    expect(
      await claimScheduledDelivery(workspace, {
        now: 1718000063000,
        leaseMs: 30_000,
      }),
    ).toMatchObject({ status: 'sending', attempts: 2 });
  });

  it('redacts credential-shaped values before persisting an error', async () => {
    await enqueue();
    await claimScheduledDelivery(workspace, {
      now: 1718000002000,
      leaseMs: 30_000,
    });
    await completeScheduledDelivery(workspace, {
      deliveryId: 'task-1:1718000000000',
      outcome: 'failed',
      now: 1718000003000,
      error: {
        code: 'channel_delivery_failed',
        message:
          'request failed: Authorization: Bearer secret-token api_key=another-secret',
      },
    });

    const [record] = await readScheduledDeliveryOutbox(workspace);
    expect(record?.lastError?.message).toBe(
      'request failed: Authorization: Bearer <redacted> api_key=<redacted>',
    );
  });

  it.each(['delivered', 'failed'] as const)(
    'stores terminal %s state and never reclaims it',
    async (outcome) => {
      await enqueue();
      await claimScheduledDelivery(workspace, {
        now: 1718000002000,
        leaseMs: 30_000,
      });
      if (outcome === 'failed') {
        await completeScheduledDelivery(workspace, {
          deliveryId: 'task-1:1718000000000',
          outcome,
          now: 1718000003000,
          error: { code: 'invalid_target', message: 'not deliverable' },
        });
      } else {
        await completeScheduledDelivery(workspace, {
          deliveryId: 'task-1:1718000000000',
          outcome,
          now: 1718000003000,
        });
      }
      expect(await readScheduledDeliveryOutbox(workspace)).toEqual([
        expect.objectContaining({ status: outcome }),
      ]);
      expect(
        await claimScheduledDelivery(workspace, {
          now: 1719000000000,
          leaseMs: 30_000,
        }),
      ).toBeNull();
    },
  );

  it('fails closed on a malformed outbox file', async () => {
    const file = getScheduledDeliveryOutboxPath(workspace);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    await expect(readScheduledDeliveryOutbox(workspace)).rejects.toThrow(
      /Malformed JSON/,
    );
    await expect(enqueue()).rejects.toThrow(/Malformed JSON/);
  });
});
