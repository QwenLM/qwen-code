/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The most a gate probe prints in one run. A scheduled task's gate hands the
 * session the first 16 KiB of the probe's stdout and cuts the rest
 * (`CRON_GATE_OUTPUT_CAP_BYTES` in core's `services/cron-gate.ts`, not
 * imported here: it would load the gate runner into every probe run), and a
 * probe writes its cursor before it prints, so whatever the gate cut would be
 * lost for good. The probes stay within this budget and leave what does not
 * fit to their next run.
 */
export const GATE_OUTPUT_BUDGET_BYTES = 12 * 1024;

/**
 * The UTF-8 size of `value` printed as one JSON line, as a gate hands it on:
 * a Managed automation sanitizes the output before it cuts it, writing each
 * `<` as `&lt;` (core's `sanitizeGateOutput`, which otherwise only removes
 * characters), so a body full of `<` grows fourfold past the cut.
 */
export function jsonBytes(value: unknown): number {
  const line = JSON.stringify(value);
  const lessThan = line.match(/</g)?.length ?? 0;
  return Buffer.byteLength(line, 'utf8') + 3 * lessThan;
}
