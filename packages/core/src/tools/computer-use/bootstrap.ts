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
 *   3. On macOS only: probe permissions via the upstream CLI (NOT via
 *      get_app_state, which has the side-effect of activating the target
 *      app — earlier rounds probed Finder this way and caused Finder to
 *      pop to the foreground at session start). Two distinct commands:
 *        - `doctor` (initial probe, once): reads TCC + runtime preflight,
 *          prints "Permissions: accessibility=..., screenRecording=..."
 *          to stdout, AND launches the onboarding window when any
 *          permission is missing. This is what shows the window — once.
 *        - `permission-status` (poll probe): prints the same summary but
 *          NEVER launches a window. The poll loop uses this so it does
 *          not spawn a new onboarding window on every iteration.
 *      `doctor` does NOT dedup its window — each invocation launches a
 *      fresh one — so polling `doctor` flooded the screen with windows.
 *      Probing the window-free `permission-status` in the loop fixes that
 *      while keeping the "grant then auto-continue" UX.
 *      Requires @qwen-code/open-computer-use >= 0.2.2 for permission-status.
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
  /**
   * Treat the first-use install as pre-approved, skipping the
   * promptInstallApproval gate. Set by the caller when the active approval
   * mode auto-approves tool calls and bypasses ComputerUseTool's confirmation
   * dialog (YOLO / AUTO_EDIT / AUTO): in those modes the dialog's onConfirm
   * never records install approval, so without this flag the headless
   * fallback below would refuse and throw "install declined by user". The
   * approval is still persisted, so later interactive calls skip the prompt.
   */
  autoApproveInstall?: boolean;
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
   * Initial probe: runs `doctor`, which both reports status AND launches
   * the onboarding window when permissions are missing. Called exactly
   * once on a fresh client start so the onboarding window appears one time.
   */
  probePermissions: (packageSpec: string) => Promise<PermissionProbeResult>;
  /**
   * Poll probe: runs `permission-status`, which reports status WITHOUT
   * launching the onboarding window. Called on every poll iteration while
   * waiting for the user to grant permissions — using the window-free
   * command here is what prevents the onboarding-window storm.
   */
  probePermissionStatus: (
    packageSpec: string,
  ) => Promise<PermissionProbeResult>;
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

/**
 * Probe macOS permissions via the `permission-status` CLI command —
 * the window-free counterpart to `doctor`.
 *
 * `permission-status` prints the SAME summary line as `doctor` but NEVER
 * launches the onboarding window. This is the probe the polling loop uses
 * while waiting for the user to grant permissions: `doctor` re-launches a
 * fresh onboarding window on every invocation (it does not dedup), so
 * polling it every few seconds floods the screen with windows. We launch
 * the window exactly once (the initial `doctor` probe) and then poll this
 * window-free command.
 *
 * Requires `@qwen-code/open-computer-use@>=0.2.2`. On older pinned packages
 * the command is unknown → npx exits non-zero → we return 'other', which
 * the poll loop treats as non-blocking (exits the wait; the real tool call
 * then surfaces any permission error). No window storm either way.
 */
export async function probePermissionStatusViaCLI(
  packageSpec: string,
): Promise<PermissionProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['-y', packageSpec, 'permission-status'],
      {
        timeout: 30000,
        env: process.env as NodeJS.ProcessEnv,
      },
    );
    return parseDoctorStdout(stdout);
  } catch {
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
    probePermissionStatus: probePermissionStatusViaCLI,
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
    if (ctx.autoApproveInstall) {
      // An auto-approve mode (YOLO / AUTO_EDIT / AUTO) already approved the
      // tool call and bypassed the confirmation dialog whose onConfirm would
      // have recorded approval, so honor that intent here instead of falling
      // through to the headless prompt (which refuses and throws).
      ctx.updateOutput?.('Computer Use install auto-approved (approval mode).');
    } else {
      ctx.updateOutput?.('Computer Use needs to be installed (first use).');
      const ok = await deps.promptInstallApproval(deps.packageSpec);
      if (!ok) {
        throw new Error(
          `Computer Use install declined by user. Re-invoke the tool to be prompted again.`,
        );
      }
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
  // transition (e.g. accessibility → screenRecording). The onboarding
  // window was launched once by the initial `doctor` probe above; the
  // poll loop below uses the window-free `permission-status` command so
  // it never spawns additional windows while the single onboarding
  // window stays open.
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
    // Window-free status check — see probePermissionStatusViaCLI.
    const next = await deps.probePermissionStatus(deps.packageSpec);
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
