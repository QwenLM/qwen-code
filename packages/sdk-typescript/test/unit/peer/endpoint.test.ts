/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerSendError, sendPeerFrame } from '../../../src/peer/client.js';
import {
  describeSendFailure,
  PeerEndpoint,
  type PeerEndpointOptions,
  type PeerInboundMessage,
  type PeerReceipt,
  type PeerSendResult,
} from '../../../src/peer/endpoint.js';
import {
  buildDeliveryStatusFrame,
  buildUserFrame,
  type BuildDeliveryStatusFields,
  type PeerControlFrame,
  type PeerFrame,
} from '../../../src/peer/frames.js';
import { startPeerInbox, type PeerInbox } from '../../../src/peer/inbox.js';
import {
  readPidNamespaceId,
  readProcStartToken,
} from '../../../src/peer/identity.js';
import { flattenPeerLabel } from '../../../src/peer/label.js';
import {
  listenForLines,
  makeTempRoot,
  noUnixSockets,
  publishRecord,
} from './helpers.js';

function msgIdOf(result: PeerSendResult): string {
  if (result.kind !== 'sent') {
    throw new Error(`expected a sent result, got ${JSON.stringify(result)}`);
  }
  return result.msgId;
}

describe('describeSendFailure', () => {
  it('says what to do next for each kind of failure', () => {
    expect(describeSendFailure(new PeerSendError('x', 'ECONNREFUSED'))).toMatch(
      /stale/,
    );
    expect(describeSendFailure(new PeerSendError('x', 'EAGAIN'))).toMatch(
      /retry/,
    );
    expect(describeSendFailure(new PeerSendError('x', 'ETIMEDOUT'))).toMatch(
      /rather than re-sending/,
    );
    expect(describeSendFailure(new PeerSendError('as is', 'EMSGSIZE'))).toBe(
      'as is',
    );
  });
});

describe.skipIf(noUnixSockets)('PeerEndpoint', () => {
  let root: string;
  let home: string;
  let counter: number;
  const endpoints: PeerEndpoint[] = [];
  const inboxes: PeerInbox[] = [];
  const servers: net.Server[] = [];

  beforeEach(() => {
    root = makeTempRoot();
    home = path.join(root, 'home');
    counter = 0;
  });

  afterEach(async () => {
    await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
    await Promise.all(inboxes.splice(0).map((inbox) => inbox.close()));
    for (const server of servers.splice(0)) server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function start(
    name: string,
    options: Partial<PeerEndpointOptions> = {},
  ): Promise<PeerEndpoint> {
    counter += 1;
    const endpoint = await PeerEndpoint.start({
      name,
      qwenHome: home,
      socketPath: path.join(root, `e${counter}.sock`),
      closeOnExit: false,
      keepAlive: false,
      ...options,
    });
    endpoints.push(endpoint);
    return endpoint;
  }

  /** An inbox that never answers, published as a session. */
  async function silentSession(
    registryDir: string,
    name = 'silent',
  ): Promise<{ inbox: PeerInbox; frames: PeerFrame[] }> {
    const frames: PeerFrame[] = [];
    const inbox = await startPeerInbox({
      socketPath: path.join(root, `${name}.sock`),
      requiredToken: 'silent-token',
      onFrame: (frame) => frames.push(frame),
      keepAlive: false,
    });
    inboxes.push(inbox);
    await publishRecord(registryDir, {
      sessionId: `${name}-session`,
      name,
      ipcPath: inbox.socketPath,
      ipcToken: 'silent-token',
    });
    return { inbox, frames };
  }

  it('publishes a record that names its inbox', async () => {
    const endpoint = await start('  voice\nbridge ', { version: '1.2.3' });
    const record = JSON.parse(fs.readFileSync(endpoint.recordPath, 'utf8'));
    expect(record).toEqual({
      schemaVersion: 1,
      pid: process.pid,
      procStart: readProcStartToken(process.pid),
      pidNs: readPidNamespaceId(),
      sessionId: endpoint.sessionId,
      cwd: process.cwd(),
      name: 'voice bridge',
      startedAt: endpoint.startedAt,
      qwenVersion: '1.2.3',
      kind: 'external',
      ipcPath: endpoint.ipcPath,
      ipcToken: endpoint.ipcToken,
    });
    expect(endpoint.ipcToken).toMatch(/^[0-9a-f]{64}$/);
    expect(path.dirname(endpoint.recordPath)).toBe(path.join(home, 'sessions'));
    expect(fs.existsSync(endpoint.ipcPath)).toBe(true);
  });

  it('refuses options it cannot publish, and leaves nothing behind', async () => {
    await expect(
      PeerEndpoint.start({ name: ' \n ', qwenHome: home }),
    ).rejects.toMatchObject({
      name: 'PeerEndpointError',
      code: 'invalid-name',
    });
    await expect(
      PeerEndpoint.start({ name: 'x', kind: 'Voice', qwenHome: home }),
    ).rejects.toMatchObject({ code: 'invalid-kind' });
    await expect(
      PeerEndpoint.start({ name: 'x', sessionId: '  ', qwenHome: home }),
    ).rejects.toMatchObject({ code: 'invalid-session-id' });
    await expect(
      PeerEndpoint.start({
        name: 'x',
        qwenHome: home,
        socketPath: 'relative.sock',
      }),
    ).rejects.toMatchObject({ code: 'bind-failed' });
    expect(fs.existsSync(home)).toBe(false);
  });

  it('lists the other sessions, never itself', async () => {
    const alpha = await start('alpha');
    const beta = await start('beta', { kind: 'voice-relay' });
    expect(await alpha.list()).toEqual([
      {
        sessionId: beta.sessionId,
        name: 'beta',
        ref: beta.ref,
        address: 'beta',
        cwd: flattenPeerLabel(process.cwd()),
        pid: process.pid,
        kind: 'voice-relay',
        startedAt: beta.startedAt,
      },
    ]);
  });

  it('delivers a message by name and reports the receipt', async () => {
    const receipts: PeerReceipt[] = [];
    const messages: PeerInboundMessage[] = [];
    const alpha = await start('alpha', {
      onReceipt: (receipt) => receipts.push(receipt),
    });
    const beta = await start('beta', {
      onMessage: (message) => {
        messages.push(message);
      },
    });

    const result = await alpha.send({
      to: 'beta',
      content: 'status?',
      priority: 'now',
    });
    expect(result).toMatchObject({
      kind: 'sent',
      peer: { name: 'beta', sessionId: beta.sessionId, address: 'beta' },
    });
    const msgId = msgIdOf(result);

    const receipt = await alpha.awaitReceipt(msgId, { timeoutMs: 5_000 });
    expect(receipt).toMatchObject({
      msgId,
      address: 'beta',
      status: 'delivered',
      previous: 'pending',
    });
    expect(receipts).toEqual([receipt]);
    expect(messages).toEqual([
      {
        msgId,
        content: 'status?',
        priority: 'now',
        from: alpha.ipcPath,
        fromName: 'alpha',
      },
    ]);
  });

  it('refuses messages when nothing handles them', async () => {
    const alpha = await start('alpha');
    await start('beta');
    const msgId = msgIdOf(await alpha.send({ to: 'beta', content: 'hi' }));
    expect(await alpha.awaitReceipt(msgId, { timeoutMs: 5_000 })).toMatchObject(
      { status: 'refused' },
    );
  });

  it('names what an address could not resolve to', async () => {
    const alpha = await start('alpha');
    const first = await start('beta');
    const second = await start('beta');
    await start('gamma');

    expect(await alpha.send({ to: 'delta', content: 'x' })).toEqual({
      kind: 'not-found',
      suggestions: [],
    });
    const ambiguous = await alpha.send({ to: 'beta', content: 'x' });
    expect(ambiguous.kind).toBe('ambiguous');
    expect(
      ambiguous.kind === 'ambiguous' ? [...ambiguous.matches].sort() : [],
    ).toEqual([`beta [${first.ref}]`, `beta [${second.ref}]`].sort());
    expect(await alpha.send({ to: 'alpha', content: 'x' })).toEqual({
      kind: 'self',
    });
    expect(await alpha.send({ to: `[${alpha.ref}]`, content: 'x' })).toEqual({
      kind: 'self',
    });
    expect(await alpha.send({ to: 'gamma', content: '' })).toMatchObject({
      kind: 'failed',
      peer: { name: 'gamma' },
    });
  });

  it('answers a frame pinned to another session misaddressed, and a repeated id the same as before', async () => {
    const onMessage = vi.fn();
    const beta = await start('beta', { onMessage });
    const replies: PeerFrame[] = [];
    const sender = await startPeerInbox({
      socketPath: path.join(root, 'sender.sock'),
      requiredToken: 'sender-token',
      onFrame: (frame) => replies.push(frame),
      keepAlive: false,
    });
    inboxes.push(sender);
    const deliver = (frame: PeerFrame) =>
      sendPeerFrame(beta.ipcPath, frame, { authToken: beta.ipcToken });

    const elsewhere = buildUserFrame({
      content: 'x',
      from: sender.socketPath,
      replyToken: 'sender-token',
      toSessionId: 'someone-else',
    });
    await deliver(elsewhere);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({
      type: 'control',
      status: 'misaddressed',
      origMsgId: elsewhere.msgId,
      from: beta.ipcPath,
    });

    const once = buildUserFrame({
      content: 'once',
      from: sender.socketPath,
      replyToken: 'sender-token',
    });
    await deliver(once);
    await deliver(once);
    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(
      replies.slice(1).map((frame) => (frame as PeerControlFrame).status),
    ).toEqual(['delivered', 'delivered']);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('applies receipts as state transitions, and ignores the rest', async () => {
    const receipts: PeerReceipt[] = [];
    const alpha = await start('alpha', {
      onReceipt: (receipt) => receipts.push(receipt),
    });
    const silent = await silentSession(alpha.registryDir);
    const ids: string[] = [];
    for (const content of ['one', 'two', 'three', 'four']) {
      ids.push(msgIdOf(await alpha.send({ to: 'silent', content })));
    }
    expect(silent.frames).toHaveLength(4);
    const inject = (fields: BuildDeliveryStatusFields) =>
      sendPeerFrame(alpha.ipcPath, buildDeliveryStatusFrame(fields), {
        authToken: alpha.ipcToken,
      });

    await inject({ status: 'delivered', origMsgId: 'never-sent' });
    await inject({
      status: 'dropped',
      origMsgId: ids[0]!,
      dropReason: 'rate-limited',
      droppedMsgIds: [ids[1]!],
    });
    expect(
      receipts.map((r) => [r.msgId, r.status, r.previous, r.dropReason]),
    ).toEqual([
      [ids[0], 'dropped', 'pending', 'rate-limited'],
      [ids[1], 'dropped', 'pending', 'rate-limited'],
    ]);

    const decided = alpha.awaitReceipt(ids[2]!, {
      final: true,
      timeoutMs: 5_000,
    });
    await inject({ status: 'held', origMsgId: ids[2]! });
    expect(await alpha.awaitReceipt(ids[2]!)).toMatchObject({
      status: 'held',
    });
    await inject({ status: 'delivered', origMsgId: ids[2]! });
    expect(await decided).toMatchObject({
      status: 'delivered',
      previous: 'held',
    });

    // A step backwards, and anything after a drop, are repeats.
    await inject({ status: 'held', origMsgId: ids[2]! });
    await inject({ status: 'delivered', origMsgId: ids[0]! });
    expect(receipts).toHaveLength(4);

    expect(
      await alpha.awaitReceipt(ids[3]!, { timeoutMs: 20 }),
    ).toBeUndefined();
    expect(await alpha.awaitReceipt('never-sent')).toBeUndefined();
    const waiting = alpha.awaitReceipt(ids[3]!, { timeoutMs: 60_000 });
    await alpha.close();
    expect(await waiting).toBeUndefined();
  });

  it('presents a controller token instead of the recipient token when it has one', async () => {
    const lines: string[] = [];
    const capturePath = path.join(root, 'capture.sock');
    servers.push(await listenForLines(capturePath, lines));
    const plain = await start('plain');
    const trusted = await start('trusted', {
      controllerToken: `qpc_${'a'.repeat(64)}`,
    });
    await publishRecord(plain.registryDir, {
      sessionId: 'capture-session',
      name: 'capture',
      ipcPath: capturePath,
      ipcToken: 'record-token',
    });

    expect((await plain.send({ to: 'capture', content: 'x' })).kind).toBe(
      'sent',
    );
    expect((await trusted.send({ to: 'capture', content: 'x' })).kind).toBe(
      'sent',
    );
    expect(
      lines
        .map((line) => JSON.parse(line) as { type: string; token?: string })
        .filter((line) => line.type === 'auth')
        .map((line) => line.token),
    ).toEqual(['record-token', `qpc_${'a'.repeat(64)}`]);
  });

  it('reports a handler that throws or rejects, and still answers delivered', async () => {
    const errors: Error[] = [];
    const alpha = await start('alpha');
    await start('beta', {
      onMessage: (message) => {
        if (message.content === 'sync') throw new Error('sync boom');
        return Promise.reject(new Error('async boom'));
      },
      onError: (error) => errors.push(error),
    });
    for (const content of ['sync', 'async']) {
      const msgId = msgIdOf(await alpha.send({ to: 'beta', content }));
      expect(
        await alpha.awaitReceipt(msgId, { timeoutMs: 5_000 }),
      ).toMatchObject({ status: 'delivered' });
    }
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    expect(errors.map((error) => error.message).sort()).toEqual([
      'async boom',
      'sync boom',
    ]);
  });

  it('removes its record and socket on close, and refuses to act afterwards', async () => {
    const alpha = await start('alpha');
    const { recordPath, ipcPath } = alpha;
    await alpha.close();
    expect(fs.existsSync(recordPath)).toBe(false);
    expect(fs.existsSync(ipcPath)).toBe(false);
    await expect(alpha.list()).rejects.toMatchObject({ code: 'closed' });
    await expect(
      alpha.send({ to: 'anyone', content: 'x' }),
    ).rejects.toMatchObject({ code: 'closed' });
    await expect(alpha.close()).resolves.toBeUndefined();
  });

  it('cleans up from an exit handler, and unhooks it on close', async () => {
    const before = process.listenerCount('exit');
    const exiting = await start('exiting', { closeOnExit: true });
    expect(process.listenerCount('exit')).toBe(before + 1);
    const hook = process.listeners('exit').at(-1) as (code: number) => void;
    hook(0);
    expect(fs.existsSync(exiting.recordPath)).toBe(false);
    expect(fs.existsSync(exiting.ipcPath)).toBe(false);
    expect(process.listenerCount('exit')).toBe(before);

    const closing = await start('closing', { closeOnExit: true });
    expect(process.listenerCount('exit')).toBe(before + 1);
    await closing.close();
    expect(process.listenerCount('exit')).toBe(before);
  });
});
