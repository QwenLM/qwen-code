/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../config/config.js';
import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';
import type { ToolPermissionDenial } from '../../core/tool-result.js';
import type { ToolUseContext } from '../../tools/tool-types.js';

import {
  DoomLoopGuard,
  REPEATED_TOOL_CALL_PERMISSION_KIND,
  buildRepeatedToolCallKey,
  type ConfirmContinuation,
  type ContinuationDecision,
  type RepeatedToolCallDetection,
} from '../../core/doom-loop-guard.js';


export const REPEATED_TOOL_CALL_TERMINAL_REASON = 'repeated_tool_call_denied';
const REPEATED_TOOL_CALL_DECISION_REASON_TYPE = 'repeatedToolCall';

export interface RepeatedCallStats {
  loopDetected: boolean;
  approvalCount: number;
  approvalRejectedCount: number;
}

type Decision =
  | { outcome: 'allow_once'; updatedInput?: Record<string, unknown> }
  | { outcome: 'allow_session'; updatedInput?: Record<string, unknown> }
  | { outcome: 'deny'; reason?: string };

type RepeatedCallCheckResult =
  | { allowed: true; block: ModelToolUseBlock }
  | {
      allowed: false;
      message: string;
      terminalReason: string;
      denial: ToolPermissionDenial;
    };

/**
 * Owns doom-loop detection, the continuation prompt, its reporting and the
 * per-session allow bookkeeping. The query loop only supplies a stats sink.
 */
export class RepeatedToolCallController {
  private readonly guard: DoomLoopGuard;

  constructor(
    private readonly deps: {
      config: Config;
      /** Agent-owned guard; one instance per agent context. */
      guard?: DoomLoopGuard;
      sessionAllowedKeys?: Set<string>;
    },
  ) {
    this.guard =
      deps.guard ??
      new DoomLoopGuard({
        sessionAllowedKeys: deps.sessionAllowedKeys,
      });
  }

  neutralize(block: ModelToolUseBlock): void {
    this.guard.neutralize(buildRepeatedToolCallKey(block.name, block.input));
  }

  async check(
    block: ModelToolUseBlock,
    params: {
      signal: AbortSignal;
      toolUseContext?: ToolUseContext;
      stats?: RepeatedCallStats;
    },
  ): Promise<RepeatedCallCheckResult> {
    const checked = this.guard.check(block);
    if (!checked.detected || !checked.detection) {
      return { allowed: true, block };
    }

    const detection = checked.detection;
    const config = this.deps.config;
    if (params.stats) {
      params.stats.loopDetected = true;
      params.stats.approvalCount++;
    }
    const defaultReason = buildRepeatedToolCallReason(detection);

    let decision: Decision;
    try {
      decision = await requestRepeatedToolCallPermission({
        detection,
        confirm: config.confirmContinuation,
        signal: params.signal,
      });
    } catch (error) {
      decision = {
        outcome: 'deny',
        reason:
          error instanceof Error
            ? error.message
            : 'Repeated tool call confirmation failed.',
      };
    }



    if (decision.outcome === 'allow_session') {
      this.guard.allowForSession(
        decision.updatedInput
          ? buildRepeatedToolCallKey(block.name, decision.updatedInput)
          : detection.inputKey,
      );
      return {
        allowed: true,
        block: withUpdatedInput(block, decision.updatedInput),
      };
    }
    if (decision.outcome === 'allow_once') {
      this.guard.allowOnce(
        decision.updatedInput
          ? buildRepeatedToolCallKey(block.name, decision.updatedInput)
          : detection.inputKey,
      );
      return {
        allowed: true,
        block: withUpdatedInput(block, decision.updatedInput),
      };
    }

    if (params.stats) params.stats.approvalRejectedCount++;
    const message = decision.reason ?? defaultReason;
    return {
      allowed: false,
      message,
      terminalReason: REPEATED_TOOL_CALL_TERMINAL_REASON,
      denial: {
        tool_name: block.name,
        tool_use_id: block.id,
        tool_input: block.input,
        message,
        decision_reason_type: REPEATED_TOOL_CALL_DECISION_REASON_TYPE,
        decision_reason: defaultReason,
      },
    };
  }
}

function withUpdatedInput(
  block: ModelToolUseBlock,
  updatedInput: Record<string, unknown> | undefined,
): ModelToolUseBlock {
  if (!updatedInput) return block;
  return {
    type: 'tool_use',
    id: block.id,
    name: block.name,
    input: structuredClone(updatedInput),
  };
}

function buildRepeatedToolCallReason(
  detection: RepeatedToolCallDetection,
): string {
  return `Repeated tool call detected: ${detection.toolName} was requested ${detection.repeatCount} recent times with identical input.`;
}

async function requestRepeatedToolCallPermission(params: {
  detection: RepeatedToolCallDetection;
  confirm?: ConfirmContinuation;
  signal?: AbortSignal;
}): Promise<Decision> {
  const { detection, confirm, signal } = params;
  if (!confirm) {
    return {
      outcome: 'deny',
      reason:
        'Repeated tool call requires confirmation, but no interactive prompt is available.',
    };
  }

  let decision: ContinuationDecision;
  try {
    decision = await confirm({
      kind: REPEATED_TOOL_CALL_PERMISSION_KIND,
      title: 'Repeated tool call detected',
      toolName: detection.toolName,
      repeatCount: detection.repeatCount,
      threshold: detection.threshold,
      inputPreview: detection.inputPreview,
      signal,
    });
  } catch {
    return { outcome: 'deny', reason: 'Confirmation prompt failed.' };
  }

  switch (decision.outcome) {
    case 'session':
      return { outcome: 'allow_session', updatedInput: decision.updatedInput };
    case 'once':
      return { outcome: 'allow_once', updatedInput: decision.updatedInput };
    default:
      return { outcome: 'deny', reason: decision.reason };
  }
}
