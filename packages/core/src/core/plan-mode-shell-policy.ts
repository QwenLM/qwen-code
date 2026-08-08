/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { PermissionCheckContext } from '../permissions/types.js';
import { ToolNames } from '../tools/tool-names.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationPayload,
} from '../tools/tools.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import {
  classifyShellCommandSafety,
  type ShellCommandSafety,
} from '../utils/shellAstParser.js';
import { normalizeMonitorCommand } from '../utils/shell-utils.js';

const UNKNOWN_WARNING =
  'Plan mode could not determine whether this shell command is read-only. Approval applies only to this exact invocation once; it may modify system state, and Plan mode will remain active.';
const WRITE_BLOCK_MESSAGE =
  'Plan mode blocked this shell command because it was classified as state-modifying. Do not retry it through wrappers or obfuscation; continue read-only investigation and include the action in the plan.';
const NO_APPROVAL_MESSAGE =
  'Plan mode could not determine whether this shell command is read-only, and no approval surface is available. The command was not run; Plan mode remains active.';
const STALE_APPROVAL_MESSAGE =
  'Plan-mode shell approval is no longer valid because the mode, permission policy, or exact invocation changed. Submit a new tool call.';

interface PlanModeShellContextSnapshot {
  requestArgs: Record<string, unknown>;
  invocationParams: Record<string, unknown>;
  approvalModeRevision: number;
  permissionContext: PermissionCheckContext;
  ambientWorkingDirectory?: string;
}

type ApplicablePlanModeShellDecision = {
  classification: ShellCommandSafety;
  rawCommand: string;
  snapshot: PlanModeShellContextSnapshot;
  writeBlockMessage: typeof WRITE_BLOCK_MESSAGE;
  noApprovalMessage: typeof NO_APPROVAL_MESSAGE;
};

/** @internal */
export type PlanModeShellDecision =
  | { classification: 'not-applicable' }
  | ApplicablePlanModeShellDecision;

function isApplicable(
  decision: PlanModeShellDecision,
): decision is ApplicablePlanModeShellDecision {
  return decision.classification !== 'not-applicable';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Plan-mode shell policy evaluation was aborted.');
}

function raceWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));

    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function appendUnique(values: string[] | undefined, value: string): string[] {
  return values?.includes(value) ? values : [...(values ?? []), value];
}

function effectiveWorkingDirectory(
  config: Config,
  invocationParams: Record<string, unknown>,
): string {
  const directory = invocationParams['directory'];
  return typeof directory === 'string' && directory.length > 0
    ? directory
    : config.getTargetDir();
}

/** @internal */
export async function evaluatePlanModeShellPolicy(input: {
  config: Config;
  toolName: string;
  requestArgs: Record<string, unknown>;
  invocationParams: Record<string, unknown>;
  permissionContext: PermissionCheckContext;
  ambientWorkingDirectory?: string;
  signal: AbortSignal;
}): Promise<PlanModeShellDecision> {
  if (
    input.toolName !== ToolNames.SHELL &&
    input.toolName !== ToolNames.MONITOR
  ) {
    return { classification: 'not-applicable' };
  }
  if (input.config.getApprovalMode() !== ApprovalMode.PLAN) {
    return { classification: 'not-applicable' };
  }

  const rawCommand =
    typeof input.invocationParams['command'] === 'string'
      ? input.invocationParams['command']
      : '';
  const safetyCommand =
    input.toolName === ToolNames.MONITOR
      ? normalizeMonitorCommand(rawCommand).safetyCommand
      : rawCommand;
  const permissionContext = clone(input.permissionContext);
  permissionContext.cwd = effectiveWorkingDirectory(
    input.config,
    input.invocationParams,
  );
  permissionContext.toolParams = clone(input.invocationParams);
  const invocationDirectory = input.invocationParams['directory'];
  const ambientWorkingDirectory =
    input.ambientWorkingDirectory ??
    (typeof invocationDirectory !== 'string' || invocationDirectory.length === 0
      ? input.config.getTargetDir()
      : undefined);
  const snapshot: PlanModeShellContextSnapshot = {
    requestArgs: clone(input.requestArgs),
    invocationParams: clone(input.invocationParams),
    approvalModeRevision: input.config.getApprovalModeRevision(),
    permissionContext,
    ambientWorkingDirectory,
  };

  let classification: ShellCommandSafety;
  try {
    classification = await raceWithAbort(
      () => classifyShellCommandSafety(safetyCommand),
      input.signal,
    );
  } catch (error) {
    if (input.signal.aborted) throw error;
    classification = 'unknown';
  }

  return {
    classification,
    rawCommand,
    snapshot,
    writeBlockMessage: WRITE_BLOCK_MESSAGE,
    noApprovalMessage: NO_APPROVAL_MESSAGE,
  };
}

/** @internal */
export async function validatePlanModeShellContext(input: {
  config: Config;
  decision: PlanModeShellDecision;
  requestArgs: Record<string, unknown>;
  invocationParams: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<string | undefined> {
  if (!isApplicable(input.decision)) return undefined;
  const decision = input.decision;

  if (input.signal.aborted) throw abortError(input.signal);

  const matchesSnapshot = () =>
    !input.signal.aborted &&
    input.config.getApprovalMode() === ApprovalMode.PLAN &&
    input.config.getApprovalModeRevision() ===
      decision.snapshot.approvalModeRevision &&
    (decision.snapshot.ambientWorkingDirectory === undefined ||
      input.config.getTargetDir() ===
        decision.snapshot.ambientWorkingDirectory) &&
    effectiveWorkingDirectory(input.config, input.invocationParams) ===
      decision.snapshot.permissionContext.cwd &&
    isDeepStrictEqual(input.requestArgs, decision.snapshot.requestArgs) &&
    isDeepStrictEqual(
      input.invocationParams,
      decision.snapshot.invocationParams,
    );

  if (!matchesSnapshot()) return STALE_APPROVAL_MESSAGE;

  const permissionManager = input.config.getPermissionManager?.();
  if (permissionManager) {
    try {
      const currentPermission = await raceWithAbort(
        () =>
          permissionManager.evaluate(
            clone(decision.snapshot.permissionContext),
          ),
        input.signal,
      );
      if (currentPermission === 'deny') return STALE_APPROVAL_MESSAGE;
    } catch {
      if (input.signal.aborted) throw abortError(input.signal);
      return STALE_APPROVAL_MESSAGE;
    }
  }

  if (input.signal.aborted) throw abortError(input.signal);
  return matchesSnapshot() ? undefined : STALE_APPROVAL_MESSAGE;
}

/** @internal */
export function decoratePlanModeShellConfirmation(
  decision: PlanModeShellDecision,
  confirmation: ToolCallConfirmationDetails,
): ToolCallConfirmationDetails {
  if (!isApplicable(decision)) return confirmation;

  if (confirmation.type === 'ask_user_question') {
    throw new Error(decision.noApprovalMessage);
  }

  if (decision.classification !== 'unknown') {
    return { ...confirmation, hideAlwaysAllow: true };
  }

  if (confirmation.type === 'exec') {
    return {
      ...confirmation,
      hideAlwaysAllow: true,
      warnings: appendUnique(confirmation.warnings, UNKNOWN_WARNING),
    };
  }

  if (confirmation.type === 'edit') {
    const warnings = appendUnique(confirmation.warnings, UNKNOWN_WARNING);
    return {
      ...confirmation,
      hideAlwaysAllow: true,
      hideModify: true,
      skipIdeDiff: true,
      warnings: appendUnique(
        warnings,
        `Exact shell command: \`${decision.rawCommand}\``,
      ),
    };
  }

  throw new Error(decision.noApprovalMessage);
}

/** @internal */
export async function validatePlanModeShellApproval(input: {
  config: Config;
  decision: PlanModeShellDecision;
  requestArgs: Record<string, unknown>;
  invocationParams: Record<string, unknown>;
  signal: AbortSignal;
  outcome: ToolConfirmationOutcome;
  payload?: ToolConfirmationPayload;
}): Promise<{
  outcome: ToolConfirmationOutcome;
  payload?: ToolConfirmationPayload;
}> {
  if (!isApplicable(input.decision)) {
    return { outcome: input.outcome, payload: input.payload };
  }

  if (input.outcome === ToolConfirmationOutcome.Cancel) {
    return {
      outcome: ToolConfirmationOutcome.Cancel,
      ...(input.payload?.cancelMessage
        ? { payload: { cancelMessage: input.payload.cancelMessage } }
        : {}),
    };
  }

  const invalidContext = await validatePlanModeShellContext(input);
  const invalidOutcome = input.outcome !== ToolConfirmationOutcome.ProceedOnce;
  const invalidPayload =
    input.payload?.newContent !== undefined ||
    (input.payload?.updatedInput !== undefined &&
      !isDeepStrictEqual(
        input.payload.updatedInput,
        input.decision.snapshot.requestArgs,
      ));

  if (invalidContext || invalidOutcome || invalidPayload) {
    return {
      outcome: ToolConfirmationOutcome.Cancel,
      payload: { cancelMessage: STALE_APPROVAL_MESSAGE },
    };
  }

  return { outcome: ToolConfirmationOutcome.ProceedOnce };
}
