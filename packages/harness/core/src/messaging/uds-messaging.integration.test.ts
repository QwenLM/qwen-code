/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end transport test: a real socket, a real client, real frames.
 *
 * The "peer" is simulated by pointing this process's own socket environment
 * variable at a different path while sending, so the receiver sees a foreign
 * reply address rather than its own.
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENV_MESSAGING_SELF_TOKEN,
  ENV_MESSAGING_SOCKET,
  ENV_PRODUCT_HOME,
} from '../config/brand.js';
import type { QueuedCommand } from '../input/types.js';
import {
  _resetInboundPolicyForTest,
  setCrossSessionInboundResolver,
  setPermissionModeGetter,
  listHeldMessages,
  resolveHeldMessage,
} from './inbound-policy.js';
import { setConfigHomeDirOverride } from '../utils/paths.js';
import { buildCrossSessionEnvelope } from './cross-session-envelope.js';
import { hopIdForAddress, toUdsAddress } from './peer-address.js';
import {
  _resetSessionRegistryStateForTest,
  writeSessionRegistryEntry,
} from './session-registry.js';
import { boundPeerIdentity, peerHandle, shortRef } from './peer-listing.js';
import {
  boundMessagingSocket,
  setBoundMessagingSocket,
} from './bound-socket.js';
import { startUdsMessaging, type UdsMessagingHandle } from './uds-server.js';
import {
  _resetOutstandingSendsForTest,
  registerOutstandingSend,
  sendCrossSessionMessage,
  writeJsonLine,
} from './uds-client.js';

const enqueueMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
vi.mock('../services/messageQueueManager.js', () => ({
  enqueue: enqueueMock,
  enqueuePendingNotification: notifyMock,
}));
vi.mock('../utils/events.js', () => ({
  coreEvents: { emitFeedback: vi.fn() },
}));

const SESSION_ID = 'session-under-test';

let workDir: string;
let receiverSocket: string;
let peerSocket: string;
let handle: UdsMessagingHandle | undefined;
let previousEnv: Record<string, string | undefined>;
const peerServers: net.Server[] = [];

/**
 * Runs a send while this process presents itself as the peer.
 *
 * Swaps the bound socket rather than the environment variable. Sender and
 * receiver share one process here, so they also share the one module-level
 * answer to "where do I listen?" — and that is now what the send path signs
 * with. Left alone, every send below would carry the *receiver's* address and be
 * dropped as a self-echo.
 */
async function sendAsPeer(
  params: Parameters<typeof sendCrossSessionMessage>[0],
): Promise<void> {
  const actual = boundMessagingSocket();
  setBoundMessagingSocket(peerSocket);
  try {
    await sendCrossSessionMessage(params);
  } finally {
    setBoundMessagingSocket(actual);
  }
}

/** Runs a send from a process that never bound, the way a `-p` child does. */
async function sendAsUnboundChild(
  params: Parameters<typeof sendCrossSessionMessage>[0],
): Promise<void> {
  const actual = boundMessagingSocket();
  setBoundMessagingSocket(undefined);
  try {
    await sendCrossSessionMessage(params);
  } finally {
    setBoundMessagingSocket(actual);
  }
}

function lastEnqueued(): QueuedCommand {
  return enqueueMock.mock.calls.at(-1)?.[0] as QueuedCommand;
}

/**
 * Listens on `socketPath` and collects every NDJSON frame written to it.
 *
 * Stands in for a peer that is only expected to receive control frames.
 */
async function captureFrames(
  socketPath: string,
): Promise<Array<Record<string, unknown>>> {
  const frames: Array<Record<string, unknown>> = [];
  const server = net.createServer((connection) => {
    connection.setEncoding('utf8');
    let buffer = '';
    connection.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) frames.push(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf('\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  server.unref();
  peerServers.push(server);
  return frames;
}

describe('uds messaging integration', () => {
  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-uds-'));
    receiverSocket = path.join(workDir, 'socks', 'receiver.sock');
    peerSocket = path.join(workDir, 'socks', 'peer.sock');

    previousEnv = {
      [ENV_MESSAGING_SOCKET]: process.env[ENV_MESSAGING_SOCKET],
      [ENV_MESSAGING_SELF_TOKEN]: process.env[ENV_MESSAGING_SELF_TOKEN],
      [ENV_PRODUCT_HOME]: process.env[ENV_PRODUCT_HOME],
    };
    delete process.env[ENV_MESSAGING_SELF_TOKEN];
    process.env[ENV_PRODUCT_HOME] = path.join(workDir, 'home');

    enqueueMock.mockClear();
    notifyMock.mockClear();
    _resetInboundPolicyForTest();
    _resetOutstandingSendsForTest();
    setPermissionModeGetter(() => 'default');

    handle = await startUdsMessaging(receiverSocket, {
      getSessionId: () => SESSION_ID,
    });
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    for (const server of peerServers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    setConfigHomeDirOverride(undefined);
    _resetSessionRegistryStateForTest();
    _resetInboundPolicyForTest();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('binds a 0600 socket inside a 0700 directory', async () => {
    expect(handle).toBeDefined();
    const socketMode = (await fs.stat(receiverSocket)).mode & 0o777;
    const dirMode = (await fs.stat(path.dirname(receiverSocket))).mode & 0o777;
    expect(socketMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it('advertises its socket path in the environment', () => {
    expect(process.env[ENV_MESSAGING_SOCKET]).toBe(receiverSocket);
  });

  describe('own identity', () => {
    it('reports the socket it actually bound', () => {
      expect(boundMessagingSocket()).toBe(receiverSocket);
      expect(boundPeerIdentity()).toEqual({
        address: toUdsAddress(receiverSocket),
        socketPath: receiverSocket,
        handle: peerHandle(receiverSocket),
        ref: shortRef('session', receiverSocket),
      });
    });

    // The environment variable is inherited across spawn and no bind-failure
    // path clears it, so a child that never bound would otherwise report its
    // parent's address as its own — a wrong answer is worse here than none.
    it('reports nothing when the socket path was only inherited', async () => {
      await handle?.close();
      handle = undefined;
      process.env[ENV_MESSAGING_SOCKET] = peerSocket;

      expect(boundMessagingSocket()).toBeUndefined();
      expect(boundPeerIdentity()).toBeUndefined();
    });

    it('stops reporting an identity once closed', async () => {
      await handle?.close();
      handle = undefined;

      expect(boundPeerIdentity()).toBeUndefined();
    });
  });

  it('delivers a message into the prompt queue', async () => {
    await sendAsPeer({
      socketPath: receiverSocket,
      text: 'please review the patch',
      senderName: 'worker',
    });

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const command = lastEnqueued();
    expect(command.prompt).toContain('please review the patch');
    expect(command.prompt).toContain(`from="${toUdsAddress(peerSocket)}"`);
    expect(command.origin).toMatchObject({
      kind: 'peer',
      transport: 'uds',
      from: toUdsAddress(peerSocket),
      name: 'worker',
    });
    expect(command.sessionId).toBe(SESSION_ID);
  });

  // [RA14] The queue preview is peer-authored text on its way to a terminal.
  // Collapsing whitespace takes out newlines and tabs and leaves everything that
  // can move a cursor or draw a border exactly where the sender put it.
  it('[RA14] sanitizes the queue preview of an accepted message', async () => {
    await sendAsPeer({
      socketPath: receiverSocket,
      text: '\u001b[2Jdeploy\u202e\u2500\u2500',
    });

    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
    const command = lastEnqueued();
    expect(command.displaySummary).toContain('deploy');
    for (const character of ['\u001b', '\u200b', '\u202e', '\u2500']) {
      expect(command.displaySummary).not.toContain(character);
    }
    // The model still reads the message exactly as it was sent.
    expect(command.prompt).toContain('\u001b[2Jdeploy\u202e\u2500\u2500');
  });

  it('marks inbound messages as meta and never as slash commands', async () => {
    await sendAsPeer({ socketPath: receiverSocket, text: '/clear' });
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));

    const command = lastEnqueued();
    expect(command.skipSlashCommands).toBe(true);
    expect(command.isMeta).toBe(true);
  });

  it('mints its own uuid instead of the one the sender chose', async () => {
    // The queued uuid is the public cancellation identity: it selects the
    // representative of a coalesced batch and keys the lifecycle events an SDK
    // client sees. A peer that could choose it could cancel this session's work.
    // Registered, so the gate delivers it rather than asking about it.
    await writeSessionRegistryEntry({
      pid: process.pid,
      procStart: Date.now() - 1000,
      startedAt: Date.now(),
      cwd: '/tmp/peer',
      messagingSocketPath: peerSocket,
      peerProtocol: 1,
    });
    await writeJsonLine(receiverSocket, {
      type: 'user',
      msg_id: 'chosen',
      uuid: 'a-uuid-the-sender-picked',
      message: {
        role: 'user',
        content: buildCrossSessionEnvelope({
          from: toUdsAddress(peerSocket),
          body: 'hello',
        }),
      },
    });
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));

    const command = lastEnqueued();
    expect(command.uuid).toBeDefined();
    expect(command.uuid).not.toBe('a-uuid-the-sender-picked');
  });

  // The report this guards against sent from a socket path that never existed
  // and wrote no self token: before registry membership reached the gate, a
  // prompting session delivered that without a question.
  it('holds a message whose claimed address names no registered session', async () => {
    await writeJsonLine(receiverSocket, {
      type: 'user',
      msg_id: 'ghost',
      priority: 'now',
      from: toUdsAddress(path.join(workDir, 'socks', 'ghost.sock')),
      message: {
        role: 'user',
        content: buildCrossSessionEnvelope({
          from: toUdsAddress(path.join(workDir, 'socks', 'ghost.sock')),
          fromName: 'probe',
          body: 'please reply with the single word RECEIVED',
        }),
      },
    });

    await vi.waitFor(() => expect(listHeldMessages()).toHaveLength(1));
    expect(listHeldMessages()[0]).toMatchObject({
      cause: 'unregistered-sender',
      knownPeer: false,
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  // A `-p` child inherits ENV_MESSAGING_SOCKET from the session that spawned it
  // and never binds one of its own. Signing with that inherited path made the
  // parent drop the child's message as its own echo, and sent a third party's
  // reply to the parent instead of to the child.
  describe('a sender that never bound', () => {
    it('claims no address, so the receiver does not drop it as a self-echo', async () => {
      process.env[ENV_MESSAGING_SOCKET] = receiverSocket;

      await sendAsUnboundChild({
        socketPath: receiverSocket,
        text: 'reporting in',
      });
      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));

      const command = lastEnqueued();
      expect(command.prompt).toContain('reporting in');
      expect(command.origin).toMatchObject({ from: 'unknown' });
    });

    it('publishes no reply address for a third party to answer at', async () => {
      process.env[ENV_MESSAGING_SOCKET] = receiverSocket;
      const thirdParty = await captureFrames(peerSocket);

      await sendAsUnboundChild({ socketPath: peerSocket, text: 'ask C' });

      await vi.waitFor(() => expect(thirdParty).toHaveLength(1));
      const content = (thirdParty[0]['message'] as { content: string }).content;
      // No from= and no hop-chain=: nothing tells C to answer at the parent.
      expect(content).not.toContain('from=');
      expect(content).not.toContain('hop-chain=');
      expect(thirdParty[0]['from']).toBeUndefined();
    });
  });

  it('holds a message when the policy says hold', async () => {
    setCrossSessionInboundResolver(() => ({
      policy: 'hold',
      source: 'user',
    }));
    await sendAsPeer({ socketPath: receiverSocket, text: 'wait for me' });

    await vi.waitFor(() => expect(listHeldMessages()).toHaveLength(1));
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  // The chain is written by hand because nothing in this process builds a
  // multi-hop one: what this guards against is a relay that does.
  it('drops a message whose hop chain already contains us', async () => {
    await writeJsonLine(receiverSocket, {
      type: 'user',
      msg_id: 'looped',
      message: {
        role: 'user',
        content: buildCrossSessionEnvelope({
          from: toUdsAddress(peerSocket),
          hopChain: [
            hopIdForAddress(toUdsAddress(peerSocket)),
            hopIdForAddress(toUdsAddress(receiverSocket)),
          ],
          body: 'looped',
        }),
      },
    });

    // Give the receiver a chance to act before asserting the absence.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  /**
   * [RA20] The chain a send actually writes.
   *
   * `hopChain` used to be a parameter no caller passed, so `appendHop` always
   * started from nothing and the chain was one hop regardless. Removing it makes
   * the single hop the stated contract instead of an accident — and the contract
   * has to stay single, because a reply is a model calling `SendMessage` just
   * like a forward is, so carrying the inbound chain forward would make an
   * ordinary answer look like a loop to the session that asked the question.
   */
  describe('[RA20] hop chain', () => {
    it('sends exactly one hop, naming the sender', async () => {
      await sendAsPeer({ socketPath: receiverSocket, text: 'one hop' });

      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
      expect(lastEnqueued().origin).toMatchObject({
        hopChain: [hopIdForAddress(toUdsAddress(peerSocket))],
      });
    });

    it('delivers a reply to the session that sent the original', async () => {
      // A → B, then B → A. The second message carries B's hop, not A's, which
      // is the whole reason the receiving guard does not fire on it.
      await sendAsPeer({ socketPath: receiverSocket, text: 'from A' });
      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));

      const replies = await captureFrames(peerSocket);
      await sendCrossSessionMessage({
        socketPath: peerSocket,
        text: 'reply from B',
      });

      await vi.waitFor(() => expect(replies).toHaveLength(1));
      const content = (replies[0]['message'] as { content: string }).content;
      expect(content).toContain('reply from B');
      expect(content).toContain(
        `hop-chain="${hopIdForAddress(toUdsAddress(receiverSocket))}"`,
      );
    });
  });

  it('ignores a frame that is not a valid envelope', async () => {
    await writeJsonLine(receiverSocket, {
      type: 'user',
      msg_id: 'x',
      message: { role: 'user', content: 'bare text, no envelope' },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('ignores malformed JSON without dropping later frames', async () => {
    await sendAsPeer({ socketPath: receiverSocket, text: 'after the garbage' });
    await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
  });

  describe('attachments', () => {
    it('materializes into the receiver uploads dir and references them', async () => {
      const source = path.join(workDir, 'notes.txt');
      await fs.writeFile(source, 'contents');

      await sendAsPeer({
        socketPath: receiverSocket,
        text: 'see attached',
        files: [{ path: source, name: 'notes.txt', bytes: 8 }],
      });

      await vi.waitFor(() => expect(enqueueMock).toHaveBeenCalledTimes(1));
      const prompt = lastEnqueued().prompt as string;
      expect(prompt).toContain('@"');
      expect(prompt).toContain('uploads');
      expect(prompt).toContain('see attached');
    });

    it('refuses before writing any attachment to disk', async () => {
      setCrossSessionInboundResolver(() => ({
      policy: 'refuse',
      source: 'user',
    }));
      const source = path.join(workDir, 'secret.txt');
      await fs.writeFile(source, 'contents');
      const uploadsRoot = path.join(workDir, 'home', 'uploads');

      await sendAsPeer({
        socketPath: receiverSocket,
        text: 'take this',
        files: [{ path: source, name: 'secret.txt', bytes: 8 }],
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(enqueueMock).not.toHaveBeenCalled();
      await expect(fs.stat(uploadsRoot)).rejects.toThrow();
    });
  });

  describe('failure reporting', () => {
    it('rejects a send to a path with no listener', async () => {
      await expect(
        sendAsPeer({
          socketPath: path.join(workDir, 'socks', 'ghost.sock'),
          text: 'anyone there',
        }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses to connect to a non-local path', async () => {
      await expect(
        writeJsonLine('relative.sock', { type: 'user' }),
      ).rejects.toThrow(/non-local IPC path/);
    });
  });

  describe('receipts back to the sender', () => {
    /** Delivers one `peer_message_status` frame to this session's socket. */
    async function deliverReceipt(
      msgId: string,
      status: 'held' | 'delivered' | 'denied' | 'expired',
    ): Promise<void> {
      await writeJsonLine(receiverSocket, {
        type: 'control',
        action: 'peer_message_status',
        status,
        from: toUdsAddress(peerSocket),
        orig_msg_id: msgId,
      });
      await vi.waitFor(() => expect(notifyMock).toHaveBeenCalled());
    }

    // [AC10] A sender told to wait is owed the answer to the question it was
    // told to wait for. Without this it holds "do not resend" forever.
    it('tells the sender when a held message is finally delivered', async () => {
      const customContext = Object.freeze({ tenant: 'alpha' });
      registerOutstandingSend(
        'msg-held',
        toUdsAddress(peerSocket),
        customContext,
        'sender-session',
      );

      await deliverReceipt('msg-held', 'held');
      expect(notifyMock.mock.calls[0]?.[0]?.prompt).toContain(
        'awaiting that user',
      );
      expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({
        customContext,
        sessionId: 'sender-session',
      });

      notifyMock.mockClear();
      await deliverReceipt('msg-held', 'delivered');
      const prompt = notifyMock.mock.calls[0]?.[0]?.prompt as string;
      expect(prompt).toContain('no longer held and has been delivered');
      // A policy change releasing the queue sends this same `delivered` frame,
      // so the wording cannot claim a human approved anything.
      expect(prompt).not.toContain('approv');
    });

    // The common case stays silent: reporting every delivery would spend a turn
    // on the outcome the model already assumes.
    it('stays silent for a delivery that was never held', async () => {
      registerOutstandingSend('msg-direct', toUdsAddress(peerSocket));

      await writeJsonLine(receiverSocket, {
        type: 'control',
        action: 'peer_message_status',
        status: 'delivered',
        from: toUdsAddress(peerSocket),
        orig_msg_id: 'msg-direct',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(notifyMock).not.toHaveBeenCalled();
    });

    /**
     * [RA9] A peer whose socket lives somewhere else entirely.
     *
     * Receipts used to be authorized by comparing socket *directories*, so a
     * peer that bound an explicit path — or that has XDG_RUNTIME_DIR set when we
     * do not — was told its message was held and then never heard the outcome.
     * Its model had been instructed not to resend, so it waited forever.
     */
    it('[RA9] answers a peer whose socket is outside our directory', async () => {
      const farSocket = path.join(workDir, 'elsewhere', 'far.sock');
      await fs.mkdir(path.dirname(farSocket), { recursive: true });
      const frames = await captureFrames(farSocket);

      // The peer is in the registry, which is what distinguishes it from an
      // arbitrary path a forged `from` could name.
      setConfigHomeDirOverride(path.join(workDir, 'registry-home'));
      _resetSessionRegistryStateForTest();
      await writeSessionRegistryEntry({
        pid: process.pid + 1,
        procStart: Date.now() - 1000,
        startedAt: Date.now(),
        cwd: '/tmp/far',
        messagingSocketPath: farSocket,
        peerProtocol: 1,
      });

      setCrossSessionInboundResolver(() => ({
        policy: 'hold',
        source: 'user',
      }));
      await writeJsonLine(receiverSocket, {
        type: 'user',
        msg_id: 'msg-far',
        message: {
          role: 'user',
          content: buildCrossSessionEnvelope({
            from: toUdsAddress(farSocket),
            body: 'from far away',
          }),
        },
      });

      await vi.waitFor(() => expect(listHeldMessages()).toHaveLength(1));
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
      expect(frames[0]).toMatchObject({
        action: 'peer_message_status',
        status: 'held',
      });

      resolveHeldMessage(listHeldMessages()[0].id, 'approve');
      await vi.waitFor(() => expect(frames.length).toBeGreaterThan(1));
      expect(frames[1]).toMatchObject({ status: 'delivered' });
    });

    // A receipt for something this session never sent is dropped rather than
    // narrated: the ledger is what makes a status meaningful.
    it('ignores a receipt matching no remembered send', async () => {
      await writeJsonLine(receiverSocket, {
        type: 'control',
        action: 'peer_message_status',
        status: 'denied',
        from: toUdsAddress(peerSocket),
        orig_msg_id: 'msg-nobody-sent',
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(notifyMock).not.toHaveBeenCalled();
    });
  });

  it('cleans up the socket on close', async () => {
    await handle?.close();
    handle = undefined;
    await expect(fs.stat(receiverSocket)).rejects.toThrow();
    expect(process.env[ENV_MESSAGING_SOCKET]).toBeUndefined();
  });
});
