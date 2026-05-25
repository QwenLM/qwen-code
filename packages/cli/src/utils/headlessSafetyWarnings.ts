/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode, type Config } from '@qwen-code/qwen-code-core';

export const HEADLESS_YOLO_NO_SANDBOX_WARNING =
  'Warning: running headless with --yolo / approval-mode=yolo and no sandbox. ' +
  "All tool calls (shell, write, edit) auto-execute at this process's privilege level. " +
  'Enable a sandbox via --sandbox / QWEN_SANDBOX, or set ' +
  'QWEN_CODE_SUPPRESS_YOLO_WARNING=1 to silence this notice.';

/**
 * Returns a warning line to emit when running in YOLO without a sandbox in a
 * non-interactive run, or `null` when no warning is warranted: sandbox is
 * configured, we're already inside a sandbox, approval mode is not YOLO, or
 * the user explicitly suppressed the notice.
 *
 * The call site (gemini.tsx) is responsible for gating on
 * `!config.isInteractive()` — this helper deliberately ignores interactivity
 * so it stays pure and unit-testable.
 *
 * The `env` argument is injectable for tests; production callers omit it and
 * fall through to `process.env`.
 */
export function getHeadlessYoloSafetyWarning(
  config: Pick<Config, 'getApprovalMode' | 'getSandbox'>,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (config.getApprovalMode() !== ApprovalMode.YOLO) return null;
  if (config.getSandbox()) return null;
  // SANDBOX is set by the sandbox transport itself (container / seatbelt
  // wrapper). Use the same strict truthy check as the suppression env to
  // avoid `SANDBOX=false` / `SANDBOX=0` accidentally silencing the warning.
  if (isTruthyEnv(env['SANDBOX'])) return null;
  if (isTruthyEnv(env['QWEN_CODE_SUPPRESS_YOLO_WARNING'])) return null;
  return HEADLESS_YOLO_NO_SANDBOX_WARNING;
}

function isTruthyEnv(val: string | undefined): boolean {
  return val === '1' || val === 'true';
}
