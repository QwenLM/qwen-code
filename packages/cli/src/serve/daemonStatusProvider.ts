/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-host implementation of the `DaemonStatusProvider` interface
 * (declared in `@qwen-code/acp-bridge/bridgeOptions`). Production
 * `qwen serve` wires this into `BridgeOptions.statusProvider` so the
 * bridge factory can pull env / preflight cells without importing
 * daemon-host-specific modules directly.
 *
 * Lift origin (#4175 PR 22b/2): the inline `buildDaemonPreflightCells`
 * function moved here from `httpAcpBridge.ts`; `buildEnvStatusFromProcess`
 * stays in `envSnapshot.ts` and is wrapped here. Mode A consumers can
 * omit this provider entirely — the bridge falls back to idle placeholders.
 */

import { promises as fs } from 'node:fs';
import { canUseRipgrep } from '@qwen-code/qwen-code-core';
import {
  type DaemonStatusProvider,
  mapDomainErrorToErrorKind,
  type ServePreflightCell,
  type ServePreflightKind,
  type ServeWorkspaceEnvStatus,
} from '@qwen-code/acp-bridge';
import { getGitVersion, getNpmVersion } from '../utils/systemInfo.js';
import { buildEnvStatusFromProcess } from './envSnapshot.js';

const REQUIRED_NODE_MAJOR = 22;

/**
 * Construct the production `DaemonStatusProvider` for `qwen serve`.
 * Returns a fresh provider per call; provider is stateless so callers
 * can cache if hot-path overhead matters (currently both methods are
 * called only from the route handlers, so per-request allocation is
 * fine).
 */
export function createDaemonStatusProvider(): DaemonStatusProvider {
  return {
    async getEnvStatus(
      boundWorkspace: string,
      acpChannelLive: boolean,
    ): Promise<ServeWorkspaceEnvStatus> {
      // `buildEnvStatusFromProcess` is synchronous (no I/O) — wrap
      // in a resolved Promise to match the async `DaemonStatusProvider`
      // contract. Future async-needing implementations (e.g. reading
      // a config file) get the seam without changing the bridge.
      return buildEnvStatusFromProcess(boundWorkspace, acpChannelLive);
    },

    async getDaemonPreflightCells(
      boundWorkspace: string,
    ): Promise<ServePreflightCell[]> {
      return buildDaemonPreflightCells(boundWorkspace);
    },
  };
}

/**
 * Daemon-side preflight cells for `GET /workspace/preflight`. Synchronous
 * cells (`node_version`, `cli_entry`) and async cells
 * (`workspace_dir` stat, `ripgrep` / `git` / `npm` PATH lookups) run in
 * parallel via `Promise.allSettled`; a single failing cell becomes an
 * `error` cell rather than poisoning the whole response. The
 * corresponding ACP-side cells (auth, MCP, skills, providers,
 * tool_registry, egress) are stitched in by the bridge's
 * `requestWorkspaceStatus` helper when a child is live, or fall back
 * to `not_started` placeholders when idle.
 *
 * Lifted verbatim from `httpAcpBridge.ts:4104-4280` in #4175 PR 22b/2
 * so the bridge factory no longer hard-imports daemon-host helpers.
 */
async function buildDaemonPreflightCells(
  boundWorkspace: string,
): Promise<ServePreflightCell[]> {
  // Each builder returns (or eventually returns) one cell. We run them via
  // `Promise.allSettled` after wrapping every call in `Promise.resolve().then`
  // so that synchronous throws from any builder become rejected promises
  // instead of escaping out of `Promise.all`'s array construction. A throw
  // there would propagate up to the route handler and turn the whole
  // `/workspace/preflight` envelope into a 500 — directly contradicting the
  // design promise that "daemon cells always render even when ACP is sick"
  // (see the route handler's catch ladder).
  //
  // For any rejected slot we synthesize an `error` cell with the slot's
  // expected `kind` so the response shape (length, ordering, locality) is
  // bit-for-bit the same regardless of failure modes.
  const nodeVersionCell = (): ServePreflightCell => {
    try {
      const nodeVersion = process.versions.node;
      const major = Number.parseInt(nodeVersion.split('.')[0] ?? '0', 10);
      if (Number.isFinite(major) && major >= REQUIRED_NODE_MAJOR) {
        return {
          kind: 'node_version',
          status: 'ok',
          locality: 'daemon',
          detail: {
            version: nodeVersion,
            required: `>=${REQUIRED_NODE_MAJOR}`,
          },
        };
      }
      return {
        kind: 'node_version',
        status: 'error',
        errorKind: 'missing_binary',
        error: `Node ${nodeVersion} is below the required >=${REQUIRED_NODE_MAJOR}.`,
        hint: `Upgrade Node to v${REQUIRED_NODE_MAJOR} or newer.`,
        locality: 'daemon',
        detail: { version: nodeVersion, required: `>=${REQUIRED_NODE_MAJOR}` },
      };
    } catch (err) {
      return {
        kind: 'node_version',
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        locality: 'daemon',
      };
    }
  };

  // Mirrors `defaultSpawnChannelFactory`'s lookup so the preflight cell
  // reflects the path the child would actually be spawned from.
  const cliEntryCell = (): ServePreflightCell => {
    const cliEntry = process.env['QWEN_CLI_ENTRY'] || process.argv[1] || '';
    if (cliEntry) {
      return {
        kind: 'cli_entry',
        status: 'ok',
        locality: 'daemon',
        detail: {
          path: cliEntry,
          source: process.env['QWEN_CLI_ENTRY']
            ? 'QWEN_CLI_ENTRY'
            : 'process.argv[1]',
        },
      };
    }
    return {
      kind: 'cli_entry',
      status: 'error',
      errorKind: 'missing_binary',
      error: 'Cannot determine CLI entry path for spawning the ACP child.',
      hint: 'Set QWEN_CLI_ENTRY to the absolute path of the qwen entry script.',
      locality: 'daemon',
    };
  };

  const workspaceDirCell = async (): Promise<ServePreflightCell> => {
    try {
      const stat = await fs.stat(boundWorkspace);
      if (stat.isDirectory()) {
        return {
          kind: 'workspace_dir',
          status: 'ok',
          locality: 'daemon',
          detail: { path: boundWorkspace },
        };
      }
      return {
        kind: 'workspace_dir',
        status: 'error',
        errorKind: 'missing_file',
        error: `Bound workspace path is not a directory: ${boundWorkspace}`,
        locality: 'daemon',
        detail: { path: boundWorkspace },
      };
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err);
      return {
        kind: 'workspace_dir',
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(errorKind ? { errorKind } : {}),
        locality: 'daemon',
        detail: { path: boundWorkspace },
      };
    }
  };

  type Slot = {
    kind: ServePreflightKind;
    run: () => ServePreflightCell | Promise<ServePreflightCell>;
  };
  const slots: Slot[] = [
    { kind: 'node_version', run: nodeVersionCell },
    { kind: 'cli_entry', run: cliEntryCell },
    { kind: 'workspace_dir', run: workspaceDirCell },
    {
      kind: 'ripgrep',
      run: () =>
        safeCheck('ripgrep', async () => {
          // Mirror runtime behavior: `Config.useBuiltinRipgrep` defaults to
          // `true`, so `canUseRipgrep(true)` reports the *bundled* binary
          // when no system `rg` is installed. Passing `false` here would
          // tell users "ripgrep missing" while the runtime can still use
          // the bundled one — a misleading warning.
          const ok = await canUseRipgrep(true);
          return ok
            ? { status: 'ok' as const }
            : {
                status: 'warning' as const,
                hint: 'Install ripgrep for faster grep tool execution.',
              };
        }),
    },
    {
      kind: 'git',
      run: () =>
        safeCheck('git', async () => {
          const v = await getGitVersion();
          return v && v !== 'unknown'
            ? { status: 'ok' as const, detail: { version: v } }
            : { status: 'warning' as const, hint: 'git not found on PATH.' };
        }),
    },
    {
      kind: 'npm',
      run: () =>
        safeCheck('npm', async () => {
          const v = await getNpmVersion();
          return v && v !== 'unknown'
            ? { status: 'ok' as const, detail: { version: v } }
            : { status: 'warning' as const, hint: 'npm not found on PATH.' };
        }),
    },
  ];

  // `Promise.resolve().then(run)` coerces sync throws into rejected
  // promises so `Promise.allSettled` can absorb them as `error` cells
  // rather than letting them escape the route.
  const settled = await Promise.allSettled(
    slots.map((s) => Promise.resolve().then(s.run)),
  );
  return settled.map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    const err = result.reason;
    const errorKind = mapDomainErrorToErrorKind(err);
    return {
      kind: slots[i]!.kind,
      status: 'error' as const,
      locality: 'daemon' as const,
      error: err instanceof Error ? err.message : String(err),
      ...(errorKind ? { errorKind } : {}),
    };
  });
}

async function safeCheck(
  kind: 'ripgrep' | 'git' | 'npm',
  body: () => Promise<{
    status: 'ok' | 'warning';
    detail?: Record<string, unknown>;
    hint?: string;
  }>,
): Promise<ServePreflightCell> {
  try {
    const r = await body();
    return {
      kind,
      status: r.status,
      locality: 'daemon',
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.hint ? { hint: r.hint } : {}),
    };
  } catch (err) {
    // Classify so SDK consumers can render structured remediation
    // (`missing_binary` for ENOENT, `missing_file` for EACCES, etc.).
    // Without this tag, the rg/git/npm catch path differs from the
    // sync-builder catch paths above, which all classify their own
    // errors. The outer `Promise.allSettled` catch in
    // `buildDaemonPreflightCells` is unreachable for slots whose `run`
    // is `() => safeCheck(...)`, because `safeCheck` always resolves
    // (its own try/catch swallows). So this is the only place to tag.
    const errorKind = mapDomainErrorToErrorKind(err);
    return {
      kind,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      locality: 'daemon',
      ...(errorKind ? { errorKind } : {}),
    };
  }
}
