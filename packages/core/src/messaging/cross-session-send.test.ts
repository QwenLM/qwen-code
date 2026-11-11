/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `SendMessage` cross-session surface: description gating and the peer
 * delivery branch.
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ENV_FEATURE_PREFIX } from '../config/brand.js';
import { createAgentTeamTools } from '../agents/teams/agent-team-tools.js';
import type { ToolUseContext } from '../tools/tool-types.js';

import {
  CROSS_SESSION_FEATURE_NAME,
  CROSS_SESSION_LIST_AGENTS_FEATURE_NAME,
} from './cross-session-feature.js';
import {
  MAX_PEER_SENDS_WITHOUT_HUMAN,
  _resetOutboundTrackingForTest,
  noteHumanTurn,
} from './outbound-tracking.js';
import { toUdsAddress } from './peer-address.js';
import { peerHandle, type PeerEntry } from './peer-listing.js';

const listAllPeersMock = vi.hoisted(() => vi.fn());
const sendCrossSessionMessageMock = vi.hoisted(() => vi.fn());
const boundPeerIdentityMock = vi.hoisted(() => vi.fn(() => undefined));

vi.mock('./peer-listing.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./peer-listing.js')>();
  return {
    ...actual,
    listAllPeers: listAllPeersMock,
    boundPeerIdentity: boundPeerIdentityMock,
  };
});
vi.mock('./uds-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./uds-client.js')>();
  return { ...actual, sendCrossSessionMessage: sendCrossSessionMessageMock };
});
const FEATURE_ENV = `${ENV_FEATURE_PREFIX}${CROSS_SESSION_FEATURE_NAME}`;
const LIST_AGENTS_ENV = `${ENV_FEATURE_PREFIX}${CROSS_SESSION_LIST_AGENTS_FEATURE_NAME}`;

function makeConfig(topic?: string): Config {
  return {
    getSessionId: () => 'session-root',
    getProjectRoot: () => '/tmp/project',
    getActiveSessionTranscriptPath: () => '/tmp/project/session-root.jsonl',
    getPermissionMode: () => 'default',
    taskRegistry: undefined,
    topicState: { getTopic: () => topic },
  } as unknown as Config;
}

function makeToolContext(): ToolUseContext {
  return {
    signal: new AbortController().signal,
    callId: 'call-1',
    sessionId: 'session-root',
  } as ToolUseContext;
}

function peerEntry(name: string, socketPath: string): PeerEntry {
  return {
    transport: 'uds',
    address: `uds:${socketPath}`,
    baseName: name,
    displayName: name,
    handle: peerHandle(socketPath),
    ref: 'abc123',
    session: {
      pid: 1,
      procStart: 0,
      startedAt: Date.now(),
      cwd: '/tmp/other',
      messagingSocketPath: socketPath,
      peerProtocol: 1,
    },
  };
}

async function runSendMessage(
  params: Record<string, unknown>,
  context: Record<string, unknown> = {},
) {
  const [tool] = createAgentTeamTools({
    config: makeConfig(),
    ...context,
  } as never);
  const invocation = tool.build(params as never);
  return invocation.executeWithContext!(makeToolContext());
}

describe('SendMessage cross-session surface', () => {
  let previous: string | undefined;
  let previousListAgents: string | undefined;

  beforeEach(() => {
    previous = process.env[FEATURE_ENV];
    previousListAgents = process.env[LIST_AGENTS_ENV];
    delete process.env[LIST_AGENTS_ENV];
    _resetOutboundTrackingForTest();
    listAllPeersMock.mockReset();
    sendCrossSessionMessageMock.mockReset();
    // Explicit default: a session that never bound has no identity, and leaving
    // one case's value in place changes how a later case names its sender.
    boundPeerIdentityMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[FEATURE_ENV];
    else process.env[FEATURE_ENV] = previous;
    if (previousListAgents === undefined) delete process.env[LIST_AGENTS_ENV];
    else process.env[LIST_AGENTS_ENV] = previousListAgents;
  });

  describe('description gating', () => {
    it('omits the cross-session section when the gate is off', () => {
      delete process.env[FEATURE_ENV];
      const [tool] = createAgentTeamTools({ config: makeConfig() });
      expect(tool.description).not.toContain('## Cross-session');
    });

    it('includes it when the gate is on', () => {
      process.env[FEATURE_ENV] = '1';
      const [tool] = createAgentTeamTools({ config: makeConfig() });
      expect(tool.description).toContain('## Cross-session');
      expect(tool.description).toContain('cross-session-message');
    });

    // The section is built once, so it must hold whether or not ListAgents is
    // registered: it names only the address sources the model always has.
    it('tells the model when to message a peer, without naming ListAgents', () => {
      process.env[FEATURE_ENV] = '1';
      const [tool] = createAgentTeamTools({ config: makeConfig() });
      const section = tool.description.slice(
        tool.description.indexOf('## Cross-session'),
      );
      expect(section).toContain('only when your user asks you to');
      expect(section).toContain('ask them to @-mention it');
      expect(section).toContain('never poll a peer');
      expect(section).toContain('Peers are not your workers');
      expect(section).toContain(
        `After ${MAX_PEER_SENDS_WITHOUT_HUMAN} sends to one peer`,
      );
      expect(section).not.toContain('ListAgents');
    });

    it('keeps the gate-off description byte-identical across builds', () => {
      delete process.env[FEATURE_ENV];
      const [first] = createAgentTeamTools({ config: makeConfig() });
      const [second] = createAgentTeamTools({ config: makeConfig() });
      expect(first.description).toBe(second.description);
    });

    it('extends rather than rewrites the base description', () => {
      delete process.env[FEATURE_ENV];
      const [off] = createAgentTeamTools({ config: makeConfig() });
      process.env[FEATURE_ENV] = '1';
      const [on] = createAgentTeamTools({ config: makeConfig() });
      expect(on.description.startsWith(off.description)).toBe(true);
    });
  });

  describe('peer delivery', () => {
    beforeEach(() => {
      process.env[FEATURE_ENV] = '1';
    });

    it('sends to a matching peer and reports success', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      sendCrossSessionMessageMock.mockResolvedValue({ msgId: 'm-1' });

      const result = await runSendMessage({
        to: 'worker',
        message: 'take a look',
        summary: 'ask worker to look',
      });

      expect(sendCrossSessionMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          socketPath: '/tmp/w.sock',
          text: 'take a look',
        }),
      );
      expect(result.toolUseResult).toMatchObject({
        success: true,
        msg_id: 'm-1',
      });
    });

    it('reports ENOENT as a failure with actionable advice', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      const error = Object.assign(new Error('gone'), { code: 'ENOENT' });
      sendCrossSessionMessageMock.mockRejectedValue(error);

      const result = await runSendMessage({
        to: 'worker',
        message: 'hello',
        summary: 'say hello',
      });

      expect(result.toolUseResult).toMatchObject({ success: false });
      expect(String(result.returnDisplay)).toContain('ENOENT');
      expect(String(result.returnDisplay)).toContain('@-mention');
      expect(String(result.returnDisplay)).not.toContain('ListAgents');
    });

    it('points at ListAgents only when that tool is registered', async () => {
      process.env[LIST_AGENTS_ENV] = '1';
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      sendCrossSessionMessageMock.mockRejectedValue(
        Object.assign(new Error('gone'), { code: 'ENOENT' }),
      );

      const result = await runSendMessage({
        to: 'worker',
        message: 'hello',
        summary: 'say hello',
      });

      expect(String(result.returnDisplay)).toContain('ListAgents');
    });

    it('tells the model to ask for an @-mention when no agent matches', async () => {
      listAllPeersMock.mockResolvedValue([]);

      const result = await runSendMessage({
        to: 'the other session',
        message: 'hello',
        summary: 'say hello',
      });

      const display = String(result.returnDisplay);
      expect(display).toContain('No agent named');
      expect(display).toContain('ask your user to @-mention it');
      expect(display).not.toContain('ListAgents');
    });

    it('reports EBUSY as retryable', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      sendCrossSessionMessageMock.mockRejectedValue(
        Object.assign(new Error('busy'), { code: 'EBUSY' }),
      );

      const result = await runSendMessage({
        to: 'worker',
        message: 'hello',
        summary: 'say hello',
      });
      expect(String(result.returnDisplay)).toContain('Retry');
    });

    it('refuses to guess between same-named peers', async () => {
      listAllPeersMock.mockResolvedValue([
        peerEntry('twin', '/tmp/a.sock'),
        peerEntry('twin', '/tmp/b.sock'),
      ]);

      const result = await runSendMessage({
        to: 'twin',
        message: 'hello',
        summary: 'say hello',
      });

      expect(sendCrossSessionMessageMock).not.toHaveBeenCalled();
      expect(result.toolUseResult).toMatchObject({ success: false });
      // [AC5] The strings it suggests are the escalated labels, which resolve.
      expect(String(result.returnDisplay)).toContain(
        `twin-${peerHandle('/tmp/a.sock')}`,
      );
      expect(String(result.returnDisplay)).toContain(
        `twin-${peerHandle('/tmp/b.sock')}`,
      );
    });

    // The tier that matched was the bare base name, so the matched peers have
    // *different* display names. Recovering candidates by filtering the listing
    // on the ambiguity's `displayName` therefore found only one of them, and
    // reported a two-way ambiguity as a single option — under a label that
    // would have resolved perfectly well.
    it('lists every peer a bare base name matched, not just the first', async () => {
      const first = {
        ...peerEntry('peer-cli-4', '/tmp/a.sock'),
        displayName: `peer-cli-4-${peerHandle('/tmp/a.sock')}`,
      };
      const second = {
        ...peerEntry('peer-cli-4', '/tmp/b.sock'),
        displayName: `peer-cli-4-${peerHandle('/tmp/b.sock')}`,
      };
      listAllPeersMock.mockResolvedValue([first, second]);

      const result = await runSendMessage({
        to: 'peer-cli-4',
        message: 'hello',
        summary: 'say hello',
      });

      expect(sendCrossSessionMessageMock).not.toHaveBeenCalled();
      const display = String(result.returnDisplay);
      expect(display).toContain('2 live sessions answer to');
      expect(display).toContain(first.displayName);
      expect(display).toContain(second.displayName);
    });

    // [RA1] The reply path the description documents: the envelope hands the
    // model a `from`, and copying it back has to reach the session that sent it.
    it('[RA1] delivers a reply addressed by the sender address', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      sendCrossSessionMessageMock.mockResolvedValue({ msgId: 'm-2' });

      const result = await runSendMessage({
        to: toUdsAddress('/tmp/w.sock'),
        message: 'on it',
        summary: 'reply',
      });

      expect(sendCrossSessionMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath: '/tmp/w.sock' }),
      );
      expect(result.toolUseResult).toMatchObject({ success: true });
    });

    // [RA2] The caller copied this string out of a message it received, so the
    // generic "check the spelling" answer sent it looking for a typo that was
    // never there. Reaches the model even when no peer is left, which is the
    // case an early return on an empty listing used to swallow.
    it('[RA2] says the addressed session has exited, with no peers left', async () => {
      listAllPeersMock.mockResolvedValue([]);

      const result = await runSendMessage({
        to: toUdsAddress('/tmp/gone.sock'),
        message: 'still there?',
        summary: 'reply',
      });

      expect(sendCrossSessionMessageMock).not.toHaveBeenCalled();
      expect(result.toolUseResult).toMatchObject({ success: false });
      expect(String(result.returnDisplay)).toContain('has exited');
      expect(String(result.returnDisplay)).toContain('@-mention');
      expect(String(result.returnDisplay)).not.toContain('spelling');
    });

    // [RA3] /peers and /status both display this session's own address, so it
    // can reach the model. Reporting ourselves as exited would be a lie about a
    // session that is plainly running.
    it('[RA3] names this session own address rather than calling it exited', async () => {
      boundPeerIdentityMock.mockReturnValue({
        address: toUdsAddress('/tmp/self.sock'),
        socketPath: '/tmp/self.sock',
        handle: peerHandle('/tmp/self.sock'),
        ref: 'aaaaaa',
      } as never);
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);

      const result = await runSendMessage({
        to: toUdsAddress('/tmp/self.sock'),
        message: 'hello me',
        summary: 'reply',
      });

      expect(sendCrossSessionMessageMock).not.toHaveBeenCalled();
      expect(String(result.returnDisplay)).toContain("this session's own address");
      expect(String(result.returnDisplay)).not.toContain('has exited');
    });

    it('does not reach peers when the gate is off', async () => {
      delete process.env[FEATURE_ENV];
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);

      const result = await runSendMessage({
        to: 'worker',
        message: 'hello',
        summary: 'say hello',
      });

      expect(sendCrossSessionMessageMock).not.toHaveBeenCalled();
      expect(String(result.returnDisplay)).toContain('No agent named');
    });

    it('[AC8] identifies the sending session, not the internal team role', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      sendCrossSessionMessageMock.mockResolvedValue({ msgId: 'm-1' });

      await runSendMessage(
        { to: 'worker', message: 'hello', summary: 'say hello' },
        { config: makeConfig('api-service') },
      );

      // Not `team-lead`: every session's main conversation reports that, so it
      // tells the recipient nothing about who is talking to it.
      expect(sendCrossSessionMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ senderName: 'api-service' }),
      );
    });

    it('[AC8] falls back to the working directory when the session is untitled', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      sendCrossSessionMessageMock.mockResolvedValue({ msgId: 'm-1' });

      await runSendMessage(
        { to: 'worker', message: 'hello', summary: 'say hello' },
        { config: makeConfig(undefined) },
      );

      const { senderName } = sendCrossSessionMessageMock.mock.calls[0][0];
      expect(senderName).toBe(path.basename(process.cwd()));
    });

    // [AC9] What a peer reads in `from-name` has to be the label its own
    // listing shows for us, or "reply to whoever messaged you" addresses
    // nothing. An untitled session's label carries its handle, so this one must
    // too — and it is the handle of the socket we actually bound.
    it('[AC9] signs an untitled session with its handle', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      sendCrossSessionMessageMock.mockResolvedValue({ msgId: 'm-1' });
      boundPeerIdentityMock.mockReturnValue({
        address: 'uds:/tmp/self.sock',
        socketPath: '/tmp/self.sock',
        handle: peerHandle('/tmp/self.sock'),
        ref: 'aaaaaa',
      } as never);

      await runSendMessage(
        { to: 'worker', message: 'hello', summary: 'say hello' },
        { config: makeConfig(undefined) },
      );

      const { senderName } = sendCrossSessionMessageMock.mock.calls[0][0];
      expect(senderName).toBe(
        `${path.basename(process.cwd())}-${peerHandle('/tmp/self.sock')}`,
      );
    });

    it('[AC2] a titled session signs its title, unsuffixed', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      sendCrossSessionMessageMock.mockResolvedValue({ msgId: 'm-1' });
      boundPeerIdentityMock.mockReturnValue({
        address: 'uds:/tmp/self.sock',
        socketPath: '/tmp/self.sock',
        handle: peerHandle('/tmp/self.sock'),
        ref: 'aaaaaa',
      } as never);

      await runSendMessage(
        { to: 'worker', message: 'hello', summary: 'say hello' },
        { config: makeConfig('api-service') },
      );

      expect(sendCrossSessionMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ senderName: 'api-service' }),
      );
    });

    it('[AC8] names both session and teammate when a teammate sends', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      sendCrossSessionMessageMock.mockResolvedValue({ msgId: 'm-1' });

      await runSendMessage(
        { to: 'worker', message: 'hello', summary: 'say hello' },
        {
          config: makeConfig('api-service'),
          senderName: 'Reviewer',
          agentLoopContext: { agentId: 'agent-1' },
        },
      );

      expect(sendCrossSessionMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ senderName: 'api-service / Reviewer' }),
      );
    });

    it('never sends a structured protocol message to a peer', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);

      const result = await runSendMessage({
        to: 'worker',
        message: { type: 'shutdown_request' },
      });

      expect(sendCrossSessionMessageMock).not.toHaveBeenCalled();
      expect(result.toolUseResult).toMatchObject({ success: false });
    });
  });
  describe('reply-loop limit', () => {
    beforeEach(() => {
      process.env[FEATURE_ENV] = '1';
      sendCrossSessionMessageMock.mockResolvedValue({ msgId: 'm-1' });
    });

    const send = (to = 'worker') =>
      runSendMessage({ to, message: 'hello', summary: 'say hello' });

    it('refuses the send after the limit, until a human message', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);

      for (let i = 0; i < MAX_PEER_SENDS_WITHOUT_HUMAN; i++) {
        expect((await send()).toolUseResult).toMatchObject({ success: true });
      }
      const refused = await send();
      expect(refused.toolUseResult).toMatchObject({ success: false });
      expect(String(refused.returnDisplay)).toContain('ask before continuing');
      expect(sendCrossSessionMessageMock).toHaveBeenCalledTimes(
        MAX_PEER_SENDS_WITHOUT_HUMAN,
      );

      noteHumanTurn();
      expect((await send()).toolUseResult).toMatchObject({ success: true });
    });

    it('counts each peer separately', async () => {
      listAllPeersMock.mockResolvedValue([
        peerEntry('worker', '/tmp/w.sock'),
        peerEntry('other', '/tmp/o.sock'),
      ]);
      for (let i = 0; i < MAX_PEER_SENDS_WITHOUT_HUMAN; i++) await send();

      expect((await send('other')).toolUseResult).toMatchObject({
        success: true,
      });
    });

    it('does not count a send that failed', async () => {
      listAllPeersMock.mockResolvedValue([peerEntry('worker', '/tmp/w.sock')]);
      sendCrossSessionMessageMock.mockRejectedValue(
        Object.assign(new Error('busy'), { code: 'EBUSY' }),
      );
      for (let i = 0; i < MAX_PEER_SENDS_WITHOUT_HUMAN; i++) await send();

      sendCrossSessionMessageMock.mockResolvedValue({ msgId: 'm-2' });
      expect((await send()).toolUseResult).toMatchObject({ success: true });
    });
  });
});
