/**
 * Tests for Qwen model utilities in config/models.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_MODEL,
  QWEN_MODELS,
  getModelShortName,
  getModelDisplayName,
  getModelContextWindow,
  getModelProvider,
  isQwenModel,
} from '../src/config/models.ts';

describe('Qwen model registry', () => {
  it('uses qwen3-coder as the fallback model', () => {
    expect(DEFAULT_MODEL).toBe('qwen3-coder');
    expect(QWEN_MODELS.map(model => model.id)).toContain('qwen3-coder');
  });

  it('detects Qwen model IDs', () => {
    expect(isQwenModel('qwen3-coder')).toBe(true);
    expect(isQwenModel('QWEN_MAX')).toBe(true);
    expect(isQwenModel('gpt-4o')).toBe(false);
  });

  it('resolves provider metadata for Qwen models', () => {
    expect(getModelProvider('qwen3-coder')).toBe('qwen');
    expect(getModelProvider('qwen-max')).toBe('qwen');
    expect(getModelProvider('gpt-4o')).toBeUndefined();
  });

  it('formats Qwen model names', () => {
    expect(getModelShortName('qwen3-coder')).toBe('Qwen');
    expect(getModelDisplayName('qwen-max')).toBe('Qwen max');
    expect(getModelContextWindow('qwen3-coder')).toBe(1_000_000);
  });
});
