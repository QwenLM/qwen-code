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

/** One foreground turn; background follow-ups use independent turn state. */
export class ChannelOutputTurn {
  private lastOutput?: string;
  private finished = false;

  constructor(private readonly mode?: ChannelOutputMode) {}

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
      if (reason !== 'completed' || this.mode !== 'final_only') {
        return { kind: 'skip' };
      }
      text = this.lastOutput ?? '';
      if (!text.trim()) return { kind: 'skip' };
    }
    if (reason === 'response_boundary' && this.mode !== 'process_and_result') {
      if (this.mode === 'final_only') this.lastOutput = text;
      return {
        kind: 'preview',
        text,
        deferFallback: this.mode === 'final_only',
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
