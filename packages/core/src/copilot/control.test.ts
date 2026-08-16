// packages/core/src/copilot/control.test.ts
import { describe, it, expect } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';

describe('CONTROL: existing auth unaffected', () => {
  it('AuthType.USE_OPENAI still exists', () => {
    expect(AuthType.USE_OPENAI).toBe('openai');
  });
  it('AuthType.USE_ANTHROPIC still exists', () => {
    expect(AuthType.USE_ANTHROPIC).toBe('anthropic');
  });
  it('AuthType.QWEN_OAUTH still exists', () => {
    expect(AuthType.QWEN_OAUTH).toBe('qwen-oauth');
  });
  it('AuthType.USE_GEMINI still exists', () => {
    expect(AuthType.USE_GEMINI).toBe('gemini');
  });
  it('AuthType.USE_COPILOT exists', () => {
    expect(AuthType.USE_COPILOT).toBe('copilot');
  });
});

describe('CONTROL: sentinel constant', () => {
  it('COPILOT_SENTINEL_BASE_URL is the expected invariant', async () => {
    const { COPILOT_SENTINEL_BASE_URL } = await import('./copilot-fetch.js');
    expect(COPILOT_SENTINEL_BASE_URL).toBe(
      'https://copilot-endpoint-rewritten-by-fetch.invalid',
    );
  });
});
