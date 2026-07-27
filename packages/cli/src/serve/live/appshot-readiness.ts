/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import type { LiveAppshotReadiness } from './types.js';

const REQUIRED_APPSHOT_TOOLS = [
  'computer_use__list_windows',
  'computer_use__get_window_state',
] as const;

type AppshotBridge = Pick<
  AcpSessionBridge,
  'preheat' | 'getWorkspaceToolsStatus'
>;

export async function probeLiveAppshotReadiness(
  bridge: AppshotBridge,
): Promise<LiveAppshotReadiness> {
  try {
    await bridge.preheat();
    const status = await bridge.getWorkspaceToolsStatus();
    const enabled = new Set(
      status.tools.filter((tool) => tool.enabled).map((tool) => tool.name),
    );
    if (
      !status.initialized ||
      !status.acpChannelLive ||
      REQUIRED_APPSHOT_TOOLS.some((name) => !enabled.has(name))
    ) {
      return {
        state: 'unavailable',
        message:
          'Computer Use tools are disabled or unavailable in the Conversations runtime.',
      };
    }
    return { state: 'ready' };
  } catch {
    return {
      state: 'unavailable',
      message:
        'Computer Use tools are unavailable in the Conversations runtime.',
    };
  }
}
