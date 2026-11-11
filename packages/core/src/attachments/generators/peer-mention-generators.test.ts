/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { FileAttachment } from '../models/file-attachments.js';
import { DirectoryAttachment } from '../models/file-attachments.js';
import { AgentMentionAttachment } from '../models/agent-attachments.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_FEATURE_PREFIX } from '../../config/brand.js';
import { CROSS_SESSION_FEATURE_NAME } from '../../messaging/cross-session-feature.js';
import {
  baseNameForSession,
  displayNameForSession,
  peerHandle,
  shortRef,
  type PeerEntry,
} from '../../messaging/peer-listing.js';
import type { LivePeerSession } from '../../messaging/session-registry.js';
import type { Attachment } from '../types.js';

const mocks = vi.hoisted(() => ({
  listAllPeers: vi.fn(),
}));

vi.mock('../../messaging/peer-listing.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../messaging/peer-listing.js')>();
  return { ...actual, listAllPeers: mocks.listAllPeers };
});

const { processPeerMentions } = await import('./peer-mention-generators.js');

const FEATURE_ENV = `${ENV_FEATURE_PREFIX}${CROSS_SESSION_FEATURE_NAME}`;
const CWD = '/home/dev/project';

function peer(
  name: string | undefined,
  socketPath: string,
  overrides: Partial<LivePeerSession> = {},
): PeerEntry {
  const live: LivePeerSession = {
    pid: 100,
    procStart: 0,
    startedAt: Date.now() - 60_000,
    cwd: '/home/dev/project',
    messagingSocketPath: socketPath,
    peerProtocol: 1,
    kind: 'interactive',
    status: 'idle',
    ...(name !== undefined && { name }),
    ...overrides,
  };
  return {
    transport: 'uds',
    address: `uds:${socketPath}`,
    session: live,
    baseName: baseNameForSession(live),
    displayName: displayNameForSession(live),
    handle: peerHandle(socketPath),
    ref: shortRef('session', socketPath),
  };
}

const REVIEWER = peer('reviewer', '/tmp/socks/1.sock');

beforeEach(() => {
  process.env[FEATURE_ENV] = '1';
  mocks.listAllPeers.mockReset();
  mocks.listAllPeers.mockResolvedValue([REVIEWER]);
});

afterEach(() => {
  delete process.env[FEATURE_ENV];
});

describe('processPeerMentions', () => {
  it('[AC6] emits a resolved attachment for a unique bare name', async () => {
    const result = await processPeerMentions(
      'ask @reviewer to rerun CI',
      CWD,
      [],
    );
    expect(result).toEqual([
      {
        type: 'peer_mention',
        mention: 'reviewer',
        status: 'resolved',
        candidates: [{ label: 'reviewer', detail: '' }],
        total: 1,
      },
    ]);
  });

  it('[AC1] does nothing and enumerates nothing when the gate is closed', async () => {
    delete process.env[FEATURE_ENV];
    expect(await processPeerMentions('ask @reviewer', CWD, [])).toEqual([]);
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('[AC10] does not enumerate for a prompt with no @', async () => {
    expect(await processPeerMentions('hello world', CWD, [])).toEqual([]);
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('[AC10] does not enumerate when a file attachment claimed the token', async () => {
    const produced: Attachment[] = [
      new FileAttachment({
        type: 'file',
        filename: `${CWD}/README.md`,
        content: '# hi',
        displayPath: 'README.md',
      }),
    ];
    expect(await processPeerMentions('read @README.md', CWD, produced)).toEqual(
      [],
    );
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('[AC10] does not enumerate when a directory claimed the token', async () => {
    // A directory keys on `path`, not `filename` — the easy field to miss.
    const produced: Attachment[] = [
      new DirectoryAttachment({
        type: 'directory',
        path: `${CWD}/somedir`,
        content: 'total 0',
        displayPath: 'somedir',
      }),
    ];
    expect(await processPeerMentions('list @somedir/', CWD, produced)).toEqual(
      [],
    );
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('[AC10] does not enumerate when an agent mention claimed the token', async () => {
    const produced: Attachment[] = [
      new AgentMentionAttachment({
        type: 'agent_mention',
        agentType: 'reviewer',
      }),
    ];
    expect(await processPeerMentions('ask @reviewer', CWD, produced)).toEqual(
      [],
    );
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('[AC9, Decision 8] still resolves a token that named no produced file', async () => {
    // The peer's own label contains a dot, so the token matches the file regex
    // — but it resolved to nothing on disk, so it is unclaimed and must reach
    // the peer parser rather than being swallowed by token shape.
    const dotted = peer(undefined, '/tmp/socks/2.sock', {
      cwd: '/home/dev/peer-cli-5.1',
    });
    mocks.listAllPeers.mockResolvedValue([dotted]);

    const result = await processPeerMentions(
      `ping @${dotted.displayName} please`,
      CWD,
      [],
    );
    expect(dotted.displayName).toContain('.');
    expect(mocks.listAllPeers).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('resolved');
  });

  it('does not resolve a bare directory name to an untitled peer', () => {
    // `core` is a live recipient only because a session happens to run in
    // /work/core. Ordinary prose must not address it.
    const dir = peer(undefined, '/tmp/socks/3.sock', { cwd: '/work/core' });
    mocks.listAllPeers.mockResolvedValue([dir]);
    return expect(
      processPeerMentions('look at the @core module', CWD, []),
    ).resolves.toEqual([]);
  });

  it('[AC8] emits nothing when the name matches no peer', async () => {
    expect(await processPeerMentions('ask @nobody', CWD, [])).toEqual([]);
  });

  it('[AC11] reads the listing fresh on every call', async () => {
    await processPeerMentions('ask @reviewer', CWD, []);
    await processPeerMentions('ask @reviewer', CWD, []);
    expect(mocks.listAllPeers).toHaveBeenCalledTimes(2);
  });

  it('emits nothing when no peers are live', async () => {
    mocks.listAllPeers.mockResolvedValue([]);
    expect(await processPeerMentions('ask @reviewer', CWD, [])).toEqual([]);
  });
});
