/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { McpAuthHeaderNotice } from './McpAuthHeaderNotice.js';

describe('McpAuthHeaderNotice', () => {
  it('renders nothing when there is no authentication notice', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <McpAuthHeaderNotice message={null} />,
    );

    expect(lastFrame({ allowEmpty: true })).toBe('');
    unmount();
  });

  it('renders the warning marker and message without extra rows', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <McpAuthHeaderNotice message="1 MCP server needs authentication · run /mcp" />,
    );

    expect(lastFrame()).toBe(
      ' ● 1 MCP server needs authentication · run /mcp\n',
    );
    unmount();
  });
});
