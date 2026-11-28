/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { FileSystemService } from '../services/fileSystemService.js';

// In-process only. A result from another runtime cannot authorize a host read.
export const NATIVE_FILE_RESULT_PATH = Symbol('native file result path');

export function withNativeFileResultPath<T extends object>(
  result: T,
  filesystem: FileSystemService,
  path: string,
): T {
  if (filesystem.usesHostFilesystem) {
    Object.assign(result, { [NATIVE_FILE_RESULT_PATH]: path });
  }
  return result;
}

export interface ToolOutputRecovery {
  text?: string;
  persistedOutputFiles?: string[];
  nativeFilePath?: string;
}

const recoveryKey = Symbol('tool-output-recovery');
type RecoveryPart = Part & { [recoveryKey]?: ToolOutputRecovery };

/**
 * The handle is an in-process side channel, not part of a part's value, so it
 * is defined non-enumerable: a part that carries one still compares equal to
 * its own serialized form (the agent JSONL transcript asserts recorded parts
 * equal the parts that were sent) and never leaks into a model request.
 *
 * Callers that copy a part with a spread drop the handle, so attach it last.
 */
function defineRecovery(part: Part, recovery: ToolOutputRecovery): Part {
  Object.defineProperty(part, recoveryKey, {
    value: recovery,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return part;
}

export function getToolOutputRecovery(
  part: Part,
): ToolOutputRecovery | undefined {
  return (part as RecoveryPart)[recoveryKey];
}

export function setToolOutputRecovery(
  part: Part,
  recovery: ToolOutputRecovery,
): void {
  defineRecovery(part, recovery);
}

export function attachToolOutputRecovery(
  parts: Part[],
  recovery: ToolOutputRecovery,
): Part[] {
  return parts.map(
    (part): RecoveryPart => defineRecovery({ ...part }, recovery),
  );
}
