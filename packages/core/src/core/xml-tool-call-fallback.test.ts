/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

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

  it('parses structured JSON but preserves scalar strings', () => {
    const text = invoke(
      'tool',
      param('count', '3') +
        param('flag', 'true') +
        param('opts', '{"a": 1}') +
        param('list', '[1, 2]') +
        param('plain', 'hello world') +
        param('nil', 'null'),
    );
    expect(extractXmlToolCalls(text)).toEqual([
      {
        name: 'tool',
        args: {
          count: '3',
          flag: 'true',
          opts: { a: 1 },
          list: [1, 2],
          plain: 'hello world',
          nil: 'null',
        },
      },
    ]);
  });

  it('preserves raw string for malformed JSON values', () => {
    const text = invoke(
      'tool',
      param('data', '{not valid json') + param('ok', 'yes'),
    );
    expect(extractXmlToolCalls(text)).toEqual([
      {
        name: 'tool',
        args: { data: '{not valid json', ok: 'yes' },
      },
    ]);
  });

  it('extracts tool calls with multi-line parameter values (issue #8003 shape)', () => {
    const text = invoke(
      'edit',
      param('file_path', '/some/path/file.tsx') +
        param('old_string', 'line1,\nline2,\nline3,'),
    );
    expect(extractXmlToolCalls(text)).toEqual([
      {
        name: 'edit',
        args: {
          file_path: '/some/path/file.tsx',
          old_string: 'line1,\nline2,\nline3,',
        },
      },
    ]);
  });

  it('strips only delimiting newlines, preserving significant whitespace', () => {
    const text = invoke('edit', param('old_string', '\n    return null;\n'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'edit', args: { old_string: '    return null;' } },
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

  it('is safe against __proto__ parameter names', () => {
    const text = invoke(
      'tool',
      param('__proto__', '{"polluted": true}') + param('safe', 'yes'),
    );
    const result = extractXmlToolCalls(text);
    expect(result).toHaveLength(1);
    const args = result[0]!.args;
    expect(args['safe']).toBe('yes');
    expect(Object.getPrototypeOf(args)).toBeNull();
    expect((args as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('skips invoke blocks inside fenced code blocks', () => {
    const text =
      '```xml\n' +
      invoke('run_shell_command', param('command', 'rm -rf /tmp/x')) +
      '\n```';
    expect(extractXmlToolCalls(text)).toEqual([]);
  });

  it('extracts non-fenced invokes while skipping fenced ones', () => {
    const realCall = invoke('read_file', param('file_path', 'a.ts'));
    const fencedExample =
      '```xml\n' +
      invoke('run_shell_command', param('command', 'echo hello')) +
      '\n```';
    const text = realCall + '\n' + fencedExample;
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'read_file', args: { file_path: 'a.ts' } },
    ]);
  });

  it('skips invokes inside a ~~~ fence that contains ``` lines', () => {
    const text =
      '~~~markdown\n' +
      'Here is an example:\n' +
      '```xml\n' +
      invoke('run_shell_command', param('command', 'echo hello')) +
      '\n```\n' +
      '~~~';
    expect(extractXmlToolCalls(text)).toEqual([]);
  });

  it('treats a shorter same-delimiter fence as content, not a close (CommonMark 4.5)', () => {
    const text =
      '````markdown\n' +
      '```xml\n' +
      invoke('run_shell_command', param('command', 'rm -rf /tmp/x')) +
      '\n```\n' +
      '````';
    expect(extractXmlToolCalls(text)).toEqual([]);
  });

  it('treats a closing fence with an info string as content, not a close (CommonMark 4.5)', () => {
    const text =
      '````markdown\n' +
      '```xml\n' +
      invoke('run_shell_command', param('command', 'rm -rf /tmp/x')) +
      '\n```xml\n' +
      '````';
    expect(extractXmlToolCalls(text)).toEqual([]);
  });

  it('treats a closing fence with trailing text as content, not a close', () => {
    const text =
      '~~~markdown\n' +
      invoke('run_shell_command', param('command', 'echo hi')) +
      '\n~~~ end of examples\n' +
      '~~~';
    expect(extractXmlToolCalls(text)).toEqual([]);
  });

  it('extracts a later invoke when an earlier parameter contains an unclosed fence', () => {
    const editWithFence = invoke(
      'edit',
      param('file_path', 'docs.md') +
        param('old_string', '```ts\nconst x = 1;'),
    );
    const readCall = invoke('read_file', param('file_path', 'a.ts'));
    const text = editWithFence + '\n' + readCall;
    expect(extractXmlToolCalls(text)).toEqual([
      {
        name: 'edit',
        args: { file_path: 'docs.md', old_string: '```ts\nconst x = 1;' },
      },
      { name: 'read_file', args: { file_path: 'a.ts' } },
    ]);
  });

  it('extracts a later invoke when an earlier parameter contains a closed fence pair', () => {
    const editWithFence = invoke('edit', param('old_string', '```\ncode\n```'));
    const readCall = invoke('read_file', param('file_path', 'b.ts'));
    const text = editWithFence + '\n' + readCall;
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'edit', args: { old_string: '```\ncode\n```' } },
      { name: 'read_file', args: { file_path: 'b.ts' } },
    ]);
  });

  it('still skips invokes inside a prose fence when parameters also contain fences', () => {
    const text =
      '```markdown\n' +
      invoke('edit', param('old_string', '```\ninner\n```')) +
      '\n```\n' +
      invoke('read_file', param('file_path', 'c.ts'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'read_file', args: { file_path: 'c.ts' } },
    ]);
  });

  it('decodes XML entities in parameter values', () => {
    const text = invoke(
      'edit',
      param('old_string', 'if (a &lt; b) &amp;&amp; c &gt; d') +
        param('new_string', 'x &apos;y&apos; &quot;z&quot;'),
    );
    expect(extractXmlToolCalls(text)).toEqual([
      {
        name: 'edit',
        args: {
          old_string: 'if (a < b) && c > d',
          new_string: 'x \'y\' "z"',
        },
      },
    ]);
  });

  it('decodes &amp; last so &amp;lt; becomes literal &lt;', () => {
    const text = invoke('tool', param('v', '&amp;lt;'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'tool', args: { v: '&lt;' } },
    ]);
  });

  it('leaves values without entities unchanged', () => {
    const text = invoke('tool', param('v', 'plain text'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'tool', args: { v: 'plain text' } },
    ]);
  });

  it('supports single-quoted attribute values', () => {
    const text =
      "<invoke name='read_file'><parameter name='file_path'>a.ts</parameter></invoke>";
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'read_file', args: { file_path: 'a.ts' } },
    ]);
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

  it('preserves short surrounding text in remainingText', () => {
    const text = 'Sure.\n' + invoke('read_file', param('file_path', 'a.ts'));
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(result.remainingText).toBe('Sure.');
  });

  it('returns empty remainingText when the content is only XML', () => {
    const result = tryRecoverXmlToolCalls(
      invoke('read_file', param('file_path', 'a.ts')),
    );
    expect(result.recovered).toBe(true);
    expect(result.remainingText).toBe('');
  });

  it('does not recover when substantial prose surrounds the XML', () => {
    const prose =
      'Here is how you use the tool. First you open the file, then you read it. ' +
      'The invoke block below shows the format. Remember to always check the path. ' +
      'This is a documentation example for the read_file tool call format. ' +
      'You should never execute these examples directly. They are for illustration ' +
      'purposes only. The actual tool calls are made through the structured API.';
    const text = prose + '\n' + invoke('read_file', param('file_path', 'a.ts'));
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(false);
    expect(result.functionCallParts).toEqual([]);
  });

  it('recovers when reasoning prose precedes the XML (issue #8003 shape)', () => {
    // Reconstructs the shape from #8003: ~1400 chars of model reasoning
    // prose followed by a ~600-byte edit invoke with multi-line params.
    // Prose ratio ≈ 0.70, which must pass the 0.8 guard.
    const reasoning =
      'I need to fix the authentication token validation in the middleware. ' +
      'The current implementation does not check the expiry date, which means ' +
      'expired tokens are still accepted. This is a security vulnerability that ' +
      'could allow unauthorized access. I will update the validateToken function ' +
      'to check the exp claim and reject tokens that have expired. The fix involves ' +
      'adding a date comparison after the signature verification step. I also need ' +
      'to make sure the error message is clear about why the token was rejected. ' +
      'Let me look at the current implementation and make the necessary changes. ' +
      'The file is located in the src/middleware directory. I will use the edit tool ' +
      'to replace the old validation logic with the new one that includes expiry ' +
      'checking. This should be a straightforward change that does not affect other ' +
      'parts of the codebase. The test suite should still pass after this change. ' +
      'I have verified that no other middleware depends on the old behavior. ' +
      'The change is backward compatible because valid tokens will still be accepted.';
    const editBlock = invoke(
      'edit',
      param('file_path', '/project/src/middleware/auth.ts') +
        param(
          'old_string',
          'function validateToken(token: string): boolean {\n' +
            '  const decoded = jwt.verify(token, SECRET);\n' +
            '  return decoded !== null;\n' +
            '}',
        ) +
        param(
          'new_string',
          'function validateToken(token: string): boolean {\n' +
            '  const decoded = jwt.verify(token, SECRET);\n' +
            '  if (!decoded || !decoded.exp) return false;\n' +
            '  return Date.now() < decoded.exp * 1000;\n' +
            '}',
        ),
    );
    const text = reasoning + '\n' + editBlock;
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(result.functionCallParts).toHaveLength(1);
    const call = result.functionCallParts[0]?.functionCall;
    expect(call?.name).toBe('edit');
    expect(call?.args).toHaveProperty('file_path');
    expect(call?.args).toHaveProperty('old_string');
    expect(call?.args).toHaveProperty('new_string');
    expect(result.remainingText).toBe(reasoning);
  });

  it('preserves parameterless invoke blocks as plain text', () => {
    const parameterless = invoke('think', 'Let me reason about this problem');
    const parameterized = invoke('read_file', param('file_path', 'a.ts'));
    const text = parameterized + '\n' + parameterless;
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(result.functionCallParts).toHaveLength(1);
    expect(result.remainingText).toContain(parameterless);
  });

  it('does not recover an invoke example inside a fenced code block', () => {
    const text =
      '```xml\n' +
      invoke('run_shell_command', param('command', 'rm -rf /tmp/x')) +
      '\n```';
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(false);
    expect(result.functionCallParts).toEqual([]);
    expect(result.remainingText).toBe(text);
  });

  it('recovers a real invoke while excluding a fenced example after it', () => {
    const realCall = invoke('read_file', param('file_path', 'a.ts'));
    const fencedExample =
      '```xml\n' +
      invoke('run_shell_command', param('command', 'echo hello')) +
      '\n```';
    const text = realCall + '\n' + fencedExample;
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(result.functionCallParts).toHaveLength(1);
    const call = result.functionCallParts[0]?.functionCall;
    expect(call?.name).toBe('read_file');
    expect(call?.args).toEqual({ file_path: 'a.ts' });
    expect(result.remainingText).toContain('```xml');
    expect(result.remainingText).toContain('echo hello');
  });

  it('does not recover an invoke inside a ~~~ fence containing ``` lines', () => {
    const text =
      '~~~markdown\n' +
      'Example:\n' +
      '```xml\n' +
      invoke('run_shell_command', param('command', 'echo hi')) +
      '\n```\n' +
      '~~~';
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(false);
    expect(result.functionCallParts).toEqual([]);
    expect(result.remainingText).toBe(text);
  });

  it('does not recover an invoke nested in a longer same-delimiter fence', () => {
    const text =
      '````markdown\n' +
      '```xml\n' +
      invoke('run_shell_command', param('command', 'rm -rf /tmp/x')) +
      '\n```\n' +
      '````';
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(false);
    expect(result.functionCallParts).toEqual([]);
    expect(result.remainingText).toBe(text);
  });

  it('does not recover an invoke when the closing fence carries an info string', () => {
    const text =
      '````markdown\n' +
      '```xml\n' +
      invoke('run_shell_command', param('command', 'rm -rf /tmp/x')) +
      '\n```xml\n' +
      '````';
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(false);
    expect(result.functionCallParts).toEqual([]);
    expect(result.remainingText).toBe(text);
  });

  it('does not recover an invoke when the closing fence has trailing text', () => {
    const text =
      '~~~markdown\n' +
      invoke('run_shell_command', param('command', 'echo hi')) +
      '\n~~~ end of examples\n' +
      '~~~';
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(false);
    expect(result.functionCallParts).toEqual([]);
    expect(result.remainingText).toBe(text);
  });

  it('recovers both invokes when the first has a fence-like parameter value', () => {
    const editWithFence = invoke(
      'edit',
      param('old_string', '```\nunclosed fence'),
    );
    const readCall = invoke('read_file', param('file_path', 'a.ts'));
    const text = editWithFence + '\n' + readCall;
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(result.functionCallParts).toHaveLength(2);
    expect(result.functionCallParts[0]?.functionCall?.name).toBe('edit');
    expect(result.functionCallParts[1]?.functionCall?.name).toBe('read_file');
  });

  it('strips an empty function_calls wrapper from remainingText', () => {
    const text =
      '<function_calls>\n' +
      invoke('read_file', param('file_path', 'a.ts')) +
      '\n<' +
      '/function_calls>';
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(result.remainingText).toBe('');
  });
});
