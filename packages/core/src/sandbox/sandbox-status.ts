/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type SandboxStatus =
  | { state: 'confirmed'; exitCode: number }
  | {
      state: 'unconfirmed';
      /**
       * True when backend evidence proves the payload exited. False proves
       * setup failed before exec. Absence remains unknown and must not be
       * interpreted as proof that the payload did not run.
       */
      payloadExitObserved?: boolean;
    }
  | { state: 'interrupted' | 'running' };

export const MAX_STATUS_BYTES = 16 * 1024;

export function sandboxStatusError(status: SandboxStatus): Error | undefined {
  if (status.state === 'unconfirmed') {
    if (status.payloadExitObserved === false) {
      return new Error(
        'Sandbox payload did not run: setup failed before execution (the sandbox runner or payload binary may be missing).',
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
