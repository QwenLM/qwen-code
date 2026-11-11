/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface gating for `peer_mention` at the pipeline level.
 *
 * The generator's own behaviour is covered in
 * `generators/peer-mention-generators.test.ts`; what is pinned here is the one
 * thing only `getAttachments` can answer — that the mention pass runs for a
 * prompt a human typed into the composer and for nothing else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_FEATURE_PREFIX } from '../config/brand.js';
import { CROSS_SESSION_FEATURE_NAME } from '../messaging/cross-session-feature.js';
import type { LivePeerSession, PeerEntry } from '../messaging/index.js';

const mocks = vi.hoisted(() => ({
  listAllPeers: vi.fn(),
}));

vi.mock('../messaging/peer-listing.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../messaging/peer-listing.js')>();
  return { ...actual, listAllPeers: mocks.listAllPeers };
});

const { createAttachmentContext, getAttachments } = await import(
  './get-attachments.js'
);
const { baseNameForSession, displayNameForSession, peerHandle, shortRef } =
  await import('../messaging/peer-listing.js');

const FEATURE_ENV = `${ENV_FEATURE_PREFIX}${CROSS_SESSION_FEATURE_NAME}`;

function reviewer(): PeerEntry {
  const socketPath = '/tmp/socks/1.sock';
  const live: LivePeerSession = {
    pid: 100,
    procStart: 0,
    startedAt: Date.now(),
    cwd: '/home/dev/project',
    messagingSocketPath: socketPath,
    peerProtocol: 1,
    kind: 'interactive',
    status: 'idle',
    name: 'reviewer',
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

async function collect(options: Record<string, unknown>) {
  const ctx = createAttachmentContext('/workspace', 'agent-1');
  return getAttachments('ask @reviewer to rerun CI', ctx, [], null, {
    skipSkillDiscovery: true,
    ...options,
  });
}

beforeEach(() => {
  process.env[FEATURE_ENV] = '1';
  mocks.listAllPeers.mockReset();
  mocks.listAllPeers.mockResolvedValue([reviewer()]);
});

afterEach(() => {
  delete process.env[FEATURE_ENV];
});

describe('getAttachments: peer_mention surface gating', () => {
  it('emits the mention for a prompt typed into the composer', async () => {
    const results = await collect({ isTuiPrompt: true });
    expect(results.filter((a) => a.type === 'peer_mention')).toHaveLength(1);
  });

  it('[AC12] emits nothing when the option is omitted', async () => {
    // The default, not an explicit false: a surface added later must inherit
    // nothing.
    const results = await collect({});
    expect(results.filter((a) => a.type === 'peer_mention')).toHaveLength(0);
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('[AC12] emits nothing when the surface declares itself non-TUI', async () => {
    const results = await collect({ isTuiPrompt: false });
    expect(results.filter((a) => a.type === 'peer_mention')).toHaveLength(0);
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('[AC12] does not run on an inter-turn call, which has no input', async () => {
    const ctx = createAttachmentContext('/workspace', 'agent-1');
    await getAttachments(null, ctx, [], null, {
      skipSkillDiscovery: true,
      isTuiPrompt: true,
    });
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('[AC10] does not enumerate for a prompt with no mention', async () => {
    const ctx = createAttachmentContext('/workspace', 'agent-1');
    await getAttachments('nothing to see here', ctx, [], null, {
      skipSkillDiscovery: true,
      isTuiPrompt: true,
    });
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });
});
