import type {
  ChannelOutputMode,
  ChannelOutputSegmentEndReason,
} from './types.js';

export type ChannelOutputDecision =
  | { kind: 'skip' }
  | { kind: 'failed' }
  | { kind: 'cancelled' }
  | { kind: 'preview'; text: string; deferFallback: boolean }
  | { kind: 'complete'; text: string; rotate: boolean };

/** Selects output within the completion boundary owned by the runtime. */
export class ChannelOutputTurn {
  private lastOutput?: string;
  private finished = false;

  constructor(private readonly mode?: ChannelOutputMode) {}

  private get latestOnly(): boolean {
    return this.mode === 'per_turn' || this.mode === 'per_task';
  }

  shouldPreview(text: string): boolean {
    return !this.finished && (this.mode === undefined || text.trim() !== '');
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
    if (
      this.mode !== undefined &&
      !text.trim() &&
      (reason === 'response_boundary' || reason === 'completed')
    ) {
      if (reason !== 'completed' || !this.latestOnly) {
        return { kind: 'skip' };
      }
      text = this.lastOutput ?? '';
      if (!text.trim()) return { kind: 'skip' };
    }
    if (reason === 'response_boundary' && this.mode !== 'per_response') {
      if (this.latestOnly) this.lastOutput = text;
      return {
        kind: 'preview',
        text,
        deferFallback: this.latestOnly,
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
