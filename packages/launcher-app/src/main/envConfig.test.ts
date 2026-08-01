import { describe, it, expect } from 'vitest';
import { parseEnv, mergeEnv } from './envConfig.js';

describe('parseEnv', () => {
  it('parses KEY=VALUE lines, ignoring comments/blanks', () => {
    expect(
      parseEnv('# c\nOPENAI_BASE_URL=http://x/v1\n\nOPENAI_MODEL=m\n'),
    ).toEqual({
      OPENAI_BASE_URL: 'http://x/v1',
      OPENAI_MODEL: 'm',
    });
  });
});

describe('mergeEnv', () => {
  it('updates the provider keys and PRESERVES unrelated lines', () => {
    const existing = 'FOO=bar\nOPENAI_BASE_URL=old\n# note\n';
    const out = mergeEnv(existing, {
      OPENAI_BASE_URL: 'http://lovelace:1234/v1',
      OPENAI_API_KEY: 'sk-1',
      OPENAI_MODEL: 'qwen',
    });
    expect(out).toContain('FOO=bar');
    expect(out).toContain('# note');
    expect(out).toContain('OPENAI_BASE_URL=http://lovelace:1234/v1');
    expect(out).toContain('OPENAI_API_KEY=sk-1');
    expect(out).toContain('OPENAI_MODEL=qwen');
    // no duplicate OPENAI_BASE_URL line
    expect(out.match(/^OPENAI_BASE_URL=/gm)?.length).toBe(1);
    expect(out).not.toContain('OPENAI_BASE_URL=old');
  });
});
