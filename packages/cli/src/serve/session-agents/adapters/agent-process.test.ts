/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  LineTooLongError,
  readJsonLines,
  scrubAgentEnv,
} from './agent-process.js';

describe('readJsonLines', () => {
  it('splits chunks into lines, including a final unterminated one', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const done = readJsonLines(stream, (line) => lines.push(line));
    stream.write('{"a":1}\n{"b"');
    stream.write(':2}\n\n  \n');
    stream.end('{"c":3}');
    await done;
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('rejects a line over the cap and keeps draining', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const done = readJsonLines(stream, (line) => lines.push(line), 10);
    stream.write('short\n');
    stream.write('x'.repeat(50));
    await expect(done).rejects.toBeInstanceOf(LineTooLongError);
    expect(lines).toEqual(['short']);
    // The writer is not blocked once the reader gave up.
    expect(stream.write('more\n')).toBe(true);
  });
});

describe('scrubAgentEnv', () => {
  it('drops Claude Code runtime markers and inherited send tokens only', () => {
    expect(
      scrubAgentEnv(
        {
          PATH: '/bin',
          CLAUDECODE: '1',
          CLAUDECODE_FOO: '1',
          CLAUDE_CODE_ENTRYPOINT: 'cli',
          CLAUDE_CODE_SESSION_ID: 's',
          CLAUDE_CODE_GIT_BASH_PATH: 'C:\\bash.exe',
          QWEN_SESSION_SEND_TOKEN: 'old',
        },
        { EXTRA: 'x' },
      ),
    ).toEqual({
      PATH: '/bin',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\bash.exe',
      EXTRA: 'x',
    });
  });
});
