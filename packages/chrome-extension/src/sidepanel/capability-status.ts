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
  | 'automation-configured'
  | 'automation-connected'
  | 'automation-pending'
  | 'automation-shadowed';

export interface CapabilityStatus {
  state: CapabilityStatusState;
  shellReady: boolean;
  warning: string | null;
}

export interface WorkspaceMcpSnapshot {
  servers?: ReadonlyArray<{
    name?: string;
    mcpStatus?: string;
    config?: { args?: readonly string[] };
  }>;
}

export function deriveCapabilityStatus(
  daemonReachable: boolean,
  features: readonly string[],
  mcpSnapshot?: WorkspaceMcpSnapshot,
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
  if (mcpSnapshot) {
    const server = mcpSnapshot.servers?.find(
      (candidate) => candidate.name === 'chrome-devtools',
    );
    if (!server) {
      return {
        state: 'automation-pending',
        shellReady: true,
        warning:
          'Browser tools are configured but the adapter is not connected.',
      };
    }
    const usesTunnel = server.config?.args?.some((arg) =>
      /\/cdp(?:$|[?#])/.test(arg),
    );
    if (!usesTunnel) {
      return {
        state: 'automation-shadowed',
        shellReady: true,
        warning:
          'An existing chrome-devtools MCP configuration is taking precedence. Disable or rename it to use the extension tunnel.',
      };
    }
    if (server.mcpStatus !== 'connected') {
      return {
        state: 'automation-pending',
        shellReady: true,
        warning:
          'Browser tools are configured but the adapter is not connected.',
      };
    }
    return { state: 'automation-connected', shellReady: true, warning: null };
  }
  return { state: 'automation-configured', shellReady: true, warning: null };
}
