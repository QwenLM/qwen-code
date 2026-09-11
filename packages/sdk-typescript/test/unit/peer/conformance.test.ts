/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The peer endpoint against Qwen Code's own implementation of the same
 * protocol, in both directions.
 *
 * `@qwen-code/sdk/peer` shares no code with a Qwen Code session: it was
 * written from the cross-session protocol page. So every place the two
 * could disagree — what a record looks like, when it counts as live, how a
 * frame parses, which token a connection presents, what a receipt says — is
 * exercised here with one side from each. A failure means one of them, or
 * the page, is wrong.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as coreControllers from '../../../../core/src/ipc/peer-controllers.js';
import * as coreDirectory from '../../../../core/src/ipc/peer-directory.js';
import * as coreEnvelope from '../../../../core/src/ipc/peer-envelope.js';
import * as coreFrames from '../../../../core/src/ipc/peer-frames.js';
import * as coreSend from '../../../../core/src/ipc/peer-send.js';
import * as coreSocketPath from '../../../../core/src/ipc/socket-path.js';
import * as coreClient from '../../../../core/src/ipc/uds-client.js';
import * as coreInbox from '../../../../core/src/ipc/uds-inbox.js';
import * as coreRegistry from '../../../../core/src/services/session-registry.js';
import * as coreLiveness from '../../../../core/src/utils/process-liveness.js';
import * as sdk from '../../../src/peer/index.js';
import {
  isSameProcess,
  readPidNamespaceId,
  readProcStartToken,
} from '../../../src/peer/identity.js';
import { boundSessionName } from '../../../src/peer/label.js';
import { makeTempRoot, noUnixSockets } from './helpers.js';

interface CoreArrival {
  frame: coreFrames.PeerFrame;
  auth?: string;
  controller?: { id: string; label: string };
}

describe.skipIf(noUnixSockets)('peer endpoint ↔ Qwen Code session', () => {
  let root: string;
  let home: string;
  let savedHome: string | undefined;
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeEach(() => {
    root = makeTempRoot();
    home = path.join(root, 'home');
    savedHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = home;
    coreRegistry.resetRegisteredRecordPathForTest();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    coreRegistry.resetRegisteredRecordPathForTest();
    if (savedHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function startEndpoint(
    options: Partial<sdk.PeerEndpointOptions> = {},
  ): Promise<sdk.PeerEndpoint> {
    const endpoint = await sdk.PeerEndpoint.start({
      name: 'voice-bridge',
      qwenHome: home,
      socketPath: path.join(root, `sdk-${cleanups.length}.sock`),
      closeOnExit: false,
      keepAlive: false,
      ...options,
    });
    cleanups.push(() => endpoint.close());
    return endpoint;
  }

  /** A session registered and listening the way a hosted Qwen Code session is. */
  async function startCoreSession(
    options: Pick<coreInbox.PeerInboxOptions, 'resolveController'> = {},
  ) {
    const token = 'c'.repeat(64);
    const arrivals: CoreArrival[] = [];
    const registration = await coreRegistry.registerSession({
      sessionId: 'core-session',
      cwd: '/w/core',
      name: 'core-tui',
      kind: 'tui',
      slot: 'own',
    });
    expect(registration.registered).toBe(true);
    const inbox = await coreInbox.startPeerInbox({
      socketPath: path.join(root, 'core.sock'),
      requiredToken: token,
      onFrame: (frame, auth, controller) =>
        arrivals.push({ frame, auth, controller }),
      ...options,
    });
    expect(inbox).not.toBeNull();
    cleanups.push(async () => {
      await inbox!.close();
      await coreRegistry.unregisterSession(registration.slot);
    });
    expect(
      await coreRegistry.patchSessionRecord(
        { ipcPath: inbox!.socketPath, ipcToken: token },
        registration.slot,
      ),
    ).toBe(true);
    return { inbox: inbox!, token, arrivals, slot: registration.slot };
  }

  it('is listed and reached by a Qwen Code session', async () => {
    const endpoint = await startEndpoint();

    expect(await coreRegistry.listLiveSessions()).toEqual([
      expect.objectContaining({
        sessionId: endpoint.sessionId,
        name: 'voice-bridge',
        kind: 'external',
        ipcPath: endpoint.ipcPath,
        ipcToken: endpoint.ipcToken,
      }),
    ]);
    expect(await coreDirectory.listMessageablePeers()).toEqual([
      expect.objectContaining({
        sessionId: endpoint.sessionId,
        name: endpoint.name,
        ref: endpoint.ref,
        kind: 'external',
      }),
    ]);
  });

  it('lists and reaches a Qwen Code session, which reads its frame and answers', async () => {
    const core = await startCoreSession();
    const endpoint = await startEndpoint();

    expect(
      (await endpoint.list()).map((s) => [s.name, s.kind, s.sessionId]),
    ).toEqual([['core-tui', 'tui', 'core-session']]);

    const sent = await endpoint.send({
      to: 'core-tui',
      content: 'open the failing test',
    });
    expect(sent.kind).toBe('sent');
    await vi.waitFor(() => expect(core.arrivals).toHaveLength(1));
    const { frame, auth } = core.arrivals[0]!;
    expect(auth).toBe('peer');
    expect(frame).toMatchObject({
      type: 'user',
      from: endpoint.ipcPath,
      replyToken: endpoint.ipcToken,
      fromName: 'voice-bridge',
      toSessionId: 'core-session',
      message: { role: 'user', content: 'open the failing test' },
    });
    expect(frame).not.toHaveProperty('fromMode');

    const user = frame as coreFrames.PeerUserFrame;
    await coreClient.sendDeliveryStatus(
      user.from!,
      { status: 'held', origMsgId: user.msgId, from: core.inbox.socketPath },
      user.replyToken,
    );
    expect(
      await endpoint.awaitReceipt(user.msgId, { timeoutMs: 5_000 }),
    ).toMatchObject({
      status: 'held',
      previous: 'pending',
      address: 'core-tui',
    });
  });

  it('settles a burst from one folded drop receipt written by a Qwen Code session', async () => {
    const core = await startCoreSession();
    const receipts: sdk.PeerReceipt[] = [];
    const endpoint = await startEndpoint({
      onReceipt: (receipt) => receipts.push(receipt),
    });
    for (const content of ['one', 'two', 'three']) {
      await endpoint.send({ to: 'core-tui', content });
    }
    await vi.waitFor(() => expect(core.arrivals).toHaveLength(3));
    const [first, ...rest] = core.arrivals.map(
      (arrival) => arrival.frame as coreFrames.PeerUserFrame,
    );

    await coreClient.sendDeliveryStatus(
      first!.from!,
      {
        status: 'dropped',
        origMsgId: first!.msgId,
        from: core.inbox.socketPath,
        dropReason: 'rate-limited',
        droppedMsgIds: rest.map((frame) => frame.msgId),
      },
      first!.replyToken,
    );
    await vi.waitFor(() => expect(receipts).toHaveLength(3));
    expect(
      receipts.every(
        (r) => r.status === 'dropped' && r.dropReason === 'rate-limited',
      ),
    ).toBe(true);
    expect(receipts.map((r) => r.msgId).sort()).toEqual(
      [first!, ...rest].map((frame) => frame.msgId).sort(),
    );
  });

  it('receives what a Qwen Code session sends, and its receipt reads back there', async () => {
    const core = await startCoreSession();
    const messages: sdk.PeerInboundMessage[] = [];
    const endpoint = await startEndpoint({
      onMessage: (message) => {
        messages.push(message);
      },
    });

    const outcome = await coreSend.sendToPeer({
      target: 'voice-bridge',
      message: 'tests pass',
      approvalMode: null,
      slot: core.slot,
    });
    expect(outcome.kind).toBe('sent');

    await vi.waitFor(() => expect(core.arrivals).toHaveLength(1));
    expect(messages).toEqual([
      {
        msgId: expect.any(String),
        content: 'tests pass',
        priority: 'next',
        from: core.inbox.socketPath,
        fromName: 'core-tui',
      },
    ]);
    expect(core.arrivals[0]).toMatchObject({
      auth: 'peer',
      frame: {
        type: 'control',
        status: 'delivered',
        origMsgId: messages[0]!.msgId,
        from: endpoint.ipcPath,
      },
    });
  });

  it('is recognised as a trusted controller only with a token the user minted', async () => {
    const grants = path.join(home, 'peer-controllers.json');
    const { token } = await coreControllers.addPeerController(
      'voice-bridge',
      grants,
    );
    const core = await startCoreSession({
      resolveController: (presented) =>
        coreControllers.resolveControllerToken(presented, grants),
    });

    const trusted = await startEndpoint({ controllerToken: token });
    // Holding the token is not presenting it.
    await trusted.send({ to: 'core-tui', content: 'plain' });
    await vi.waitFor(() => expect(core.arrivals).toHaveLength(1));
    expect(core.arrivals[0]).toMatchObject({ auth: 'peer' });
    await trusted.send({ to: 'core-tui', content: 'go', controller: true });
    await vi.waitFor(() => expect(core.arrivals).toHaveLength(2));
    expect(core.arrivals[1]).toMatchObject({
      auth: 'controller',
      controller: { label: 'voice-bridge' },
    });

    const forged = await startEndpoint({
      name: 'forged',
      controllerToken: `qpc_${'0'.repeat(64)}`,
    });
    await forged.send({ to: 'core-tui', content: 'go', controller: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(core.arrivals).toHaveLength(2);
  });

  it('parses every line the way a Qwen Code session does', () => {
    const user = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        msgV: 1,
        msgId: 'm-1',
        type: 'user',
        priority: 'next',
        message: { role: 'user', content: 'x' },
        ...overrides,
      });
    const control = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        msgV: 1,
        msgId: 'c-1',
        type: 'control',
        action: 'delivery_status',
        status: 'held',
        origMsgId: 'm-1',
        ...overrides,
      });
    const lines = [
      user(),
      user({
        from: '/tmp/a.sock',
        replyToken: 'r',
        fromName: 'n',
        fromMode: 'bypass',
        toSessionId: 's',
        priority: 'now',
        extra: true,
      }),
      user({ priority: 7, fromMode: 'yolo', from: 5, replyToken: null }),
      user({ msgV: 0 }),
      user({ msgV: 2 }),
      user({ msgV: '1' }),
      user({ msgId: 'all' }),
      user({ msgId: 'A-l-L' }),
      user({ msgId: 'has space' }),
      user({ msgId: '_lead' }),
      user({ msgId: 'x'.repeat(64) }),
      user({ msgId: 'x'.repeat(65) }),
      user({ message: { role: 'user', content: '' } }),
      user({ message: { role: 'system', content: 'x' } }),
      user({ message: ['x'] }),
      user({ type: 'auth' }),
      control(),
      control({ reason: 'why', from: '/tmp/b.sock' }),
      control({ dropReason: 'duplicate', droppedMsgIds: ['a'] }),
      control({
        status: 'dropped',
        dropReason: 'queue-full',
        droppedMsgIds: [
          'ok',
          'all',
          'bad id',
          7,
          ...Array.from({ length: 300 }, (_, i) => `id${i}`),
        ],
      }),
      control({ status: 'dropped', dropReason: 'bored', droppedMsgIds: 'a' }),
      control({ status: 'dropped', droppedMsgIds: [] }),
      control({ status: 'read' }),
      control({ origMsgId: '' }),
      control({ origMsgId: 3 }),
      control({ action: 'rename' }),
      '[]',
      'null',
      '"string"',
      'not json',
      '{"msgV":1,"msgId":"m","type":"user"}',
    ];
    for (const line of lines) {
      // The line rides along so a failure names the input that diverged.
      expect({ line, parsed: sdk.parsePeerFrame(line) }).toEqual({
        line,
        parsed: coreFrames.parsePeerFrame(line),
      });
    }
    for (const line of [
      '{"msgV":1,"type":"auth","token":"t"}',
      '{"msgV":2,"type":"auth","token":"t"}',
      '{"msgV":1,"type":"auth","token":""}',
      '{"msgV":1,"type":"auth"}',
      '{"msgV":1,"type":"user","token":"t"}',
      'nope',
    ]) {
      expect({ line, token: sdk.parsePeerAuthLine(line) }).toEqual({
        line,
        token: coreFrames.parsePeerAuthLine(line),
      });
    }
    expect(sdk.buildAuthLine('tok')).toBe(coreFrames.buildAuthLine('tok'));
  });

  it('builds frames a Qwen Code session builds, up to the fresh id and the prose', () => {
    const fields = {
      content: 'hello',
      from: '/tmp/me.sock',
      replyToken: 'r',
      fromName: 'me',
      fromMode: 'prompting' as const,
      toSessionId: 's',
      priority: 'now' as const,
    };
    const withoutId = <T extends { msgId: string }>(frame: T) => ({
      ...frame,
      msgId: 'id',
    });
    expect(withoutId(sdk.buildUserFrame(fields))).toEqual(
      withoutId(coreFrames.buildUserFrame(fields)),
    );
    const receipt = {
      status: 'dropped' as const,
      origMsgId: 'm',
      from: '/tmp/r.sock',
      dropReason: 'duplicate' as const,
      droppedMsgIds: ['a', 'b'],
    };
    const withoutProse = <T extends { msgId: string; reason?: string }>(
      frame: T,
    ) => ({ ...frame, msgId: 'id', reason: 'prose' });
    expect(withoutProse(sdk.buildDeliveryStatusFrame(receipt))).toEqual(
      withoutProse(coreFrames.buildDeliveryStatusFrame(receipt)),
    );
  });

  it('judges the registry directory the way a Qwen Code session does', async () => {
    const endpoint = await startEndpoint();
    const dir = path.join(home, 'sessions');
    const base = {
      schemaVersion: 1,
      pid: process.pid,
      procStart: readProcStartToken(process.pid),
      pidNs: readPidNamespaceId(),
      cwd: '/w',
      name: 'planted',
      startedAt: 5,
      qwenVersion: null,
    };
    const dead = 2 ** 22 + 11;
    const plant = (name: string, contents: Record<string, unknown>) =>
      fs.writeFileSync(path.join(dir, name), JSON.stringify(contents));
    plant(`${process.pid}-0000000a.json`, {
      ...base,
      sessionId: 'live-minted',
      kind: 'serve',
      ipcPath: '/tmp/x.sock',
    });
    plant(`${process.pid}-0000000b.json`, {
      ...base,
      sessionId: 'odd-kind',
      kind: 'Not-Valid',
      ipcToken: '',
    });
    plant('999999.json', { ...base, sessionId: 'name-mismatch' });
    plant(`0${process.pid}.json`, { ...base, sessionId: 'padded' });
    plant('2026-notes.json', { ...base, sessionId: 'notes', pid: 2026 });
    plant(`${process.pid}-0000000c.json`, {
      ...base,
      sessionId: 'other-namespace',
      pidNs: -1,
    });
    plant(`${process.pid}-0000000d.json`, {
      ...base,
      sessionId: 'newer',
      schemaVersion: 2,
    });
    if (process.platform === 'linux') {
      const [boot, ticks] = readProcStartToken(process.pid)!.split(':');
      plant(`${process.pid}-0000000e.json`, {
        ...base,
        sessionId: 'reused-pid',
        procStart: `${boot}:${Number(ticks) + 1}`,
      });
      plant(`${process.pid}-0000000f.json`, {
        ...base,
        sessionId: 'no-namespace',
        pidNs: null,
      });
    }
    plant(`${dead}.json`, {
      ...base,
      sessionId: 'dead',
      pid: dead,
      procStart: null,
    });

    const bySession = (a: { sessionId: string }, b: { sessionId: string }) =>
      a.sessionId.localeCompare(b.sessionId);
    const fromSdk = (await sdk.readLiveSessionRecords(dir)).sort(bySession);
    // Read second: a Qwen Code session also clears away the dead record.
    const fromCore = (await coreRegistry.listLiveSessions()).sort(bySession);

    expect(fromSdk).toEqual(fromCore);
    expect(fromSdk.map((r) => r.sessionId)).toEqual(
      [endpoint.sessionId, 'live-minted', 'odd-kind'].sort(),
    );
  });

  it('derives identity, names and refs the way a Qwen Code session does', async () => {
    expect(readProcStartToken(process.pid)).toBe(
      coreLiveness.readProcStartToken(process.pid),
    );
    expect(readPidNamespaceId()).toBe(coreLiveness.readPidNamespaceId());
    expect(isSameProcess(process.pid, readProcStartToken(process.pid))).toBe(
      coreLiveness.isSameProcess(process.pid, readProcStartToken(process.pid)),
    );

    const awkward = [
      'plain',
      ' two\nlines\t',
      'bidi\u202eoverride\u200bzero-width',
      'x'.repeat(250),
      '\u{1F600}'.repeat(45),
      '\u{1F600}'.repeat(250),
      'voice\u{E0041}\u{E0042}bridge',
      'a\u180eb\ufff9c',
      '',
    ];
    for (const value of awkward) {
      expect(sdk.flattenPeerLabel(value)).toBe(
        coreEnvelope.flattenPeerLabel(value),
      );
      expect(sdk.peerRef(value)).toBe(coreDirectory.peerRef(value));
      expect(sdk.deriveSessionName(`/w/${value}`, 'id')).toBe(
        coreRegistry.deriveSessionName(`/w/${value}`, 'id'),
      );
    }

    const longName = `named ${'\u{1F600}'.repeat(50)}`;
    const registration = await coreRegistry.registerSession({
      sessionId: 'named-session',
      cwd: '/w',
      name: longName,
      slot: 'own',
    });
    cleanups.push(() => coreRegistry.unregisterSession(registration.slot));
    const [record] = await coreRegistry.listLiveSessions();
    expect(record?.name).toBe(boundSessionName(longName));
  });

  it('agrees on every limit the protocol page publishes', () => {
    expect(sdk.PEER_FRAME_VERSION).toBe(coreFrames.PEER_FRAME_VERSION);
    expect(sdk.MAX_FRAME_CHARS).toBe(coreFrames.MAX_FRAME_BYTES);
    expect(sdk.MAX_DROPPED_MSG_IDS).toBe(coreFrames.MAX_DROPPED_MSG_IDS);
    expect(sdk.SEND_TIMEOUT_MS).toBe(coreClient.SEND_TIMEOUT_MS);
    expect(sdk.PROBE_TIMEOUT_MS).toBe(coreClient.PROBE_TIMEOUT_MS);
    expect(sdk.MAX_CONCURRENT_SENDS).toBe(coreClient.MAX_CONCURRENT_SENDS);
    expect(sdk.MAX_PEER_CONNECTIONS).toBe(coreInbox.MAX_PEER_CONNECTIONS);
    expect(sdk.LINE_DEADLINE_MS).toBe(coreInbox.LINE_DEADLINE_MS);
    expect(sdk.MAX_SOCKET_PATH_BYTES).toBe(
      coreSocketPath.MAX_SOCKET_PATH_BYTES,
    );
    expect(sdk.MAX_SESSION_NAME_CHARS).toBe(
      coreRegistry.MAX_SESSION_NAME_CHARS,
    );
    expect(sdk.SESSION_REGISTRY_SCHEMA_VERSION).toBe(
      coreRegistry.SESSION_REGISTRY_SCHEMA_VERSION,
    );
    const nonce = (candidates: string[]) =>
      candidates.map((candidate) =>
        candidate.replace(/qwen-socks-[0-9a-f]{16}/, 'qwen-socks-<nonce>'),
      );
    expect(nonce(sdk.resolveInboxCandidates(4242))).toEqual(
      nonce(coreSocketPath.resolvePeerSocketCandidates(4242)),
    );
  });
});
