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
  | 'automation-shadowed'
  | 'automation-unavailable';

export interface CapabilityStatus {
  state: CapabilityStatusState;
  shellReady: boolean;
  warning: string | null;
}

export interface WorkspaceMcpSnapshot {
  initialized?: boolean;
  discoveryState?: string;
  servers?: ReadonlyArray<{
    name?: string;
    mcpStatus?: string;
    config?: { args?: readonly string[] };
  }>;
}

export function deriveCapabilityStatus(
  daemonReachable: boolean,
  features: readonly string[],
  mcpSnapshot?: WorkspaceMcpSnapshot | null,
  baseUrl?: string,
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
  if (mcpSnapshot === null) {
    return {
      state: 'automation-unavailable',
      shellReady: true,
      warning: 'Browser tools status could not be verified.',
    };
  }

  if (mcpSnapshot) {
    // The ACP child serves an idle placeholder ({ initialized: false,
    // discoveryState: 'not_started', servers: [] }) before the first session,
    // after the child is reaped, and on cold-start preheat timeout. That is
    // "no data yet", not "adapter missing".
    if (
      mcpSnapshot.initialized === false ||
      mcpSnapshot.discoveryState === 'not_started'
    ) {
      return {
        state: 'automation-configured',
        shellReady: true,
        warning: null,
      };
    }

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
    // The /cdp path pattern mirrors run-real-chrome.mjs's acceptance wait.
    const usesTunnel = server.config?.args?.some((arg) => {
      if (!/\/cdp(?:$|[/?#])/.test(arg)) return false;
      if (!baseUrl) return true;
      try {
        const argUrl = new URL(arg);
        const daemonUrl = new URL(baseUrl);
        return (
          argUrl.hostname === daemonUrl.hostname &&
          argUrl.port === daemonUrl.port
        );
      } catch {
        return true;
      }
    });
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
