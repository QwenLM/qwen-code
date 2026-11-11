/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { describe, expect, it, vi } from 'vitest';
import { oscColor, TerminalQuerier, xtversion } from './terminal-querier.js';

function createQuerier() {
  const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
  return new TerminalQuerier(stdout);
}

describe('TerminalQuerier response prefixes', () => {
  it('matches only the OSC response code of an outstanding color query', () => {
    const querier = createQuerier();
    void querier.send(oscColor(11));

    expect(querier.expectsResponsePrefix('\x1b]')).toBe(false);
    expect(querier.expectsResponsePrefix('\x1b]1')).toBe(true);
    expect(querier.expectsResponsePrefix('\x1b]11')).toBe(true);
    expect(querier.expectsResponsePrefix('\x1b]11;rgb:')).toBe(true);
    expect(querier.expectsResponsePrefix('\x1b]10')).toBe(false);
  });

  it('matches a split XTVERSION response only while its query is pending', () => {
    const querier = createQuerier();
    expect(querier.expectsResponsePrefix('\x1bP>')).toBe(false);

    void querier.send(xtversion());
    expect(querier.expectsResponsePrefix('\x1bP>')).toBe(true);
    expect(querier.expectsResponsePrefix('\x1bP>|ghostty')).toBe(true);
  });
});
