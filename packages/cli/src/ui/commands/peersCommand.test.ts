/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  baseNameForSession,
  displayNameForSession,
  peerHandle,
  shortRef,
  type LivePeerSession,
  type PeerEntry,
} from '@qwen-code/core';
import { peersCommand } from './peersCommand.js';
import type { CommandContext } from './types.js';

/**
 * The characters `sanitizeForDisplay` exists to remove.
 *
 * Checked by inclusion rather than by regex: a character class holding a control
 * character is itself the thing lint objects to, and the list reads better as a
 * list.
 */
const UNSAFE_DISPLAY_CHARS = ['\u001b', '\u200b', '\u202e', '\u2500'];

function hasUnsafeDisplayChars(text: string): boolean {
  return UNSAFE_DISPLAY_CHARS.some((character) => text.includes(character));
}

const mocks = vi.hoisted(() => ({
  listAllPeers: vi.fn(),
  listHeldMessages: vi.fn(),
  resolveHeldMessage: vi.fn(),
  describeEffectiveInboundPolicy: vi.fn(),
  isPeerModeEmitEnabled: vi.fn(),
  currentModeClass: vi.fn(),
  boundPeerIdentity: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return { ...actual, ...mocks };
});

/** Settings stand-in; only the four scopes the resolver reads are populated. */
function makeSettings(values: Record<string, string | undefined> = {}) {
  const file = (value: string | undefined, path: string) => ({
    path,
    settings:
      value === undefined ? {} : { security: { crossSessionInbound: value } },
  });
  return {
    user: file(values['user'], '/home/dev/.qwen/settings.json'),
    project: file(values['project'], '/repo/.qwen/settings.json'),
    local: file(values['local'], '/repo/.qwen/settings.local.json'),
    flag: file(values['flag'], '/tmp/flag.json'),
    // The resolver gates the local project scope on trust, so a stand-in
    // without this silently drops that scope instead of exercising it.
    isTrusted: true,
  };
}

function makeContext(
  settingValues: Record<string, string | undefined> = {},
): { context: CommandContext; texts: string[] } {
  const texts: string[] = [];
  const context = {
    services: { settings: makeSettings(settingValues) },
    ui: {
      addItem: (item: { text?: string }) => {
        if (item.text) texts.push(item.text);
      },
    },
  } as unknown as CommandContext;
  return { context, texts };
}

async function run(
  args: string,
  settingValues: Record<string, string | undefined> = {},
): Promise<string[]> {
  const { context, texts } = makeContext(settingValues);
  await peersCommand.action?.(context, args);
  return texts;
}

/** A peer the way `listAllPeers` builds one, so naming stays the real rule. */
function peerEntry(
  overrides: Partial<LivePeerSession> & { socketPath?: string } = {},
): PeerEntry {
  const { socketPath = '/tmp/a.sock', ...sessionOverrides } = overrides;
  const session: LivePeerSession = {
    pid: 1,
    procStart: 0,
    startedAt: Date.now(),
    cwd: '/tmp/alpha',
    messagingSocketPath: socketPath,
    peerProtocol: 1,
    kind: 'interactive',
    status: 'idle',
    ...sessionOverrides,
  };
  return {
    transport: 'uds',
    address: `uds:${socketPath}`,
    session,
    baseName: baseNameForSession(session),
    displayName: displayNameForSession(session),
    handle: peerHandle(socketPath),
    ref: shortRef('session', socketPath),
  };
}

function heldMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ab12cd34',
    receivedAt: Date.now(),
    from: 'uds:/tmp/peer.sock',
    fromName: 'worker',
    cause: 'mode-mismatch',
    // The body is the only source of display text now: `/peers` summarizes the
    // stored command rather than reading a preview cached beside it.
    command: { prompt: 'please deploy to prod', commandMode: 'prompt' },
    hints: {},
    ...overrides,
  };
}

describe('/peers', () => {
  beforeEach(() => {
    mocks.listAllPeers.mockResolvedValue([]);
    mocks.listHeldMessages.mockReturnValue([]);
    mocks.resolveHeldMessage.mockReset();
    mocks.describeEffectiveInboundPolicy.mockReturnValue({
      policy: 'accept',
      cause: 'default-accept',
    });
    mocks.isPeerModeEmitEnabled.mockReturnValue(false);
    mocks.currentModeClass.mockReturnValue('prompting');
    mocks.boundPeerIdentity.mockReturnValue(undefined);
  });

  describe('effective policy line', () => {
    // The line states the rule rather than the verdict on one hypothetical
    // message: describing a single sample used to print `hold` directly above a
    // list of peers that would every one of them be accepted.
    it('states the parity rule when nothing is configured', async () => {
      mocks.describeEffectiveInboundPolicy.mockReturnValue({
        policy: 'hold',
        cause: 'no-mode-asserted',
      });
      mocks.currentModeClass.mockReturnValue('bypass');
      const [text] = await run('');
      expect(text).toContain('not configured');
      expect(text).toContain('held for your approval');
      expect(text).toContain('bypasses permission checks');
    });

    it('states that a prompting session accepts, with the gate off', async () => {
      mocks.describeEffectiveInboundPolicy.mockReturnValue({
        policy: 'accept',
        cause: 'default-accept',
      });
      const [text] = await run('');
      expect(text).toContain('peer messages are accepted');
      expect(text).toContain(
        'messages from an address that matches no registered session are held for your approval',
      );
    });

    // With the gate on, mode matching is reachable and the line has to say so.
    it('describes mode matching when the attestation gate is on', async () => {
      mocks.isPeerModeEmitEnabled.mockReturnValue(true);
      mocks.currentModeClass.mockReturnValue('bypass');
      mocks.describeEffectiveInboundPolicy.mockReturnValue({
        policy: 'hold',
        cause: 'no-mode-asserted',
      });
      const [text] = await run('');
      expect(text).toContain('same permission posture');
      expect(text).toContain('(bypass)');
      expect(text).toContain('matches no registered session');
    });

    it('reports a non-interactive session as refusing', async () => {
      mocks.describeEffectiveInboundPolicy.mockReturnValue({
        policy: 'refuse',
        cause: 'no-review-surface',
      });
      const [text] = await run('');
      expect(text).toContain('refusing peer messages');
      expect(text).toContain('non-interactive');
    });

    it('names the user settings file when the user configured it', async () => {
      const [text] = await run('', { user: 'hold' });
      expect(text).toContain('Inbound policy: hold');
      expect(text).toContain('/home/dev/.qwen/settings.json');
    });

    it('flags a repository setting that is overriding the user', async () => {
      const [text] = await run('', { user: 'accept', project: 'hold' });
      expect(text).toContain("repository's settings");
      expect(text).toContain('/repo/.qwen/settings.json');
      expect(text).toContain('stricter');
    });

    it('does not call a local project setting a repository one', async () => {
      // These two lines used to be printed together: the scope label said the
      // file was the reader's own, and the suffix said a repository set it.
      const [text] = await run('', { user: 'hold', local: 'accept' });
      expect(text).toContain('Inbound policy: accept');
      expect(text).toContain('local project');
      expect(text).toContain('/repo/.qwen/settings.local.json');
      expect(text).not.toContain('stricter');
    });

    it('explains a repo-forced refuse even with an empty queue', async () => {
      // The case with no held messages to hint at the cause.
      const [text] = await run('', { project: 'refuse' });
      expect(text).toContain('Inbound policy: refuse');
      expect(text).toContain('/repo/.qwen/settings.json');
      expect(text).toContain('Held messages: none');
    });
  });

  it('reports an empty state', async () => {
    const [text] = await run('');
    expect(text).toContain('none reachable');
    expect(text).toContain('Held messages: none');
  });

  it('lists peers and held messages', async () => {
    mocks.listAllPeers.mockResolvedValue([peerEntry({ name: 'alpha' })]);
    mocks.listHeldMessages.mockReturnValue([heldMessage()]);

    const [text] = await run('');
    expect(text).toContain('alpha');
    expect(text).toContain('[ab12cd34]');
    expect(text).toContain('please deploy to prod');
    expect(text).toContain('/peers approve');
  });

  describe('[AC3] handles', () => {
    it('states the handle of a titled peer', async () => {
      mocks.listAllPeers.mockResolvedValue([peerEntry({ name: 'alpha' })]);

      const [text] = await run('');
      expect(text).toContain(`handle -${peerHandle('/tmp/a.sock')}`);
    });

    it('does not repeat it when the name already carries it', async () => {
      mocks.listAllPeers.mockResolvedValue([peerEntry()]);

      const [text] = await run('');
      expect(text).toContain(`alpha-${peerHandle('/tmp/a.sock')}`);
      expect(text).not.toContain('handle -');
    });
  });

  describe('[AC11] this session', () => {
    it('says nothing when the session never bound a socket', async () => {
      const [text] = await run('');
      expect(text).not.toContain('This session:');
    });

    it('names this session the way its peers name it', async () => {
      mocks.boundPeerIdentity.mockReturnValue({
        address: 'uds:/tmp/self.sock',
        socketPath: '/tmp/self.sock',
        handle: peerHandle('/tmp/self.sock'),
        ref: shortRef('session', '/tmp/self.sock'),
      });

      const [text] = await run('');
      expect(text).toContain(
        `This session: ${displayNameForSession({
          cwd: process.cwd(),
          messagingSocketPath: '/tmp/self.sock',
        })}`,
      );
      // The name already ends in the handle, so it is not restated.
      const line = text
        .split('\n')
        .find((row) => row.startsWith('This session:')) as string;
      expect(line).not.toContain('handle -');
    });
  });

  describe('[AC11] held message attribution', () => {
    it('attributes to a live peer by handle', async () => {
      const peer = peerEntry({ name: 'alpha', socketPath: '/tmp/peer.sock' });
      mocks.listAllPeers.mockResolvedValue([peer]);
      mocks.listHeldMessages.mockReturnValue([heldMessage()]);

      const [text] = await run('');
      expect(text).toContain(`from -${peer.handle} (alpha)`);
    });

    // The handle is derived from the address the sender supplied, so it can
    // name nothing at all. Saying so beats printing a name nobody can check.
    it('says when the sender is not reachable, and marks the name a claim', async () => {
      mocks.listAllPeers.mockResolvedValue([]);
      mocks.listHeldMessages.mockReturnValue([heldMessage()]);

      const [text] = await run('');
      expect(text).toContain(`from -${peerHandle('/tmp/peer.sock')}`);
      expect(text).toContain('not reachable; claims "worker"');
    });

    it('falls back to the claimed name for a non-socket address', async () => {
      mocks.listHeldMessages.mockReturnValue([
        heldMessage({ from: 'somewhere-else' }),
      ]);

      const [text] = await run('');
      expect(text).toContain('from worker');
    });

    /**
     * [RA13] The name is whatever the sender typed into its own envelope.
     *
     * It reaches a terminal on all three branches below, so all three read it
     * through the summary: an escape sequence here can clear the screen or draw
     * a convincing dialog border directly above the approve/deny instructions.
     */
    describe('[RA13] a hostile claimed name', () => {
      const HOSTILE = '\u001b[2Jwiped\u202e\u200b\u2500\u2500';

      it('strips escapes where the sender is unreachable', async () => {
        mocks.listAllPeers.mockResolvedValue([]);
        mocks.listHeldMessages.mockReturnValue([
          heldMessage({ fromName: HOSTILE }),
        ]);

        const [text] = await run('');
        expect(text).toContain('wiped');
        expect(hasUnsafeDisplayChars(text)).toBe(false);
      });

      it('strips escapes on the address fallback branch', async () => {
        mocks.listHeldMessages.mockReturnValue([
          heldMessage({ from: 'somewhere-else', fromName: HOSTILE }),
        ]);

        const [text] = await run('');
        expect(text).toContain('wiped');
        expect(hasUnsafeDisplayChars(text)).toBe(false);
      });

      // Nothing sanitized should mangle ordinary CJK punctuation; the character
      // class is scoped to what can impersonate this CLI's own chrome.
      it('leaves an ordinary non-ASCII name intact', async () => {
        mocks.listAllPeers.mockResolvedValue([]);
        mocks.listHeldMessages.mockReturnValue([
          heldMessage({ fromName: '构建会话（主）' }),
        ]);

        const [text] = await run('');
        expect(text).toContain('claims "构建会话（主）"');
      });
    });
  });

  // [AC4] Approving "a message" that silently brought four files is not an
  // informed decision, so the count rides alongside the preview.
  it('discloses attachments on a held message', async () => {
    mocks.listAllPeers.mockResolvedValue([]);
    mocks.listHeldMessages.mockReturnValue([
      heldMessage({
        attachmentPaths: ['/uploads/a.txt', '/uploads/b.txt'],
        sessionId: 'session-1',
      }),
    ]);

    const [text] = await run('');
    expect(text).toContain('2 file(s) already copied into this session');
  });

  // [AC4] Truncation is disclosed for the same reason: the user is approving
  // more than the line in front of them.
  it('marks a truncated preview', async () => {
    mocks.listAllPeers.mockResolvedValue([]);
    mocks.listHeldMessages.mockReturnValue([
      heldMessage({
        command: {
          prompt: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'),
          commandMode: 'prompt',
        },
      }),
    ]);

    const [text] = await run('');
    expect(text).toContain('preview shortened');
  });

  it('approves a held message', async () => {
    mocks.resolveHeldMessage.mockReturnValue('delivered');
    const [text] = await run('approve ab12cd34');
    expect(mocks.resolveHeldMessage).toHaveBeenCalledWith(
      'ab12cd34',
      'approve',
    );
    expect(text).toContain('Approved ab12cd34');
  });

  it('denies a held message', async () => {
    mocks.resolveHeldMessage.mockReturnValue('dropped');
    const [text] = await run('deny ab12cd34');
    expect(mocks.resolveHeldMessage).toHaveBeenCalledWith('ab12cd34', 'deny');
    expect(text).toContain('Declined ab12cd34');
  });

  it('reports an unknown id', async () => {
    mocks.resolveHeldMessage.mockReturnValue('gone');
    const [text] = await run('approve nope');
    expect(text).toContain('No held message with id nope');
  });

  it('rejects an unknown verb', async () => {
    const [text] = await run('nuke ab12cd34');
    expect(text).toContain('Usage: /peers');
    expect(mocks.resolveHeldMessage).not.toHaveBeenCalled();
  });

  it('requires an id', async () => {
    const [text] = await run('approve');
    expect(text).toContain('Usage: /peers approve <id>');
    expect(mocks.resolveHeldMessage).not.toHaveBeenCalled();
  });
});
