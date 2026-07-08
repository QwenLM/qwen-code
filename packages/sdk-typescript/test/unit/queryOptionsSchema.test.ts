/**
 * Unit tests for queryOptionsSchema validation
 */

import { describe, expect, it } from 'vitest';
import { QueryOptionsSchema } from '../../src/types/queryOptionsSchema.js';

describe('QueryOptionsSchema', () => {
  it('accepts empty options', () => {
    const result = QueryOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts fallbackModel with up to 3 models', () => {
    const result = QueryOptionsSchema.safeParse({
      fallbackModel: ['a', 'b', 'c'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects fallbackModel with more than 3 models', () => {
    const result = QueryOptionsSchema.safeParse({
      fallbackModel: ['a', 'b', 'c', 'd'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty proxy string', () => {
    const result = QueryOptionsSchema.safeParse({ proxy: '   ' });
    expect(result.success).toBe(false);
  });

  it('accepts extraArgs with non-reserved flags', () => {
    const result = QueryOptionsSchema.safeParse({
      extraArgs: ['--verbose', '--some-flag'],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    '--input-format',
    '--output-format',
    '--channel',
    '--model',
    '--auth-type',
    '--approval-mode',
    '--yolo',
    '-y',
    '--insecure',
    '--allowed-tools',
    '--exclude-tools',
    '--resume',
    '--session-id',
    '--proxy',
    '--openai-base-url',
    '--mcp-config',
    '--prompt',
    '--add-dir',
  ])('rejects extraArgs containing reserved flag %s', (flag) => {
    const result = QueryOptionsSchema.safeParse({ extraArgs: [flag] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('reserved flag');
    }
  });

  it('accepts all new option fields together', () => {
    const result = QueryOptionsSchema.safeParse({
      forkSession: true,
      maxToolCalls: 10,
      maxSubagentDepth: 3,
      includeDirectories: ['/tmp/a'],
      extraArgs: ['--verbose'],
      extensions: ['ext1'],
      allowedMcpServerNames: ['server1'],
      fallbackModel: ['model-a'],
      proxy: 'http://localhost:8080',
      sandbox: true,
      safeMode: true,
      insecure: false,
      worktree: false,
      disabledSlashCommands: ['cmd1'],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    '--model=qwen-max',
    '--auth-type=openai',
    '--approval-mode=yolo',
    '--insecure=true',
    '--proxy=http://localhost:8080',
  ])('rejects extraArgs with --flag=value syntax: %s', (flag) => {
    const result = QueryOptionsSchema.safeParse({ extraArgs: [flag] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('reserved flag');
    }
  });

  it.each([
    '--yolo',
    '-y',
    '--openai-base-url',
    '--openai-api-key',
    '--mcp-config',
    '--prompt',
    '--add-dir',
    '--input-file',
  ])('rejects extraArgs with new dangerous flags: %s', (flag) => {
    const result = QueryOptionsSchema.safeParse({ extraArgs: [flag] });
    expect(result.success).toBe(false);
  });

  it('rejects maxToolCalls less than -1', () => {
    const result = QueryOptionsSchema.safeParse({ maxToolCalls: -2 });
    expect(result.success).toBe(false);
  });

  it('accepts maxToolCalls of -1 (unlimited)', () => {
    const result = QueryOptionsSchema.safeParse({ maxToolCalls: -1 });
    expect(result.success).toBe(true);
  });

  it('rejects agents with empty string values', () => {
    const result = QueryOptionsSchema.safeParse({
      agents: [{ name: '', description: 'test', systemPrompt: 'test' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys due to strict mode', () => {
    const result = QueryOptionsSchema.safeParse({ unknownField: true });
    expect(result.success).toBe(false);
  });
});
