/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, MCPServerConfig } from '@qwen-code/qwen-code-core';
import { useMcpApproval } from './useMcpApproval.js';
import { McpApprovalChoice } from '../components/mcp/MCPServerApprovalDialog.js';
import {
  loadMcpApprovals,
  resetMcpApprovalsForTesting,
  MCP_APPROVALS_FILENAME,
} from '../../config/mcpApprovals.js';

describe('useMcpApproval', () => {
  let dir: string;
  let discoverSpy: ReturnType<typeof vi.fn>;
  let approveForSession: ReturnType<typeof vi.fn>;

  const makeConfig = (servers: Record<string, MCPServerConfig>): Config => {
    const pending = new Set(
      Object.entries(servers)
        .filter(([, c]) => c.scope === 'project')
        .map(([name]) => name),
    );
    approveForSession = vi.fn((name: string) => pending.delete(name));
    discoverSpy = vi.fn().mockResolvedValue(undefined);
    return {
      getMcpServers: () => servers,
      getWorkingDir: () => dir,
      approveMcpServerForSession: approveForSession,
      isMcpServerPendingApproval: (n: string) => pending.has(n),
      getToolRegistry: () => ({ discoverToolsForServer: discoverSpy }),
    } as unknown as Config;
  };

  const stateOf = (name: string, config: MCPServerConfig) => {
    resetMcpApprovalsForTesting();
    return loadMcpApprovals().getState(dir, name, config);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'use-mcp-approval-'));
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

  it('is closed when there are no project servers', () => {
    const config = makeConfig({
      settingsServer: { command: 'node' }, // no scope -> not project
    });
    const { result } = renderHook(() => useMcpApproval(config));
    expect(result.current.isMcpApprovalDialogOpen).toBe(false);
  });

  it('queues pending project servers and exposes the first', () => {
    const config = makeConfig({
      a: { command: 'a', scope: 'project' },
      b: { httpUrl: 'https://b.test', scope: 'project' },
    });
    const { result } = renderHook(() => useMcpApproval(config));
    expect(result.current.isMcpApprovalDialogOpen).toBe(true);
    expect(result.current.currentMcpApproval?.name).toBe('a');
    expect(result.current.mcpApprovalRemaining).toBe(1);
  });

  it('approve persists, un-gates, reconnects, and advances the queue', async () => {
    const a: MCPServerConfig = { command: 'a', scope: 'project' };
    const config = makeConfig({
      a,
      b: { command: 'b', scope: 'project' },
    });
    const { result } = renderHook(() => useMcpApproval(config));

    await act(async () =>
      result.current.handleMcpApprovalSelect(McpApprovalChoice.APPROVE),
    );

    expect(stateOf('a', a)).toBe('approved');
    expect(approveForSession).toHaveBeenCalledWith('a');
    expect(discoverSpy).toHaveBeenCalledWith('a');
    expect(result.current.currentMcpApproval?.name).toBe('b');
  });

  it('reject persists rejected, does not reconnect, advances', async () => {
    const a: MCPServerConfig = { command: 'a', scope: 'project' };
    const config = makeConfig({ a, b: { command: 'b', scope: 'project' } });
    const { result } = renderHook(() => useMcpApproval(config));

    await act(async () =>
      result.current.handleMcpApprovalSelect(McpApprovalChoice.REJECT),
    );

    expect(stateOf('a', a)).toBe('rejected');
    expect(discoverSpy).not.toHaveBeenCalled();
    expect(result.current.currentMcpApproval?.name).toBe('b');
  });

  it('approve-all approves every queued server and closes the dialog', async () => {
    const a: MCPServerConfig = { command: 'a', scope: 'project' };
    const b: MCPServerConfig = { command: 'b', scope: 'project' };
    const config = makeConfig({ a, b });
    const { result } = renderHook(() => useMcpApproval(config));

    await act(async () =>
      result.current.handleMcpApprovalSelect(McpApprovalChoice.APPROVE_ALL),
    );

    expect(stateOf('a', a)).toBe('approved');
    expect(stateOf('b', b)).toBe('approved');
    expect(discoverSpy).toHaveBeenCalledTimes(2);
    expect(result.current.isMcpApprovalDialogOpen).toBe(false);
  });

  it('skips servers already decided (only prompts pending)', async () => {
    const a: MCPServerConfig = { command: 'a', scope: 'project' };
    // Pre-approve a.
    await loadMcpApprovals().setState(dir, 'a', a, 'approved');
    resetMcpApprovalsForTesting();

    const config = makeConfig({ a, b: { command: 'b', scope: 'project' } });
    const { result } = renderHook(() => useMcpApproval(config));

    expect(result.current.currentMcpApproval?.name).toBe('b');
    expect(result.current.mcpApprovalRemaining).toBe(0);
  });
});
