/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isExtensionRunStart,
  isExtensionRunSuccessor,
  isTerminalRunState,
  parseExtensionRun,
  type ExtensionRun,
} from './managed-extension-record.js';
import { isDeepStrictEqual } from 'node:util';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

export interface ManagedToolStage {
  readonly kind: 'tool_stage';
  readonly toolStageId: string;
  readonly expansionId: string;
  readonly stepIndex: number;
  readonly toolName: 'read_file' | 'shell';
  readonly inputRef: ManagedSessionDurableRef;
  readonly permissionRef: ManagedSessionDurableRef | null;
  readonly resultRef: ManagedSessionDurableRef | null;
  readonly run: ExtensionRun;
}

export function parseManagedToolStage(value: unknown): ManagedToolStage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const fields = value as Record<string, ManagedSessionJsonValue>;
  if (
    Object.keys(fields).sort().join(',') !==
      'expansionId,inputRef,kind,permissionRef,resultRef,run,stepIndex,toolName,toolStageId' ||
    fields['kind'] !== 'tool_stage' ||
    !Number.isSafeInteger(fields['stepIndex']) ||
    Number(fields['stepIndex']) < 0 ||
    !['read_file', 'shell'].includes(String(fields['toolName']))
  )
    invalid();
  const toolStageId = assertManagedSessionStableId(
    fields['toolStageId'],
    'toolStageId',
  );
  const run = parseExtensionRun(fields['run']);
  if (
    !run.definition ||
    run.definition.definitionId !== fields['toolName'] ||
    run.executionCallId !== toolStageId
  )
    invalid();
  return {
    kind: 'tool_stage',
    toolStageId,
    expansionId: assertManagedSessionStableId(
      fields['expansionId'],
      'expansionId',
    ),
    stepIndex: fields['stepIndex'] as number,
    toolName: fields['toolName'] as ManagedToolStage['toolName'],
    inputRef: assertManagedSessionDurableRef(fields['inputRef'], 'inputRef'),
    permissionRef:
      fields['permissionRef'] === null
        ? null
        : assertManagedSessionDurableRef(
            fields['permissionRef'],
            'permissionRef',
          ),
    resultRef:
      fields['resultRef'] === null
        ? null
        : assertManagedSessionDurableRef(fields['resultRef'], 'resultRef'),
    run,
  };
}

export function isManagedToolStageStart(value: unknown): boolean {
  try {
    const record = parseManagedToolStage(value);
    return record.resultRef === null && isExtensionRunStart(record.run);
  } catch (cause) {
    if (cause instanceof ManagedSessionRecordError) return false;
    throw cause;
  }
}

export function isManagedToolStageSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  try {
    const before = parseManagedToolStage(previous);
    const after = parseManagedToolStage(next);
    if (isTerminalRunState(before.run.state))
      return isDeepStrictEqual(before, after);
    for (const key of [
      'kind',
      'toolStageId',
      'expansionId',
      'stepIndex',
      'toolName',
      'inputRef',
    ] as const)
      if (!isDeepStrictEqual(before[key], after[key])) return false;
    for (const key of ['permissionRef', 'resultRef'] as const)
      if (before[key] && !isDeepStrictEqual(before[key], after[key]))
        return false;
    return isExtensionRunSuccessor(before.run, after.run);
  } catch (cause) {
    if (cause instanceof ManagedSessionRecordError) return false;
    throw cause;
  }
}

function invalid(): never {
  throw new ManagedSessionRecordError(
    'Invalid Managed command preprocessing stage.',
  );
}
