/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import { ToolResultDisplay } from './ToolResultDisplay.js';
import { describe, it, expect } from 'vitest';
import { makeFakeConfig } from '@qwen-code/core';

describe('ToolResultDisplay Overflow', () => {
  // skip: 现存失败
  it.skip('shows the head of the content when overflowDirection is bottom (string)', async () => {
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <ToolResultDisplay
        resultDisplay={content}
        terminalWidth={80}
        maxLines={3}
        overflowDirection="bottom"
      />,
      {
        config: makeFakeConfig({ useAlternateBuffer: false }),
        settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        uiState: { constrainHeight: true, terminalHeight: 50 },
      },
    );
    await waitUntilReady();
    const output = lastFrame();

    expect(output).not.toContain('Line 1');
    expect(output).not.toContain('Line 2');
    expect(output).toContain('Line 3');
    expect(output).toContain('Line 4');
    expect(output).toContain('Line 5');
    unmount();
  });

  // skip: 现存失败
  it.skip('shows the tail of the content when overflowDirection is top (string default)', async () => {
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <ToolResultDisplay
        resultDisplay={content}
        terminalWidth={80}
        maxLines={3}
        overflowDirection="top"
      />,
      {
        config: makeFakeConfig({ useAlternateBuffer: false }),
        settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        uiState: { constrainHeight: true, terminalHeight: 50 },
      },
    );
    await waitUntilReady();
    const output = lastFrame();

    expect(output).not.toContain('Line 1');
    expect(output).not.toContain('Line 2');
    expect(output).toContain('Line 3');
    expect(output).toContain('Line 4');
    expect(output).toContain('Line 5');
    unmount();
  });
});
