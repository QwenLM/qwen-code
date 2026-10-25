/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

export interface ToolOutputRecovery {
  text?: string;
  persistedOutputFiles?: string[];
}

const recoveryKey = Symbol('tool-output-recovery');
type RecoveryPart = Part & { [recoveryKey]?: ToolOutputRecovery };

export function getToolOutputRecovery(
  part: Part,
): ToolOutputRecovery | undefined {
  return (part as RecoveryPart)[recoveryKey];
}

export function setToolOutputRecovery(
  part: Part,
  recovery: ToolOutputRecovery,
): void {
  (part as RecoveryPart)[recoveryKey] = recovery;
}

export function attachToolOutputRecovery(
  parts: Part[],
  recovery: ToolOutputRecovery,
): Part[] {
  return parts.map(
    (part): RecoveryPart => ({ ...part, [recoveryKey]: recovery }),
  );
}
