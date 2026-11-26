/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { describe, expect, it } from 'vitest';
import type { StyledSegment } from './squash-text-nodes.js';
import {
  applyStylesToWrappedText,
  buildCharToSegmentMap,
} from './render-node-to-output.js';

const SESSION_URL =
  'https://example.com/agents/session/qs_01kz87vg4wzd4878em4hhzm3x3';

// Mirrors what InfoMessage produces for the /remote-control banner: leading
// indent, prose, the space before the link, then the link itself.
const segments: StyledSegment[] = [
  { text: '    ', styles: { color: '#73b78e' } },
  { text: 'Scan the QR or visit:', styles: { color: '#73b78e' } },
  { text: ' ', styles: { color: '#73b78e' } },
  {
    text: SESSION_URL,
    styles: { color: '#6ad86c', underline: true },
    hyperlink: SESSION_URL,
  },
];

const plainText = segments.map((segment) => segment.text).join('');

function stripSgr(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

function styleWrapped(
  wrapped: string,
  styledSegments: StyledSegment[] = segments,
  original: string = plainText,
): string[] {
  return applyStylesToWrappedText(
    wrapped,
    styledSegments,
    buildCharToSegmentMap(styledSegments),
    original,
    false,
  ).split('\n');
}

/** Text covered by the OSC 8 hyperlink on the given styled line. */
function hyperlinkText(styledLine: string): string | undefined {
  const match = /\u001B]8;;[^\u0007]*\u0007([\s\S]*?)\u001B]8;;\u0007/.exec(
    styledLine,
  );
  return match ? stripSgr(match[1]!) : undefined;
}

describe('applyStylesToWrappedText', () => {
  it('links the whole URL when the wrap keeps the break-point space', () => {
    const lines = styleWrapped(`    Scan the QR or visit: \n${SESSION_URL}`);

    expect(hyperlinkText(lines[1]!)).toBe(SESSION_URL);
  });

  it('links the whole URL when the wrap swallowed the break-point space', () => {
    // Regression for the /remote-control banner: a wrap implementation that
    // drops the space it breaks on used to shift the continuation line by one
    // character, leaving the leading `h` outside the OSC 8 range so the
    // clickable text became `ttps://…`.
    const lines = styleWrapped(`    Scan the QR or visit:\n${SESSION_URL}`);

    expect(hyperlinkText(lines[1]!)).toBe(SESSION_URL);
    expect(stripSgr(lines[1]!).startsWith('\u001B]8;;')).toBe(true);
  });

  it('keeps segment boundaries when wrapping preserves whitespace', () => {
    const boundarySegments: StyledSegment[] = [
      { text: 'AAAA', styles: { color: '#ff0000' } },
      { text: '   ', styles: { color: '#ff0000' } },
      { text: 'BBBB', styles: { color: '#0000ff' } },
    ];
    const boundaryPlain = boundarySegments
      .map((segment) => segment.text)
      .join('');
    const lines = styleWrapped(
      'AAAA  \n BBBB',
      boundarySegments,
      boundaryPlain,
    );

    expect(lines.map(stripSgr)).toEqual(['AAAA  ', ' BBBB']);
  });
});
