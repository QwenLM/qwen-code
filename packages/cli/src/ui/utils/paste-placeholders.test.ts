/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  expandPendingPastePlaceholders,
  restorePasteDraft,
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
