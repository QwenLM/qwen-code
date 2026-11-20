/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  hashMcpServerConfig,
  type MCPServerConfig,
} from '@qwen-code/qwen-code-core';
import { LoadedMcpApprovals } from '../config/mcpApprovals.js';
import {
  carryGatedMcpApprovals,
  formatMcpApprovalCarryLog,
  resolveGatedConfigSource,
  type McpApprovalStore,
} from './mcp-approval-carry.js';

const workspaceServer: MCPServerConfig = {
  command: 'node',
  args: ['fixture.mjs'],
  scope: 'workspace',
};

const projectServer: MCPServerConfig = {
  command: 'node',
  args: ['fixture.mjs'],
  scope: 'project',
};

// Symlink-dependent cases cannot run on Windows without elevation.
const itSymlink = process.platform === 'win32' ? it.skip : it;

describe('carryGatedMcpApprovals', () => {
  let root: string;
  let workspace: string;
  let child: string;
  let approvalsPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-approval-carry-'));
    workspace = path.join(root, 'agent');
    child = path.join(workspace, 'sessions', 'A');
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(workspace, '.qwen', 'settings.json'), '{}');
    approvalsPath = path.join(root, 'mcpApprovals.json');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** The child directory's `.qwen` is a symlink to the workspace's `.qwen`. */
  function linkChildSettings(): void {
    fs.symlinkSync('../../.qwen', path.join(child, '.qwen'), 'dir');
  }

  function storeWithDecision(
    server: MCPServerConfig,
    status: 'approved' | 'rejected' = 'approved',
    hash = hashMcpServerConfig(server),
  ): LoadedMcpApprovals {
    return new LoadedMcpApprovals(
      {
        path: approvalsPath,
        config: {
          [path.resolve(workspace)]: { fixture: { hash, status } },
        },
      },
      [],
    );
  }

  it('resolves the same configuration source through a symlinked config directory', () => {
    linkChildSettings();
    expect(resolveGatedConfigSource(child, 'workspace')).toBe(
      fs.realpathSync(path.join(workspace, '.qwen', 'settings.json')),
    );
  });

  itSymlink(
    'carries an approved decision when the settings source is unchanged',
    async () => {
      linkChildSettings();
      const approvals = storeWithDecision(workspaceServer);

      const carried = await carryGatedMcpApprovals(
        workspace,
        child,
        { fixture: workspaceServer },
        approvals,
      );

      expect(carried.carried).toEqual([
        { server: 'fixture', status: 'approved' },
      ]);
      expect(approvals.getState(child, 'fixture', workspaceServer)).toBe(
        'approved',
      );
    },
  );

  itSymlink('carries a rejection rather than reviving the server', async () => {
    linkChildSettings();
    const approvals = storeWithDecision(workspaceServer, 'rejected');

    await carryGatedMcpApprovals(
      workspace,
      child,
      { fixture: workspaceServer },
      approvals,
    );

    expect(approvals.getState(child, 'fixture', workspaceServer)).toBe(
      'rejected',
    );
  });

  it('does not carry when the child directory has a different settings file', async () => {
    fs.mkdirSync(path.join(child, '.qwen'));
    fs.writeFileSync(path.join(child, '.qwen', 'settings.json'), '{}');
    const approvals = storeWithDecision(workspaceServer);

    const carried = await carryGatedMcpApprovals(
      workspace,
      child,
      { fixture: workspaceServer },
      approvals,
    );

    expect(carried.carried).toEqual([]);
    expect(approvals.getState(child, 'fixture', workspaceServer)).toBe(
      'pending',
    );
  });

  it('does not carry when the child directory has no configuration file', async () => {
    const approvals = storeWithDecision(workspaceServer);

    const carried = await carryGatedMcpApprovals(
      workspace,
      child,
      { fixture: workspaceServer },
      approvals,
    );

    expect(carried.carried).toEqual([]);
    expect(resolveGatedConfigSource(child, 'workspace')).toBeUndefined();
  });

  itSymlink(
    'does not carry when the config changed after approval',
    async () => {
      linkChildSettings();
      const approvals = storeWithDecision(
        workspaceServer,
        'approved',
        'stale-hash',
      );

      const carried = await carryGatedMcpApprovals(
        workspace,
        child,
        { fixture: workspaceServer },
        approvals,
      );

      expect(carried.carried).toEqual([]);
      expect(approvals.getState(child, 'fixture', workspaceServer)).toBe(
        'pending',
      );
    },
  );

  itSymlink('does not carry an undecided server', async () => {
    linkChildSettings();
    const approvals = new LoadedMcpApprovals(
      { path: approvalsPath, config: {} },
      [],
    );

    const carried = await carryGatedMcpApprovals(
      workspace,
      child,
      { fixture: workspaceServer },
      approvals,
    );

    expect(carried.carried).toEqual([]);
  });

  itSymlink(
    'carries a project-scoped decision when .mcp.json is shared',
    async () => {
      fs.writeFileSync(path.join(workspace, '.mcp.json'), '{"mcpServers":{}}');
      fs.symlinkSync(
        path.join('..', '..', '.mcp.json'),
        path.join(child, '.mcp.json'),
        'file',
      );
      const approvals = storeWithDecision(projectServer);

      const carried = await carryGatedMcpApprovals(
        workspace,
        child,
        { fixture: projectServer },
        approvals,
      );

      expect(carried.carried).toEqual([
        { server: 'fixture', status: 'approved' },
      ]);
      expect(approvals.getState(child, 'fixture', projectServer)).toBe(
        'approved',
      );
    },
  );

  it('ignores servers that are not approval-gated', async () => {
    const userServer: MCPServerConfig = {
      command: 'node',
      args: ['fixture.mjs'],
    };
    const approvals = storeWithDecision(userServer);

    const carried = await carryGatedMcpApprovals(
      workspace,
      child,
      { fixture: userServer },
      approvals,
    );

    expect(carried.carried).toEqual([]);
  });

  itSymlink(
    'reports a failed persist while keeping the in-memory decision',
    async () => {
      linkChildSettings();
      const store: McpApprovalStore = {
        getState: vi.fn().mockReturnValue('approved'),
        setState: vi.fn().mockResolvedValue(false),
      };

      const result = await carryGatedMcpApprovals(
        workspace,
        child,
        { fixture: workspaceServer },
        store,
      );

      expect(result.carried).toEqual([
        { server: 'fixture', status: 'approved' },
      ]);
      expect(result.failed).toEqual([
        {
          server: 'fixture',
          message: 'the approval store could not be written',
        },
      ]);
    },
  );

  it('reports why a gated server stayed behind', async () => {
    fs.mkdirSync(path.join(child, '.qwen'));
    fs.writeFileSync(path.join(child, '.qwen', 'settings.json'), '{}');
    const approvals = storeWithDecision(workspaceServer);

    const changed = await carryGatedMcpApprovals(
      workspace,
      child,
      { fixture: workspaceServer },
      approvals,
    );
    expect(changed.skipped).toEqual([
      { server: 'fixture', reason: 'config-source-changed' },
    ]);

    fs.rmSync(path.join(child, '.qwen'), { recursive: true, force: true });
    const missing = await carryGatedMcpApprovals(
      workspace,
      child,
      { fixture: workspaceServer },
      approvals,
    );
    expect(missing.skipped).toEqual([
      { server: 'fixture', reason: 'config-source-missing' },
    ]);
  });

  itSymlink('reports an undecided server as skipped', async () => {
    linkChildSettings();
    const approvals = new LoadedMcpApprovals(
      { path: approvalsPath, config: {} },
      [],
    );

    const result = await carryGatedMcpApprovals(
      workspace,
      child,
      { fixture: workspaceServer },
      approvals,
    );

    expect(result.skipped).toEqual([
      { server: 'fixture', reason: 'no-decision' },
    ]);
  });
});

describe('formatMcpApprovalCarryLog', () => {
  it('names the session, directories, carried servers, skip reasons and failures', () => {
    const line = formatMcpApprovalCarryLog(
      'session-1234',
      '/workspace/agent',
      '/workspace/agent/sessions/A',
      {
        carried: [{ server: 's1', status: 'approved' }],
        failed: [{ server: 's2', message: 'disk full' }],
        skipped: [{ server: 's3', reason: 'no-decision' }],
      },
    );

    expect(line).toContain('session=session-1234');
    expect(line).toContain('/workspace/agent -> /workspace/agent/sessions/A');
    expect(line).toContain('s1:approved');
    expect(line).toContain('s2:disk full');
    expect(line).toContain('s3:no-decision');
  });

  it('stays quiet when there was nothing gated to report', () => {
    expect(
      formatMcpApprovalCarryLog('session-1234', '/a', '/b', {
        carried: [],
        failed: [],
        skipped: [],
      }),
    ).toBeUndefined();
  });
});
