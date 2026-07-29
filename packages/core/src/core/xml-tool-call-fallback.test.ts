/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

const OPEN = '<' + 'invoke';
const CLOSE = '</' + 'invoke>';
const PARAM_OPEN = '<' + 'parameter';
const PARAM_CLOSE = '</' + 'parameter>';

function invoke(name: string, params: string): string {
  return `${OPEN} name="${name}">${params}${CLOSE}`;
}

function param(name: string, value: string): string {
  return `${PARAM_OPEN} name="${name}">${value}${PARAM_CLOSE}`;
}

// Imported after the mocks above are registered.
import {
  containsXmlToolCalls,
  extractXmlToolCalls,
  tryRecoverXmlToolCalls,
} from './xml-tool-call-fallback.js';

describe('containsXmlToolCalls', () => {
  it('detects an invoke block', () => {
    expect(containsXmlToolCalls(invoke('read_file', param('p', 'v')))).toBe(
      true,
    );
  });

  it('returns false for plain text', () => {
    expect(containsXmlToolCalls('just some text')).toBe(false);
  });

  it('is stable across repeated calls (no lastIndex leak)', () => {
    const text = invoke('read_file', param('p', 'v'));
    expect(containsXmlToolCalls(text)).toBe(true);
    expect(containsXmlToolCalls(text)).toBe(true);
    expect(containsXmlToolCalls(text)).toBe(true);
  });
});

describe('extractXmlToolCalls', () => {
  it('extracts a single tool call', () => {
    const text = invoke('read_file', param('file_path', 'a.ts'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'read_file', args: { file_path: 'a.ts' } },
    ]);
  });

  it('extracts multiple tool calls', () => {
    const text =
      invoke('read_file', param('file_path', 'a.ts')) +
      '\n' +
      invoke('run_shell_command', param('command', 'ls'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'read_file', args: { file_path: 'a.ts' } },
      { name: 'run_shell_command', args: { command: 'ls' } },
    ]);
  });

  it('extracts multiple parameters for one call', () => {
    const text = invoke(
      'edit',
      param('file_path', 'a.ts') + param('old_string', 'x'),
    );
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'edit', args: { file_path: 'a.ts', old_string: 'x' } },
    ]);
  });

  it('skips invoke blocks without parameters (conservative)', () => {
    const text = invoke('no_params', 'some body but no parameters');
    expect(extractXmlToolCalls(text)).toEqual([]);
  });

  it('restores structured JSON parameter values', () => {
    const text = invoke(
      'tool',
      param('count', '3') +
        param('flag', 'true') +
        param('opts', '{"a": 1}') +
        param('list', '[1, 2]') +
        param('plain', 'hello world'),
    );
    expect(extractXmlToolCalls(text)).toEqual([
      {
        name: 'tool',
        args: {
          count: 3,
          flag: true,
          opts: { a: 1 },
          list: [1, 2],
          plain: 'hello world',
        },
      },
    ]);
  });

  it('does not crash on malformed or nested XML', () => {
    expect(extractXmlToolCalls('<invoke name="x"><invoke')).toEqual([]);
    expect(extractXmlToolCalls('</invoke><invoke>')).toEqual([]);
    expect(
      extractXmlToolCalls(invoke('outer', invoke('inner', param('p', 'v')))),
    ).toBeInstanceOf(Array);
  });

  it('returns consistent results across repeated calls (no lastIndex leak)', () => {
    const text = invoke('read_file', param('p', 'v'));
    const first = extractXmlToolCalls(text);
    const second = extractXmlToolCalls(text);
    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });
});

describe('tryRecoverXmlToolCalls', () => {
  it('reports no recovery when there are no tool calls', () => {
    const result = tryRecoverXmlToolCalls('plain text only');
    expect(result.recovered).toBe(false);
    expect(result.functionCallParts).toEqual([]);
    expect(result.remainingText).toBe('plain text only');
  });

  it('recovers functionCall parts from XML content', () => {
    const result = tryRecoverXmlToolCalls(
      invoke('read_file', param('file_path', 'a.ts')),
    );
    expect(result.recovered).toBe(true);
    expect(result.functionCallParts).toHaveLength(1);
    const call = result.functionCallParts[0]?.functionCall;
    expect(call?.name).toBe('read_file');
    expect(call?.args).toEqual({ file_path: 'a.ts' });
    expect(call?.id).toMatch(/^xml-recovered-/);
  });

  it('preserves surrounding non-XML text in remainingText', () => {
    const text =
      'Let me check that file for you.\n' +
      invoke('read_file', param('file_path', 'a.ts')) +
      '\nLet me know if you need more.';
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(result.remainingText).toBe(
      'Let me check that file for you.\n\nLet me know if you need more.',
    );
  });

  it('returns empty remainingText when the content is only XML', () => {
    const result = tryRecoverXmlToolCalls(
      invoke('read_file', param('file_path', 'a.ts')),
    );
    expect(result.recovered).toBe(true);
    expect(result.remainingText).toBe('');
  });
});
