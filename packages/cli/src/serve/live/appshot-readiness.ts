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
const APPSHOT_PROBE_TIMEOUT_MS = 5_000;

type AppshotBridge = Pick<
  AcpSessionBridge,
  'preheat' | 'getWorkspaceToolsStatus'
>;

export async function probeLiveAppshotReadiness(
  bridge: AppshotBridge,
): Promise<LiveAppshotReadiness> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    const status = await Promise.race([
      (async () => {
        await bridge.preheat();
        return await bridge.getWorkspaceToolsStatus();
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Appshot readiness probe timed out.')),
          APPSHOT_PROBE_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
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
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
