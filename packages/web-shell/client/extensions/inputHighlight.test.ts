/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import { buildInputHighlightDecorations } from './inputHighlight';

describe('inputHighlight', () => {
  it('scans visible lines instead of the entire composer document', () => {
    const state = EditorState.create({
      doc: `${Array.from({ length: 10_000 }, () => '@hidden').join('\n')}\n/final`,
    });
    const lastLine = state.doc.line(state.doc.lines);
    const view = {
      state,
      visibleRanges: [{ from: lastLine.from, to: lastLine.to }],
    } as EditorView;
    const getCommands = vi.fn(() => []);

    const decorations = buildInputHighlightDecorations(
      view,
      getCommands,
      () => 'en',
    );

    expect(getCommands).toHaveBeenCalledOnce();
    expect(decorations.size).toBe(1);
  });
});
