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
    // The quoted call stays data, and the outer call receives the complete
    // content instead of ending at the quoted call's closer. See #13492.
    const quoted = invoke(
      'run_shell_command',
      param('command', 'rm -rf /tmp/x'),
    );
    const text = invoke(
      'write_file',
      param('file_path', 'doc.md') + param('content', `Usage:\n${quoted}\n`),
    );
    const expected = {
      name: 'write_file',
      args: { file_path: 'doc.md', content: `Usage:\n${quoted}` },
    };
    expect(extractXmlToolCalls(text)).toEqual([expected]);
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(result.functionCallParts.map((part) => part.functionCall)).toEqual([
      expect.objectContaining(expected),
    ]);
    expect(result.remainingText).toBe('');
  });

  it('keeps a value-quoted call inert when the rescan steps over it', () => {
    // Fuzz-derived witness for the #13515 guard: on this input the close-tag
    // rescan never lands inside the quoted call, so the `valueSpans` skip is
    // the only thing keeping the documented `rm -rf /tmp/x` inert. Dropping
    // the skip leaves every other test here green. Tidier hand-written shapes
    // (stray opener, bare closer, unclosed trailing parameter, function
    // dialect, fence between parameters) are rejected earlier, pin nothing.
    const text = `<parameter name="content"><invoke name="write_file">    </example></parameter></function>&lt;<invoke name="read_file"><invoke name="run_shell_command"><parameter name="command">rm -rf /tmp/x</parameter></invoke>\n~~~<function=run_shell_command><parameter=command>rm -rf /tmp/x</parameter></function><parameter name="file_path">doc.md</parameter>\`\`\`<invoke name='edit'><invoke name="run_shell_command"><parameter name="command">rm -rf /tmp/x</parameter></invoke>`;
    expect(extractXmlToolCalls(text)).toEqual([]);
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
      { name: 'write_file', args: { content: `Usage:\n${quoted}` } },
      { name: 'read_file', args: { p: 'b.ts' } },
    ]);
  });

  it('keeps a long quoted function value out of the prose and example guards', () => {
    const quoted =
      '<function=read_file><parameter=file_path>example.txt</parameter></function>';
    const content = `${quoted}\n<example>\n\`\`\`xml\n${'data '.repeat(1000)}`;
    const text =
      '<function=write_file><parameter=file_path>doc.md</parameter>' +
      `<parameter=content>${content}</parameter></function>`;
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(result.functionCallParts.map((part) => part.functionCall)).toEqual([
      expect.objectContaining({
        name: 'write_file',
        args: { file_path: 'doc.md', content },
      }),
    ]);
    expect(result.remainingText).toBe('');
  });

  it('recovers a genuine call from a markup-only turn beside a stray opener', () => {
    // A rejected block leaves its opener behind with no closer for the intent
    // guard's pattern to pair, so that markup used to be charged to prose. On a
    // turn made of markup alone — one unclosed invoke opener, well-formed
    // parameter elements and one complete call — the ratio crosses the
    // threshold and the whole turn is refused, dropping the genuine call the
    // extraction had already found. See #13492.
    const text =
      '<invoke name="a">' +
      Array.from({ length: 16 }, (_, index) =>
        param(`p${index}`, `v${index}`),
      ).join(' ') +
      ' ' +
      invoke('read_file', param('file_path', 'a.ts'));
    const result = tryRecoverXmlToolCalls(text);
    expect(result.recovered).toBe(true);
    expect(
      result.functionCallParts.map((part) => part.functionCall?.name),
    ).toEqual(['read_file']);
  });

  it('does not borrow a closer that following prose merely mentions', () => {
    // Stepping out of a quoted value searches the rest of the text, so the
    // advance lands on the closer this prose documents instead of the block's
    // own. Unchecked, it swallowed that prose: the trailing file_path was never
    // parsed, a write_file missing its required path was dispatched, and the
    // block's own markup was reinserted into the visible turn. See #13492.
    const quoted = invoke('read_file', param('file_path', 'x.txt'));
    const text = invoke(
      'write_file',
      param('content', `Usage:\n${quoted}\n`) +
        `\nEscape ${CLOSE} in docs.\n` +
        param('file_path', 'doc.md'),
    );
    expect(extractXmlToolCalls(text)).toEqual([]);
    expect(tryRecoverXmlToolCalls(text)).toEqual({
      recovered: false,
      functionCallParts: [],
      remainingText: text,
    });
  });

  it('does not borrow a function-dialect closer that prose mentions', () => {
    const fnOpen = (name: string) => '<' + 'function=' + name + '>';
    const fnClose = '<' + '/function>';
    const flat = (name: string, value: string) =>
      PARAM_OPEN + '=' + name + '>' + value + PARAM_CLOSE;
    const quoted = fnOpen('read_file') + flat('file_path', 'x.txt') + fnClose;
    const text =
      fnOpen('write_file') +
      flat('content', `Run rm -rf /tmp/x\nWell-formed:\n${quoted}\n`) +
      `\nEscape ${fnClose} in docs.\n` +
      flat('file_path', 'doc.md') +
      fnClose;
    expect(extractXmlToolCalls(text)).toEqual([]);
    expect(tryRecoverXmlToolCalls(text)).toEqual({
      recovered: false,
      functionCallParts: [],
      remainingText: text,
    });
  });

  it('does not swallow prose between a quoted value and a borrowed closer', () => {
    // Same advance with nothing but prose after it: the block must stay whole
    // rather than end at a closer the prose mentions.
    const quoted = invoke('read_file', param('file_path', 'x.txt'));
    const text = invoke(
      'write_file',
      param('content', `Usage:\n${quoted}\n`) + `\nNote: escape ${CLOSE} here.`,
    );
    expect(extractXmlToolCalls(text)).toEqual([]);
    expect(tryRecoverXmlToolCalls(text)).toEqual({
      recovered: false,
      functionCallParts: [],
      remainingText: text,
    });
  });

  it('still recovers a trailing parameter behind a quoted value', () => {
    // Positive control for the advance check above: the legitimate shape is a
    // quoted value followed by the block's own parameter element, so what the
    // advance steps over is that element plus whitespace, not whitespace only.
    const quoted = invoke('read_file', param('file_path', 'x.txt'));
    const text = invoke(
      'write_file',
      param('content', `Usage:\n${quoted}\n`) + param('file_path', 'doc.md'),
    );
    expect(extractXmlToolCalls(text)).toEqual([
      {
        name: 'write_file',
        args: { content: `Usage:\n${quoted}`, file_path: 'doc.md' },
      },
    ]);
    expect(tryRecoverXmlToolCalls(text).remainingText).toBe('');
  });

  it('keeps leading parameters when the name attribute mixes quote characters', () => {
    // TOOL_CALL_PATTERN's name group is `["']([^"']+)["']`, whose delimiters
    // are independent character classes, so a name opened with one quote
    // character and closed with the other matches. Splitting the open tag by
    // scanning enters quote mode on that name, never finds the matching quote
    // and lands inside the block body, so every parameter before the landing
    // point is dropped: the required `content` here never reaches write_file,
    // validation fails, and the block is accepted so nothing is left behind in
    // the turn to explain it.
    const text = `${OPEN} name="write_file'>\n${param('file_path', 'doc.md')}\n${param('content', 'body')}\n${CLOSE}`;
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'write_file', args: { file_path: 'doc.md', content: 'body' } },
    ]);
  });

  it('keeps a single-parameter block whose name mixes quote characters', () => {
    // The same split lands past the block's only parameter, which previously
    // dropped the whole call instead of disabling it.
    const text = `${OPEN} name='read_file'>\n${param('file_path', 'a.ts')}\n${CLOSE}`;
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'read_file', args: { file_path: 'a.ts' } },
    ]);
  });

  it('never dispatches a truncated value when a parameter name mixes quote characters', () => {
    // A parameter name opened with one quote character and closed with the
    // other is admitted by PARAMETER_PATTERN's name group, whose delimiters are
    // likewise independent classes. Classifying such an element as a quoted
    // value rests on an `openTagEnd` scan that leaves quote mode inside the
    // value, so the argument would be sliced from behind its own leading text
    // and a truncated write dispatched with nothing left in the turn to explain
    // it. The element falls back to the flat match instead, whose parameter
    // region still holds the quoted opener, so the block is rejected and the
    // whole turn stays visible. See #13492.
    const quoted = invoke('a', param('p', 'v'));
    const text =
      `${OPEN} name="write_file">` +
      param('file_path', 'doc.md') +
      `<parameter name='content">A' x>${quoted}</parameter>` +
      CLOSE;
    expect(extractXmlToolCalls(text)).toEqual([]);
    expect(tryRecoverXmlToolCalls(text)).toEqual({
      recovered: false,
      functionCallParts: [],
      remainingText: text,
    });
  });

  it('carries the advance past two quoted values in one block', () => {
    // The lazy match ends at the first quoted closer, so a block quoting one
    // call per value needs a second advance step to reach its own closer.
    // Stopping after one step leaves closeStart inside the second value, its
    // element fails the ownership lookup, the trailing closer is read as a
    // rejected block and the whole call is dropped into the visible turn.
    const quoted = invoke('read_file', param('file_path', 'x.txt'));
    const text = invoke(
      'write_file',
      param('content', `Usage:\n${quoted}\n`) +
        param('note', `Also:\n${quoted}\n`),
    );
    expect(extractXmlToolCalls(text)).toEqual([
      {
        name: 'write_file',
        args: { content: `Usage:\n${quoted}`, note: `Also:\n${quoted}` },
      },
    ]);
    expect(tryRecoverXmlToolCalls(text).remainingText).toBe('');
  });

  it('keeps a later call when a quoted value hides an example closer', () => {
    // The mask covers the quoting value wholesale, so the `</example>` that
    // ends the prose construct sits inside it. Masked tags may not open an
    // example, but they must still close one: otherwise the prose-opened range
    // runs to the end of the turn and every real call in it is filtered out.
    const quoted = invoke('b', param('p', 'w'));
    const text =
      '<example>\n' +
      `<invoke name="a"><parameter name="content">${quoted}</example>\n</parameter></invoke>\n` +
      invoke('c', param('q', 'z'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'c', args: { q: 'z' } },
    ]);
  });

  it('does not let a value-borne example closer end a prose-opened example', () => {
    // The complementary half: the masked closer may end the range only as a
    // last resort, since a closer prose writes further on is the boundary.
    // Ending the range at the masked one leaves the documented call between
    // them outside every range, and the prose's own closer then opens a range
    // that filters out the real call after it. See #13492.
    const documented = invoke(
      'run_shell_command',
      param('command', 'rm -rf /tmp/x'),
    );
    const text =
      '<example>\n' +
      invoke(
        'w',
        param(
          'content',
          'Use the example closer tag to end the block</example>\ntail',
        ),
      ) +
      '\n' +
      documented +
      '\n</example>\n' +
      invoke('read_file', param('file_path', 'b.ts'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'read_file', args: { file_path: 'b.ts' } },
    ]);
  });

  it('keeps a later call when a quoted value hides a fence closer', () => {
    // Same asymmetry with a delimiter: a prose-opened fence must still be
    // closed by the delimiter line the mask covers.
    const quoted = invoke('b', param('p', 'w'));
    const text =
      '```\n' +
      '<invoke name="a"><parameter name="content">' +
      quoted +
      '\n```\n</parameter></invoke>\n' +
      invoke('c', param('q', 'z'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'c', args: { q: 'z' } },
    ]);
  });

  it('does not let a value-borne delimiter close a fence prose still closes', () => {
    // The complementary half for a fence, and it fails in both directions:
    // clearing on the masked delimiter ends the fence inside the value, so the
    // documented call between them is dispatched, while the prose's genuine
    // delimiter then opens a fence that swallows the real call after it. The
    // masked line may close only when prose has no delimiter left to do it.
    // See #13492.
    const quoted = invoke('read_file', param('file_path', 'x.txt'));
    const documented = invoke(
      'run_shell_command',
      param('command', 'rm -rf /tmp/x'),
    );
    const text =
      '```\n' +
      invoke('w', param('content', `${quoted}\n\`\`\`\ntail`)) +
      '\n' +
      documented +
      '\n```\n' +
      invoke('read_file', param('file_path', 'b.ts'));
    expect(extractXmlToolCalls(text)).toEqual([
      { name: 'read_file', args: { file_path: 'b.ts' } },
    ]);
  });

  it('masks quoted values out of the lexer prose without changing its length', () => {
    // Example tag positions are reported in prose offsets and looked up again
    // in the raw text, so the mask has to be length-preserving. Appending the
    // quoted-value spans after the flat parameter matches puts them out of text
    // order, which is what the sort plus overlap-compaction undoes. Dropping
    // that normalization flips no end-to-end outcome here: the only tags it
    // mispositions are the ones after the last parameter element, and a region
    // holding no parameter element holds no call for an example range to
    // filter. So the mask length is the assertion that pins it — without the
    // normalization the prose outgrows the text it is read back against, and
    // the lexer cap, which is measured on text.length, stops bounding it.
    const spy = vi.spyOn(Lexer, 'lexInline');
    try {
      const quoted = invoke('read_file', param('file_path', 'x.txt'));
      const text =
        invoke(
          'write_file',
          param('content', `Usage:\n${quoted}\n`) + param('file_path', 'd.md'),
        ) +
        '\n<example>model:\n' +
        readBlock +
        EXAMPLE_CLOSE;
      expect(extractXmlToolCalls(text)).toEqual([
        {
          name: 'write_file',
          args: { content: `Usage:\n${quoted}`, file_path: 'd.md' },
        },
      ]);
      expect(spy).toHaveBeenCalled();
      for (const call of spy.mock.calls) {
        expect(String(call[0]).length).toBe(text.length);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
