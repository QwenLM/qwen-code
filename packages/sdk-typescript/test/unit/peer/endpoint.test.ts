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
  MAX_REMEMBERED_MESSAGES,
  MAX_TRACKED_SENDS,
  PeerEndpoint,
  type PeerEndpointOptions,
  type PeerInboundMessage,
  type PeerReceipt,
  type PeerSendResult,
} from '../../../src/peer/endpoint.js';
import {
  buildDeliveryStatusFrame,
  buildUserFrame,
  MAX_FRAME_CHARS,
  type BuildDeliveryStatusFields,
  type PeerControlFrame,
  type PeerFrame,
} from '../../../src/peer/frames.js';
import { startPeerInbox, type PeerInbox } from '../../../src/peer/inbox.js';
import {
  readPidNamespaceId,
  readProcStartToken,
} from '../../../src/peer/identity.js';
import { flattenPeerLabel, MAX_LABEL_CHARS } from '../../../src/peer/label.js';
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

const CONTROLLER_TOKEN = `qpc_${'a'.repeat(64)}`;

/** The tokens auth lines presented, in the order connections ended. */
function authTokens(lines: readonly string[]): Array<string | undefined> {
  return lines
    .map((line) => JSON.parse(line) as { type: string; token?: string })
    .filter((line) => line.type === 'auth')
    .map((line) => line.token);
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
    const cap = new PeerSendError('Already sending 64 frames', 'EBUSY', {
      local: true,
    });
    expect(describeSendFailure(cap)).toMatch(/nothing was written/);
    expect(describeSendFailure(cap)).not.toMatch(/that session is alive/);
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

  it('presents the controller token only on a send marked controller', async () => {
    const lines: string[] = [];
    const capturePath = path.join(root, 'capture.sock');
    servers.push(await listenForLines(capturePath, lines));
    const plain = await start('plain');
    const trusted = await start('trusted', {
      controllerToken: CONTROLLER_TOKEN,
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
    // Holding a token is not presenting it: an unmarked send from the same
    // endpoint uses the record's own token like any other.
    expect((await trusted.send({ to: 'capture', content: 'x' })).kind).toBe(
      'sent',
    );
    expect(
      (await trusted.send({ to: 'capture', content: 'x', controller: true }))
        .kind,
    ).toBe('sent');
    expect(authTokens(lines)).toEqual([
      'record-token',
      'record-token',
      CONTROLLER_TOKEN,
    ]);
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
  it('refuses a controller token no session would accept, and a controller send without one', async () => {
    for (const controllerToken of ['', '   ', 'record-token', 'qpc_']) {
      await expect(
        PeerEndpoint.start({ name: 'x', qwenHome: home, controllerToken }),
      ).rejects.toMatchObject({ code: 'invalid-controller-token' });
    }
    expect(fs.existsSync(home)).toBe(false);
    const plain = await start('plain');
    await expect(
      plain.send({ to: 'anyone', content: 'x', controller: true }),
    ).rejects.toMatchObject({ code: 'invalid-controller-token' });
  });

  it('will not hand the controller token to a copy of a session record', async () => {
    const lines: string[] = [];
    const originalPath = path.join(root, 'original.sock');
    const copyPath = path.join(root, 'copy.sock');
    servers.push(await listenForLines(originalPath, lines));
    servers.push(await listenForLines(copyPath, lines));
    const trusted = await start('trusted', {
      controllerToken: CONTROLLER_TOKEN,
    });
    for (const [ipcPath, ipcToken] of [
      [originalPath, 'original-token'],
      [copyPath, 'copy-token'],
    ] as const) {
      await publishRecord(trusted.registryDir, {
        sessionId: 'victim-session',
        name: 'victim',
        ipcPath,
        ipcToken,
      });
    }

    expect(
      await trusted.send({ to: 'victim', content: 'x', controller: true }),
    ).toEqual({ kind: 'ambiguous', matches: [] });
    expect(lines).toEqual([]);

    // An unmarked send keeps the usual collapse of one session seen twice,
    // and presents the chosen record's own token.
    expect((await trusted.send({ to: 'victim', content: 'x' })).kind).toBe(
      'sent',
    );
    expect(authTokens(lines)).toHaveLength(1);
    expect(authTokens(lines)[0]).not.toBe(CONTROLLER_TOKEN);
  });

  it('reaches another endpoint unmarked, and not with a controller send', async () => {
    const messages: string[] = [];
    const trusted = await start('trusted', {
      controllerToken: CONTROLLER_TOKEN,
    });
    await start('beta', {
      onMessage: (message) => {
        messages.push(message.content);
      },
    });
    const plainId = msgIdOf(
      await trusted.send({ to: 'beta', content: 'plain' }),
    );
    expect(
      await trusted.awaitReceipt(plainId, { timeoutMs: 5_000 }),
    ).toMatchObject({ status: 'delivered' });

    const marked = await trusted.send({
      to: 'beta',
      content: 'controller',
      controller: true,
    });
    expect(['sent', 'failed']).toContain(marked.kind);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(messages).toEqual(['plain']);
  });

  it('offers only addresses that select one session when a name is ambiguous', async () => {
    const alpha = await start('alpha');
    const blocked = await start('x');
    await start('x');
    // Literal names that take both of the blocked session's other addresses.
    await start(`x [${blocked.ref}]`);
    await start(`[${blocked.ref}]`);

    const result = await alpha.send({ to: 'x', content: 'hi' });
    expect(result.kind).toBe('ambiguous');
    const matches = result.kind === 'ambiguous' ? result.matches : [];
    expect(matches).toHaveLength(1);
    expect(matches).not.toContain(`x [${blocked.ref}]`);
    expect((await alpha.send({ to: matches[0]!, content: 'hi' })).kind).toBe(
      'sent',
    );
  });

  it('refuses a send that overlaps close() rather than writing from a closed endpoint', async () => {
    const onMessage = vi.fn();
    const alpha = await start('alpha');
    await start('beta', { onMessage });
    // Settled into a value at once: the rejection lands while close() is
    // still being awaited, before anything else could observe it.
    const sending = alpha
      .send({ to: 'beta', content: 'late' })
      .catch((error: unknown) => error);
    await alpha.close();
    expect(await sending).toMatchObject({ code: 'closed' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('flattens the reason a recipient writes before handing it on', async () => {
    const receipts: PeerReceipt[] = [];
    const alpha = await start('alpha', {
      onReceipt: (receipt) => receipts.push(receipt),
    });
    await silentSession(alpha.registryDir);
    const msgId = msgIdOf(await alpha.send({ to: 'silent', content: 'x' }));
    await sendPeerFrame(
      alpha.ipcPath,
      buildDeliveryStatusFrame({
        status: 'denied',
        origMsgId: msgId,
        reason: `denied\u001b[31m\n\u202e${'r'.repeat(5_000)}`,
      }),
      { authToken: alpha.ipcToken },
    );
    expect(receipts).toHaveLength(1);
    const reason = receipts[0]!.reason!;
    expect(reason.includes('\u001b')).toBe(false);
    expect(reason.includes('\n')).toBe(false);
    expect(reason.includes('\u202e')).toBe(false);
    expect(Array.from(reason).length).toBeLessThanOrEqual(MAX_LABEL_CHARS);
  });

  it('forgets the oldest sends past its bound, and keeps sending', async () => {
    const alpha = await start('alpha');
    await silentSession(alpha.registryDir);
    const ids: string[] = [];
    for (let i = 0; i <= MAX_TRACKED_SENDS; i += 1) {
      ids.push(msgIdOf(await alpha.send({ to: 'silent', content: `m${i}` })));
    }
    // Forgotten, so the wait ends at once instead of running out its time.
    const started = Date.now();
    expect(
      await alpha.awaitReceipt(ids[0]!, { timeoutMs: 10_000 }),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(
      await alpha.awaitReceipt(ids.at(-1)!, { timeoutMs: 20 }),
    ).toBeUndefined();
  });

  it('forgets the oldest answered ids past its bound, and keeps reading', async () => {
    const onMessage = vi.fn();
    const beta = await start('beta', { onMessage });
    const frames = Array.from({ length: MAX_REMEMBERED_MESSAGES + 1 }, (_, i) =>
      buildUserFrame({ content: `m${i}` }),
    );
    const deliver = (frame: PeerFrame) =>
      sendPeerFrame(beta.ipcPath, frame, { authToken: beta.ipcToken });
    for (const frame of frames) await deliver(frame);
    expect(onMessage).toHaveBeenCalledTimes(MAX_REMEMBERED_MESSAGES + 1);

    await deliver(frames.at(-1)!);
    expect(onMessage).toHaveBeenCalledTimes(MAX_REMEMBERED_MESSAGES + 1);
    await deliver(frames[0]!);
    expect(onMessage).toHaveBeenCalledTimes(MAX_REMEMBERED_MESSAGES + 2);
  });

  it('closes its inbox again when the record cannot be written', async () => {
    const notAHome = path.join(root, 'not-a-home');
    fs.writeFileSync(notAHome, '');
    const socketPath = path.join(root, 'rollback.sock');
    await expect(
      PeerEndpoint.start({
        name: 'x',
        qwenHome: notAHome,
        socketPath,
        closeOnExit: false,
        keepAlive: false,
      }),
    ).rejects.toMatchObject({ code: 'registry-unwritable' });
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('reports a receipt callback that throws', async () => {
    const errors: Error[] = [];
    const alpha = await start('alpha', {
      onReceipt: () => {
        throw new Error('receipt boom');
      },
      onError: (error) => errors.push(error),
    });
    await start('beta', { onMessage: () => {} });
    const msgId = msgIdOf(await alpha.send({ to: 'beta', content: 'x' }));
    expect(await alpha.awaitReceipt(msgId, { timeoutMs: 5_000 })).toMatchObject(
      { status: 'delivered' },
    );
    expect(errors.map((error) => error.message)).toEqual(['receipt boom']);
  });

  it('hooks process exit by default', async () => {
    const before = process.listenerCount('exit');
    counter += 1;
    const endpoint = await PeerEndpoint.start({
      name: 'defaults',
      qwenHome: home,
      socketPath: path.join(root, `e${counter}.sock`),
      keepAlive: false,
    });
    endpoints.push(endpoint);
    expect(process.listenerCount('exit')).toBe(before + 1);
    await endpoint.close();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('treats another record with its own session id as itself, not as a peer', async () => {
    const alpha = await start('alpha', { sessionId: 'stable-id' });
    const elsewhere = await startPeerInbox({
      socketPath: path.join(root, 'elsewhere.sock'),
      requiredToken: 'elsewhere-token',
      onFrame: () => {},
      keepAlive: false,
    });
    inboxes.push(elsewhere);
    await publishRecord(alpha.registryDir, {
      sessionId: 'stable-id',
      name: 'alpha-elsewhere',
      ipcPath: elsewhere.socketPath,
      ipcToken: 'elsewhere-token',
    });
    expect(await alpha.list()).toEqual([]);
    expect(await alpha.send({ to: 'alpha-elsewhere', content: 'x' })).toEqual({
      kind: 'self',
    });
  });

  it('forgets a send that never left, and keeps one that may still be read', async () => {
    const receipts: PeerReceipt[] = [];
    const alpha = await start('alpha', {
      onReceipt: (receipt) => receipts.push(receipt),
    });
    await silentSession(alpha.registryDir);
    const oversized = await alpha.send({
      to: 'silent',
      content: 'x'.repeat(MAX_FRAME_CHARS),
    });
    expect(oversized).toMatchObject({ kind: 'failed', code: 'EMSGSIZE' });
    expect(oversized).not.toHaveProperty('msgId');

    const held: net.Socket[] = [];
    const stuckPath = path.join(root, 'stuck.sock');
    const stuck = net.createServer({ allowHalfOpen: true }, (socket) => {
      held.push(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => stuck.listen(stuckPath, resolve));
    try {
      await publishRecord(alpha.registryDir, {
        sessionId: 'stuck-session',
        name: 'stuck',
        ipcPath: stuckPath,
        ipcToken: 'stuck-token',
      });
      const timedOut = await alpha.send({ to: 'stuck', content: 'x' });
      expect(timedOut).toMatchObject({
        kind: 'failed',
        code: 'ETIMEDOUT',
        msgId: expect.any(String),
      });
      const msgId = timedOut.kind === 'failed' ? timedOut.msgId! : '';
      await sendPeerFrame(
        alpha.ipcPath,
        buildDeliveryStatusFrame({ status: 'delivered', origMsgId: msgId }),
        { authToken: alpha.ipcToken },
      );
      expect(receipts.map((receipt) => receipt.status)).toEqual(['delivered']);
    } finally {
      for (const socket of held) socket.destroy();
      stuck.close();
    }
  });
});
