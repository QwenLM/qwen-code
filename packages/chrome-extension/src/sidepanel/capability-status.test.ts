/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CDP_TUNNEL_ENDPOINT_PATTERN,
  CHROME_DEVTOOLS_SERVER_NAME,
  deriveCapabilityStatus,
} from './capability-status.js';

describe('deriveCapabilityStatus', () => {
  it('reports a stopped daemon before inspecting capabilities', () => {
    expect(deriveCapabilityStatus(false, [])).toEqual({
      state: 'down',
      shellReady: false,
      warning: null,
    });
  });

  it('requires the extension origin before framing the Web Shell', () => {
    expect(deriveCapabilityStatus(true, ['health'])).toEqual({
      state: 'needs-allow-origin',
      shellReady: false,
      warning: null,
    });
  });

  it('warns when chat is ready without the CDP tunnel', () => {
    expect(deriveCapabilityStatus(true, ['allow_origin'])).toEqual({
      state: 'chat-only',
      shellReady: true,
      warning: 'Browser bridge is disabled for this daemon.',
    });
  });

  it('warns when the CDP tunnel is ready without an automation adapter', () => {
    expect(
      deriveCapabilityStatus(true, ['allow_origin', 'cdp_tunnel_over_ws']),
    ).toEqual({
      state: 'tunnel-only',
      shellReady: true,
      warning:
        'Browser tools are unavailable. They require QWEN_CDP_MCP_COMMAND and an auth-free loopback daemon.',
    });
  });

  it('reports configured, not pending, when the ACP child has not started discovery', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        { initialized: false, discoveryState: 'not_started', servers: [] },
      ),
    ).toEqual({
      state: 'automation-configured',
      shellReady: true,
      warning: 'Browser tools status is unknown until a chat session starts.',
    });
  });

  it('reports configured when the MCP snapshot argument is omitted', () => {
    expect(
      deriveCapabilityStatus(true, [
        'allow_origin',
        'cdp_tunnel_over_ws',
        'browser_automation_mcp',
      ]),
    ).toEqual({
      state: 'automation-configured',
      shellReady: true,
      warning: 'Browser tools status is unknown until a chat session starts.',
    });
  });

  it('warns when runtime MCP status cannot be read', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        null,
      ),
    ).toEqual({
      state: 'automation-unavailable',
      shellReady: true,
      warning: 'Browser tools status could not be verified.',
    });
  });

  it('reports a connected runtime MCP that targets the extension tunnel', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
              config: {
                args: ['--wsEndpoint', 'ws://127.0.0.1:4170/cdp'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-connected',
      shellReady: true,
      warning: null,
    });
  });

  it('treats a localhost-bound tunnel as connected, not shadowed', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
              config: {
                args: ['--wsEndpoint', 'ws://localhost:4170/cdp'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-connected',
      shellReady: true,
      warning: null,
    });
  });

  it('treats a trailing-slash tunnel endpoint as connected, not shadowed', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
              config: {
                args: ['--wsEndpoint', 'ws://127.0.0.1:4170/cdp/'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-connected',
      shellReady: true,
      warning: null,
    });
  });

  it('warns while the configured runtime MCP is not connected', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        { servers: [] },
      ),
    ).toEqual({
      state: 'automation-pending',
      shellReady: true,
      warning: 'Browser tools are configured but the adapter is not connected.',
    });
  });

  it('warns while the tunnel-backed runtime MCP is connecting', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connecting',
              config: {
                args: ['--wsEndpoint', 'ws://127.0.0.1:4170/cdp'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-pending',
      shellReady: true,
      warning: 'Browser tools are configured but the adapter is not connected.',
    });
  });

  it('warns when an existing chrome-devtools configuration shadows the tunnel', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
              config: {
                args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-shadowed',
      shellReady: true,
      warning:
        'An existing chrome-devtools MCP configuration is taking precedence. Disable or rename it to use the extension tunnel.',
    });
  });

  it('detects shadowing when a different daemon serves the /cdp endpoint', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
              config: {
                args: ['--wsEndpoint', 'ws://127.0.0.1:4171/cdp'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-shadowed',
      shellReady: true,
      warning:
        'An existing chrome-devtools MCP configuration is taking precedence. Disable or rename it to use the extension tunnel.',
    });
  });

  it('treats a chrome-devtools server with no config args as shadowing', () => {
    // An HTTP/SSE-transport chrome-devtools server carries no --wsEndpoint arg,
    // so config?.args?.some(...) is undefined and it must read as shadowing,
    // not fall through to automation-pending.
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-shadowed',
      shellReady: true,
      warning:
        'An existing chrome-devtools MCP configuration is taking precedence. Disable or rename it to use the extension tunnel.',
    });
  });

  it('detects shadowing even while discoveryState stays not_started', () => {
    // A live daemon reports discoveryState: 'not_started' permanently next to a
    // populated servers array, so a stale --browserUrl config that shadows the
    // tunnel must still surface as shadowed, not collapse to automation-configured.
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          initialized: true,
          discoveryState: 'not_started',
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'disconnected',
              config: {
                args: ['--browserUrl', 'http://127.0.0.1:9333'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-shadowed',
      shellReady: true,
      warning:
        'An existing chrome-devtools MCP configuration is taking precedence. Disable or rename it to use the extension tunnel.',
    });
  });

  it('reports a connected tunnel even while discoveryState stays not_started', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          initialized: true,
          discoveryState: 'not_started',
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
              config: {
                args: ['--wsEndpoint', 'ws://127.0.0.1:4170/cdp'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-connected',
      shellReady: true,
      warning: null,
    });
  });

  it('does not treat an argument that merely contains "cdp" as the tunnel', () => {
    // A userDataDir like /home/me/cdp-profile contains "cdp" but not a /cdp path
    // segment, so it must read as shadowing, not as the extension tunnel.
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
              config: {
                args: ['--userDataDir', '/home/me/cdp-profile'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-shadowed',
      shellReady: true,
      warning:
        'An existing chrome-devtools MCP configuration is taking precedence. Disable or rename it to use the extension tunnel.',
    });
  });

  it('does not treat a filesystem path containing /cdp/ as the tunnel', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
              config: {
                args: ['--userDataDir', '/tmp/cdp/profile'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-shadowed',
      shellReady: true,
      warning:
        'An existing chrome-devtools MCP configuration is taking precedence. Disable or rename it to use the extension tunnel.',
    });
  });

  it('treats a bracketed ::1 tunnel endpoint as connected, not shadowed', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
              config: {
                args: ['--wsEndpoint', 'ws://[::1]:4170/cdp'],
              },
            },
          ],
        },
        'http://[::1]:4170',
      ),
    ).toEqual({
      state: 'automation-connected',
      shellReady: true,
      warning: null,
    });
  });

  it('treats a --flag=value tunnel endpoint as connected, not shadowed', () => {
    expect(
      deriveCapabilityStatus(
        true,
        ['allow_origin', 'cdp_tunnel_over_ws', 'browser_automation_mcp'],
        {
          servers: [
            {
              name: 'chrome-devtools',
              mcpStatus: 'connected',
              config: {
                args: ['--wsEndpoint=ws://127.0.0.1:4170/cdp'],
              },
            },
          ],
        },
        'http://127.0.0.1:4170',
      ),
    ).toEqual({
      state: 'automation-connected',
      shellReady: true,
      warning: null,
    });
  });
});

describe('cross-package contracts', () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
  );

  it('keeps the runtime MCP server name aligned with the daemon', () => {
    const daemonSource = readFileSync(
      path.join(repoRoot, 'packages/cli/src/serve/acp-http/index.ts'),
      'utf8',
    );
    const declaration = daemonSource.match(
      /const CHROME_DEVTOOLS_MCP_SERVER_NAME = '([^']+)'/,
    );
    expect(declaration?.[1]).toBe(CHROME_DEVTOOLS_SERVER_NAME);
  });

  it('keeps the tunnel endpoint pattern aligned with the acceptance runner', () => {
    const runnerSource = readFileSync(
      path.join(
        repoRoot,
        'packages/cli/src/serve/cdp-tunnel/acceptance/run-real-chrome.mjs',
      ),
      'utf8',
    );
    expect(runnerSource).toContain(String(CDP_TUNNEL_ENDPOINT_PATTERN));
  });
});
