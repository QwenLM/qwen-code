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
});
