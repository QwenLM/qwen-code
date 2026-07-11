/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type CapabilityStatusState =
  | 'down'
  | 'needs-allow-origin'
  | 'chat-only'
  | 'tunnel-only'
  | 'automation-configured';

export interface CapabilityStatus {
  state: CapabilityStatusState;
  shellReady: boolean;
  warning: string | null;
}

export function deriveCapabilityStatus(
  daemonReachable: boolean,
  features: readonly string[],
): CapabilityStatus {
  if (!daemonReachable) {
    return { state: 'down', shellReady: false, warning: null };
  }
  if (!features.includes('allow_origin')) {
    return {
      state: 'needs-allow-origin',
      shellReady: false,
      warning: null,
    };
  }
  if (!features.includes('cdp_tunnel_over_ws')) {
    return {
      state: 'chat-only',
      shellReady: true,
      warning: 'Browser bridge is disabled for this daemon.',
    };
  }
  if (!features.includes('browser_automation_mcp')) {
    return {
      state: 'tunnel-only',
      shellReady: true,
      warning:
        'Browser tools are unavailable. They require QWEN_CDP_MCP_COMMAND and an auth-free loopback daemon.',
    };
  }
  return { state: 'automation-configured', shellReady: true, warning: null };
}
