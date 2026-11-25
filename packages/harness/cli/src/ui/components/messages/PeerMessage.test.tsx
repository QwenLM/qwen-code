/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildCrossSessionEnvelope,
  peerHandle,
  toUdsAddress,
  wrapTextByOrigin,
  UNKNOWN_PEER_LABEL,
} from '@qwen-code/core';
import { renderWithProviders } from '../../../test-utils/render.js';
import { useOverflowState } from '../../contexts/OverflowContext.js';
import { figures } from '../../utils/figures.js';
import {
  buildPeerMessageHistoryItem,
  type PeerOriginLike,
} from './PeerMessage.js';

const SOCKET = '/tmp/qwen-socks/4242.sock';
const ADDRESS = toUdsAddress(SOCKET);
const HANDLE = peerHandle(SOCKET);
const BODY = 'pong — session bar is up and idle';

function origin(overrides: Partial<PeerOriginLike> = {}): PeerOriginLike {
  return { from: ADDRESS, name: `peer-cli-4-${HANDLE}`, body: BODY, ...overrides };
}

/** The envelope as it reaches a live command: unwrapped, model-facing. */
function envelope(body = BODY): string {
  return buildCrossSessionEnvelope({
    from: ADDRESS,
    fromName: `peer-cli-4-${HANDLE}`,
    body,
  });
}

/**
 * No fold state is passed: the row renders the same at every level, which is
 * what test 1 below pins. A helper that took one would imply otherwise.
 */
async function render(source: Parameters<typeof buildPeerMessageHistoryItem>[0]) {
  const item = buildPeerMessageHistoryItem(source);
  const result = await renderWithProviders(<>{item.content}</>);
  const frame = result.lastFrame() ?? '';
  result.unmount();
  return frame;
}

describe('buildPeerMessageHistoryItem', () => {
  /**
   * The three assertions are not separable. Byte-identity alone passes if both
   * fold levels collapse; "body at the default level" alone does not catch a
   * re-added fold read. Together they are the whole change: the row shows the
   * message the model already acted on, and shows it whatever the reader has
   * pressed.
   */
  it('renders the sender and the body identically at every fold level', async () => {
    const item = buildPeerMessageHistoryItem({
      text: envelope(),
      origin: origin(),
    });

    const frames: string[] = [];
    for (const constrainHeight of [true, false]) {
      const result = await renderWithProviders(<>{item.content}</>, {
        uiState: { constrainHeight },
      });
      frames.push(result.lastFrame() ?? '');
      result.unmount();
    }

    expect(frames[0]).toBe(frames[1]);
    for (const frame of frames) {
      expect(frame).toContain(`peer-cli-4-${HANDLE}`);
      expect(frame).toContain(BODY);
      expect(frame).not.toContain('to expand');
      // The envelope is what the model reads, never what the user does.
      expect(frame).not.toContain('cross-session-message');
    }
  });

  /**
   * The sigil marks the line as inbound, and there must be exactly one of them.
   * `formatPeerAttribution` has three shapes and supplies its own `@` in the
   * third, which an unconditional prefix turns into `@ @peer`.
   */
  it('carries exactly one sigil for every attribution shape', async () => {
    const carriesHandle = await render({
      text: envelope(),
      origin: origin({ name: `peer-cli-4-${HANDLE}` }),
    });
    expect(carriesHandle).toContain(`@ peer-cli-4-${HANDLE} ${figures.pointer}`);

    const disagrees = await render({
      text: envelope(),
      origin: origin({ name: 'foo' }),
    });
    expect(disagrees).toContain(`@ foo -${HANDLE} ${figures.pointer}`);

    // No origin at all: neither a claimed name nor a usable address, which is
    // the branch that returns the placeholder.
    const unidentified = await render({ text: 'not an envelope at all' });
    expect(unidentified).toContain(`${UNKNOWN_PEER_LABEL} ${figures.pointer}`);
    expect(unidentified).not.toContain(`@ ${UNKNOWN_PEER_LABEL}`);
  });

  /**
   * The row used to register an overflow id so the footer would offer `ctrl+o`.
   * Nothing is hidden now, and `boundPeerBodyForFeed` truncates at build time,
   * so the hint would point at content no screen can produce.
   */
  it('registers no overflow id', async () => {
    const sizes: number[] = [];
    const Probe = () => {
      sizes.push(useOverflowState()?.overflowingIds.size ?? 0);
      return null;
    };

    const item = buildPeerMessageHistoryItem({
      text: envelope(),
      origin: origin(),
    });
    const result = await renderWithProviders(
      <>
        {item.content}
        <Probe />
      </>,
      { uiState: { constrainHeight: true } },
    );
    await result.waitUntilReady();
    result.unmount();

    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((size) => size === 0)).toBe(true);
  });

  /**
   * `origin.body` is the message before the transport prefixed it with `@"path"`
   * attachment references, so it wins over re-parsing the prompt.
   */
  it('prefers origin.body over parsing the prompt', async () => {
    const frame = await render(
      { text: envelope('markup version'), origin: origin({ body: 'clean version' }) },
    );

    expect(frame).toContain('clean version');
    expect(frame).not.toContain('markup version');
  });

  it('parses the envelope when no origin body is carried', async () => {
    const frame = await render(
      { text: envelope(), origin: origin({ body: undefined }) },
    );

    expect(frame).toContain(BODY);
    expect(frame).not.toContain('cross-session-message');
  });

  /**
   * The persisted form carries the header and safety notice `wrapPeerMessage`
   * adds for the model. A transcript written before `origin.body` existed has
   * only this to work from.
   */
  it('unwraps the persisted form before parsing it', async () => {
    const wrapped = wrapTextByOrigin(envelope(), { kind: 'peer', from: ADDRESS });
    expect(wrapped).not.toBe(envelope());

    const frame = await render(
      { text: wrapped, origin: origin({ body: undefined }) },
    );

    expect(frame).toContain(BODY);
    expect(frame).not.toContain('Another Qwen Code session sent a message');
    expect(frame).not.toContain('permission laundering');
  });

  /**
   * The defect this whole row exists to fix: a builder that can decline to
   * render leaves a message that the model has already acted on invisible.
   */
  it('never declines to render, whatever it is handed', async () => {
    expect(buildPeerMessageHistoryItem({ text: 'not an envelope at all' })).toBeTruthy();

    const fromRaw = await render({ text: 'not an envelope at all' });
    expect(fromRaw).toContain('not an envelope at all');

    const fromSummary = await render(
      { text: '', displaySummary: 'summary only' },
    );
    expect(fromSummary).toContain('summary only');
  });

  it('stands in for an empty body', async () => {
    const frame = await render({
      text: envelope(''),
      origin: origin({ body: '' }),
    });

    expect(frame).toContain('(empty message)');
  });

  it('discloses attachments', async () => {
    const frame = await render({
      text: envelope(),
      origin: origin({ attachmentCount: 2 }),
    });

    expect(frame).toContain('2 files arrived with this message');
    // The `+N file` fragment belonged to the collapsed row and has no second
    // state to live in.
    expect(frame).not.toContain('+2 file');
  });

  it('reports a body it had to truncate', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const frame = await render(
      { text: envelope(long), origin: origin({ body: long }) },
    );

    expect(frame).toContain('20 more lines');
  });

  it('renders peer text inert', async () => {
    const hostile = 'wiped[2J───';
    const frame = await render(
      { text: envelope(hostile), origin: origin({ body: hostile }) },
    );

    expect(frame).toContain('wiped');
    for (const unsafe of ['', '─']) {
      expect(frame).not.toContain(unsafe);
    }
  });

  // The address is a claim either way; this says only that no session on this
  // machine had published it when the message arrived.
  it('marks a sender whose address named no registered session', async () => {
    const frame = await render({
      text: envelope(),
      origin: origin({ knownPeer: false }),
    });

    expect(frame).toContain(`peer-cli-4-${HANDLE} (unregistered) ${figures.pointer}`);
  });

  it('leaves a registered or unrecorded sender unmarked', async () => {
    for (const knownPeer of [true, undefined]) {
      const frame = await render({
        text: envelope(),
        origin: origin(knownPeer === undefined ? {} : { knownPeer }),
      });
      expect(frame).not.toContain('unregistered');
      expect(frame).toContain(`peer-cli-4-${HANDLE} ${figures.pointer}`);
    }
  });

});
