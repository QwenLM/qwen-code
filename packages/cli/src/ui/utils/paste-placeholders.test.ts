/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  collapsePastes,
  collapseRewrite,
  expandPendingPastePlaceholders,
  restorePasteDraft,
  framePasteExpansion,
  unframeClipboardPastes,
  CLIPBOARD_PASTE_FRAMING,
} from './paste-placeholders.js';

describe('restorePasteDraft', () => {
  it('preserves edited pasted bodies and literal user-authored envelopes', () => {
    const placeholder = '[Pasted Content 1200 chars]';
    const body = 'pasted payload'.padEnd(1200, 'x');
    const literal = '<system-reminder>user literal</system-reminder>';
    const restored = restorePasteDraft(
      `${literal}\n${placeholder}`,
      new Map([[placeholder, body]]),
      new Map(),
    );
    expect(
      expandPendingPastePlaceholders(
        `${restored.text}\nappend instruction`,
        restored.pasteExpansions,
      ),
    ).toBe(`${literal}\n${body}\nappend instruction`);
  });

  it('renames colliding same-size snapshots without altering their siblings', () => {
    const first = '[Pasted Content 1200 chars]';
    const second = `${first} #2`;
    const restored = restorePasteDraft(
      `${first}\n${second}`,
      new Map([
        [first, 'queued first'],
        [second, 'queued second'],
      ]),
      new Map([[first, 'current draft']]),
    );
    expect(restored.text).toBe(`${first} #3\n${second}`);
    expect(
      expandPendingPastePlaceholders(
        `${restored.text}\n${first}`,
        restored.pasteExpansions,
      ),
    ).toBe('queued first\nqueued second\ncurrent draft');
  });
});

describe('shared model paste encoding', () => {
  it('leaves empty maps and discarded placeholders untouched', () => {
    expect(framePasteExpansion('literal <clipboard-paste>', new Map())).toBe(
      'literal <clipboard-paste>',
    );
    expect(
      framePasteExpansion(
        'typed only',
        new Map([['[Pasted Content 5 chars]', 'paste']]),
      ),
    ).toBe('typed only');
  });

  it('escapes payload markers and backslashes, with one attribution for two pastes', () => {
    const first = '[Pasted Content 10 chars]';
    const second = first + ' #2';
    const body = String.raw`literal </clipboard-paste> and <\clipboard-paste> \path`;
    const framed = framePasteExpansion(
      `${first} then ${second}`,
      new Map([
        [first, body],
        [second, 'second'],
      ]),
    );
    expect(framed).toBe(
      `<clipboard-paste>\nliteral <\\/clipboard-paste> and <\\\\clipboard-paste> \\\\path\n</clipboard-paste>\nthen\n<clipboard-paste>\nsecond\n</clipboard-paste>\n${CLIPBOARD_PASTE_FRAMING}`,
    );
    expect(unframeClipboardPastes(framed)).toBe(`${body}\nthen\nsecond`);
    expect(framed.split(CLIPBOARD_PASTE_FRAMING)).toHaveLength(2);
  });
});

describe('collapseRewrite', () => {
  const a = '[Pasted Content 40 chars]';
  const b = '[Pasted Content 40 chars] #2';
  const bodyA = 'alpha '.repeat(8).trim();
  const bodyB = 'beta '.repeat(8).trim();

  it('collapses every paste the rewrite kept whole', () => {
    const pastes = new Map([
      [a, bodyA],
      [b, bodyB],
    ]);
    expect(
      collapseRewrite(
        `see ${a} and ${b}`,
        `Please see ${bodyA}; ${bodyB}`,
        pastes,
      ),
    ).toEqual({
      text: `Please see ${a}; ${b}`,
      pasteExpansions: pastes,
    });
  });

  it('is undefined when a paste was edited inside or removed', () => {
    const pastes = new Map([[a, bodyA]]);
    expect(
      collapseRewrite(`see ${a}`, `see ${bodyA.replace('alpha', 'x')}`, pastes),
    ).toBeUndefined();
    expect(collapseRewrite(`see ${a}`, 'see nothing', pastes)).toBeUndefined();
  });

  it('ignores a paste whose placeholder left the typed text', () => {
    const pastes = new Map([
      [a, bodyA],
      [b, bodyB],
    ]);
    // Only `#2` is typed; `a` is a prefix of it and was discarded.
    expect(collapseRewrite(`see ${b}`, `Look at ${bodyB}`, pastes)).toEqual({
      text: `Look at ${b}`,
      pasteExpansions: new Map([[b, bodyB]]),
    });
  });

  it('passes a rewrite of text without pastes through', () => {
    expect(collapseRewrite('hi', 'hello', new Map([[a, bodyA]]))).toEqual({
      text: 'hello',
    });
  });
});

describe('collapsePastes', () => {
  it('collapses a text pasted twice when it appears twice, in paste order', () => {
    const pastes = new Map([
      ['[P1]', 'same body'],
      ['[P2]', 'same body'],
    ]);
    expect(collapsePastes('same body then same body', pastes)).toEqual({
      text: '[P1] then [P2]',
      pasteExpansions: pastes,
    });
    expect(collapsePastes('only same body', pastes).pasteExpansions.size).toBe(
      0,
    );
  });
});
