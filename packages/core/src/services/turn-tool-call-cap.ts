/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServerLlmStreamEvent } from '../core/turn.js';
import { LlmEventType } from '../core/turn.js';
import type { Config } from '../config/config.js';
import { logLoopDetected } from '../telemetry/loggers.js';
import {
  LoopDetectedEvent,
  LoopReason,
  LoopType,
  type LoopStopDetail,
} from '../telemetry/types.js';

/**
 * Counts a turn's tool calls against an explicit `model.maxToolCallsPerTurn`.
 * The turn stops on the first call past the cap; without a cap it never stops.
 */
export class TurnToolCallCap {
  private promptId = '';
  private total = 0;
  // The total as of the last finished model response: a retry re-streams the
  // failed attempt's calls, so it rolls back to here.
  private committed = 0;
  private stop: LoopStopDetail | undefined;

  constructor(private readonly config: Config) {}

  reset(promptId: string): void {
    this.promptId = promptId;
    this.total = 0;
    this.committed = 0;
    this.stop = undefined;
  }

  /** Feeds one stream event; true once the turn has gone past the cap. */
  check(event: ServerLlmStreamEvent): boolean {
    if (this.stop) return true;
    if (event.type === LlmEventType.Finished) {
      this.committed = this.total;
      return false;
    }
    if (event.type === LlmEventType.Retry) {
      this.total = this.committed;
      return false;
    }
    if (event.type !== LlmEventType.ToolCallRequest) return false;
    this.total++;
    const limit = this.config.getMaxToolCallsPerTurn();
    if (this.total <= limit) return false;
    this.stop = {
      loopReason: LoopReason.EXPLICIT_CAP,
      toolCallCount: this.total,
      toolCallLimit: limit,
    };
    logLoopDetected(
      this.config,
      new LoopDetectedEvent(
        LoopType.TURN_TOOL_CALL_CAP,
        this.promptId,
        this.stop,
      ),
    );
    return true;
  }

  /** The stop, once `check` returned true. */
  getStop(): LoopStopDetail | undefined {
    return this.stop;
  }
}
