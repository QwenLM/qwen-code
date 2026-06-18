/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import yargs, { type Argv } from 'yargs';
import { serveCommand } from './serve.js';

function buildParser(): Argv {
  return (serveCommand.builder as (argv: Argv) => Argv)(
    yargs([]).exitProcess(false).fail(false).locale('en'),
  );
}

describe('serve command args', () => {
  it('parses --enable-session-shell', () => {
    const parsed = buildParser().parseSync('--enable-session-shell');
    expect(parsed['enable-session-shell']).toBe(true);
  });

  it('defaults direct session shell to disabled', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['enable-session-shell']).toBe(false);
  });

  it('parses --permission-response-timeout-ms as a number', () => {
    const parsed = buildParser().parseSync(
      '--permission-response-timeout-ms 60000',
    );
    expect(parsed['permission-response-timeout-ms']).toBe(60000);
  });

  it('leaves --permission-response-timeout-ms unset by default', () => {
    const parsed = buildParser().parseSync('');
    expect(parsed['permission-response-timeout-ms']).toBeUndefined();
  });
});
