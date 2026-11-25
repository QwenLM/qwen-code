/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isAbortError,
  runLogger,
  type Config,
  type ConfigStartupGate,
  type SessionStartupGate,
  type StartupGateResult,
  type StartupRuntime,
} from '@qwen-code/core';
import type { SlashCommand } from '../ui/commands/types.js';

interface StartupPolicyWaitOptions {
  signal?: AbortSignal;
}

interface StartupReadinessPolicy {
  configGates?: ConfigStartupGate[];
  sessionGates?: SessionStartupGate[];
}

async function waitForConfigGate(
  config: Config,
  gate: ConfigStartupGate,
  options: StartupPolicyWaitOptions = {},
): Promise<StartupGateResult> {
  return config.waitForStartupGate(gate, options);
}

export async function waitForReadiness(
  config: Config,
  sessionRuntime: StartupRuntime<SessionStartupGate> | undefined,
  readinessPolicy: StartupReadinessPolicy,
  options: StartupPolicyWaitOptions = {},
): Promise<void> {
  const configGates = readinessPolicy.configGates ?? [];
  const sessionGates = readinessPolicy.sessionGates ?? [];
  if (sessionGates.length > 0 && !sessionRuntime) {
    const gateList = sessionGates.map((gate) => `"${gate}"`).join(', ');
    throw new Error(
      `Session startup ${sessionGates.length === 1 ? 'gate' : 'gates'} ${gateList} ${
        sessionGates.length === 1 ? 'requires' : 'require'
      } a session runtime.`,
    );
  }
  if (sessionRuntime && sessionGates.length === 0) {
    throw new Error(
      'Session runtime was provided without session startup gates.',
    );
  }

  const sessionGateWaits =
    sessionRuntime === undefined
      ? []
      : sessionGates.map((gate) => sessionRuntime.when(gate, options));

  await Promise.all([
    ...configGates.map((gate) => waitForConfigGate(config, gate, options)),
    ...sessionGateWaits,
  ]);
}

async function waitForReadinessBestEffort(
  label: string,
  readinessWait: Promise<void>,
  options: StartupPolicyWaitOptions,
): Promise<void> {
  try {
    await readinessWait;
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      throw error;
    }
    runLogger.warn(
      `[startup] ${label} readiness failed; continuing with degraded startup:`,
      error,
    );
  }
}

export async function waitForTuiFirstTurnReady(
  config: Config,
  sessionRuntime: StartupRuntime<SessionStartupGate>,
  options: StartupPolicyWaitOptions = {},
): Promise<void> {
  await waitForReadiness(
    config,
    sessionRuntime,
    {
      configGates: ['commands', 'memory'],
      sessionGates: ['session-start'],
    },
    options,
  );
}

/**
 * Milliseconds since the current CLI process time origin. Keep cumulative
 * startup milestones on this monotonic clock so wall-clock corrections cannot
 * invert a settled readiness gate and its parent Runtime-ready milestone.
 */
export function getMonotonicStartupElapsedMs(): number {
  return Math.max(0, Math.round(performance.now()));
}

export async function waitForNonInteractiveRequestReady(
  config: Config,
  options: StartupPolicyWaitOptions = {},
): Promise<void> {
  await waitForReadinessBestEffort(
    'non-interactive request',
    waitForReadiness(
      config,
      undefined,
      {
        configGates: ['commands', 'memory'],
      },
      options,
    ),
    options,
  );
}

export async function waitForCommandCatalogReady(
  config: Config,
  options: StartupPolicyWaitOptions = {},
): Promise<void> {
  await waitForReadiness(
    config,
    undefined,
    {
      configGates: ['commands', 'mcp-budget'],
    },
    options,
  );
}

export async function waitForAcpFirstTurnReady(
  config: Config,
  sessionRuntime: StartupRuntime<SessionStartupGate>,
  options: StartupPolicyWaitOptions = {},
): Promise<void> {
  await waitForReadinessBestEffort(
    'ACP first-turn',
    waitForReadiness(
      config,
      sessionRuntime,
      {
        configGates: ['commands', 'mcp-budget'],
        sessionGates: ['session-start'],
      },
      options,
    ),
    options,
  );
}

export async function waitForSlashCommandReady(
  config: Config,
  command: SlashCommand,
  options: StartupPolicyWaitOptions = {},
): Promise<void> {
  await waitForReadiness(
    config,
    undefined,
    {
      configGates: command.requiredStartupGates ?? [],
    },
    options,
  );
}
