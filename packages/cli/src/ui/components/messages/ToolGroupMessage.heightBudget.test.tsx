/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import type React from 'react';
import { ToolGroupMessage } from './ToolGroupMessage.js';
import type { IndividualToolCallDisplay } from '../../types.js';
import { StreamingState, ToolCallStatus } from '../../types.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { ConfigContext } from '../../contexts/ConfigContext.js';
import { SettingsContext } from '../../contexts/SettingsContext.js';
import { StreamingContext } from '../../contexts/StreamingContext.js';
import type { LoadedSettings } from '../../../config/settings.js';

/**
 * The `ui.showToolCallArgs` args row renders through the REAL ToolMessage here
 * — the sibling `ToolGroupMessage.test.tsx` mocks that component away, so it
 * cannot see how tall the row actually draws.
 *
 * `ToolGroupMessage` budgets height as
 * `availableTerminalHeight - staticHeight - countOneLineToolCalls`, hands the
 * remainder to the result renderers only, and counts a tool with no
 * `resultDisplay` as exactly one line. The args row is outside both, so while
 * its only bound was 1000 *characters* a single pending batch drew far past the
 * viewport (six calls measured ~72 rows into a 20-row frame). Once the live,
 * non-`<Static>` frame exceeds the terminal height, ink's
 * `shouldClearTerminalForFrame` wipes scrollback on every repaint (#5798).
 */
describe('ToolGroupMessage height budget under ui.showToolCallArgs', () => {
  const AVAILABLE_TERMINAL_HEIGHT = 20;
  const CONTENT_WIDTH = 100;

  const mockConfig = {
    getShouldUseNodePtyShell: () => false,
  } as unknown as Config;

  const renderWithArgsSetting = (
    component: React.ReactElement,
    showToolCallArgs: boolean,
  ) =>
    render(
      <SettingsContext.Provider
        value={{ merged: { ui: { showToolCallArgs } } } as LoadedSettings}
      >
        <ConfigContext.Provider value={mockConfig}>
          <StreamingContext.Provider value={StreamingState.Responding}>
            {component}
          </StreamingContext.Provider>
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

  // Six executing edits, each with an args payload far past the character cap
  // — the shape the reviewer's probe used.
  const pendingBatch: IndividualToolCallDisplay[] = Array.from(
    { length: 6 },
    (_unused, i) => ({
      callId: `edit-${i}`,
      name: 'Edit',
      description: `file${i}.ts`,
      resultDisplay: undefined,
      status: ToolCallStatus.Executing,
      confirmationDetails: undefined,
      renderOutputAsMarkdown: false,
      args: {
        file_path: `file${i}.ts`,
        old_string: 'a'.repeat(2000),
        new_string: 'b'.repeat(2000),
      },
    }),
  );

  const frameLines = (frame: string) => frame.split('\n').length;

  it('keeps a pending batch inside the terminal height with the setting on', () => {
    const { lastFrame } = renderWithArgsSetting(
      <ToolGroupMessage
        groupId={1}
        toolCalls={pendingBatch}
        contentWidth={CONTENT_WIDTH}
        isFocused={true}
        isPending={true}
        availableTerminalHeight={AVAILABLE_TERMINAL_HEIGHT}
      />,
      true,
    );
    const frame = lastFrame() ?? '';

    // The rows are actually there — this is a bound, not a regression to the
    // compact view. If the args row were dropped the next assertion would pass
    // vacuously.
    expect(frame).toContain('old_string');
    expect(frame).toContain('chars (ctrl+o)');
    // Each tool costs its header plus at most TOOL_ARGS_INLINE_MAX_LINES rows.
    expect(frameLines(frame)).toBeLessThanOrEqual(AVAILABLE_TERMINAL_HEIGHT);
  });

  it('is not taller than the same batch with the setting off, by more than the args rows', () => {
    const { lastFrame: offFrame } = renderWithArgsSetting(
      <ToolGroupMessage
        groupId={1}
        toolCalls={pendingBatch}
        contentWidth={CONTENT_WIDTH}
        isFocused={true}
        isPending={true}
        availableTerminalHeight={AVAILABLE_TERMINAL_HEIGHT}
      />,
      false,
    );
    const { lastFrame: onFrame } = renderWithArgsSetting(
      <ToolGroupMessage
        groupId={1}
        toolCalls={pendingBatch}
        contentWidth={CONTENT_WIDTH}
        isFocused={true}
        isPending={true}
        availableTerminalHeight={AVAILABLE_TERMINAL_HEIGHT}
      />,
      true,
    );

    const off = frameLines(offFrame() ?? '');
    const on = frameLines(onFrame() ?? '');
    // 2 rows per call, no more: the growth is bounded by the line cap rather
    // than by how long the payload happens to be.
    expect(on - off).toBeLessThanOrEqual(2 * pendingBatch.length);
  });
});
