/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type BwrapStatus =
  | { state: 'confirmed'; exitCode: number }
  | {
      state: 'unconfirmed';
      /**
       * True when the status wire carried a well-formed bwrap exit-code
       * record — i.e. the payload got past exec and ran to an exit, so the
       * run may genuinely have happened and its dirs are worth retaining.
       * False is a positive attestation that the payload never executed
       * (a bwrap spawn failure, or a wire with no exit-code record).
       * Absent means unknown — an oversized or partial wire, or a
       * non-spawn relay failure — and must never be read as "did not run".
       */
      payloadExitObserved?: boolean;
    }
  | { state: 'interrupted' | 'running' };

export const MAX_STATUS_BYTES = 16 * 1024;

export function sandboxStatusError(status: BwrapStatus): Error | undefined {
  if (status.state === 'unconfirmed') {
    // Only a positive no-exec attestation gets the definitive message;
    // unknown stays on the cautious "may have run" wording so a
    // retry-deciding caller is never told the payload did not run without
    // evidence (PR #12067 review, round 2).
    if (status.payloadExitObserved === false) {
      return new Error(
        'Sandbox payload did not run: setup failed before execution (bubblewrap or the payload binary may be missing).',
      );
    }
    return new Error(
      'Sandbox execution status could not be confirmed. The command may have run; do not automatically retry it.',
    );
  }
  if (status.state === 'interrupted') {
    return new Error('Sandbox execution was interrupted.');
  }
  return undefined;
}

export function parseBwrapStatus(
  wire: string,
  exitCode: number | null,
): BwrapStatus {
  if (Buffer.byteLength(wire) > MAX_STATUS_BYTES || !wire.endsWith('\n')) {
    return { state: 'unconfirmed' };
  }
  // Whether the wire carries any well-formed bwrap exit-code record,
  // independent of correlation — bwrap only emits it once the payload is
  // past exec, so its presence is proof the payload process ran to an exit.
  const payloadExitObserved = wire
    .trim()
    .split('\n')
    .some((line) => {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const code = record['exit-code'];
        return (
          typeof code === 'number' &&
          Number.isInteger(code) &&
          code >= 0 &&
          code <= 255
        );
      } catch {
        return false;
      }
    });
  try {
    const lines = wire.trim().split('\n');
    if (lines.length !== 2)
      return { state: 'unconfirmed', payloadExitObserved };
    const initial = JSON.parse(lines[0]) as Record<string, unknown>;
    const final = JSON.parse(lines[1]) as Record<string, unknown>;
    const pid = initial['child-pid'];
    const code = final['exit-code'];
    if (
      typeof pid === 'number' &&
      Number.isInteger(pid) &&
      pid > 0 &&
      typeof code === 'number' &&
      Number.isInteger(code) &&
      code >= 0 &&
      code <= 255 &&
      code === exitCode
    ) {
      return { state: 'confirmed', exitCode: code };
    }
  } catch {
    // A partial or incompatible status stream cannot prove successful exec.
  }
  return { state: 'unconfirmed', payloadExitObserved };
}
