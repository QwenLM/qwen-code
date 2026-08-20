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
    '-o',
    '--channel',
    '--model',
    '-m',
    '--auth-type',
    '--approval-mode',
    '--yolo',
    '-y',
    '--insecure',
    '--allowed-tools',
    '--exclude-tools',
    '--resume',
    '-r',
    '--continue',
    '-c',
    '--session-id',
    '--proxy',
    '--openai-base-url',
    '--mcp-config',
    '--prompt',
    '-p',
    '--prompt-interactive',
    '-i',
    '--add-dir',
    '--extensions',
    '-e',
    '--sandbox',
    '-s',
    '--no-sandbox',
    '--no-insecure',
    '--no-safe-mode',
    '--sandbox-image',
    '--fork-session',
    '--max-tool-calls',
    '--max-subagent-depth',
    '--max-session-turns',
    '--system-prompt',
    '--append-system-prompt',
    '--include-directories',
    '--allowed-mcp-server-names',
    '--disabled-slash-commands',
    '--include-partial-messages',
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
      resume: 'session-123',
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

  it('rejects forkSession without resume or continue', () => {
    const result = QueryOptionsSchema.safeParse({ forkSession: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        'forkSession requires resume or continue',
      );
    }
  });

  it('accepts forkSession with continue', () => {
    const result = QueryOptionsSchema.safeParse({
      forkSession: true,
      continue: true,
    });
    expect(result.success).toBe(true);
  });

  it.each([
    'includeDirectories',
    'extensions',
    'allowedMcpServerNames',
    'fallbackModel',
    'disabledSlashCommands',
  ])('rejects %s items containing commas', (field) => {
    const result = QueryOptionsSchema.safeParse({
      [field]: ['valid', 'invalid,comma'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxSubagentDepth of 0', () => {
    const result = QueryOptionsSchema.safeParse({ maxSubagentDepth: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects maxSubagentDepth of 101', () => {
    const result = QueryOptionsSchema.safeParse({ maxSubagentDepth: 101 });
    expect(result.success).toBe(false);
  });

  it('accepts maxSubagentDepth boundary values 1 and 100', () => {
    expect(QueryOptionsSchema.safeParse({ maxSubagentDepth: 1 }).success).toBe(
      true,
    );
    expect(
      QueryOptionsSchema.safeParse({ maxSubagentDepth: 100 }).success,
    ).toBe(true);
  });

  it('accepts continue field', () => {
    const result = QueryOptionsSchema.safeParse({ continue: true });
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

  it('rejects fractional maxSessionTurns', () => {
    const value = 0.5;
    const result = QueryOptionsSchema.safeParse({ maxSessionTurns: value });
    expect(result.success).toBe(false);
  });

  it('preserves negative maxSessionTurns values', () => {
    const result = QueryOptionsSchema.safeParse({ maxSessionTurns: -42 });
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
