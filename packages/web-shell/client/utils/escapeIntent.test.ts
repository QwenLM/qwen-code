import { describe, expect, it } from 'vitest';
import { decideEscapeIntent, type EscapeContext } from './escapeIntent';

const base: EscapeContext = {
  blocked: false,
  streaming: false,
  hasInput: false,
  armed: null,
};

describe('decideEscapeIntent', () => {
  it('ignores Escape while blocked, even with a stream or input', () => {
    expect(decideEscapeIntent({ ...base, blocked: true })).toEqual({
      kind: 'ignore',
    });
    expect(
      decideEscapeIntent({
        ...base,
        blocked: true,
        streaming: true,
        hasInput: true,
        armed: 'cancel',
      }),
    ).toEqual({ kind: 'ignore' });
  });

  it('arms cancel on the first Esc while streaming', () => {
    expect(decideEscapeIntent({ ...base, streaming: true })).toEqual({
      kind: 'arm',
      action: 'cancel',
    });
  });

  it('confirms cancel on the second Esc while streaming', () => {
    expect(
      decideEscapeIntent({ ...base, streaming: true, armed: 'cancel' }),
    ).toEqual({ kind: 'cancel' });
  });

  it('re-arms cancel (not clear) when a clear-armed press lands while streaming', () => {
    expect(
      decideEscapeIntent({ ...base, streaming: true, armed: 'clear' }),
    ).toEqual({ kind: 'arm', action: 'cancel' });
  });

  it('prioritises streaming over composer text', () => {
    expect(
      decideEscapeIntent({ ...base, streaming: true, hasInput: true }),
    ).toEqual({ kind: 'arm', action: 'cancel' });
  });

  it('arms clear on the first Esc with text and no stream', () => {
    expect(decideEscapeIntent({ ...base, hasInput: true })).toEqual({
      kind: 'arm',
      action: 'clear',
    });
  });

  it('confirms clear on the second Esc with text', () => {
    expect(
      decideEscapeIntent({ ...base, hasInput: true, armed: 'clear' }),
    ).toEqual({ kind: 'clear' });
  });

  it('re-arms clear when a stale cancel-armed press lands with text', () => {
    expect(
      decideEscapeIntent({ ...base, hasInput: true, armed: 'cancel' }),
    ).toEqual({ kind: 'arm', action: 'clear' });
  });

  it('ignores Escape with no stream and no text', () => {
    expect(decideEscapeIntent(base)).toEqual({ kind: 'ignore' });
    expect(decideEscapeIntent({ ...base, armed: 'clear' })).toEqual({
      kind: 'ignore',
    });
  });
});
