import { describe, expect, it } from 'vitest';
import { mergeRestoredPromptText } from './useQueuedPrompts';

// Regression for #7128: restoration paths can fire more than once for the
// same prompt (failed submit + reconnect/refresh, queue clear racing an
// abort), and a user retrying an identical message restores identical text.
// Stacking those copies is what surfaced as "sent messages concatenated back
// into the input box after refresh".
describe('mergeRestoredPromptText', () => {
  it('fills an empty editor with the restored text', () => {
    expect(mergeRestoredPromptText('', 'hello')).toBe('hello');
    expect(mergeRestoredPromptText('   ', 'hello')).toBe('hello');
  });

  it('prepends above a different draft the user is typing', () => {
    expect(mergeRestoredPromptText('draft', 'restored')).toBe(
      'restored\ndraft',
    );
  });

  it('is a no-op when the same text was already restored', () => {
    expect(mergeRestoredPromptText('hello', 'hello')).toBe('hello');
  });

  it('is a no-op when the text already sits at the top of the editor', () => {
    expect(mergeRestoredPromptText('hello\ndraft', 'hello')).toBe(
      'hello\ndraft',
    );
  });

  it('stays idempotent across repeated restores of the same prompt', () => {
    let editor = '';
    for (let i = 0; i < 3; i++) {
      editor = mergeRestoredPromptText(editor, '用python写一个hello world');
    }
    expect(editor).toBe('用python写一个hello world');
  });

  it('does not treat a same-prefix but different first line as a duplicate', () => {
    expect(mergeRestoredPromptText('hello world\ndraft', 'hello')).toBe(
      'hello\nhello world\ndraft',
    );
  });
});
