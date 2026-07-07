/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Computer Use bootstrap state machine (cua-driver backend).
 *
 * cua-driver is a persistent daemon (`CuaDriver serve` under com.trycua.driver)
 * fronted by a thin `cua-driver mcp` stdio proxy. Tools only work once the
 * daemon has BOTH macOS grants (Accessibility + Screen Recording).
 *
 * First-use permission flow — driven so the user grants ONE permission at a
 * time, and so we can reliably detect progress (the two problems with the
 * native `permissions grant`: it requests both at once, and while its daemon
 * sits in the all-or-nothing gate `permissions status` reports `unknown`, so a
 * partial grant is undetectable). Instead:
 *
 *   1. Run a status-only daemon with `serve --no-permissions-gate` (launched
 *      via `open -a CuaDriver` so it carries the com.trycua.driver identity).
 *      With the gate off it SERVES IMMEDIATELY even with no grants, so
 *      `permissions status --json` returns accurate PER-PERMISSION booleans.
 *   2. POLL status every 5s. Open the System Settings pane for whichever
 *      permission is still missing — Accessibility first, then Screen
 *      Recording — one at a time, guiding the user.
 *   3. Granting Screen Recording force-restarts the daemon → the next poll
 *      reads `unknown`; we relaunch the status daemon and keep polling.
 *   4. Once both are granted, tear the status daemon down and spawn the real
 *      proxy. Any residual restart is absorbed by the client's reconnect.
 */

import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ComputerUseClient } from './client.js';
import { isPackageSpecApproved, saveInstallState } from './install-state.js';
import { approvalKey, binaryPath } from './constants.js';
import { ensureInstalled } from './downloader.js';

const execFileAsync = promisify(execFile);

export interface BootstrapContext {
  signal: AbortSignal;
  updateOutput?: (output: string) => void;
  /** Treat the first-use install as pre-approved (YOLO / AUTO_EDIT / AUTO). */
  autoApproveInstall?: boolean;
}

/**
 * Result of a permission probe:
 *  - 'ok'              both grants present
 *  - 'accessibility'   Accessibility missing
 *  - 'screenRecording' Accessibility present, Screen Recording missing
 *  - 'unknown'         couldn't read status (no daemon yet / restarting)
 */
export type PermissionProbeResult =
  | 'ok'
  | 'accessibility'
  | 'screenRecording'
  | 'unknown';

/** A running status daemon we can tear down. */
export interface StatusDaemon {
  kill: () => void;
}

export interface BootstrapDeps {
  homeDir: string;
  approvalKey: string;
  platform: NodeJS.Platform;
  promptInstallApproval: (key: string) => Promise<boolean>;
  install: (onProgress?: (m: string) => void) => Promise<string>;
  /**
   * Launch a status-only daemon (`serve --no-permissions-gate` via
   * `open -a CuaDriver`) so `permissions status` returns per-permission
   * booleans even before any grant. Returns a handle to tear it down.
   */
  startStatusDaemon: () => StatusDaemon;
  /** Read current TCC status (`permissions status --json`). */
  probePermissions: () => Promise<PermissionProbeResult>;
  /** Open the System Settings pane for one permission so the user can grant it. */
  openPermissionPane: (kind: 'accessibility' | 'screenRecording') => void;
  /** Poll interval. Default 5000ms. */
  pollIntervalMs?: number;
  /** Total poll timeout. Default 10 min. */
  pollTimeoutMs?: number;
}

/**
 * Parse `cua-driver permissions status --json` into a probe result.
 * Shape: `{ accessibility: bool, screen_recording: bool, ... }`.
 */
export function parsePermissionsStatus(json: string): PermissionProbeResult {
  try {
    const o = JSON.parse(json) as {
      accessibility?: boolean;
      screen_recording?: boolean;
    };
    if (typeof o.accessibility !== 'boolean') return 'unknown';
    if (!o.accessibility) return 'accessibility';
    if (!o.screen_recording) return 'screenRecording';
    return 'ok';
  } catch {
    return 'unknown';
  }
}

const SOCKET = () =>
  join(homedir(), 'Library', 'Caches', 'cua-driver', 'cua-driver.sock');

function killServeDaemons(): void {
  try {
    spawnSync(
      'pkill',
      ['-f', 'CuaDriver.app/Contents/MacOS/cua-driver serve'],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    // ignore
  }
  try {
    rmSync(SOCKET(), { force: true });
  } catch {
    // ignore
  }
}

/** Probe via the window-free `permissions status --json` CLI (non-blocking). */
export async function probePermissionsViaStatus(): Promise<PermissionProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      binaryPath(homedir()),
      ['permissions', 'status', '--json'],
      { timeout: 10_000, env: process.env as NodeJS.ProcessEnv },
    );
    return parsePermissionsStatus(stdout);
  } catch {
    return 'unknown';
  }
}

/**
 * Launch the status-only daemon. `open -a CuaDriver` gives it the
 * com.trycua.driver TCC identity; `--no-permissions-gate` makes it serve
 * immediately so status reads work before grants land. Kills any prior daemon
 * first so there is exactly one.
 */
export function startStatusDaemonProcess(): StatusDaemon {
  killServeDaemons();
  try {
    spawnSync(
      'open',
      [
        '-n',
        '-g',
        '-a',
        'CuaDriver',
        '--args',
        'serve',
        '--no-permissions-gate',
      ],
      { stdio: 'ignore' },
    );
  } catch {
    // ignore — the poll loop reports 'unknown' and retries.
  }
  return { kill: killServeDaemons };
}

/** Open the System Settings privacy pane for a permission. */
export function openPermissionPaneProcess(
  kind: 'accessibility' | 'screenRecording',
): void {
  const anchor =
    kind === 'accessibility'
      ? 'Privacy_Accessibility'
      : 'Privacy_ScreenCapture';
  try {
    spawnSync(
      'open',
      [`x-apple.systempreferences:com.apple.preference.security?${anchor}`],
      { stdio: 'ignore' },
    );
  } catch {
    // ignore — the message still tells the user where to go.
  }
}

/** Production defaults — instantiated lazily so tests can override per call. */
function defaultDeps(): BootstrapDeps {
  const home = homedir();
  return {
    homeDir: home,
    approvalKey: approvalKey(),
    platform: process.platform,
    promptInstallApproval: async (key) => {
      process.stderr.write(
        `\n[Computer Use] First-time setup\n` +
          `  Driver: ${key}\n` +
          `  This downloads a ~20MB signed + notarized binary into ~/.qwen/computer-use/.\n` +
          `  Computer Use can click, type, and read your desktop apps in the background.\n` +
          `  On macOS you'll be guided through Accessibility and Screen Recording permissions next.\n` +
          `Set QWEN_COMPUTER_USE_AUTO_APPROVE=1 to skip this prompt.\n`,
      );
      return process.env['QWEN_COMPUTER_USE_AUTO_APPROVE'] === '1';
    },
    install: (onProgress) => ensureInstalled({ home, onProgress }),
    startStatusDaemon: startStatusDaemonProcess,
    probePermissions: probePermissionsViaStatus,
    openPermissionPane: openPermissionPaneProcess,
  };
}

export async function runBootstrap(
  client: ComputerUseClient,
  ctx: BootstrapContext,
  depsOverride?: Partial<BootstrapDeps>,
): Promise<void> {
  const deps: BootstrapDeps = { ...defaultDeps(), ...depsOverride };
  const pollIntervalMs = deps.pollIntervalMs ?? 5000;
  const pollTimeoutMs = deps.pollTimeoutMs ?? 10 * 60_000;

  // A warm client (already started this session) has already passed the install
  // gate, the download, and the permission flow — short-circuit before any of
  // them run again. This MUST precede the install gate and `deps.install()`:
  // a started client implies the binary already exists, and otherwise a unit
  // test that injects a started fake client still triggers the real downloader
  // (network + ~20MB) and writes install-state into the repo CWD. (review #1)
  if (client.isStarted()) return;

  // Step 1: install approval gate (gates the download).
  const approved = await isPackageSpecApproved(deps.homeDir, deps.approvalKey);
  if (!approved) {
    if (ctx.autoApproveInstall) {
      ctx.updateOutput?.('Computer Use install auto-approved (approval mode).');
    } else {
      ctx.updateOutput?.(
        'Computer Use needs a one-time driver download (first use).',
      );
      const ok = await deps.promptInstallApproval(deps.approvalKey);
      if (!ok) {
        throw new Error(
          `Computer Use install declined by user. Re-invoke the tool to be prompted again.`,
        );
      }
    }
    await saveInstallState(deps.homeDir, {
      approvedPackageSpec: deps.approvalKey,
      approvedAtIso: new Date().toISOString(),
    });
  }

  // Step 2: ensure the binary is present (download on first use; no-op after).
  await deps.install(ctx.updateOutput);

  // Step 3: macOS permission flow (one permission at a time; see file header).
  if (deps.platform === 'darwin') {
    await ensurePermissions(deps, ctx, pollIntervalMs, pollTimeoutMs);
  }

  // Step 4: spawn the proxy against the now-granted daemon.
  await client.start(ctx.updateOutput);
}

async function ensurePermissions(
  deps: BootstrapDeps,
  ctx: BootstrapContext,
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<void> {
  // A status-only (no-gate) daemon so `permissions status` reports per-
  // permission booleans throughout — this is what makes partial grants
  // detectable and lets us guide one permission at a time.
  let daemon = deps.startStatusDaemon();
  let openedAccessibility = false;
  let openedScreenRecording = false;

  try {
    const startedAt = Date.now();
    for (;;) {
      if (ctx.signal.aborted)
        throw new Error('Computer Use bootstrap aborted.');
      if (Date.now() - startedAt > pollTimeoutMs) {
        throw new Error(
          `Computer Use permission grant timed out after ${Math.round(
            pollTimeoutMs / 1000,
          )}s. Re-invoke the tool to retry.`,
        );
      }
      await sleep(pollIntervalMs);
      const probe = await deps.probePermissions();

      if (probe === 'ok') return;

      if (probe === 'unknown') {
        // No serving daemon — first launch still coming up, or the daemon was
        // restarted by a Screen-Recording grant. Relaunch and keep polling.
        daemon.kill();
        daemon = deps.startStatusDaemon();
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        ctx.updateOutput?.(
          `Bringing up Computer Use permissions check… (${elapsed}s)`,
        );
        continue;
      }

      if (probe === 'accessibility') {
        if (!openedAccessibility) {
          openedAccessibility = true;
          deps.openPermissionPane('accessibility');
          ctx.updateOutput?.(
            'Step 1/2 — In the System Settings window that opened ' +
              '(Privacy & Security → Accessibility), turn ON CuaDriver. ' +
              'This continues automatically.',
          );
        } else {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          ctx.updateOutput?.(
            `Waiting for Accessibility… (${elapsed}s) — enable CuaDriver in System Settings.`,
          );
        }
        continue;
      }

      // probe === 'screenRecording'
      if (!openedScreenRecording) {
        openedScreenRecording = true;
        deps.openPermissionPane('screenRecording');
        ctx.updateOutput?.(
          'Step 2/2 — Accessibility granted. Now in System Settings ' +
            '(Privacy & Security → Screen & System Audio Recording), turn ON ' +
            'CuaDriver. macOS will ask to restart CuaDriver — allow it; that is ' +
            'expected. This continues automatically.',
        );
      } else {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        ctx.updateOutput?.(
          `Waiting for Screen Recording… (${elapsed}s) — enable CuaDriver in System Settings.`,
        );
      }
    }
  } finally {
    daemon.kill();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
