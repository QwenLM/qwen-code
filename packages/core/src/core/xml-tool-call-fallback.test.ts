/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { Lexer } from 'marked';

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

describe('complete taught-dialect recovery (#10692)', () => {
  const functionBlock =
    '<function=read_file><parameter=file_path>a.ts</parameter></function>';

  it.each([functionBlock, `<tool_call>${functionBlock}</tool_call>`])(
    'recovers a complete function block: %s',
    (text) => {
      expect(containsXmlToolCalls(text)).toBe(true);
      const result = tryRecoverXmlToolCalls(text);
      expect(result.recovered).toBe(true);
      expect(result.functionCallParts).toEqual([
        {
          functionCall: {
            id: expect.any(String),
            name: 'read_file',
            args: { file_path: 'a.ts' },
          },
        },
      ]);
      expect(result.remainingText).toBe('');
    },
  );

  it('preserves explicit examples while recovering a following real call', () => {
    const documentation = `<example>model:\n${functionBlock}</example>`;
    expect(tryRecoverXmlToolCalls(documentation)).toEqual({
      recovered: false,
      functionCallParts: [],
      remainingText: documentation,
    });
    const result = tryRecoverXmlToolCalls(`${documentation}\n${functionBlock}`);
    expect(result.functionCallParts).toHaveLength(1);
    expect(result.functionCallParts[0]?.functionCall?.name).toBe('read_file');
    expect(result.remainingText).toBe(documentation);
  });

  it.each([
    functionBlock,
    '<invoke name="read_file"><parameter name="file_path">a.ts</parameter></invoke>',
  ])('ignores an inline-code example mention before %s', (call) => {
    const prose = 'See the `<example>` format.';
    const result = tryRecoverXmlToolCalls(`${prose}\n${call}`);
    expect(result.functionCallParts).toHaveLength(1);
    expect(result.functionCallParts[0]?.functionCall?.name).toBe('read_file');
    expect(result.remainingText).toBe(prose);
  });

  it('keeps a genuinely unclosed example inert', () => {
    const documentation = `<example>model:\n${functionBlock}`;
    expect(tryRecoverXmlToolCalls(documentation)).toEqual({
      recovered: false,
      functionCallParts: [],
      remainingText: documentation,
    });
  });

  it('keeps parameter backticks from masking a later example opener', () => {
    const write =
      '<function=write_file><parameter=file_path>a.ts</parameter>' +
      '<parameter=content>`</parameter></function>';
    const documentation = `<example>model:\n${functionBlock}\nclosing \`</example>`;
    const result = tryRecoverXmlToolCalls(`${write}\n${documentation}`);
    expect(result.functionCallParts).toHaveLength(1);
    expect(result.functionCallParts[0]?.functionCall?.name).toBe('write_file');
    expect(result.functionCallParts[0]?.functionCall?.args).toEqual({
      file_path: 'a.ts',
      content: '`',
    });
    expect(result.remainingText).toBe(documentation);
  });

  it.each([
    ['<example id="one > two">', '</example>'],
    ['<example >', '</example >'],
  ])('preserves example attributes and whitespace: %s', (open, close) => {
    const documentation = `${open}${functionBlock}${close}`;
    const result = tryRecoverXmlToolCalls(`${documentation}\n${functionBlock}`);
    expect(result.functionCallParts).toHaveLength(1);
    expect(result.remainingText).toBe(documentation);
  });

  it('ignores a literal example opener in fenced documentation', () => {
    const documentation = '```xml\n<example>\n```';
    const result = tryRecoverXmlToolCalls(`${documentation}\n${functionBlock}`);
    expect(result.functionCallParts).toHaveLength(1);
    expect(result.remainingText).toBe(documentation);
  });

  it('keeps example tags in parameter data from hiding a following real call', () => {
    const write =
      '<function=write_file><parameter=file_path>a.ts</parameter>' +
      '<parameter=content><example>literal data</parameter></function>';
    expect(
      extractXmlToolCalls(`${write}\n${functionBlock}`).map(
        (call) => call.name,
      ),
    ).toEqual(['write_file', 'read_file']);
  });

  it('preserves parameter values, JSON structure and null-prototype args', () => {
    const calls = extractXmlToolCalls(
      '<function=write_file>' +
        '<parameter=file_path>null</parameter>' +
        '<parameter=content>\n    a &lt; b &amp;&amp; c\n</parameter>' +
        '<parameter=options>{"x":[1,2]}</parameter>' +
        '<parameter=__proto__>value</parameter>' +
        '</function>',
    );
    expect(calls).toEqual([
      {
        name: 'write_file',
        args: {
          file_path: 'null',
          content: '    a < b && c',
          options: { x: [1, 2] },
          ['__proto__']: 'value',
        },
      },
    ]);
    expect(Object.getPrototypeOf(calls[0]!.args)).toBeNull();
  });

  it('recovers mixed dialects while retaining fenced and parameterless blocks', () => {
    const documented = `\`\`\`xml\n${functionBlock}\n\`\`\``;
    const parameterless = '<function=no_params></function>';
    const text =
      `<tool_call>${functionBlock}</tool_call>\n` +
      invoke('run_shell_command', param('command', 'pwd')) +
      `\n${documented}\n${parameterless}`;
    const result = tryRecoverXmlToolCalls(text);
    expect(
      result.functionCallParts.map((part) => part.functionCall?.name),
    ).toEqual(['read_file', 'run_shell_command']);
    expect(result.remainingText).toBe(`${documented}\n${parameterless}`);
  });

  it.each([
    [
      invoke('read_file', param('file_path', 'a.ts')),
      '<tool_call></tool_call>',
    ],
    [`<tool_call>${functionBlock}</tool_call>`, '<tool_call></tool_call>'],
    [
      invoke('read_file', param('file_path', 'a.ts')),
      '```xml\n<tool_call></tool_call>\n```',
    ],
    [functionBlock, '```xml\n<tool_call> \n</tool_call>\n```'],
  ])(
    'preserves an originally empty envelope after %s',
    (call, documentation) => {
      const result = tryRecoverXmlToolCalls(`${call}\n${documentation}`);
      expect(result.recovered).toBe(true);
      expect(result.functionCallParts).toHaveLength(1);
      expect(result.remainingText).toBe(documentation);
    },
  );

  it('keeps parameter fences from hiding a later function block', () => {
    const text =
      '<function=edit><parameter=old_string>\n```\n</parameter></function>\n' +
      functionBlock;
    expect(extractXmlToolCalls(text).map((call) => call.name)).toEqual([
      'edit',
      'read_file',
    ]);
  });

  it.each([
    'The shell format is <function=run_shell_command> with a command:\n' +
      '```xml\n<parameter=command>echo example</parameter></function>\n```',
    '<function=run_shell_command>\n```xml\n' +
      '<parameter=command>echo example</parameter>\n```\n</function>',
  ])('does not join a prose opener to fenced parameters: %s', (text) => {
    expect(tryRecoverXmlToolCalls(text)).toEqual({
      recovered: false,
      functionCallParts: [],
      remainingText: text,
    });
  });

  it.each([
    '<function=run_shell_command>\n```xml\n' + functionBlock + '\n```',
    '<tool_call><function=write_file>' +
      '<parameter=file_path>a.ts</parameter>' +
      '<parameter=content>before</function>after</parameter></function></tool_call>',
  ])(
    'preserves malformed blocks instead of dispatching partial calls: %s',
    (text) => {
      expect(tryRecoverXmlToolCalls(text)).toEqual({
        recovered: false,
        functionCallParts: [],
        remainingText: text,
      });
    },
  );

  it('recovers the intact call after an envelope whose block never closed', () => {
    // The first envelope never closes its function block, so nothing may be
    // dispatched from it — but the rescan still finds the intact second call,
    // and the malformed envelope stays visible in remainingText.
    const tcOpen = '<' + 'tool_call>';
    const tcClose = '</' + 'tool_call>';
    const fnOpen = '<' + 'function=';
    const fnClose = '</' + 'function>';
    const truncated = [
      tcOpen,
      fnOpen,
      'read_file>',
      PARAM_OPEN,
      '=file_path>a.ts',
      PARAM_CLOSE,
      tcClose,
    ].join('');
    const intact = [
      tcOpen,
      fnOpen,
      'run_shell_command>',
      PARAM_OPEN,
      '=command>pwd',
      PARAM_CLOSE,
      fnClose,
      tcClose,
    ].join('');
    const text = truncated + intact;
    const result = tryRecoverXmlToolCalls(text);
    expect(
      result.functionCallParts.map((part) => part.functionCall?.name),
    ).toEqual(['run_shell_command']);
    expect(result.functionCallParts[0]?.functionCall?.args).toEqual({
      command: 'pwd',
    });
    expect(result.remainingText).toBe(truncated);
  });

  it('preserves a parameterless block whose name contains parameter syntax', () => {
    const parameterless = "<invoke name='<parameter=x>y</parameter>'></invoke>";
    const result = tryRecoverXmlToolCalls(`${functionBlock}\n${parameterless}`);
    expect(result.functionCallParts).toHaveLength(1);
    expect(result.remainingText).toBe(parameterless);
  });

  it.each([
    `\`\`\`xml\n${functionBlock}\n\`\`\``,
    `${'Explanation. '.repeat(80)}${functionBlock}`,
    '<function=read_file><parameter=file_path>a.ts</parameter>',
    '<function=read_file><parameter=file_path>a.ts</function>',
    '<invoke name="read_file"><parameter=file_path>a.ts</parameter></function>',
  ])(
    'does not recover documentation or incomplete/mismatched blocks: %s',
    (text) => {
      expect(tryRecoverXmlToolCalls(text)).toEqual({
        recovered: false,
        functionCallParts: [],
        remainingText: text,
      });
    },
  );
});

describe('borrowed closers, lexer cost and rejected-block masking', () => {
  const FN_CLOSE = '</' + 'function>';
  const TC_OPEN = '<' + 'tool_call>';
  const TC_CLOSE = '</' + 'tool_call>';
  const EXAMPLE_CLOSE = '</' + 'example>';
  const readBlock = [
    '<function=read_file>',
    PARAM_OPEN,
    '=file_path>b.ts',
    PARAM_CLOSE,
    FN_CLOSE,
  ].join('');

  it('does not dispatch a truncated block that borrows the next call closers', () => {
    const text = [
      TC_OPEN,
      '\n<function=write_file>\n',
      PARAM_OPEN,
      '=file_path>a.txt',
      PARAM_CLOSE,
      '\n',
      PARAM_OPEN,
      '=content>hello\n',
      TC_OPEN,
      '\n<function=run_shell_command>',
      PARAM_OPEN,
      '=command>pwd',
      PARAM_CLOSE,
      FN_CLOSE,
      '\n',
      TC_CLOSE,
    ].join('');
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(
      result.functionCallParts.map((part) => part.functionCall?.name),
    ).toEqual(['run_shell_command']);
    expect(result.functionCallParts[0]?.functionCall?.args).toEqual({
      command: 'pwd',
    });
    // The truncated block stays visible instead of being dispatched with the
    // next call's markup as its content.
    expect(result.remainingText).toContain('hello');
    expect(result.remainingText).not.toContain(FN_CLOSE);
  });

  it('leaves a truncated block inert when no donor close follows', () => {
    const fnOpen = '<' + 'function=';
    const text = [
      fnOpen,
      'write_file>',
      PARAM_OPEN,
      '=file_path>a.txt',
      PARAM_CLOSE,
      PARAM_OPEN,
      '=content>hello',
    ].join('');
    expect(tryRecoverXmlToolCalls(text)).toEqual({
      recovered: false,
      functionCallParts: [],
      remainingText: text,
    });
  });

  it('recovers a value that mentions the parameter syntax literally', () => {
    // A value documenting this dialect — a write_file whose content shows the
    // tag shape — nests an open tag inside an accepted match's value. That is
    // the same geometry as a borrowed closer, but no later call was swallowed,
    // so the block is intact and its call must still run.
    const write = invoke(
      'write_file',
      param('file_path', 'a.txt') +
        param(
          'content',
          `Each argument is wrapped in ${PARAM_OPEN} name="x"> tags.`,
        ),
    );
    expect(extractXmlToolCalls(write)).toEqual([
      {
        name: 'write_file',
        args: {
          file_path: 'a.txt',
          content: `Each argument is wrapped in ${PARAM_OPEN} name="x"> tags.`,
        },
      },
    ]);
  });

  it('does not run the markdown lexer when the text has no example tag', () => {
    const spy = vi.spyOn(Lexer, 'lexInline');
    try {
      // Unterminated link openers are the super-linear case for marked's
      // inline lexer; with no example tag in the text none of it may run.
      const text = '[a]('.repeat(50) + '\n' + readBlock;
      const result = tryRecoverXmlToolCalls(text);
      expect(
        result.functionCallParts.map((part) => part.functionCall?.name),
      ).toEqual(['read_file']);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('still runs the markdown lexer when an example tag is present', () => {
    const spy = vi.spyOn(Lexer, 'lexInline');
    try {
      const documentation = '<example>model:\n' + readBlock + EXAMPLE_CLOSE;
      expect(tryRecoverXmlToolCalls(documentation).recovered).toBe(false);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('skips the lexer past the length cap while still honouring examples', () => {
    // The cap is what bounds marked's quadratic inline lexer, so past it the
    // lexer must not run at all — and the regex-only fallback must still keep
    // a documented call from being dispatched. Both halves are pinned on
    // behaviour rather than elapsed time, which is flaky in CI.
    const spy = vi.spyOn(Lexer, 'lexInline');
    try {
      const overCap =
        '<example>model:\n' +
        '*a '.repeat(2000) +
        'x'.repeat(64 * 1024) +
        readBlock +
        EXAMPLE_CLOSE;
      expect(overCap.length).toBeGreaterThan(64 * 1024);
      expect(tryRecoverXmlToolCalls(overCap).recovered).toBe(false);
      expect(spy).not.toHaveBeenCalled();

      const underCap = '<example>model:\n' + readBlock + EXAMPLE_CLOSE;
      expect(underCap.length).toBeLessThanOrEqual(64 * 1024);
      expect(tryRecoverXmlToolCalls(underCap).recovered).toBe(false);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves examples when nested emphasis overflows the markdown lexer', () => {
    const prose = '*'.repeat(4096) + 'nested emphasis' + '*'.repeat(4096);
    const documentedCall = invoke(
      'write_file',
      param('file_path', 'example.txt') + param('content', 'x'.repeat(3000)),
    );
    const documentation = '<example>model:\n' + documentedCall + EXAMPLE_CLOSE;
    const text = prose + '\n' + documentation + '\n' + readBlock;
    expect(text.length).toBeLessThan(64 * 1024);

    const result = tryRecoverXmlToolCalls(text);
    expect(
      result.functionCallParts.map((part) => part.functionCall?.name),
    ).toEqual(['read_file']);
    expect(result.functionCallParts[0]?.functionCall?.args).toEqual({
      file_path: 'b.ts',
    });
    expect(result.remainingText).toContain(documentation);
  });

  it('does not let a rejected block parameter swallow a later valid call', () => {
    // The write_file block is rejected — its content parameter never closes
    // and borrows the function close tag — yet its parameter data must still
    // be masked out of the prose the example scan reads. Unclosed, that
    // literal example opener would swallow everything to the end of the text.
    const fnOpen = '<' + 'function=';
    const rejected = [
      fnOpen,
      'write_file>',
      PARAM_OPEN,
      '=file_path>a.txt',
      PARAM_CLOSE,
      PARAM_OPEN,
      '=content><example>note',
      FN_CLOSE,
      'tail',
      PARAM_CLOSE,
      FN_CLOSE,
    ].join('');
    const text = rejected + '\n' + readBlock;
    const result = tryRecoverXmlToolCalls(text);
    expect(
      result.functionCallParts.map((part) => part.functionCall?.name),
    ).toEqual(['read_file']);
    expect(result.remainingText).toContain('<example>note');
  });

  it('does not dispatch a complete call embedded in a rejected block name', () => {
    // The invoke name pattern admits `>`, so this block's open tag ends after
    // the quoted name, not at the first `>` in it. Deriving the rescan offset
    // from that first `>` restarted the scan inside the name attribute, where
    // it matched the complete call below and dispatched it out of a block the
    // guard had already rejected — leaving corrupted `a>btail` markup behind.
    const fnOpen = '<' + 'function=';
    const embedded = [
      fnOpen,
      'run>',
      PARAM_OPEN,
      '=cmd>ls',
      PARAM_CLOSE,
      FN_CLOSE,
    ].join('');
    const text = [
      OPEN,
      ' name="a>b',
      embedded,
      '">',
      'tail',
      PARAM_OPEN,
      '=x>',
      CLOSE,
    ].join('');
    expect(tryRecoverXmlToolCalls(text)).toEqual({
      recovered: false,
      functionCallParts: [],
      remainingText: text,
    });
  });

  it('does not dispatch a call quoted inside a parameter value', () => {
    // A write_file whose content documents this dialect with an unfenced
    // example call. The outer block is rejected by its own guard — the lazy
    // body ends at the quoted block's closer — and the rescan then matched
    // that quoted call on its own merits and ran it, while the write the user
    // asked for stayed behind as prose. Markup a value quotes is that value's
    // own text, so it must stay data. See #13492.
    const quoted = invoke(
      'run_shell_command',
      param('command', 'rm -rf /tmp/x'),
    );
    const text = invoke(
      'write_file',
      param('file_path', 'doc.md') + param('content', `Usage:\n${quoted}\n`),
    );
    expect(extractXmlToolCalls(text)).toEqual([]);
    expect(tryRecoverXmlToolCalls(text)).toEqual({
      recovered: false,
      functionCallParts: [],
      remainingText: text,
    });
  });

  it('still dispatches a real call that follows a value quoting one', () => {
    // The skip is scoped to the value that owns the quoted markup: a sibling
    // call outside it is a real call and must still run.
    const quoted = invoke(
      'run_shell_command',
      param('command', 'rm -rf /tmp/x'),
    );
    const documented = invoke(
      'write_file',
      param('content', `Usage:\n${quoted}\n`),
    );
    const text = documented + '\n' + invoke('read_file', param('p', 'b.ts'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'read_file', args: { p: 'b.ts' } },
    ]);
  });
});
