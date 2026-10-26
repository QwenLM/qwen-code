/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The Runtime worker's gate probe: a worker-internal tool the hosted
// Harness runs as an ordinary Tool v2 execution before it claims a gated
// automation run. It is admitted beside the model tools by name and never
// declared to a model. It runs the command with the scheduled-task gate's
// runner over the worker's per-call configuration — the Session's context
// directory, the worker's environment, stdout and stderr apart — and
// answers the runner's structured result as one JSON text part, which the
// Broker stores as the execution's settled result so a retried fire reads
// it back instead of running the command again. See
// docs/design/2026-10-22-managed-automation-gate.md.

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  createCronGateRunner,
  gateCommandError,
  type CronGateResult,
} from '@qwen-code/qwen-code-core/services/cron-gate.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolResult,
} from '@qwen-code/qwen-code-core/tools/tools.js';

export const MANAGED_AUTOMATION_GATE_TOOL = 'managed_automation_gate';

/**
 * The probe's own bound, under the scheduled-task gate's 60 s: the control
 * plane relays `fire_run` under a 30 s request timeout, so a Runtime acquire
 * plus a probe has to answer inside it in the ordinary case. An overrun is a
 * lost reply the scanner re-drives, and the Broker's receipt answers it.
 */
export const MANAGED_AUTOMATION_GATE_TIMEOUT_MS = 20_000;

export interface ManagedAutomationGateParams {
  gate: string;
}

/** A probe invocation as the worker runs it, with its group handed back. */
export interface ManagedAutomationGateExecution {
  execute(
    signal: AbortSignal,
    updateOutput?: undefined,
    shellExecutionConfig?: undefined,
    onProcessGroup?: (pgid: number) => void,
  ): Promise<ToolResult>;
}

class ManagedAutomationGateInvocation extends BaseToolInvocation<
  ManagedAutomationGateParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ManagedAutomationGateParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Automation gate: ${this.params.gate}`;
  }

  /**
   * `onProcessGroup` gets the command's process group as it starts, in the
   * same position as a Shell call's, so the worker stops and sweeps it the
   * same way.
   */
  async execute(
    signal: AbortSignal,
    _updateOutput?: unknown,
    _shellExecutionConfig?: unknown,
    onProcessGroup?: (pgid: number) => void,
  ): Promise<ToolResult> {
    const run = createCronGateRunner(this.config, {
      timeoutMs: MANAGED_AUTOMATION_GATE_TIMEOUT_MS,
      ...(onProcessGroup ? { onProcessGroup } : {}),
    });
    // The definition's author approved the command when they wrote it; the
    // worker runs admitted tools under yolo, so this is the in-process mark.
    const result: CronGateResult = await run(this.params.gate, {
      signal,
      approvedInProcess: true,
    });
    return {
      llmContent: JSON.stringify(result),
      returnDisplay: `Automation gate ${result.kind}`,
    };
  }
}

export class ManagedAutomationGateTool extends BaseDeclarativeTool<
  ManagedAutomationGateParams,
  ToolResult
> {
  static readonly Name = MANAGED_AUTOMATION_GATE_TOOL;

  constructor(private readonly config: Config) {
    super(
      ManagedAutomationGateTool.Name,
      'Automation gate',
      'Runs a managed automation definition gate command outside the model. Internal to the Runtime worker.',
      Kind.Execute,
      {
        type: 'object',
        properties: {
          gate: {
            type: 'string',
            description: 'The gate command to run in the Session directory.',
          },
        },
        required: ['gate'],
      },
    );
  }

  protected override validateToolParamValues(
    params: ManagedAutomationGateParams,
  ): string | null {
    const error = gateCommandError(params.gate);
    return error === null ? null : `gate ${error}`;
  }

  protected createInvocation(
    params: ManagedAutomationGateParams,
  ): ManagedAutomationGateInvocation {
    return new ManagedAutomationGateInvocation(this.config, params);
  }
}

/** Reads the probe result a gate execution answered, or null if it is not one. */
export function parseManagedAutomationGateResult(
  responseParts: readonly unknown[],
): CronGateResult | null {
  const first = responseParts[0];
  const text =
    first && typeof first === 'object' && 'text' in first
      ? (first as { text?: unknown }).text
      : undefined;
  if (typeof text !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const result = parsed as Record<string, unknown>;
  // A whole, non-negative count, as the records store it: a worker whose
  // wall clock stepped back mid-probe must not leave a claim whose output
  // can never be read back.
  const durationMs =
    typeof result['durationMs'] === 'number' &&
    Number.isFinite(result['durationMs'])
      ? Math.max(0, Math.round(result['durationMs']))
      : undefined;
  switch (result['kind']) {
    case 'quiet':
      return durationMs !== undefined ? { kind: 'quiet', durationMs } : null;
    case 'output':
      return typeof result['stdout'] === 'string' &&
        typeof result['truncated'] === 'boolean' &&
        durationMs !== undefined
        ? {
            kind: 'output',
            stdout: result['stdout'],
            truncated: result['truncated'],
            durationMs,
          }
        : null;
    case 'failed':
      return typeof result['detail'] === 'string' &&
        typeof result['stderr'] === 'string' &&
        durationMs !== undefined
        ? {
            kind: 'failed',
            detail: result['detail'],
            stderr: result['stderr'],
            durationMs,
          }
        : null;
    case 'blocked':
      return typeof result['reason'] === 'string'
        ? {
            kind: 'blocked',
            reason: result['reason'],
            ...(typeof result['rule'] === 'string'
              ? { rule: result['rule'] }
              : {}),
          }
        : null;
    default:
      return null;
  }
}
