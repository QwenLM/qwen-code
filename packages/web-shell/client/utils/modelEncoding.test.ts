import { describe, expect, it } from 'vitest';
import {
  encodeVisionModelForSetting,
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

  it('passes through already-encoded colon format unchanged', () => {
    // If someone somehow passes an already-encoded authType:modelId,
    // it should be left alone — not double-encoded.
    expect(encodeVisionModelForSetting('qwen-oauth:qwen-vl-max')).toBe(
      'qwen-oauth:qwen-vl-max',
    );
  });

  it('passes through malformed — bare authType only', () => {
    // '(authType)' has no modelId before the parens and no text
    // before the opening paren that can serve as group 1, so the
    // regex won't match and we get the input back unchanged.
    expect(encodeVisionModelForSetting('(authType)')).toBe('(authType)');
  });

  it('passes through malformed — unclosed paren', () => {
    expect(encodeVisionModelForSetting('modelId(')).toBe('modelId(');
  });

  it('passes through malformed — double-parens inside', () => {
    expect(encodeVisionModelForSetting('a((b))')).toBe('a((b))');
  });

  it('passes through empty string unchanged', () => {
    expect(encodeVisionModelForSetting('')).toBe('');
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

  it('passes through leading-colon malformed input', () => {
    // colonIdx === 0, which is not > 0, so passthrough
    expect(decodeVisionModelForPicker(':modelId')).toBe(':modelId');
  });

  it('strips \\0baseUrl suffix before decoding', () => {
    expect(
      decodeVisionModelForPicker(
        'qwen-oauth:qwen-vl-max\0https://api.example.com',
      ),
    ).toBe('qwen-vl-max(qwen-oauth)');
  });

  it('handles colon-bearing ID with \\0baseUrl suffix', () => {
    expect(
      decodeVisionModelForPicker(
        'openai:gpt-4o:online\0https://api.openai.com',
      ),
    ).toBe('gpt-4o:online(openai)');
  });

  it('passes through bare ID with \\0baseUrl suffix but no colon', () => {
    expect(
      decodeVisionModelForPicker('plain-model\0https://api.example.com'),
    ).toBe('plain-model');
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
