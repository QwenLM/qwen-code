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
});
