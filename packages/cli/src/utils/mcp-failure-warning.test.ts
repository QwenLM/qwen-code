/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  collectFailedMcpServers,
  formatFailedMcpServers,
} from './mcp-failure-warning.js';

/** Only the two MCP-failure getters are exercised here. */
const asConfig = (stub: Record<string, unknown>) => stub as unknown as Config;

describe('collectFailedMcpServers', () => {
  it('prefers the detail API so the recorded reason reaches the warning', () => {
    const config = asConfig({
      getFailedMcpServerDetails: () => [
        { name: 'aliyuncs-openapi', reason: 'connect failed: fetch failed' },
      ],
    });

    expect(collectFailedMcpServers(config)).toEqual([
      { name: 'aliyuncs-openapi', reason: 'connect failed: fetch failed' },
    ]);
  });

  it('falls back to names for Config stubs without the detail API', () => {
    const config = asConfig({ getFailedMcpServerNames: () => ['a', 'b'] });

    expect(collectFailedMcpServers(config)).toEqual([
      { name: 'a' },
      { name: 'b' },
    ]);
  });

  it('returns an empty list when neither API exists', () => {
    expect(collectFailedMcpServers(asConfig({}))).toEqual([]);
  });
});

describe('formatFailedMcpServers', () => {
  it('renders the reason next to the server name', () => {
    expect(
      formatFailedMcpServers([
        {
          name: 'aliyuncs-openapi',
          reason: 'timeout: discovery did not finish within 30000ms',
        },
        { name: 'plain' },
      ]),
    ).toBe(
      'aliyuncs-openapi (timeout: discovery did not finish within 30000ms), plain',
    );
  });
});
