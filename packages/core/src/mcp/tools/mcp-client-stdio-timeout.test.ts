/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StdioMcpConnector } from '../connector/stdioConnector.js';
import { connectToMcpServer } from '../connector/connectMcpServer.js';
import { discoverTools } from './mcp-tool.js';
import { ENV_MCP_TOOL_IDLE_TIMEOUT } from './mcp-timeouts.js';
import { McpClientContext } from '../mcpClientContext.js';
import { ToolErrorType } from '../../tools/tool-error.js';

const EMPTY_CONTEXT = new McpClientContext({
  sanitizationConfig: {
    enableEnvironmentVariableRedaction: true,
    allowedEnvironmentVariables: [],
    blockedEnvironmentVariables: [],
  },
  emitDiagnostic: vi.fn(),
  isTrustedFolder: () => true,
});

describe('MCP stdio tool hard timeout', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['hard timeout', 'idle timeout', 'user cancellation'] as const)(
    'distinguishes %s on a slow stdio call',
    async (failure) => {
      vi.stubEnv(
        ENV_MCP_TOOL_IDLE_TIMEOUT,
        failure === 'idle timeout' ? '1000' : '0',
      );
      vi.stubEnv('MCP_TOOL_TIMEOUT', '10000');
      const fixture = fileURLToPath(
        new URL(
          '../../tools/test-fixtures/mcp-timeout-server.mjs',
          import.meta.url,
        ),
      );
      const serverConfig = {
        command: process.execPath,
        args: [fixture],
        timeout: failure === 'hard timeout' ? 1_000 : undefined,
      };
      const client = await connectToMcpServer({
        clientVersion: '0.0.0',
        serverName: 'timeout-test',
        serverConfig,
        debugMode: false,
        cliConfig: EMPTY_CONTEXT,
        connector: new StdioMcpConnector(),
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const tools = await discoverTools(
          'timeout-test',
          serverConfig,
          client,
          {
            callMcpTool: (params, options) =>
              client.callTool(params, undefined, options),
          },
          EMPTY_CONTEXT,
        );
        const startedAt = performance.now();

        const controller = new AbortController();
        if (failure === 'user cancellation') {
          timer = setTimeout(() => controller.abort(), 1_000);
        }
        const execution = tools[0].build({}).execute(controller.signal);
        if (failure === 'user cancellation') {
          await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
        } else {
          const result = await execution;
          expect(result.error).toMatchObject({
            type: ToolErrorType.MCP_TOOL_ERROR,
            message: expect.stringMatching(/timed out|timeout/i),
          });
          expect(result.data).toMatchObject({
            mcp_operation_outcome: 'timeout',
            mcp_server_responded: false,
          });
          expect(result.isError).toBeUndefined();
          expect(result.mcpResult).toBeUndefined();
          if (failure === 'idle timeout') {
            expect(result.error?.message).toContain('MCP tool idle timeout');
          }
        }

        const elapsedMs = performance.now() - startedAt;
        expect(elapsedMs).toBeGreaterThanOrEqual(800);
        expect(elapsedMs).toBeLessThan(3_000);
      } finally {
        clearTimeout(timer);
        await client.close();
      }
    },
  );

  it('does not apply the server tool timeout to initialize or discovery', async () => {
    vi.stubEnv('MCP_TIMEOUT', '2500');
    const fixture = fileURLToPath(
      new URL(
        '../../tools/test-fixtures/mcp-timeout-server.mjs',
        import.meta.url,
      ),
    );
    const serverConfig = {
      command: process.execPath,
      args: [fixture],
      env: {
        MCP_TIMEOUT_FIXTURE_INITIALIZE_DELAY: '1200',
        MCP_TIMEOUT_FIXTURE_LIST_DELAY: '1200',
      },
      timeout: 1_000,
    };
    const client = await connectToMcpServer({
      clientVersion: '0.0.0',
      serverName: 'request-timeout-test',
      serverConfig,
      debugMode: false,
      cliConfig: EMPTY_CONTEXT,
      connector: new StdioMcpConnector(),
    });

    try {
      const tools = await discoverTools(
        'request-timeout-test',
        serverConfig,
        client,
        {
          callMcpTool: (params, options) =>
            client.callTool(params, undefined, options),
        },
        EMPTY_CONTEXT,
      );

      expect(tools).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
