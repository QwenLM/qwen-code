import { describe, expect, it } from 'vitest';
import {
  encodeVisionModelForSetting,
  encodeFastModelForSetting,
  extractBareModelId,
  decodeVisionModelForPicker,
} from './modelEncoding';

describe('encodeVisionModelForSetting', () => {
  it('encodes standard ACP format', () => {
    expect(encodeVisionModelForSetting('qwen-max(qwen-oauth)')).toBe(
      'qwen-oauth:qwen-max',
    );
  });

  it('passes through non-ACP format unchanged', () => {
    expect(encodeVisionModelForSetting('plain-model')).toBe('plain-model');
  });

  it('passes through empty parens unchanged', () => {
    expect(encodeVisionModelForSetting('model()')).toBe('model()');
  });

  it('passes through colon-bearing IDs unchanged', () => {
    expect(encodeVisionModelForSetting('openai:gpt-4o')).toBe('openai:gpt-4o');
  });

  it('handles nested parentheses by matching outermost ACP pattern', () => {
    // The regex matches the outermost group: modelId(authType)
    expect(encodeVisionModelForSetting('model(name)(extra)')).toBe(
      'extra:model(name)',
    );
  });
});

describe('encodeFastModelForSetting', () => {
  it('encodes standard ACP format', () => {
    expect(encodeFastModelForSetting('qwen-max(qwen-oauth)')).toBe(
      'qwen-oauth:qwen-max',
    );
  });

  it('passes through non-ACP format unchanged', () => {
    expect(encodeFastModelForSetting('plain-model')).toBe('plain-model');
  });
});

describe('extractBareModelId', () => {
  it('extracts bare model ID from ACP format', () => {
    expect(extractBareModelId('qwen-max(qwen-oauth)')).toBe('qwen-max');
  });

  it('passes through non-ACP format unchanged', () => {
    expect(extractBareModelId('plain-model')).toBe('plain-model');
  });

  it('passes through empty parens unchanged', () => {
    // The regex requires at least one char in each capture group,
    // so '()' does not match and passes through.
    expect(extractBareModelId('()')).toBe('()');
  });
});

describe('decodeVisionModelForPicker', () => {
  it('decodes authType:modelId back to ACP format', () => {
    expect(decodeVisionModelForPicker('qwen-oauth:qwen-max')).toBe(
      'qwen-max(qwen-oauth)',
    );
  });

  it('handles colon-bearing model IDs — splits on first colon only', () => {
    expect(decodeVisionModelForPicker('openai:gpt-4o:online')).toBe(
      'gpt-4o:online(openai)',
    );
  });

  it('passes through values without a colon', () => {
    expect(decodeVisionModelForPicker('plain-model')).toBe('plain-model');
  });

  it('passes through ACP-formatted values unchanged', () => {
    expect(decodeVisionModelForPicker('qwen-max(qwen-oauth)')).toBe(
      'qwen-max(qwen-oauth)',
    );
  });

  it('passes through empty string unchanged', () => {
    expect(decodeVisionModelForPicker('')).toBe('');
  });
});

describe('round-trip: encode then decode', () => {
  it('preserves the original ACP format', () => {
    const original = 'qwen-vl-max(qwen-oauth)';
    const encoded = encodeVisionModelForSetting(original);
    const decoded = decodeVisionModelForPicker(encoded);
    expect(decoded).toBe(original);
  });

  it('preserves colon-bearing IDs after round-trip', () => {
    const original = 'gpt-4o:new-model(openai)';
    const encoded = encodeVisionModelForSetting(original);
    const decoded = decodeVisionModelForPicker(encoded);
    expect(decoded).toBe(original);
  });
});
