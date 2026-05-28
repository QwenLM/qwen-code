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
 *   3. On macOS only: probe permissions by calling get_app_state on
 *      Finder. If a permission error surfaces, spawn the upstream
 *      doctor (which opens the system settings + onboarding window),
 *      then poll until permissions grant or 10 min timeout.
 *
 * IMPLEMENTER NOTE (Task 10 investigation — Task 11 will wire this up):
 *   Investigation: qwen-code's BaseDeclarativeTool / BaseToolInvocation
 *   confirmation pathway (shouldConfirmExecute / getConfirmationDetails /
 *   onConfirm) runs BEFORE execute() is called — it is a pre-execution
 *   dialog driven by the coreToolScheduler, not something that can be
 *   triggered from inside execute(). Therefore, promptInstallApproval
 *   CANNOT use the standard ToolCallConfirmationDetails path when called
 *   mid-execution in bootstrap. Task 11 will wire it up via
 *   ComputerUseTool.getDefaultPermission() returning 'ask' on first use,
 *   surfacing the install prompt through getConfirmationDetails() /
 *   ToolAskUserQuestionConfirmationDetails before execute() is reached,
 *   and passing the result into runBootstrap via a BootstrapDeps override.
 *   Until then, the default promptInstallApproval uses stderr + the
 *   QWEN_COMPUTER_USE_AUTO_APPROVE=1 env-var fallback.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { ComputerUseClient } from './client.js';
import { isPackageSpecApproved, saveInstallState } from './install-state.js';
import {
  detectPermissionError,
  type PermissionErrorKind,
} from './permission-detector.js';
import { resolveComputerUsePackageSpec } from './constants.js';

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
   * true if approved. Implementation may use the qwen-code confirm
   * tool path or a stdin fallback.
   *
   * Task 11 will replace the default with getConfirmationDetails()-based
   * pre-execution prompting. See module JSDoc above for details.
   */
  promptInstallApproval: (packageSpec: string) => Promise<boolean>;
  /**
   * Spawn `open-computer-use doctor` (detached). The binary handles
   * opening the system settings window itself.
   */
  spawnDoctor: () => void;
  /**
   * Probe the upstream MCP server for permission state by issuing a
   * lightweight tool call. Returns 'ok' on success or the kind of
   * permission error on failure.
   */
  probePermissions: (
    client: ComputerUseClient,
  ) => Promise<PermissionProbeResult>;
  /** Poll interval for the permission watcher. Default 2000ms. */
  pollIntervalMs?: number;
  /** Total poll timeout. Default 10 min. */
  pollTimeoutMs?: number;
}

/**
 * Probe Finder's app state to determine what macOS permissions are available.
 *
 * Exported for testing. In production it is wired into defaultDeps().
 *
 * Two-phase detection:
 *   1. If get_app_state returns an MCP error, detectPermissionError classifies
 *      it — Accessibility missing throws 'permissionDenied' upstream, so we
 *      see isError=true.
 *   2. If get_app_state succeeds (isError=false) but returns NO image content
 *      part, Screen Recording is missing. The upstream binary silently sets
 *      screenshotPNGData=nil and the MCP layer omits the image block entirely.
 *      We treat absence of any image block as 'screenRecording'.
 *
 * Note on transient false-positives: a screenshot-capture timeout (rare) can
 * also produce no image — but the next 2s poll iteration will succeed once
 * the timeout clears, so a transient false-positive resolves itself without
 * user action.
 */
export async function probeFinderPermissions(
  client: ComputerUseClient,
): Promise<PermissionProbeResult> {
  // Use Finder as a known-running, always-installed macOS app.
  // get_app_state hits AccessibilitySnapshot which is the first
  // path that throws permissionDenied.
  const result = await client.callTool('get_app_state', { app: 'Finder' });
  const kind = detectPermissionError(result);
  if (kind !== 'none') return kind;
  // get_app_state succeeded with no error, but check if a screenshot
  // came back. The upstream binary silently omits the image content
  // part when ScreenCaptureKit can't capture — most commonly Screen
  // Recording permission missing (also possible on capture timeout,
  // but a granted-SR retry will succeed on the next 2s poll iteration,
  // so a transient false-positive resolves itself).
  const hasImage = result.content.some((part) => part.type === 'image');
  if (!hasImage) return 'screenRecording';
  return 'ok';
}

/** Production defaults — instantiated lazily so tests can override per call. */
function defaultDeps(): BootstrapDeps {
  const packageSpec = resolveComputerUsePackageSpec();
  return {
    homeDir: homedir(),
    packageSpec,
    platform: process.platform,
    promptInstallApproval: async (spec) => {
      // v0 fallback: stderr prompt + auto-approve env var. Replace with
      // qwen-code's standard confirm pathway in Task 11.
      process.stderr.write(
        `\n[Computer Use] First-time install\n` +
          `  Package: ${spec}\n` +
          `  This will fetch ~50MB from the npm registry the first time.\n` +
          `  Computer Use can click, type, and read your desktop apps.\n` +
          `  On macOS you'll be guided through Accessibility and Screen Recording permissions next.\n` +
          `Set QWEN_COMPUTER_USE_AUTO_APPROVE=1 to skip this prompt.\n`,
      );
      // For headless / SDK contexts the default is to refuse —
      // explicit user opt-in required.
      return process.env['QWEN_COMPUTER_USE_AUTO_APPROVE'] === '1';
    },
    spawnDoctor: () => {
      const child = spawn('npx', ['-y', packageSpec, 'doctor'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    },
    probePermissions: probeFinderPermissions,
  };
}

export async function runBootstrap(
  client: ComputerUseClient,
  ctx: BootstrapContext,
  depsOverride?: Partial<BootstrapDeps>,
): Promise<void> {
  const deps: BootstrapDeps = { ...defaultDeps(), ...depsOverride };
  const pollIntervalMs = deps.pollIntervalMs ?? 2000;
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
  // process lifetime — re-probing on every tool call would call
  // get_app_state on Finder and repeatedly bring Finder to the
  // foreground (user-visible regression observed in real sessions).
  //
  // If the user revokes permissions mid-session, the actual tool call
  // will surface upstream's permissionDenied error and the next
  // reconnect-driven start (stop → start in client.callTool's
  // transport-closed retry) will trigger a fresh probe.
  if (wasAlreadyStarted) return;
  if (deps.platform !== 'darwin') return;

  const probe = await deps.probePermissions(client);
  if (probe === 'ok' || probe === 'other') {
    // 'other' means an error happened that isn't permission-related.
    // We don't block bootstrap on that — let the actual tool call surface it.
    return;
  }

  ctx.updateOutput?.(
    `Computer Use needs macOS permissions (${probe}). ` +
      `An onboarding window will open — please grant Accessibility and Screen Recording, then this will continue automatically.`,
  );
  deps.spawnDoctor();

  // Track last probe kind so we can detect transitions between permissions
  // (e.g. 'accessibility' → 'screenRecording') and re-spawn the doctor window.
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
    const next = await deps.probePermissions(client);
    if (next === 'ok' || next === 'other') return;

    // Re-spawn doctor when permission kind shifts — upstream onboarding
    // window has typically auto-closed after the first permission was
    // granted, so a fresh spawn brings the next prompt back into view.
    if (next !== lastProbeKind) {
      ctx.updateOutput?.(
        `Now waiting for ${next} permission. Please complete this step in the onboarding window — bringing it to the front now.`,
      );
      deps.spawnDoctor();
      lastProbeKind = next;
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    ctx.updateOutput?.(`Waiting for ${next} permission... (${elapsedSec}s)`);
  }
}
