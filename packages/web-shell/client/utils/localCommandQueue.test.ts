import { describe, expect, it, vi } from 'vitest';
import {
  appendOrDeferLocalUserMessage,
  isCommandPrompt,
} from './localCommandQueue';

describe('appendOrDeferLocalUserMessage', () => {
  it('appends and returns false when no turn is streaming', () => {
    const append = vi.fn();
    const enqueue = vi.fn();

    const deferred = appendOrDeferLocalUserMessage(
      false,
      '/context',
      undefined,
      {
        append,
        enqueue,
      },
    );

    expect(deferred).toBe(false);
    expect(append).toHaveBeenCalledExactlyOnceWith('/context');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('defers to the queue and returns true while a turn is streaming', () => {
    const append = vi.fn();
    const enqueue = vi.fn();

    const deferred = appendOrDeferLocalUserMessage(
      true,
      '/context',
      undefined,
      {
        append,
        enqueue,
      },
    );

    expect(deferred).toBe(true);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('/context', undefined);
    expect(append).not.toHaveBeenCalled();
  });

  it('forwards images to the queue when deferring', () => {
    const append = vi.fn();
    const enqueue = vi.fn();
    const images = [{ data: 'base64xx', media_type: 'image/png' }];

    appendOrDeferLocalUserMessage(true, '/stats', images, { append, enqueue });

    expect(enqueue).toHaveBeenCalledExactlyOnceWith('/stats', images);
  });
});

describe('isCommandPrompt', () => {
  it('treats slash and shell prefixes as commands', () => {
    expect(isCommandPrompt('/context detail')).toBe(true);
    expect(isCommandPrompt('/stats')).toBe(true);
    expect(isCommandPrompt('!ls -la')).toBe(true);
    expect(isCommandPrompt('  /context')).toBe(true); // leading whitespace
  });

  it('treats prose as not a command', () => {
    expect(isCommandPrompt('summarize the project structure')).toBe(false);
    expect(isCommandPrompt('what does this do?')).toBe(false);
    expect(isCommandPrompt('')).toBe(false);
  });
});
