/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import { assembleMcpServers } from './mcpServers.js';

/**
 * Precedence contract (#4615), lowest → highest:
 *   user/default settings < project `.mcp.json` < workspace/system settings < CLI
 */
describe('assembleMcpServers (precedence + scope tagging)', () => {
  let dir: string;

  const writeMcpJson = (servers: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: servers }),
    );

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-assemble-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tags `.mcp.json` servers with scope "project"', () => {
    writeMcpJson({ proj: { command: 'node' } });
    const result = assembleMcpServers({}, dir);
    expect(result['proj'].scope).toBe('project');
  });

  it('lets a `.mcp.json` server override a user-level settings server', () => {
    // user-level server has no scope tag.
    const userServer: MCPServerConfig = { command: 'user-cmd' };
    writeMcpJson({ shared: { command: 'project-cmd' } });

    const result = assembleMcpServers({ shared: userServer }, dir);

    // project wins over user (Claude parity: project > user).
    expect(result['shared'].command).toBe('project-cmd');
    expect(result['shared'].scope).toBe('project');
  });

  it('lets a workspace settings server override a `.mcp.json` server', () => {
    const workspaceServer: MCPServerConfig = {
      command: 'workspace-cmd',
      scope: 'workspace',
    };
    writeMcpJson({ shared: { command: 'project-cmd' } });

    const result = assembleMcpServers({ shared: workspaceServer }, dir);

    expect(result['shared'].command).toBe('workspace-cmd');
    expect(result['shared'].scope).toBe('workspace');
  });

  it('keeps an enterprise (system) server above a `.mcp.json` server', () => {
    const systemServer: MCPServerConfig = {
      command: 'system-cmd',
      scope: 'system',
    };
    writeMcpJson({ shared: { command: 'project-cmd' } });

    const result = assembleMcpServers({ shared: systemServer }, dir);

    expect(result['shared'].command).toBe('system-cmd');
  });

  it('lets `--mcp-config` override everything', () => {
    const systemServer: MCPServerConfig = {
      command: 'system-cmd',
      scope: 'system',
    };
    writeMcpJson({ shared: { command: 'project-cmd' } });
    const cli: Record<string, MCPServerConfig> = {
      shared: { command: 'cli-cmd' },
    };

    const result = assembleMcpServers({ shared: systemServer }, dir, cli);

    expect(result['shared'].command).toBe('cli-cmd');
  });

  it('returns only settings servers when there is no `.mcp.json`', () => {
    const result = assembleMcpServers({ usr: { command: 'user-cmd' } }, dir);
    expect(Object.keys(result)).toEqual(['usr']);
  });
});
