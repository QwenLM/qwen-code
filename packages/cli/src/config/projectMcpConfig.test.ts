/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadProjectMcpServers,
  mergeProjectMcpServers,
} from './projectMcpConfig.js';

describe('projectMcpConfig', () => {
  it('loads .mcp.json servers as pending project-scoped servers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-project-mcp-'));
    writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          local: {
            command: 'node',
            args: ['server.js'],
          },
        },
      }),
    );

    expect(loadProjectMcpServers(dir)).toEqual({
      local: {
        command: 'node',
        args: ['server.js'],
        source: 'project',
        pendingApproval: true,
        projectConfigPath: path.join(dir, '.mcp.json'),
      },
    });
  });

  it('throws a path-specific error for malformed .mcp.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-project-mcp-'));
    const configPath = path.join(dir, '.mcp.json');
    writeFileSync(configPath, '{');

    expect(() => loadProjectMcpServers(dir)).toThrow(
      `Failed to parse ${configPath}:`,
    );
  });

  it('rejects array-shaped mcpServers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-project-mcp-'));
    const configPath = path.join(dir, '.mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: [{ command: 'node' }],
      }),
    );

    expect(() => loadProjectMcpServers(dir)).toThrow(
      `Invalid ${configPath}: expected an object of MCP servers.`,
    );
  });

  it('rejects servers without a transport', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qwen-project-mcp-'));
    const configPath = path.join(dir, '.mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          missing: {
            description: 'missing transport',
          },
        },
      }),
    );

    expect(() => loadProjectMcpServers(dir)).toThrow(
      `Invalid ${configPath}: expected an object of MCP servers.`,
    );
  });

  it('does not override existing servers when merging project servers', () => {
    expect(
      mergeProjectMcpServers(
        { server: { command: 'settings' } },
        {
          server: {
            command: 'project',
            source: 'project',
            pendingApproval: true,
          },
        },
      ),
    ).toEqual({
      server: { command: 'settings' },
    });
  });
});
