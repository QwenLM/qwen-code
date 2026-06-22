/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-host integration tests for the `DaemonStatusProvider` seam
 * introduced in #4175 PR 22b/2. Rewritten to exercise the
 * `DaemonWorkspaceService` facade (which now owns env + preflight
 * status) rather than the removed bridge methods. The tests verify
 * that `createDaemonStatusProvider()` cells flow correctly through
 * the workspace service layer — the daemon-host-specific cells that
 * scan `$PATH` for git/npm/rg and read `process.env`.
 */

import { describe, it, expect } from 'vitest';
import { createDaemonStatusProvider } from './daemon-status-provider.js';
import { createDaemonWorkspaceService } from './workspace-service/index.js';
import type {
  DaemonWorkspaceServiceDeps,
  WorkspaceRequestContext,
} from './workspace-service/types.js';
import { WS_A } from '@qwen-code/acp-bridge/internal/testUtils';

/**
 * Minimal request context for status queries.
 */
const CTX: WorkspaceRequestContext = {
  route: 'GET /workspace/status',
  workspaceCwd: WS_A,
};

/**
 * Build a workspace service wired to the real `createDaemonStatusProvider()`
 * with a configurable `queryWorkspaceStatus` and `isChannelLive` for
 * controlling the ACP simulation layer.
 */
function makeWorkspaceServiceWithProvider(
  opts: {
    isChannelLive?: () => boolean;
    queryWorkspaceStatus?: DaemonWorkspaceServiceDeps['queryWorkspaceStatus'];
  } = {},
) {
  const statusProvider = createDaemonStatusProvider();
  const noopQueryWorkspaceStatus: DaemonWorkspaceServiceDeps['queryWorkspaceStatus'] =
    async (_method, idle) => idle();

  return createDaemonWorkspaceService({
    boundWorkspace: WS_A,
    contextFilename: 'QWEN.md',
    statusProvider,
    isChannelLive: opts.isChannelLive ?? (() => false),
    persistDisabledTools: async () => {},
    queryWorkspaceStatus: opts.queryWorkspaceStatus ?? noopQueryWorkspaceStatus,
    invokeWorkspaceCommand: async () => {
      throw new Error('not wired');
    },
    publishWorkspaceEvent: () => {},
  });
}

describe('DaemonWorkspaceService — daemon-host status provider integration', () => {
  it('answers /workspace/env from process state without consulting ACP, idle or live', async () => {
    let queryCount = 0;
    const service = makeWorkspaceServiceWithProvider({
      isChannelLive: () => false,
      queryWorkspaceStatus: async (_method, idle) => {
        queryCount++;
        return idle();
      },
    });

    // Idle path — daemon answers env from `process.*`; no ACP query.
    const idle = await service.getWorkspaceEnvStatus(CTX);
    expect(idle).toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: true,
      acpChannelLive: false,
    });
    expect(idle.cells.length).toBeGreaterThan(0);
    // Env status is purely daemon-local — queryWorkspaceStatus must NOT be called.
    expect(queryCount).toBe(0);

    // Live path — workspace service still answers locally; no ACP round-trip.
    const liveService = makeWorkspaceServiceWithProvider({
      isChannelLive: () => true,
      queryWorkspaceStatus: async (_method, idle) => {
        queryCount++;
        return idle();
      },
    });
    queryCount = 0;
    const live = await liveService.getWorkspaceEnvStatus(CTX);
    expect(live.acpChannelLive).toBe(true);
    expect(live.cells.length).toBeGreaterThan(0);
    // Still no ACP query — env is always daemon-local.
    expect(queryCount).toBe(0);
  });

  it('returns daemon preflight cells with not_started ACP cells when idle', async () => {
    const service = makeWorkspaceServiceWithProvider({
      isChannelLive: () => false,
    });

    const status = await service.getWorkspacePreflightStatus(CTX);
    expect(status).toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: true,
      acpChannelLive: false,
    });

    // Daemon-level cells are always populated.
    const daemonKinds = status.cells
      .filter((c) => c.locality === 'daemon')
      .map((c) => c.kind);
    expect(daemonKinds).toEqual(
      expect.arrayContaining([
        'node_version',
        'cli_entry',
        'workspace_dir',
        'ripgrep',
        'git',
        'npm',
      ]),
    );

    // ACP cells fall back to `not_started` placeholders without spawning.
    const acpCells = status.cells.filter((c) => c.locality === 'acp');
    expect(acpCells.map((c) => c.kind)).toEqual([
      'auth',
      'mcp_discovery',
      'skills',
      'providers',
      'tool_registry',
      'egress',
    ]);
    for (const cell of acpCells) {
      expect(cell.status).toBe('not_started');
    }
  });

  it('merges daemon cells with live ACP-side preflight cells when a channel is up', async () => {
    const acpCells = [
      { kind: 'auth', status: 'ok', locality: 'acp' },
      { kind: 'mcp_discovery', status: 'ok', locality: 'acp' },
      { kind: 'skills', status: 'ok', locality: 'acp' },
      { kind: 'providers', status: 'ok', locality: 'acp' },
      { kind: 'tool_registry', status: 'ok', locality: 'acp' },
      { kind: 'egress', status: 'not_started', locality: 'acp' },
    ];
    const service = makeWorkspaceServiceWithProvider({
      isChannelLive: () => true,
      queryWorkspaceStatus: (async (method: string, idle: () => unknown) => {
        if (method === 'qwen/status/workspace/preflight') {
          return { cells: acpCells };
        }
        return idle();
      }) as DaemonWorkspaceServiceDeps['queryWorkspaceStatus'],
    });

    const status = await service.getWorkspacePreflightStatus(CTX);
    expect(status.acpChannelLive).toBe(true);
    // Daemon cells precede ACP cells in the merged response.
    const daemonKinds = status.cells
      .filter((c) => c.locality === 'daemon')
      .map((c) => c.kind);
    expect(daemonKinds).toEqual(
      expect.arrayContaining([
        'node_version',
        'cli_entry',
        'workspace_dir',
        'ripgrep',
        'git',
        'npm',
      ]),
    );
    const liveAcpCells = status.cells.filter((c) => c.locality === 'acp');
    expect(liveAcpCells.map((c) => [c.kind, c.status])).toEqual([
      ['auth', 'ok'],
      ['mcp_discovery', 'ok'],
      ['skills', 'ok'],
      ['providers', 'ok'],
      ['tool_registry', 'ok'],
      ['egress', 'not_started'],
    ]);
    expect(status.errors).toBeUndefined();
  });

  it('falls back to idle ACP cells + envelope error when queryWorkspaceStatus throws mid-preflight', async () => {
    const service = makeWorkspaceServiceWithProvider({
      isChannelLive: () => true,
      queryWorkspaceStatus: async () => {
        throw new Error('agent channel closed mid-request');
      },
    });

    const status = await service.getWorkspacePreflightStatus(CTX);
    // Daemon cells must still render — that's the route's resilience contract.
    const daemonKinds = status.cells
      .filter((c) => c.locality === 'daemon')
      .map((c) => c.kind);
    expect(daemonKinds.length).toBeGreaterThan(0);
    // ACP cells fall back to `not_started` placeholders since the query rejected.
    const acpCells = status.cells.filter((c) => c.locality === 'acp');
    expect(acpCells.length).toBe(6);
    for (const cell of acpCells) {
      expect(cell.status).toBe('not_started');
    }
    // The envelope's `errors` array carries the failure description.
    expect(status.errors).toBeDefined();
    expect(status.errors![0]).toMatchObject({
      kind: 'preflight',
      status: 'error',
    });
    expect(status.errors![0]!.error).toBeTruthy();
  });
});
