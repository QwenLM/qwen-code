/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
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
