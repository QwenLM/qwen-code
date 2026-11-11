/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildTuiPromptSuggestionSystemPrompt } from './tuiPromptSuggestion.js';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;

describe('buildTuiPromptSuggestionSystemPrompt', () => {
  it('places plugin contributions between the generic guidance and output contract', () => {
    const prompt = buildTuiPromptSuggestionSystemPrompt([
      { id: 'example', prompt: '## Example\n\nExample guidance.' },
    ]);

    expect(prompt).toContain('## Example\n\nExample guidance.');
    expect(prompt.indexOf('## Example')).toBeGreaterThan(
      prompt.indexOf('## Select suggestions'),
    );
    expect(prompt.indexOf('## Example')).toBeLessThan(
      prompt.indexOf('## Output'),
    );
    expect(prompt).not.toMatch(CJK_RE);
  });

  it('preserves the legacy TUI next-action guidance and output contract', () => {
    const prompt = buildTuiPromptSuggestionSystemPrompt();

    expect(prompt).toContain('Newer evidence overrides older plans');
    expect(prompt).toContain(
      'Treat automated task notifications as system events',
    );
    expect(prompt).toContain(
      'already asks the user to choose, confirm, approve, authorize, or reply using explicit options',
    );
    expect(prompt).toContain(
      "do not duplicate its options, predict the user's choice, or bias the decision",
    );
    expect(prompt).not.toContain('choosing an offered path');
    expect(prompt).toContain(
      'A completed task may still have a natural next step',
    );
    expect(prompt).toContain(
      'do not favor coding actions for documentation, research, analysis, or other non-code work',
    );
    expect(prompt).toContain('Return up to 3 short, distinct instructions');
    expect(prompt).toContain(
      'no numbering, quotes, or explanation',
    );
    expect(prompt).toContain('Do not target a fixed count');
    expect(prompt).not.toContain('Return exactly one');
    expect(prompt).toContain("Match the latest actual user's language");
  });
});
