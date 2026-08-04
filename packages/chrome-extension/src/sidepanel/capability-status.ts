/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Server name the daemon registers for the runtime adapter. Matched by string
// across the package boundary; capability-status.test.ts pins it against
// CHROME_DEVTOOLS_MCP_SERVER_NAME in packages/cli/src/serve/acp-http/index.ts.
export const CHROME_DEVTOOLS_SERVER_NAME = 'chrome-devtools';

// Tunnel-endpoint path pattern; capability-status.test.ts pins the same
// literal in run-real-chrome.mjs's acceptance wait.
export const CDP_TUNNEL_ENDPOINT_PATTERN = /\/cdp(?:$|[/?#])/;

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
    // "no data yet", not "adapter missing". A live daemon, however, reports
    // discoveryState: 'not_started' permanently next to a populated servers
    // array (the chrome-devtools entry comes from the daemon MCP pool, not the
    // config-level discovery state), so this branch only applies when there are
    // genuinely no servers to inspect yet.
    if (
      (mcpSnapshot.initialized === false ||
        mcpSnapshot.discoveryState === 'not_started') &&
      !mcpSnapshot.servers?.length
    ) {
      return {
        state: 'automation-configured',
        shellReady: true,
        warning: 'Browser tools status is unknown until a chat session starts.',
      };
    }

    const server = mcpSnapshot.servers?.find(
      (candidate) => candidate.name === CHROME_DEVTOOLS_SERVER_NAME,
    );
    if (!server) {
      return {
        state: 'automation-pending',
        shellReady: true,
        warning:
          'Browser tools are configured but the adapter is not connected.',
      };
    }
    const usesTunnel = server.config?.args?.some((arg) => {
      const candidate = arg.replace(/^--?[\w-]+=/, '');
      if (!CDP_TUNNEL_ENDPOINT_PATTERN.test(candidate)) return false;
      if (!baseUrl) return true;
      try {
        const argUrl = new URL(candidate);
        const daemonUrl = new URL(baseUrl);
        // The panel treats every loopback spelling as one host (isLoopback in
        // sidepanel.js), so a daemon bound to `localhost`/`::1` is the same
        // tunnel as the default 127.0.0.1 bind, not a shadowing config.
        const loopback = (host: string) => {
          const bare = host.replace(/^\[|\]$/g, '');
          return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1'
            ? 'loopback'
            : bare;
        };
        return (
          loopback(argUrl.hostname) === loopback(daemonUrl.hostname) &&
          argUrl.port === daemonUrl.port
        );
      } catch {
        return false;
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
  return {
    state: 'automation-configured',
    shellReady: true,
    warning: 'Browser tools status is unknown until a chat session starts.',
  };
}
