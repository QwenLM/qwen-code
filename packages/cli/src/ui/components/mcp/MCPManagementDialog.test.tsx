/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { MCPManagementDialog } from './MCPManagementDialog.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { loadMcpApprovals } from '../../../config/mcpApprovals.js';

vi.mock('../../../config/mcpApprovals.js', async (importOriginal) => ({
  // The gate predicate is pure; keep the real one.
  isMcpApprovalGateArmed: (
    await importOriginal<typeof import('../../../config/mcpApprovals.js')>()
  ).isMcpApprovalGateArmed,
  loadMcpApprovals: vi.fn(() => ({
    getState: vi.fn(() => 'approved'),
  })),
}));

const createConfig = (overrides: Record<string, unknown> = {}): Config =>
  ({
    getMcpServers: () => ({}),
    getToolRegistry: () => undefined,
    getPromptRegistry: () => undefined,
    getResourceRegistry: () => undefined,
    getWorkingDir: () => process.cwd(),
    isMcpServerDisabled: () => false,
    getApprovalMode: () => 'default',
    getBareMode: () => false,
    isSafeMode: () => false,
    ...overrides,
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

  // A gate-off session holds `.mcp.json` unexpanded, so its digest cannot match
  // the store: it must neither read it nor offer to write it.
  it('does not read or show approval state from a gate-off (YOLO) session', async () => {
    const getState = vi.fn(() => 'pending' as const);
    vi.mocked(loadMcpApprovals).mockReturnValue({
      getState,
    } as unknown as ReturnType<typeof loadMcpApprovals>);
    const servers = {
      proj: { httpUrl: 'https://h.example/mcp', scope: 'project' as const },
    };

    const armed = renderWithProviders(
      <MCPManagementDialog onClose={vi.fn()} />,
      { config: createConfig({ getMcpServers: () => servers }) },
    );
    await vi.waitFor(() =>
      expect(armed.lastFrame()).toContain('needs approval'),
    );
    expect(getState).toHaveBeenCalledTimes(1);

    const yolo = renderWithProviders(
      <MCPManagementDialog onClose={vi.fn()} />,
      {
        config: createConfig({
          getMcpServers: () => servers,
          getApprovalMode: () => 'yolo',
        }),
      },
    );
    await vi.waitFor(() => expect(yolo.lastFrame()).toContain('proj'));
    expect(yolo.lastFrame()).not.toContain('needs approval');
    expect(getState).toHaveBeenCalledTimes(1);
  });
});
