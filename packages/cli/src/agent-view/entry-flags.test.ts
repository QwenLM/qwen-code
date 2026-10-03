/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { findSessionsAnswerChain } from './entry-flags.js';

describe('findSessionsAnswerChain', () => {
  it('sees the chain past a boolean root flag and its off-word', () => {
    // yargs-parser consumes the `false` after a known boolean flag, so the
    // word must not read as the first positional — when it did, every
    // chain-keyed protection went dark while yargs still routed to
    // `sessions answer`.
    expect(
      findSessionsAnswerChain([
        '--debug',
        'false',
        'sessions',
        'answer',
        '0f8e',
        'x',
      ]),
    ).toEqual({ sessionsAt: 2, answerAt: 3, sessionAt: 4 });
  });

  it('still refuses a chain when another word follows a boolean flag', () => {
    // Only the two measured boolean literals are value words; anything else
    // is a real first positional and there is no chain.
    expect(
      findSessionsAnswerChain(['--debug', 'maybe', 'sessions', 'answer', 'x']),
    ).toBeUndefined();
  });

  it('treats a version token between answer and the id as a root global', () => {
    // The version intercept in cli.ts exempts the region after `answer`;
    // bailing here printed the version and dropped the reply with exit 0.
    expect(
      findSessionsAnswerChain(['sessions', 'answer', '-v', '0f8e', 'hi']),
    ).toEqual({ sessionsAt: 0, answerAt: 1, sessionAt: 3 });
  });

  it('keeps bailing on a help token between answer and the id', () => {
    expect(
      findSessionsAnswerChain(['sessions', 'answer', '--help', '0f8e', 'hi']),
    ).toBeUndefined();
  });
});
