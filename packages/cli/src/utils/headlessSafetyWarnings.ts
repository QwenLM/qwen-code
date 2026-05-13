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
 * non-interactive run — or `null` when no warning is warranted (sandbox is
 * configured, already inside a sandbox, approval mode is not YOLO, or the
 * user explicitly suppressed the notice).
 *
 * Pure / env-injectable so the policy can be unit-tested without mocking
 * `process.env` globally.
 */
export function getHeadlessYoloSafetyWarning(
  config: Pick<Config, 'getApprovalMode' | 'getSandbox'>,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (config.getApprovalMode() !== ApprovalMode.YOLO) return null;
  if (config.getSandbox()) return null;
  if (env['SANDBOX']) return null;
  if (env['QWEN_CODE_SUPPRESS_YOLO_WARNING']) return null;
  return HEADLESS_YOLO_NO_SANDBOX_WARNING;
}
