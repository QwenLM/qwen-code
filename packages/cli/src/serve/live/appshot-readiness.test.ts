/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { ServeWorkspaceToolsStatus } from '@qwen-code/acp-bridge/status';
import { probeLiveAppshotReadiness } from './appshot-readiness.js';

function toolsStatus(
  tools: ServeWorkspaceToolsStatus['tools'],
  acpChannelLive = true,
): ServeWorkspaceToolsStatus {
  return {
    v: 1,
    workspaceCwd: '/conversations',
    initialized: true,
    acpChannelLive,
    tools,
  };
}

describe('probeLiveAppshotReadiness', () => {
  it('requires the actual Live Appshot tools from the Conversations registry', async () => {
    const bridge = {
      preheat: vi.fn(async () => undefined),
      getWorkspaceToolsStatus: vi.fn(async () =>
        toolsStatus([
          { name: 'computer_use__list_windows', enabled: true },
          { name: 'computer_use__get_window_state', enabled: true },
        ]),
      ),
    };

    await expect(probeLiveAppshotReadiness(bridge)).resolves.toEqual({
      state: 'ready',
    });
    expect(bridge.preheat).toHaveBeenCalledOnce();
    expect(bridge.getWorkspaceToolsStatus).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'a required tool is disabled',
      status: toolsStatus([
        { name: 'computer_use__list_windows', enabled: true },
        { name: 'computer_use__get_window_state', enabled: false },
      ]),
    },
    {
      name: 'the registry has not initialized',
      status: {
        ...toolsStatus([
          { name: 'computer_use__list_windows', enabled: true },
          { name: 'computer_use__get_window_state', enabled: true },
        ]),
        initialized: false,
      },
    },
    {
      name: 'the initialized ACP registry is unavailable',
      status: toolsStatus(
        [
          { name: 'computer_use__list_windows', enabled: true },
          { name: 'computer_use__get_window_state', enabled: true },
        ],
        false,
      ),
    },
  ])('fails closed when $name', async ({ status }) => {
    const bridge = {
      preheat: vi.fn(async () => undefined),
      getWorkspaceToolsStatus: vi.fn(
        async () => status as ServeWorkspaceToolsStatus,
      ),
    };

    await expect(probeLiveAppshotReadiness(bridge)).resolves.toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('Conversations runtime'),
    });
  });

  it('fails closed when the Conversations ACP child cannot initialize', async () => {
    const bridge = {
      preheat: vi.fn(async () => {
        throw new Error('preheat failed');
      }),
      getWorkspaceToolsStatus: vi.fn(),
    };

    await expect(probeLiveAppshotReadiness(bridge)).resolves.toMatchObject({
      state: 'unavailable',
      message: expect.stringContaining('Conversations runtime'),
    });
    expect(bridge.getWorkspaceToolsStatus).not.toHaveBeenCalled();
  });
});
