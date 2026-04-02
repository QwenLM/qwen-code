import { describe, it, expect, beforeEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  startTurnSpan,
  endTurnSpan,
  getActiveTurnContext,
  getActiveTurnSpan,
} from './turnSpanContext.js';

describe('TurnSpanContext', () => {
  beforeEach(() => {
    // Ensure no lingering turn from a previous test
    endTurnSpan();
  });

  it('startTurnSpan returns an OTel Context', () => {
    const ctx = startTurnSpan('session-1', 'turn-1');
    expect(ctx).toBeDefined();
    // The context should carry the turn span
    const span = trace.getSpan(ctx);
    expect(span).toBeDefined();
  });

  it('getActiveTurnContext returns undefined before any turn starts', () => {
    expect(getActiveTurnContext()).toBeUndefined();
  });

  it('getActiveTurnContext returns a context after startTurnSpan', () => {
    startTurnSpan('session-1', 'turn-1');
    const ctx = getActiveTurnContext();
    expect(ctx).toBeDefined();
  });

  it('getActiveTurnSpan returns the active span after startTurnSpan', () => {
    startTurnSpan('session-1', 'turn-1');
    const span = getActiveTurnSpan();
    expect(span).toBeDefined();
  });

  it('getActiveTurnSpan returns undefined before any turn starts', () => {
    expect(getActiveTurnSpan()).toBeUndefined();
  });

  it('endTurnSpan clears the active context', () => {
    startTurnSpan('session-1', 'turn-1');
    expect(getActiveTurnContext()).toBeDefined();

    endTurnSpan();
    expect(getActiveTurnContext()).toBeUndefined();
    expect(getActiveTurnSpan()).toBeUndefined();
  });

  it('endTurnSpan clears the active span', () => {
    startTurnSpan('session-1', 'turn-1');
    expect(getActiveTurnSpan()).toBeDefined();

    endTurnSpan('ok');
    expect(getActiveTurnSpan()).toBeUndefined();
  });

  it('startTurnSpan auto-closes a previous unclosed span', () => {
    startTurnSpan('session-1', 'turn-1');
    const firstSpan = getActiveTurnSpan();

    startTurnSpan('session-1', 'turn-2');
    const secondSpan = getActiveTurnSpan();

    // The second span should be a different span instance
    expect(secondSpan).toBeDefined();
    expect(secondSpan).not.toBe(firstSpan);

    // The active context should reflect the new turn
    const ctx = getActiveTurnContext();
    expect(ctx).toBeDefined();
    const spanFromCtx = trace.getSpan(ctx!);
    expect(spanFromCtx).toBe(secondSpan);
  });

  it('endTurnSpan is a no-op when no turn is active', () => {
    // Should not throw
    expect(() => endTurnSpan()).not.toThrow();
    expect(() => endTurnSpan('ok')).not.toThrow();
    expect(() => endTurnSpan('error')).not.toThrow();
  });

  it('endTurnSpan accepts an ok status', () => {
    startTurnSpan('session-1', 'turn-1');
    // Should not throw; status is set on the span internally
    expect(() => endTurnSpan('ok')).not.toThrow();
    expect(getActiveTurnSpan()).toBeUndefined();
  });

  it('endTurnSpan accepts an error status', () => {
    startTurnSpan('session-1', 'turn-1');
    expect(() => endTurnSpan('error')).not.toThrow();
    expect(getActiveTurnSpan()).toBeUndefined();
  });

  it('returned context carries the turn span', () => {
    const turnCtx = startTurnSpan('session-1', 'turn-1');
    const turnSpan = getActiveTurnSpan();

    // Extracting the span from the returned context directly proves
    // the context is wired correctly (context.with() uses the no-op
    // context manager when the SDK is not initialized, so we verify
    // the context object itself rather than propagation through with()).
    const spanFromCtx = trace.getSpan(turnCtx);
    expect(spanFromCtx).toBe(turnSpan);
  });
});
