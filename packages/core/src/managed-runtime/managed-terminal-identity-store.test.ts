/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileManagedActivationStore,
  type ManagedActivationDescriptor,
} from './managed-activation-store.js';
import { ManagedPromptAdmissionController } from './managed-prompt-admission.js';
import {
  FileManagedSessionInbox,
  managedSessionPayloadRef,
} from './managed-session-inbox.js';

const fault = vi.hoisted(() => ({
  phase: undefined as
    | 'write'
    | 'file-sync'
    | 'link'
    | 'directory-sync'
    | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const pending =
        path.basename(String(args[0])).startsWith('.pending-') &&
        path.dirname(String(args[0])).endsWith('.terminal-identities');
      const directory = String(args[0]).endsWith('.terminal-identities');
      const write = handle.writeFile.bind(handle);
      const sync = handle.sync.bind(handle);
      handle.writeFile = async (...writeArgs) => {
        if (pending && fault.phase === 'write') {
          await write('torn');
          throw new Error('terminal write failed');
        }
        return write(...writeArgs);
      };
      handle.sync = async () => {
        if (
          (pending && fault.phase === 'file-sync') ||
          (directory && fault.phase === 'directory-sync')
        ) {
          throw new Error(`terminal ${fault.phase} failed`);
        }
        return sync();
      };
      return handle;
    },
    link: async (...args: Parameters<typeof original.link>) => {
      if (fault.phase === 'link') throw new Error('terminal link failed');
      return original.link(...args);
    },
  };
});

const activationLimits = { maxQueued: 10, maxQueuedPerTenant: 10 };
const inboxLimits = { maxPending: 10, maxPendingPerTenant: 10 };
const input = { tenantId: 'tenant', sessionId: 'session', messageId: 'first' };
const activation: ManagedActivationDescriptor = {
  tenantId: input.tenantId,
  sessionId: input.sessionId,
  activationId: input.messageId,
  payloadRef: managedSessionPayloadRef(input),
  reason: 'user_message',
  recovery: 'replay_safe',
};

describe('durable terminal identity lookup', () => {
  let root: string;
  let activationPath: string;
  let inboxPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'managed-terminal-'));
    activationPath = path.join(root, 'activations.jsonl');
    inboxPath = path.join(root, 'inbox.jsonl');
  });

  afterEach(async () => {
    fault.phase = undefined;
    await rm(root, { recursive: true, force: true });
  });

  async function released() {
    const store = await FileManagedActivationStore.open(activationPath, {
      clock: () => 100,
    });
    await store.enqueue(activation, activationLimits);
    const lease = (await store.claim(activation, 'worker', 1000))!;
    await store.release(lease, 'completed');
    return store;
  }

  async function recordPath(file: string) {
    const directory = `${file}.terminal-identities`;
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    return path.join(directory, names[0]!);
  }

  it('materializes an original terminal and reads it after reopening', async () => {
    const store = await released();
    const original = store.get(activation);
    const journal = await readFile(activationPath);
    const result = await store.readTerminal(activation);
    expect(result).toEqual(original);
    expect(result).not.toHaveProperty('lease');
    const file = await recordPath(activationPath);
    const record = JSON.parse(await readFile(file, 'utf8'));
    expect(record).toMatchObject({
      v: 1,
      kind: 'activation',
      identity: ['tenant', 'session', 'first'],
      terminal: original,
    });
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }
    (result!.descriptor as { payloadRef: string }).payloadRef =
      'caller mutation';
    const reopened = await FileManagedActivationStore.open(activationPath);
    expect(await reopened.readTerminal(activation)).toEqual(original);
    expect(await reopened.enqueue(activation, activationLimits)).toEqual({
      created: false,
      activation: original,
    });
    expect(await readFile(activationPath)).toEqual(journal);
  });

  it('does not expose active, missing or orphan identities as terminals', async () => {
    const store = await released();
    await store.readTerminal(activation);
    const orphan = await recordPath(activationPath);
    const otherPath = path.join(root, 'other.jsonl');
    const other = await FileManagedActivationStore.open(otherPath);
    await mkdir(`${otherPath}.terminal-identities`);
    await copyFile(
      orphan,
      path.join(`${otherPath}.terminal-identities`, path.basename(orphan)),
    );
    expect(await other.readTerminal(activation)).toBeUndefined();
    expect(await other.enqueue(activation, activationLimits)).toMatchObject({
      created: true,
    });
    expect(await other.readTerminal(activation)).toBeUndefined();
    expect(
      await store.readTerminal({ ...activation, tenantId: 'another' }),
    ).toBeUndefined();
    expect(
      await store.readTerminal({ ...activation, sessionId: 'another' }),
    ).toBeUndefined();
  });

  it('rebuilds a missing index without admitting or appending again', async () => {
    const store = await released();
    const original = await store.readTerminal(activation);
    const file = await recordPath(activationPath);
    const bytes = await readFile(file);
    await rm(file);
    const journal = await readFile(activationPath);
    expect(await store.enqueue(activation, activationLimits)).toEqual({
      created: false,
      activation: original,
    });
    expect(await readFile(file)).toEqual(bytes);
    expect(await readFile(activationPath)).toEqual(journal);
    expect(store.listRunnable()).toEqual([]);
  });

  it.each(['size', 'digest', 'identity', 'outcome'] as const)(
    'refuses a conflicting %s without another admission or journal mutation',
    async (damage) => {
      const store = await released();
      await store.readTerminal(activation);
      const file = await recordPath(activationPath);
      const original = await readFile(file);
      const record = JSON.parse(original.toString());
      if (damage === 'size') {
        await writeFile(file, Buffer.alloc(original.length + 1));
      } else {
        if (damage === 'digest') record.digest = '0'.repeat(64);
        if (damage === 'identity') record.identity[0] = 'xxxxxx';
        if (damage === 'outcome') record.terminal.outcome = 'failed';
        await writeFile(file, `${JSON.stringify(record)}\n`);
      }
      const journal = await readFile(activationPath);
      await expect(store.readTerminal(activation)).rejects.toThrow(
        /Terminal identity/,
      );
      await expect(store.enqueue(activation, activationLimits)).rejects.toThrow(
        /Terminal identity/,
      );
      expect(await readFile(activationPath)).toEqual(journal);
      expect(store.listRunnable()).toEqual([]);
      await writeFile(file, original);
      expect(await store.readTerminal(activation)).toEqual(
        store.get(activation),
      );
    },
  );

  it.each(
    (['write', 'file-sync', 'link', 'directory-sync'] as const).filter(
      (phase) => phase !== 'directory-sync' || process.platform !== 'win32',
    ),
  )(
    'preserves terminal acknowledgement and replay when %s publication fails',
    async (phase) => {
      fault.phase = phase;
      const store = await released();
      const original = store.get(activation);
      const journal = await readFile(activationPath);
      await expect(store.readTerminal(activation)).rejects.toThrow(
        /terminal .* failed/,
      );
      expect(store.haltedError).toBeUndefined();
      expect(await readFile(activationPath)).toEqual(journal);
      expect(
        await readdir(`${activationPath}.terminal-identities`),
      ).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^\.pending-/)]),
      );
      fault.phase = undefined;
      const reopened = await FileManagedActivationStore.open(activationPath);
      expect(await reopened.enqueue(activation, activationLimits)).toEqual({
        created: false,
        activation: original,
      });
      expect(await readFile(activationPath)).toEqual(journal);
    },
  );

  it('keeps terminal mutations independent of an unavailable index', async () => {
    await writeFile(`${activationPath}.terminal-identities`, 'not a directory');
    const store = await released();
    await expect(store.readTerminal(activation)).rejects.toThrow(
      /real directory/,
    );
    expect(store.get(activation)).toMatchObject({
      status: 'released',
      outcome: 'completed',
    });
    const reopened = await FileManagedActivationStore.open(activationPath);
    expect(reopened.get(activation)).toEqual(store.get(activation));

    await writeFile(`${inboxPath}.terminal-identities`, 'not a directory');
    const inbox = await FileManagedSessionInbox.open(inboxPath);
    await inbox.admit({ ...input, payload: {} }, inboxLimits);
    await expect(inbox.requestCancel(input)).resolves.toMatchObject({
      state: 'finished',
    });
    await expect(inbox.readTerminal(input)).rejects.toThrow(/real directory/);
  });

  it('replays canonical inbox payloads and preserves cancellation without a fence', async () => {
    const inbox = await FileManagedSessionInbox.open(inboxPath, {
      clock: () => 100,
    });
    await inbox.admit({ ...input, payload: { a: -0, b: 1 } }, inboxLimits);
    const original = await inbox.requestCancel(input);
    expect(await inbox.readTerminal(input)).toEqual(original);
    expect(original).not.toHaveProperty('fence');
    expect(original.activationReady).toBe(false);
    const reopened = await FileManagedSessionInbox.open(inboxPath);
    expect(
      await reopened.admit({ ...input, payload: { b: 1, a: 0 } }, inboxLimits),
    ).toEqual({
      created: false,
      message: original,
    });
    await expect(
      reopened.admit({ ...input, payload: { a: 1, b: 1 } }, inboxLimits),
    ).rejects.toThrow(/different data/);
    expect(await reopened.readTerminal(input)).toEqual(original);
  });

  it('reconciles an unfinished inbox against the original released activation', async () => {
    const store = await released();
    const inbox = await FileManagedSessionInbox.open(inboxPath);
    await inbox.admit(
      { ...input, payload: { prompt: 'original' } },
      inboxLimits,
    );
    await inbox.markActivationReady(input);
    const reopened = await FileManagedActivationStore.open(activationPath);
    const controller = new ManagedPromptAdmissionController(
      await FileManagedSessionInbox.open(inboxPath),
      { submit: (value) => reopened.enqueue(value, activationLimits) },
      inboxLimits,
    );
    expect(await controller.reconcile()).toEqual({ inspected: 1, readied: 0 });
    expect(reopened.listRunnable()).toEqual([]);
    expect(await reopened.readTerminal(activation)).toEqual(
      store.get(activation),
    );
    expect(inbox.listPending()).toHaveLength(1);
    await recordPath(activationPath);
  });

  it('uses the durable inbox record for duplicate replay and refuses corruption', async () => {
    const inbox = await FileManagedSessionInbox.open(inboxPath);
    const message = { ...input, payload: { prompt: 'original' } };
    await inbox.admit(message, inboxLimits);
    const original = await inbox.requestCancel(input);
    expect(await inbox.admit(message, inboxLimits)).toEqual({
      created: false,
      message: original,
    });
    const file = await recordPath(inboxPath);
    const record = JSON.parse(await readFile(file, 'utf8'));
    expect(record.kind).toBe('inbox');
    record.digest = '0'.repeat(64);
    await writeFile(file, `${JSON.stringify(record)}\n`);
    const journal = await readFile(inboxPath);
    await expect(inbox.admit(message, inboxLimits)).rejects.toThrow(
      /Terminal identity/,
    );
    expect(await readFile(inboxPath)).toEqual(journal);
    expect(inbox.get(input)).toEqual(original);
    expect(inbox.listPending()).toEqual([]);
  });

  it('orders lookup after pending mutations and captures the call-time identity', async () => {
    const store = await FileManagedActivationStore.open(activationPath);
    await store.enqueue(activation, activationLimits);
    const cancelling = store.cancelQueued(activation);
    const identity = { ...activation };
    const lookup = store.readTerminal(identity);
    identity.activationId = 'different';
    await cancelling;
    expect(await lookup).toEqual(store.get(activation));

    const inbox = await FileManagedSessionInbox.open(inboxPath);
    await inbox.admit({ ...input, payload: {} }, inboxLimits);
    const finishing = inbox.requestCancel(input);
    const messageIdentity = { ...input };
    const messageLookup = inbox.readTerminal(messageIdentity);
    messageIdentity.messageId = 'different';
    expect(await messageLookup).toEqual(await finishing);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses symlinked index directories and leaf records',
    async () => {
      const store = await released();
      await store.readTerminal(activation);
      const file = await recordPath(activationPath);
      const outside = path.join(root, 'outside.json');
      await copyFile(file, outside);
      await rm(file);
      await symlink(outside, file);
      await expect(store.readTerminal(activation)).rejects.toThrow();
      await rm(`${activationPath}.terminal-identities`, { recursive: true });
      const outsideDirectory = path.join(root, 'outside');
      await mkdir(outsideDirectory);
      await symlink(
        outsideDirectory,
        `${activationPath}.terminal-identities`,
        'dir',
      );
      await expect(store.readTerminal(activation)).rejects.toThrow(
        /real directory/,
      );
    },
  );
});
