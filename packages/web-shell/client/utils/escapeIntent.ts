// Pure decision logic for the composer's two-press Escape behaviour, extracted
// from App's keydown listener so the priority + confirm rules can be tested
// without mounting the whole app. The listener owns the side effects (timers,
// cancel/clear handlers); this module only decides what a press means.

/**
 * Confirm windows for the two-press Escape gesture, in milliseconds. The cancel
 * window also drives the countdown ring's animation duration (passed to CSS as a
 * custom property), so it stays the single source of truth for that timing.
 */
export const ESC_CANCEL_CONFIRM_WINDOW_MS = 2000;
export const ESC_CLEAR_CONFIRM_WINDOW_MS = 500;

export type EscArmedAction = 'cancel' | 'clear';

export interface EscapeContext {
  /** A pending approval or blocking dialog swallows Escape entirely. */
  blocked: boolean;
  /** A turn is in flight (streamingState !== 'idle'). */
  streaming: boolean;
  /** The composer currently has text that could be cleared. */
  hasInput: boolean;
  /** Which action the previous Escape armed, or null when idle. */
  armed: EscArmedAction | null;
}

export type EscapeIntent =
  | { kind: 'cancel' } // confirmed second press: stop the stream
  | { kind: 'clear' } // confirmed second press: clear the composer
  | { kind: 'arm'; action: EscArmedAction } // first press: show the affordance
  | { kind: 'ignore' }; // nothing to act on

/**
 * Decide what an Escape press means. Streaming takes priority over clearing
 * text (stopping a live turn is what the user most wants), and each action is a
 * two-press confirm: the first press arms, a matching second press confirms. A
 * press armed for the wrong action (e.g. clear-armed while now streaming)
 * re-arms the action that currently applies rather than confirming.
 */
export function decideEscapeIntent(ctx: EscapeContext): EscapeIntent {
  if (ctx.blocked) return { kind: 'ignore' };
  if (ctx.streaming) {
    return ctx.armed === 'cancel'
      ? { kind: 'cancel' }
      : { kind: 'arm', action: 'cancel' };
  }
  if (ctx.hasInput) {
    return ctx.armed === 'clear'
      ? { kind: 'clear' }
      : { kind: 'arm', action: 'clear' };
  }
  return { kind: 'ignore' };
}
