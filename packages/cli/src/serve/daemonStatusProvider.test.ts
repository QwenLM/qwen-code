/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-host integration tests for the `DaemonStatusProvider` seam
 * introduced in #4175 PR 22b/2. Carved out of the lifted
 * `bridge.test.ts` suite during the #4175 F1 test split (deferred
 * from #4334): the bulk of that 6861-line suite is pure bridge
 * behavior that lives in `@qwen-code/acp-bridge` now, but these 4
 * tests must stay in cli because they wire `createDaemonStatusProvider()`
 * — the daemon-host-specific cells that scan `$PATH` for git/npm/rg
 * and read `process.env`. acp-bridge has no view into that and its
 * tests exercise the no-provider / throwing-provider fallback paths
 * instead.
 *
 * Importing `createHttpAcpBridge` via the `./httpAcpBridge.js`
 * re-export shim (rather than directly from `@qwen-code/acp-bridge`)
 * also acts as a smoke check that the shim's surface stays in sync
 * with the lifted factory.
 */

import { describe, it, expect } from 'vitest';
import {
  createHttpAcpBridge,
  type BridgeOptions,
  type HttpAcpBridge,
} from './httpAcpBridge.js';
import { createDaemonStatusProvider } from './daemonStatusProvider.js';
import {
  type ChannelHandle,
  makeChannel,
  WS_A,
} from '@qwen-code/acp-bridge/internal/testUtils';

/**
 * Cli-side bridge factory wired to the real
 * `createDaemonStatusProvider()`. Distinct name + JSDoc from
 * `testUtils.makeBridge` (which omits the provider for the
 * no-provider fallback assertions in `bridge.test.ts`) so a
 * contributor adding a test can't pick the wrong helper by accident
 * — wenshao review #4445 thread.
 */
function makeBridgeWithDaemonStatusProvider(
  opts: Partial<BridgeOptions> = {},
): HttpAcpBridge {
  return createHttpAcpBridge({
    boundWorkspace: WS_A,
    statusProvider: createDaemonStatusProvider(),
    ...opts,
  });
}

describe('createHttpAcpBridge — daemon-host status provider integration', () => {
  it('answers /workspace/env from process state without consulting ACP, idle or live', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridgeWithDaemonStatusProvider({
      channelFactory: async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      },
    });

    // Idle path — daemon answers env from `process.*`; no ACP child spawn.
    const idle = await bridge.getWorkspaceEnvStatus();
    expect(idle).toMatchObject({
      v: 1,
      workspaceCwd: WS_A,
      initialized: true,
      acpChannelLive: false,
    });
    expect(idle.cells.length).toBeGreaterThan(0);
    expect(handles).toHaveLength(0);

    // Live path — bridge still answers locally; the ACP child sees no
    // ext-method invocation for env.
    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const live = await bridge.getWorkspaceEnvStatus();
    expect(live.acpChannelLive).toBe(true);
    expect(handles).toHaveLength(1);
    expect(
      handles[0]?.agent.extMethodCalls.some((c) =>
        c.method.includes('/workspace/env'),
      ),
    ).toBe(false);

    await bridge.shutdown();
  });

  it('returns daemon preflight cells with not_started ACP cells when idle', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridgeWithDaemonStatusProvider({
      channelFactory: async () => {
        const h = makeChannel();
        handles.push(h);
        return h.channel;
      },
    });

    const status = await bridge.getWorkspacePreflightStatus();
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

    expect(handles).toHaveLength(0);
    await bridge.shutdown();
  });

  it('merges daemon cells with live ACP-side preflight cells when a channel is up', async () => {
    const handles: ChannelHandle[] = [];
    const acpCells = [
      { kind: 'auth', status: 'ok', locality: 'acp' },
      { kind: 'mcp_discovery', status: 'ok', locality: 'acp' },
      { kind: 'skills', status: 'ok', locality: 'acp' },
      { kind: 'providers', status: 'ok', locality: 'acp' },
      { kind: 'tool_registry', status: 'ok', locality: 'acp' },
      { kind: 'egress', status: 'not_started', locality: 'acp' },
    ];
    const bridge = makeBridgeWithDaemonStatusProvider({
      channelFactory: async () => {
        const h = makeChannel({
          extMethodImpl: (method) => {
            if (method === 'qwen/status/workspace/preflight') {
              return { cells: acpCells };
            }
            return { cells: [] };
          },
        });
        handles.push(h);
        return h.channel;
      },
    });

    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const status = await bridge.getWorkspacePreflightStatus();
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

    await bridge.shutdown();
  });

  it('falls back to idle ACP cells + envelope error when extMethod throws mid-preflight', async () => {
    const handles: ChannelHandle[] = [];
    const bridge = makeBridgeWithDaemonStatusProvider({
      channelFactory: async () => {
        const h = makeChannel({
          extMethodImpl: () => {
            throw new Error('agent channel closed mid-request');
          },
        });
        handles.push(h);
        return h.channel;
      },
    });

    await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const status = await bridge.getWorkspacePreflightStatus();
    // Daemon cells must still render — that's the route's resilience contract.
    const daemonKinds = status.cells
      .filter((c) => c.locality === 'daemon')
      .map((c) => c.kind);
    expect(daemonKinds.length).toBeGreaterThan(0);
    // ACP cells fall back to `not_started` placeholders since the extMethod
    // call rejected.
    const acpCells = status.cells.filter((c) => c.locality === 'acp');
    expect(acpCells.length).toBe(6);
    for (const cell of acpCells) {
      expect(cell.status).toBe('not_started');
    }
    // The envelope's `errors` array carries the bridge-side failure
    // describing which surface failed without sinking the whole route.
    // `errorKind` is best-effort via `mapDomainErrorToErrorKind`; here the
    // ACP SDK wraps the inner throw as a generic JSON-RPC "Internal
    // error" which doesn't match any of the helper's recognition rules
    // (the typed `BridgeChannelClosedError` follow-up will close that
    // gap), so we only assert the structural shape, not the tag.
    expect(status.errors).toBeDefined();
    expect(status.errors![0]).toMatchObject({
      kind: 'preflight',
      status: 'error',
    });
    expect(status.errors![0].error).toBeTruthy();

    await bridge.shutdown();
  });
});
