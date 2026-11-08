import { DEFAULT_CHANNEL_OUTPUT_MODE } from './output-mode.js';
import type {
  ChannelOutputMode,
  ChannelOutputSegmentEndReason,
} from './types.js';

export type ChannelOutputDecision =
  | { kind: 'skip' }
  | { kind: 'failed' }
  | { kind: 'cancelled' }
  | { kind: 'preview'; text: string }
  | { kind: 'complete'; text: string; rotate: boolean };

/** Selects output within the completion boundary owned by the runtime. */
export class ChannelOutputTurn {
  private lastOutput?: string;
  private finished = false;

  constructor(
    private readonly mode: ChannelOutputMode = DEFAULT_CHANNEL_OUTPUT_MODE,
  ) {}

  private get latestOnly(): boolean {
    return this.mode === 'per_turn' || this.mode === 'per_task';
  }

  shouldPreview(text: string): boolean {
    return !this.finished && text.trim() !== '';
  }

  close(
    text: string,
    reason: ChannelOutputSegmentEndReason,
  ): ChannelOutputDecision {
    if (this.finished) return { kind: 'skip' };
    if (reason === 'failed' || reason === 'cancelled') {
      this.lastOutput = undefined;
      return { kind: reason };
    }
    if (!text.trim()) {
      if (reason === 'response_boundary' || !this.latestOnly) {
        return { kind: 'skip' };
      }
      text = this.lastOutput ?? '';
      if (!text.trim()) return { kind: 'skip' };
    }
    if (reason === 'response_boundary' && this.mode !== 'per_response') {
      this.lastOutput = text;
      return {
        kind: 'preview',
        text,
      };
    }
    this.lastOutput = undefined;
    return { kind: 'complete', text, rotate: reason !== 'completed' };
  }

  finish(terminal: 'completed' | 'failed' | 'cancelled'): string | undefined {
    const output = terminal === 'completed' ? this.lastOutput : undefined;
    this.lastOutput = undefined;
    this.finished = true;
    return output;
  }
}
