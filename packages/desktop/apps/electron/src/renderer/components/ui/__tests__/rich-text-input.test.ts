import { describe, it, expect } from 'bun:test';
import {
  isEscapeDuringComposition,
  shouldSyncRenderedValue,
} from '../rich-text-input';

describe('isEscapeDuringComposition', () => {
  it('returns true for Escape when local composition ref is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, true)).toBe(true);
  });

  it('returns true for Escape when nativeEvent.isComposing is true', () => {
    expect(
      isEscapeDuringComposition(
        { key: 'Escape', nativeEvent: { isComposing: true } },
        false,
      ),
    ).toBe(true);
  });

  it('returns true for Escape when event.isComposing is true', () => {
    expect(
      isEscapeDuringComposition({ key: 'Escape', isComposing: true }, false),
    ).toBe(true);
  });

  it('returns false for Escape when no composition signal is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, false)).toBe(false);
  });

  it('returns false for non-Escape keys even if composing', () => {
    expect(
      isEscapeDuringComposition({ key: 'Enter', isComposing: true }, true),
    ).toBe(false);
  });
});

describe('shouldSyncRenderedValue', () => {
  it('returns true when the text value changes', () => {
    expect(shouldSyncRenderedValue('hello', 'hello world', '', '')).toBe(true);
  });

  it('returns true when mention availability changes badge rendering', () => {
    expect(
      shouldSyncRenderedValue(
        '[skill:pptx] inspect this deck',
        '[skill:pptx] inspect this deck',
        '',
        'skill:pptx:0',
      ),
    ).toBe(true);
  });

  it('returns false when neither text nor badge rendering changed', () => {
    expect(
      shouldSyncRenderedValue(
        '[skill:pptx] inspect this deck',
        '[skill:pptx] inspect this deck',
        'skill:pptx:0',
        'skill:pptx:0',
      ),
    ).toBe(false);
  });
});
