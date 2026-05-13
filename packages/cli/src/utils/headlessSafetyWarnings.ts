/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  ToolNames,
  type Config,
  type SessionMetrics,
} from '@qwen-code/qwen-code-core';

/**
 * Per-run snapshot of dangerous-tool counts pulled from
 * `uiTelemetryService.getMetrics().tools.byName`. The telemetry singleton
 * is process-global, so daemon / SDK callers that invoke `runNonInteractive`
 * multiple times in one process MUST snapshot at run start and pass deltas
 * to the audit — otherwise later runs would report cumulative counts.
 */
export interface DangerousToolCounts {
  shell: number;
  write: number;
  edit: number;
}

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
  // SANDBOX is set by the sandbox transport itself (container / seatbelt
  // wrapper) so any non-empty value means we're already inside a sandbox.
  if (env['SANDBOX']) return null;
  // Explicit user opt-out. Match the project convention (cf. isUnattendedMode
  // in core/utils/retry.ts) so `=0` / `=false` don't accidentally suppress.
  if (isTruthyEnv(env['QWEN_CODE_SUPPRESS_YOLO_WARNING'])) return null;
  return HEADLESS_YOLO_NO_SANDBOX_WARNING;
}

function isTruthyEnv(val: string | undefined): boolean {
  return val === '1' || val === 'true';
}

/**
 * Tool names that have material side effects on the host filesystem or
 * subprocess space. In YOLO / headless runs these auto-execute with no
 * user prompt, so the exit-time audit highlights them by name so CI logs
 * and post-run reviews don't have to grep through structured events.
 *
 * Kept narrow on purpose — see issue #4103. Read-only tools (grep, glob,
 * read_file) and meta tools (todo_write, save_memory) are intentionally
 * out of scope; widening the list dilutes the signal.
 */
const DANGEROUS_TOOLS = {
  shell: ToolNames.SHELL,
  write: ToolNames.WRITE_FILE,
  edit: ToolNames.EDIT,
} as const;

/**
 * Extracts the dangerous-tool counts (shell / write / edit) from a
 * SessionMetrics snapshot. Used by the audit caller to take a baseline
 * snapshot at run start; the delta vs. the current snapshot at run end
 * is the per-run count.
 */
export function readDangerousToolCounts(
  metrics: SessionMetrics,
): DangerousToolCounts {
  const byName = metrics.tools?.byName ?? {};
  return {
    shell: byName[DANGEROUS_TOOLS.shell]?.count ?? 0,
    write: byName[DANGEROUS_TOOLS.write]?.count ?? 0,
    edit: byName[DANGEROUS_TOOLS.edit]?.count ?? 0,
  };
}

/**
 * Returns a one-line stderr summary of dangerous tool calls (shell /
 * write / edit) for an exiting YOLO run, or `null` when no audit line
 * is warranted (not YOLO, no dangerous calls observed, or the user
 * explicitly suppressed the YOLO notice).
 *
 * Takes pre-computed **delta** counts (current - baseline) rather than
 * raw metrics: the underlying `uiTelemetryService` singleton is
 * process-global, so callers that share a process across runs (daemon,
 * SDK) must subtract the baseline snapshot taken at run start.
 *
 * Distinct from the *startup* warning emitted by
 * `getHeadlessYoloSafetyWarning`: that one warns about the privilege
 * boundary before the run begins; this one summarises what actually
 * happened so the operator can spot-check unattended runs in a single
 * log line.
 */
export function getDangerousToolAuditLine(
  config: Pick<Config, 'getApprovalMode'>,
  counts: DangerousToolCounts,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (config.getApprovalMode() !== ApprovalMode.YOLO) return null;
  if (isTruthyEnv(env['QWEN_CODE_SUPPRESS_YOLO_WARNING'])) return null;
  if (counts.shell + counts.write + counts.edit === 0) return null;
  return `YOLO audit: executed ${counts.shell} shell, ${counts.write} write, ${counts.edit} edit tool call(s) during this run.`;
}
