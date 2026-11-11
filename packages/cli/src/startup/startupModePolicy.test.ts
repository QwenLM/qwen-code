/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createSessionStartupRuntime,
  type Config,
  type ConfigStartupGate,
} from '@qwen-code/core';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import {
  getMonotonicStartupElapsedMs,
  waitForAcpFirstTurnReady,
  waitForCommandCatalogReady,
  waitForNonInteractiveRequestReady,
  waitForReadiness,
  waitForSlashCommandReady,
  waitForTuiFirstTurnReady,
} from './startupModePolicy.js';

function createConfig() {
  const readyGates = new Set<ConfigStartupGate>();
  const waiters = new Map<ConfigStartupGate, Array<() => void>>();
  const config = {
    waitForStartupGate: vi.fn((gate: ConfigStartupGate) => {
      if (readyGates.has(gate)) {
        return Promise.resolve({ status: 'ready' as const });
      }
      return new Promise((resolve) => {
        const gateWaiters = waiters.get(gate) ?? [];
        gateWaiters.push(() => resolve({ status: 'ready' as const }));
        waiters.set(gate, gateWaiters);
      });
    }),
  } as unknown as Config;

  return {
    config,
    markReady(gate: ConfigStartupGate) {
      readyGates.add(gate);
      for (const resolve of waiters.get(gate) ?? []) {
        resolve();
      }
      waiters.delete(gate);
    },
  };
}

describe('startupModePolicy', () => {
  it('uses the monotonic process clock for cumulative startup milestones', () => {
    vi.spyOn(performance, 'now').mockReturnValue(4321.4);

    expect(getMonotonicStartupElapsedMs()).toBe(4321);
  });

  it('waits for TUI first-turn config gates and session-start', async () => {
    const { config, markReady } = createConfig();
    const sessionRuntime = createSessionStartupRuntime();
    let resolved = false;
    const ready = waitForTuiFirstTurnReady(config, sessionRuntime).then(() => {
      resolved = true;
    });

    markReady('commands');
    sessionRuntime.markReady('session-start');
    await Promise.resolve();
    expect(resolved).toBe(false);

    markReady('memory');
    await ready;
    expect(resolved).toBe(true);
  });

  it('waits for non-interactive prompt gates without mcp budget', async () => {
    const { config, markReady } = createConfig();
    let resolved = false;
    const ready = waitForNonInteractiveRequestReady(config).then(() => {
      resolved = true;
    });

    markReady('commands');
    markReady('memory');
    await expect(ready).resolves.toBeUndefined();
    expect(resolved).toBe(true);
    expect(config.waitForStartupGate).not.toHaveBeenCalledWith(
      'mcp-budget',
      expect.anything(),
    );
  });

  it('continues non-interactive request readiness on gate failure', async () => {
    const config = {
      waitForStartupGate: vi.fn((gate: ConfigStartupGate) =>
        gate === 'commands'
          ? Promise.reject(
              new Error('Startup readiness gate "commands" failed: base boom'),
            )
          : Promise.resolve({ status: 'ready' as const }),
      ),
    } as unknown as Config;

    await expect(
      waitForNonInteractiveRequestReady(config),
    ).resolves.toBeUndefined();
  });

  it('waits for command catalog gates without memory', async () => {
    const { config, markReady } = createConfig();
    let resolved = false;
    const ready = waitForCommandCatalogReady(config).then(() => {
      resolved = true;
    });

    markReady('commands');
    await Promise.resolve();
    expect(resolved).toBe(false);

    markReady('mcp-budget');
    await ready;
    expect(resolved).toBe(true);
    expect(config.waitForStartupGate).not.toHaveBeenCalledWith(
      'memory',
      expect.anything(),
    );
  });

  it('waits for ACP command catalog and session-start readiness', async () => {
    const { config, markReady } = createConfig();
    const sessionRuntime = createSessionStartupRuntime();
    let resolved = false;
    const ready = waitForAcpFirstTurnReady(config, sessionRuntime).then(() => {
      resolved = true;
    });

    markReady('commands');
    sessionRuntime.markReady('session-start');
    await Promise.resolve();
    expect(resolved).toBe(false);

    markReady('mcp-budget');
    await ready;
    expect(resolved).toBe(true);
  });

  it('continues ACP first-turn readiness on config gate failure', async () => {
    const config = {
      waitForStartupGate: vi.fn((gate: ConfigStartupGate) =>
        gate === 'mcp-budget'
          ? Promise.reject(
              new Error('Startup readiness gate "mcp-budget" failed: base boom'),
            )
          : Promise.resolve({ status: 'ready' as const }),
      ),
    } as unknown as Config;
    const sessionRuntime = createSessionStartupRuntime();
    sessionRuntime.markReady('session-start');

    await expect(
      waitForAcpFirstTurnReady(config, sessionRuntime),
    ).resolves.toBeUndefined();
  });

  it('rejects missing session runtime before starting config gate waits', async () => {
    const { config } = createConfig();

    await expect(
      waitForReadiness(
        config,
        undefined,
        {
          configGates: ['commands'],
          sessionGates: ['session-start'],
        },
      ),
    ).rejects.toThrow(/requires a session runtime/);
    expect(config.waitForStartupGate).not.toHaveBeenCalled();
  });

  it('rejects unused session runtime before starting config gate waits', async () => {
    const { config } = createConfig();
    const sessionRuntime = createSessionStartupRuntime();

    await expect(
      waitForReadiness(
        config,
        sessionRuntime,
        {
          configGates: ['commands'],
          sessionGates: [],
        },
      ),
    ).rejects.toThrow(/without session startup gates/);
    expect(config.waitForStartupGate).not.toHaveBeenCalled();
  });

  it('waits for command-declared startup gates', async () => {
    const { config, markReady } = createConfig();
    const command: SlashCommand = {
      name: 'mcp-only',
      description: 'Needs MCP',
      kind: CommandKind.BUILT_IN,
      requiredStartupGates: ['mcp-budget'],
    };
    let resolved = false;
    const ready = waitForSlashCommandReady(config, command).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    markReady('mcp-budget');
    await ready;
    expect(resolved).toBe(true);
  });
});
