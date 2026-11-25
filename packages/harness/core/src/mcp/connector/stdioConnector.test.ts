/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import { StdioMcpConnector } from './stdioConnector.js';

const constructed = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: class {
    async send(): Promise<void> {}

    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
  },
}));

afterEach(() => {
  constructed.length = 0;
  vi.unstubAllEnvs();
});

describe('StdioMcpConnector', () => {
  it('expands the host runtime placeholder in the command', async () => {
    vi.stubEnv('QODER_NODE_RUNTIME', '/opt/qoder/node');
    const config = {
      command: '${QODER_NODE_RUNTIME}',
      args: ['server.js'],
      cwd: '/work',
    } as MCPServerConfig;

    await new StdioMcpConnector().connect(
      { serverName: 'srv', config },
      {
        debugMode: false,
        cliConfig: {
          isTrustedFolder: () => true,
          sanitizationConfig: {},
        },
      } as never,
    );

    expect(constructed[0]).toMatchObject({
      command: '/opt/qoder/node',
      args: ['server.js'],
      cwd: '/work',
    });
  });
});
