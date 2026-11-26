/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import type { Config } from '../config/config.js';
import {
  hasMidTurnConsumableCommand,
  subscribeToCommandQueue,
} from '../services/messageQueueManager.js';
import { getAgentContext } from '../utils/agentContext.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolResult,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { SLEEP_DISPLAY_NAME, SLEEP_TOOL_NAME } from './tool-names.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';

export interface SleepParams {
  duration_ms: number;
}

export type SleepWakeReason = 'input' | 'timeout';

export type SleepOutput = {
  reason: SleepWakeReason;
  elapsedMs: number;
};

function hasWakingInput(sessionId: string): boolean {
  return hasMidTurnConsumableCommand({ isSubagent: false, sessionId });
}

function waitForInputOrTimeout(
  sessionId: string,
  durationMs: number,
  signal: AbortSignal,
): Promise<SleepWakeReason> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Sleep aborted', 'AbortError'));
      return;
    }
    let settled = false;

    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = () =>
      settle(() => reject(new DOMException('Sleep aborted', 'AbortError')));
    const onQueueChange = () => {
      if (hasWakingInput(sessionId)) settle(() => resolve('input'));
    };

    const unsubscribe = subscribeToCommandQueue(onQueueChange);
    const timer = setTimeout(() => settle(() => resolve('timeout')), durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
    // Input queued before the call started wakes it immediately.
    onQueueChange();
  });
}

class SleepInvocation extends BaseToolInvocation<SleepParams, ToolResult> {
  constructor(
    private readonly config: Config,
    params: SleepParams,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, toolName, toolDisplayName);
  }

  getDescription(): string {
    return `Waiting up to ${this.params.duration_ms}ms for user input`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (getAgentContext() !== undefined) {
      const message = `${SLEEP_TOOL_NAME} is only available in the main session.`;
      return {
        llmContent: `Error: ${message}`,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    const startedAt = Date.now();
    const reason = await waitForInputOrTimeout(
      this.config.getSessionId(),
      this.params.duration_ms,
      signal,
    );
    const output: SleepOutput = { reason, elapsedMs: Date.now() - startedAt };
    const text =
      reason === 'input'
        ? `Woke up after ${output.elapsedMs}ms: new input arrived.`
        : `Slept for ${output.elapsedMs}ms without new input.`;
    return {
      llmContent: text,
      returnDisplay: text,
      data: output,
      toolUseResult: output,
      ...(reason === 'timeout' ? { repeatNeutral: true } : {}),
    };
  }
}

export class SleepTool extends BaseDeclarativeTool<SleepParams, ToolResult> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = SLEEP_TOOL_NAME;

  constructor(private readonly config: Config) {
    super(
      SleepTool.Name,
      SLEEP_DISPLAY_NAME,
      CORE_TOOL_SET.Sleep.description!,
      Kind.Other,
      CORE_TOOL_SET.Sleep.parametersJsonSchema,
      false,
      false,
    );
  }

  override get isReadOnly(): boolean {
    return true;
  }

  protected createInvocation(
    params: SleepParams,
    toolName?: string,
    toolDisplayName?: string,
  ): SleepInvocation {
    return new SleepInvocation(this.config, params, toolName, toolDisplayName);
  }
}
