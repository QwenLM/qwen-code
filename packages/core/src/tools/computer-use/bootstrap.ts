/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Computer Use bootstrap state machine.
 *
 * On first invocation of any computer_use__* tool:
 *   1. If not yet approved: prompt the user to install (one-time).
 *   2. Start the client (lazy npx spawn, may take ~60s first time).
 *   3. On macOS only: probe permissions via the upstream `doctor` CLI
 *      (NOT via get_app_state, which has the side-effect of activating
 *      the target app — earlier rounds probed Finder this way and
 *      caused Finder to pop to the foreground at session start). The
 *      doctor command:
 *        - reads TCC + runtime preflight, prints
 *          "Permissions: accessibility=granted, screenRecording=missing"
 *          to stdout, then exits cleanly
 *        - launches the onboarding window via LaunchServices when any
 *          permission is missing — LaunchServices dedups so repeated
 *          invocations just bring the existing window to front
 *      We parse stdout for the probe result and rely on doctor's own
 *      window launching for the UX trigger — no separate spawnDoctor
 *      call needed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import type { ComputerUseClient } from './client.js';
import { isPackageSpecApproved, saveInstallState } from './install-state.js';
import { type PermissionErrorKind } from './permission-detector.js';
import { resolveComputerUsePackageSpec } from './constants.js';

const execFileAsync = promisify(execFile);

export interface BootstrapContext {
  signal: AbortSignal;
  updateOutput?: (output: string) => void;
}

/** Result of a permission probe. */
export type PermissionProbeResult = 'ok' | PermissionErrorKind;

export interface BootstrapDeps {
  homeDir: string;
  packageSpec: string;
  platform: NodeJS.Platform;
  /**
   * Prompt the user to approve installing the upstream binary. Returns
   * true if approved. Default uses stderr + the
   * QWEN_COMPUTER_USE_AUTO_APPROVE=1 env-var fallback; the interactive
   * confirmation dialog is wired through ComputerUseTool's
   * getConfirmationDetails(), which runs BEFORE execute() reaches
   * runBootstrap (so by the time we get here the install-state file
   * already exists for interactive sessions and this fallback is the
   * headless / SDK path only).
   */
  promptInstallApproval: (packageSpec: string) => Promise<boolean>;
  /**
   * Probe permissions by running the upstream doctor CLI and parsing
   * its stdout summary. The probe itself triggers the onboarding window
   * when permissions are missing — no separate spawnDoctor needed.
   */
  probePermissions: (packageSpec: string) => Promise<PermissionProbeResult>;
  /** Poll interval for the permission watcher. Default 5000ms. */
  pollIntervalMs?: number;
  /** Total poll timeout. Default 10 min. */
  pollTimeoutMs?: number;
}

/**
 * Parse the doctor stdout summary into a probe result.
 *
 * Doctor prints a single line of the form:
 *   "Permissions: accessibility=granted, screenRecording=missing"
 *
 * Exported separately from probePermissionsViaDoctor so unit tests can
 * exercise the parse logic without spawning a real npx process.
 */
export function parseDoctorStdout(stdout: string): PermissionProbeResult {
  const accessibilityGranted = /accessibility\s*=\s*granted/i.test(stdout);
  const screenRecordingGranted = /screenrecording\s*=\s*granted/i.test(stdout);
  if (!accessibilityGranted) return 'accessibility';
  if (!screenRecordingGranted) return 'screenRecording';
  return 'ok';
}

/**
 * Probe macOS permissions by spawning the upstream doctor CLI.
 *
 * Doctor runs `PermissionDiagnostics.current()` (reads TCC SQLite +
 * runtime preflight via AXIsProcessTrusted() / CGPreflightScreenCaptureAccess()),
 * prints the summary to stdout, and — only if any permissions are
 * missing — launches the onboarding window via LaunchServices. The
 * doctor process exits in both cases.
 *
 * Key UX property: when permissions are already granted, doctor exits
 * silently without opening any window. Unlike the previous get_app_state
 * probe, NO target app is activated by the probe itself.
 *
 * Cost: each invocation spawns `npx`. With the binary cached this is
 * ~200-500ms total. Steady-state runs (permissions OK) pay this once
 * per fresh client start; the polling loop pays it every pollIntervalMs
 * only while permissions are missing (i.e., during initial setup).
 *
 * Returns:
 *   - 'ok'             → both permissions granted
 *   - 'accessibility'  → Accessibility missing
 *   - 'screenRecording' → AX granted, Screen Recording missing
 *   - 'other'          → spawn / parse failed; skip probe and let the
 *                        real tool call surface any permission error
 */
export async function probePermissionsViaDoctor(
  packageSpec: string,
): Promise<PermissionProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['-y', packageSpec, 'doctor'],
      {
        timeout: 30000,
        env: process.env as NodeJS.ProcessEnv,
      },
    );
    return parseDoctorStdout(stdout);
  } catch {
    // Spawn failed (npx missing, network down on first run, timeout, etc.)
    // OR doctor exited non-zero. Skip probe; the next real tool call
    // will surface any permission error via upstream's normal error path.
    return 'other';
  }
}

/** Production defaults — instantiated lazily so tests can override per call. */
function defaultDeps(): BootstrapDeps {
  const packageSpec = resolveComputerUsePackageSpec();
  return {
    homeDir: homedir(),
    packageSpec,
    platform: process.platform,
    promptInstallApproval: async (spec) => {
      process.stderr.write(
        `\n[Computer Use] First-time install\n` +
          `  Package: ${spec}\n` +
          `  This will fetch ~50MB from the npm registry the first time.\n` +
          `  Computer Use can click, type, and read your desktop apps.\n` +
          `  On macOS you'll be guided through Accessibility and Screen Recording permissions next.\n` +
          `Set QWEN_COMPUTER_USE_AUTO_APPROVE=1 to skip this prompt.\n`,
      );
      return process.env['QWEN_COMPUTER_USE_AUTO_APPROVE'] === '1';
    },
    probePermissions: probePermissionsViaDoctor,
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

  // Step 1: install approval gate.
  const approved = await isPackageSpecApproved(deps.homeDir, deps.packageSpec);
  if (!approved) {
    ctx.updateOutput?.('Computer Use needs to be installed (first use).');
    const ok = await deps.promptInstallApproval(deps.packageSpec);
    if (!ok) {
      throw new Error(
        `Computer Use install declined by user. Re-invoke the tool to be prompted again.`,
      );
    }
    await saveInstallState(deps.homeDir, {
      approvedPackageSpec: deps.packageSpec,
      approvedAtIso: new Date().toISOString(),
    });
  }

  // Step 2: spawn (idempotent). Remember whether THIS call performed
  // the spawn — used below to decide whether to re-probe permissions.
  const wasAlreadyStarted = client.isStarted();
  if (!wasAlreadyStarted) {
    await client.start(ctx.updateOutput);
  }

  // Step 3: macOS permission probe + guide.
  //
  // Only probe on a fresh client start. Once the upstream binary is
  // running with permissions verified, TCC state is stable for the
  // process lifetime — re-probing on every tool call would needlessly
  // spawn extra doctor processes.
  //
  // Trade-off on mid-session permission revocation: upstream returns
  // permissionDenied as an MCP result with isError=true (not a thrown
  // exception), so it does NOT trigger client.callTool's transport-
  // closed retry path, and the reconnect path itself goes through
  // client.stop() + client.start() directly without re-entering
  // runBootstrap. The model therefore receives permissionDenied on
  // every subsequent tool call with no automatic recovery — the user
  // must restart qwen-code to re-enter the permission flow. This is
  // an acceptable trade-off: TCC revocation mid-session is extremely
  // rare.
  if (wasAlreadyStarted) return;
  if (deps.platform !== 'darwin') return;

  const probe = await deps.probePermissions(deps.packageSpec);
  if (probe === 'ok' || probe === 'other') {
    // 'other' means doctor failed for an unexpected reason; we don't
    // block bootstrap on that — let the actual tool call surface it.
    return;
  }

  // probe == 'accessibility' | 'screenRecording' | 'unknown_permission':
  // doctor has ALREADY launched the onboarding window from its own
  // process. We just inform the user and enter the poll loop.
  ctx.updateOutput?.(
    `Computer Use needs macOS permissions (${probe}). ` +
      `The onboarding window is opening — please grant Accessibility and Screen Recording, then this will continue automatically.`,
  );

  // Track the last probe kind so we can emit a fresh message on
  // transition (e.g. accessibility → screenRecording). LaunchServices
  // dedup ensures each subsequent doctor poll re-focuses the existing
  // window — no separate spawnDoctor call needed.
  let lastProbeKind: PermissionProbeResult = probe;

  const startedAt = Date.now();
  for (;;) {
    if (ctx.signal.aborted) {
      throw new Error('Computer Use bootstrap aborted.');
    }
    if (Date.now() - startedAt > pollTimeoutMs) {
      throw new Error(
        `Computer Use permission grant timed out after ${Math.round(pollTimeoutMs / 1000)}s. Re-invoke the tool to retry.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const next = await deps.probePermissions(deps.packageSpec);
    if (next === 'ok' || next === 'other') return;

    if (next !== lastProbeKind) {
      ctx.updateOutput?.(
        `Now waiting for ${next} permission. The onboarding window remains open — please grant this permission to continue.`,
      );
      lastProbeKind = next;
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    ctx.updateOutput?.(`Waiting for ${next} permission... (${elapsedSec}s)`);
  }
}
