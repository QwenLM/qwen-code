/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How a peer message names its sender, and how much of its body is shown.
 *
 * Both halves are the point at which sender-authored text becomes something a
 * terminal renders, so the assertions here are as much about what is *not*
 * carried through as about what is.
 */

import { describe, expect, it } from 'vitest';
import { peerHandle, toUdsAddress } from './peer-address.js';
import {
  MAX_FEED_BODY_LINES,
  MAX_FEED_BODY_LINE_LENGTH,
  UNKNOWN_PEER_LABEL,
  boundPeerBodyForFeed,
  formatPeerAttribution,
  joinPeerAttribution,
  labelCarriesHandle,
} from './peer-message-preview.js';

const SOCKET = '/tmp/test-socks/4242.sock';
const ADDRESS = toUdsAddress(SOCKET);
const HANDLE = peerHandle(SOCKET);

describe('formatPeerAttribution', () => {
  /**
   * The ordinary case. An untitled session signs itself `base-<handle>`, and the
   * handle we derive from its address is the same one — so repeating it would
   * print the same two characters twice on every row a user ever sees.
   */
  it('does not repeat a handle the claimed name already carries', () => {
    const attribution = formatPeerAttribution({
      from: ADDRESS,
      claimedName: `peer-cli-4-${HANDLE}`,
    });

    expect(attribution).toEqual({ name: `peer-cli-4-${HANDLE}` });
    expect(joinPeerAttribution(attribution)).toBe(`peer-cli-4-${HANDLE}`);
  });

  it('appends the handle to a titled session, which carries none', () => {
    const attribution = formatPeerAttribution({
      from: ADDRESS,
      claimedName: 'bar',
    });

    expect(attribution).toEqual({ name: 'bar', handleSuffix: `-${HANDLE}` });
  });

  /**
   * A teammate relaying through a session signs `<session> / <member>`, so the
   * segment that carries the handle is the one before the separator.
   */
  it('reads the session segment of a relayed name', () => {
    const attribution = formatPeerAttribution({
      from: ADDRESS,
      claimedName: `peer-cli-4-${HANDLE} / Reviewer`,
    });

    expect(attribution.handleSuffix).toBeUndefined();
  });

  /**
   * The whole reason the handle is derived rather than read. A sender is free to
   * claim any name; it is not free to choose the address replies go to, so a
   * name whose handle disagrees with that address gets both shown.
   */
  it('shows both when the claimed handle disagrees with the address', () => {
    const claimed = 'peer-cli-4-99';
    expect(claimed.endsWith(`-${HANDLE}`)).toBe(false);

    const attribution = formatPeerAttribution({
      from: ADDRESS,
      claimedName: claimed,
    });

    expect(attribution).toEqual({ name: claimed, handleSuffix: `-${HANDLE}` });
  });

  it('names the handle alone when no name was claimed', () => {
    expect(formatPeerAttribution({ from: ADDRESS })).toEqual({
      name: `-${HANDLE}`,
    });
  });

  it('falls back to a placeholder with neither a name nor a usable address', () => {
    expect(formatPeerAttribution({})).toEqual({ name: UNKNOWN_PEER_LABEL });
    expect(formatPeerAttribution({ from: 'mailbox:someone' })).toEqual({
      name: UNKNOWN_PEER_LABEL,
    });
  });

  /**
   * Sanitizing inside the formatter rather than at each surface is what makes it
   * impossible for one of them to forget. A name is one line of chrome, so
   * newlines collapse too — a sender must not be able to push the row apart.
   */
  it('strips escapes and collapses whitespace in a claimed name', () => {
    // ESC, a bidi override, a zero-width space and a box-drawing character: the
    // things that let a name repaint the screen or impersonate this CLI's
    // chrome. What survives is inert text — `[2J` without its ESC is four
    // characters, not a clear-screen.
    const hostile = '\u001b[2Jwiped\u202e\u200b\u2500\nsecond line';

    const attribution = formatPeerAttribution({
      from: ADDRESS,
      claimedName: hostile,
    });

    expect(attribution.name).toBe('[2Jwiped second line');
    for (const unsafe of ['\u001b', '\u202e', '\u200b', '\u2500', '\n']) {
      expect(attribution.name).not.toContain(unsafe);
    }
  });

  it('bounds an absurdly long claimed name', () => {
    const attribution = formatPeerAttribution({
      from: ADDRESS,
      claimedName: 'x'.repeat(500),
    });

    expect(attribution.name.length).toBeLessThanOrEqual(80);
  });
});

describe('labelCarriesHandle', () => {
  it('matches only a trailing suffix on the session segment', () => {
    expect(labelCarriesHandle('project-4f', '4f')).toBe(true);
    expect(labelCarriesHandle('project-4f / Reviewer', '4f')).toBe(true);
    expect(labelCarriesHandle('4f-project', '4f')).toBe(false);
    expect(labelCarriesHandle('project / Reviewer-4f', '4f')).toBe(false);
  });
});

describe('boundPeerBodyForFeed', () => {
  it('passes an ordinary body through, sanitized', () => {
    const bounded = boundPeerBodyForFeed('pong \u001b[31m— still here');

    expect(bounded).toEqual({
      body: 'pong [31m— still here',
      omittedLines: 0,
    });
  });

  /**
   * The inbound frame cap is a megabyte and the feed is neither scrollable nor
   * cheap to redraw, so one peer must not be able to push everything else off
   * the screen.
   */
  it('caps the line count and reports what it dropped', () => {
    const lines = Array.from({ length: MAX_FEED_BODY_LINES + 7 }, (_, i) =>
      String(i),
    );
    const bounded = boundPeerBodyForFeed(lines.join('\n'));

    expect(bounded.body.split('\n')).toHaveLength(MAX_FEED_BODY_LINES);
    expect(bounded.omittedLines).toBe(7);
  });

  it('caps a single very long line', () => {
    const bounded = boundPeerBodyForFeed('x'.repeat(MAX_FEED_BODY_LINE_LENGTH * 2));

    expect(bounded.body).toHaveLength(MAX_FEED_BODY_LINE_LENGTH + 1);
    expect(bounded.body.endsWith('…')).toBe(true);
  });

  /** Rendering an empty envelope as blank space says less than saying so. */
  it('stands in for an empty body', () => {
    expect(boundPeerBodyForFeed('   \n  ').body).toBe('(empty message)');
  });
});
