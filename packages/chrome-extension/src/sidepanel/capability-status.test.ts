/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { deriveCapabilityStatus } from './capability-status.js';

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

  it('hides the warning when browser automation is configured', () => {
    expect(
      deriveCapabilityStatus(true, [
        'allow_origin',
        'cdp_tunnel_over_ws',
        'browser_automation_mcp',
      ]),
    ).toEqual({
      state: 'automation-configured',
      shellReady: true,
      warning: null,
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
      ),
    ).toEqual({
      state: 'automation-shadowed',
      shellReady: true,
      warning:
        'An existing chrome-devtools MCP configuration is taking precedence. Disable or rename it to use the extension tunnel.',
    });
  });
});
