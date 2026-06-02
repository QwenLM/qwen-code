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
import {
  loadMcpApprovals,
  getPendingProjectMcpServers,
  resetMcpApprovalsForTesting,
  MCP_APPROVALS_FILENAME,
} from './mcpApprovals.js';

describe('mcpApprovals (hash-bound approval store)', () => {
  let dir: string;
  const projectRoot = '/work/my-repo';
  const server: MCPServerConfig = {
    command: 'node',
    args: ['server.js'],
    scope: 'project',
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-approvals-'));
    process.env['QWEN_CODE_MCP_APPROVALS_PATH'] = path.join(
      dir,
      MCP_APPROVALS_FILENAME,
    );
    resetMcpApprovalsForTesting();
  });

  afterEach(() => {
    delete process.env['QWEN_CODE_MCP_APPROVALS_PATH'];
    resetMcpApprovalsForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is pending with no stored decision', () => {
    const approvals = loadMcpApprovals();
    expect(approvals.getState(projectRoot, 'slack', server)).toBe('pending');
  });

  it('returns approved after approval', () => {
    const approvals = loadMcpApprovals();
    approvals.setState(projectRoot, 'slack', server, 'approved');
    expect(approvals.getState(projectRoot, 'slack', server)).toBe('approved');
  });

  it('returns rejected after rejection', () => {
    const approvals = loadMcpApprovals();
    approvals.setState(projectRoot, 'slack', server, 'rejected');
    expect(approvals.getState(projectRoot, 'slack', server)).toBe('rejected');
  });

  it('persists decisions across reload', () => {
    loadMcpApprovals().setState(projectRoot, 'slack', server, 'approved');
    resetMcpApprovalsForTesting();
    expect(loadMcpApprovals().getState(projectRoot, 'slack', server)).toBe(
      'approved',
    );
  });

  it('writes the file with the documented shape', () => {
    loadMcpApprovals().setState(projectRoot, 'slack', server, 'approved');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, MCP_APPROVALS_FILENAME), 'utf-8'),
    );
    const record = onDisk[path.resolve(projectRoot)]['slack'];
    expect(record.status).toBe('approved');
    expect(record.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  describe('hash binding (the issue #4615 requirement)', () => {
    it('reverts to pending when the config changes after approval', () => {
      const approvals = loadMcpApprovals();
      approvals.setState(projectRoot, 'slack', server, 'approved');
      expect(approvals.getState(projectRoot, 'slack', server)).toBe('approved');

      // Same name, edited command — the user never reviewed this.
      const edited: MCPServerConfig = { ...server, command: 'curl' };
      expect(approvals.getState(projectRoot, 'slack', edited)).toBe('pending');
    });

    it('a rejected server also reverts to pending when edited', () => {
      const approvals = loadMcpApprovals();
      approvals.setState(projectRoot, 'slack', server, 'rejected');
      const edited: MCPServerConfig = { ...server, args: ['other.js'] };
      expect(approvals.getState(projectRoot, 'slack', edited)).toBe('pending');
    });

    it('ignores provenance-only changes (scope) — stays approved', () => {
      const approvals = loadMcpApprovals();
      approvals.setState(projectRoot, 'slack', server, 'approved');
      const sameBehavior: MCPServerConfig = {
        command: 'node',
        args: ['server.js'],
      };
      expect(approvals.getState(projectRoot, 'slack', sameBehavior)).toBe(
        'approved',
      );
    });
  });

  it('keeps decisions independent per project root', () => {
    const approvals = loadMcpApprovals();
    approvals.setState(projectRoot, 'slack', server, 'approved');
    expect(approvals.getState('/work/other-repo', 'slack', server)).toBe(
      'pending',
    );
  });

  describe('getPendingProjectMcpServers (gated-scope filter)', () => {
    const workspaceServer: MCPServerConfig = {
      command: 'node',
      args: ['ws.js'],
      scope: 'workspace',
    };
    const systemServer: MCPServerConfig = {
      command: 'node',
      args: ['sys.js'],
      scope: 'system',
    };
    const userServer: MCPServerConfig = { command: 'node', args: ['user.js'] };

    it('gates both project and workspace servers, ignores user/system', () => {
      const pending = getPendingProjectMcpServers(
        {
          proj: server,
          ws: workspaceServer,
          sys: systemServer,
          usr: userServer,
        },
        projectRoot,
      );
      expect(pending.sort()).toEqual(['proj', 'ws']);
    });

    it('drops a gated server once it is approved', () => {
      loadMcpApprovals().setState(
        projectRoot,
        'ws',
        workspaceServer,
        'approved',
      );
      const pending = getPendingProjectMcpServers(
        { ws: workspaceServer },
        projectRoot,
      );
      expect(pending).toEqual([]);
    });

    it('keeps a rejected gated server in the pending (skip) set', () => {
      loadMcpApprovals().setState(
        projectRoot,
        'ws',
        workspaceServer,
        'rejected',
      );
      const pending = getPendingProjectMcpServers(
        { ws: workspaceServer },
        projectRoot,
      );
      expect(pending).toEqual(['ws']);
    });
  });
});
