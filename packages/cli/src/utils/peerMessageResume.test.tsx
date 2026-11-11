/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A peer message must survive `/resume`, and must look the same afterwards.
 *
 * Two code paths build this row — the live feed from a queued command, and the
 * resume projection from a persisted message — and the bug they exist to fix was
 * exactly this shape: paths that were supposed to agree, one of them silently
 * producing nothing. The parity assertions are the guard; per-path assertions
 * cannot catch drift between them.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCrossSessionEnvelope,
  peerHandle,
  toUdsAddress,
  wrapTextByOrigin,
  type Message,
} from '@qwen-code/core';
import { renderWithProviders } from '../test-utils/render.js';
import { buildPeerMessageHistoryItem } from '../ui/components/messages/PeerMessage.js';
import { convertMessagesToHistoryFormats } from './sessionUtils.js';
import type { HistoryItemWithoutId } from '../ui/types.js';

const SOCKET = '/tmp/qwen-socks/4242.sock';
const ADDRESS = toUdsAddress(SOCKET);
const HANDLE = peerHandle(SOCKET);
const NAME = `peer-cli-4-${HANDLE}`;
const BODY = 'pong — session bar is up and idle';

const PEER_ORIGIN = {
  kind: 'peer' as const,
  transport: 'uds' as const,
  from: ADDRESS,
  name: NAME,
  body: BODY,
};

const ENVELOPE = buildCrossSessionEnvelope({
  from: ADDRESS,
  fromName: NAME,
  body: BODY,
});

/** What the transport enqueues, after the model-facing wrapper is applied. */
const PERSISTED_TEXT = wrapTextByOrigin(ENVELOPE, PEER_ORIGIN);

function persistedUserMessage(): Message {
  return {
    type: 'user',
    uuid: 'peer-1',
    isMeta: true,
    origin: PEER_ORIGIN,
    message: { role: 'user', content: PERSISTED_TEXT },
  } as unknown as Message;
}

function persistedQueuedCommand(): Message {
  return {
    type: 'attachment',
    uuid: 'peer-2',
    attachment: {
      type: 'queued_command',
      prompt: ENVELOPE,
      isMeta: true,
      origin: PEER_ORIGIN,
    },
  } as unknown as Message;
}

async function frameOf(item: HistoryItemWithoutId): Promise<string> {
  expect(item.type).toBe('custom_content');
  const content = (item as { content: React.ReactNode }).content;
  // No fold state: the row renders the same at every level, so passing one here
  // would imply a dependency the component no longer has.
  const result = await renderWithProviders(<>{content}</>);
  const frame = result.lastFrame() ?? '';
  result.unmount();
  return frame;
}

describe('peer messages on resume', () => {
  it('projects a persisted user message back into a peer row', async () => {
    const { uiHistory } = convertMessagesToHistoryFormats([
      persistedUserMessage(),
    ]);

    expect(uiHistory).toHaveLength(1);
    const frame = await frameOf(uiHistory[0]);
    expect(frame).toContain(NAME);
    expect(frame).toContain(BODY);
    // Neither the envelope nor the model-facing wrapper belongs on screen.
    expect(frame).not.toContain('cross-session-message');
    expect(frame).not.toContain('Another Qwen Code session sent a message');
  });

  /**
   * A message that arrived mid-turn persists as a `queued_command` attachment
   * rather than as a user message, so it resumes through a different branch.
   * Before this existed it fell through to the plain-user case and redrew the
   * raw envelope as though the user had typed it.
   */
  it('projects a persisted queued command back into a peer row', async () => {
    const { uiHistory } = convertMessagesToHistoryFormats([
      persistedQueuedCommand(),
    ]);

    expect(uiHistory).toHaveLength(1);
    const frame = await frameOf(uiHistory[0]);
    expect(frame).toContain(NAME);
    expect(frame).toContain(BODY);
    expect(frame).not.toContain('cross-session-message');
  });

  /**
   * The marker rides the persisted origin. A transcript from a build that never
   * recorded registry membership has no `knownPeer`, and that must not read as
   * a sender nobody had registered — which is what every test above resumes.
   */
  it('keeps the unregistered marker, and only where it was recorded', async () => {
    const unregistered = { ...PEER_ORIGIN, knownPeer: false };
    const { uiHistory } = convertMessagesToHistoryFormats([
      {
        type: 'user',
        uuid: 'peer-3',
        isMeta: true,
        // No `body`, so the row has to recover the text from the stored form,
        // which now ends in the extra sentence the model was shown.
        origin: { ...unregistered, body: undefined },
        message: {
          role: 'user',
          content: wrapTextByOrigin(ENVELOPE, unregistered),
        },
      } as unknown as Message,
      persistedUserMessage(),
    ]);

    expect(uiHistory).toHaveLength(2);
    const marked = await frameOf(uiHistory[0]);
    expect(marked).toContain('(unregistered)');
    expect(marked).toContain(BODY);
    expect(marked).not.toContain('registered Qwen Code session');
    expect(await frameOf(uiHistory[1])).not.toContain('unregistered');
  });

  it('renders the live row and the resumed row identically', async () => {
    const live = buildPeerMessageHistoryItem({
      text: ENVELOPE,
      origin: PEER_ORIGIN,
    });
    const { uiHistory } = convertMessagesToHistoryFormats([
      persistedUserMessage(),
    ]);

    expect(await frameOf(uiHistory[0])).toBe(await frameOf(live));
  });

  /**
   * The discriminator is `transport`, not `kind`: in-process teammate messages
   * carry `kind: 'peer'` too, and routing them here would break a feature that
   * works today.
   */
  it('leaves an in-process teammate message to its own renderer', () => {
    const teammate = {
      type: 'user',
      uuid: 'mate-1',
      isMeta: true,
      origin: { kind: 'peer', from: 'architect', name: 'architect' },
      message: {
        role: 'user',
        content: '<teammate-message teammate_id="architect">hi</teammate-message>',
      },
    } as unknown as Message;

    const { uiHistory } = convertMessagesToHistoryFormats([teammate]);

    expect(uiHistory).toHaveLength(0);
  });
});
