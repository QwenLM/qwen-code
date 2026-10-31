/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { MCPManagementDialog } from './MCPManagementDialog.js';
import { renderWithProviders } from '../../../test-utils/render.js';

vi.mock('../../../config/mcpApprovals.js', () => ({
  loadMcpApprovals: vi.fn(() => ({
    getState: vi.fn(() => 'approved'),
  })),
}));

const createConfig = (): Config =>
  ({
    getMcpServers: () => ({}),
    getToolRegistry: () => undefined,
    getPromptRegistry: () => undefined,
    getResourceRegistry: () => undefined,
    getWorkingDir: () => process.cwd(),
    isMcpServerDisabled: () => false,
  }) as unknown as Config;

describe('MCPManagementDialog', () => {
  it('uses the same rounded outer border as other dialogs', () => {
    const { lastFrame } = renderWithProviders(
      <MCPManagementDialog onClose={vi.fn()} />,
      { config: createConfig() },
    );

    expect(lastFrame()).toContain('╭');
    expect(lastFrame()).toContain('╮');
  });

  it('opens the details of a configured server with an empty name', async () => {
    const config = createConfig();
    vi.spyOn(config, 'getMcpServers').mockReturnValue({
      '': { command: 'node' },
    });
    const { lastFrame, stdin } = renderWithProviders(
      <MCPManagementDialog onClose={vi.fn()} />,
      { config },
    );
    await vi.waitFor(() => expect(lastFrame()).toContain('User MCPs'));
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame()).toContain('Command:'));
    expect(lastFrame()).toContain('node');
  });
});
