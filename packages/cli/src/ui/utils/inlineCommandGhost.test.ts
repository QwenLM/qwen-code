/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  findBestCommandGhostMatch,
  findMidInputSlashQuery,
} from './inlineCommandGhost.js';
import { CommandKind, type SlashCommand } from '../commands/types.js';

function cmd(overrides: Partial<SlashCommand> & { name: string }): SlashCommand {
  return {
    description: `the ${overrides.name} command`,
    kind: CommandKind.BUILT_IN,
    ...overrides,
  } as SlashCommand;
}

describe('findMidInputSlashQuery', () => {
  it('matches a slash token that follows a space', () => {
    expect(findMidInputSlashQuery('hello /extra')).toBe('extra');
  });

  it('does not match a slash at the very start of the input', () => {
    expect(findMidInputSlashQuery('/extra')).toBeNull();
  });

  it('matches a slash at the start of a continuation line', () => {
    // The caller prefixes a synthetic newline for rows > 0.
    expect(findMidInputSlashQuery('\n/extra')).toBe('extra');
    expect(findMidInputSlashQuery('\nhello /extra')).toBe('extra');
  });

  it('matches after CJK sentence punctuation', () => {
    expect(findMidInputSlashQuery('你好。/extra')).toBe('extra');
    expect(findMidInputSlashQuery('好的、/extra')).toBe('extra');
    expect(findMidInputSlashQuery('是吗？/extra')).toBe('extra');
    expect(findMidInputSlashQuery('快跑！/extra')).toBe('extra');
  });

  it('matches after the CJK punctuation that appears mid-sentence', () => {
    expect(findMidInputSlashQuery('参考模板，/extra')).toBe('extra');
    expect(findMidInputSlashQuery('参考模板；/extra')).toBe('extra');
    expect(findMidInputSlashQuery('参考模板：/extra')).toBe('extra');
    expect(findMidInputSlashQuery('见（/extra')).toBe('extra');
    expect(findMidInputSlashQuery('（见）/extra')).toBe('extra');
  });

  it('does not match after an English curly quote', () => {
    // macOS and Word turn a plain `"` into `“` in English prose, so treating it
    // as a separator would start a command lookup on an ordinary path.
    expect(findMidInputSlashQuery('run “/usr')).toBeNull();
  });

  it('does not match after halfwidth punctuation', () => {
    // English writing puts a space there anyway, which \s already covers.
    expect(findMidInputSlashQuery('hello,/extra')).toBeNull();
    expect(findMidInputSlashQuery('http://extra')).toBeNull();
  });

  it('does not match a bare slash with nothing typed after it', () => {
    expect(findMidInputSlashQuery('50 / ')).toBeNull();
    expect(findMidInputSlashQuery('50 /')).toBeNull();
  });

  it('does not match when the slash is not preceded by a separator', () => {
    expect(findMidInputSlashQuery('src/utils')).toBeNull();
    expect(findMidInputSlashQuery('a/b')).toBeNull();
    expect(findMidInputSlashQuery('模板/extra')).toBeNull();
  });

  it('does not match when the token is no longer at the cursor', () => {
    expect(findMidInputSlashQuery('hello /extra world')).toBeNull();
    expect(findMidInputSlashQuery('hello /extra ')).toBeNull();
  });

  it('accepts the full command-name character set', () => {
    expect(findMidInputSlashQuery('x /cc-plugins:one_shot.v2')).toBe(
      'cc-plugins:one_shot.v2',
    );
  });
});

describe('findBestCommandGhostMatch', () => {
  const commands = [
    cmd({ name: 'extract-approach' }),
    cmd({ name: 'exit' }),
    cmd({ name: 'export' }),
  ];

  it('returns the not-yet-typed suffix of a unique prefix match', () => {
    expect(findBestCommandGhostMatch(commands, 'extra')).toEqual({
      token: 'extract-approach',
      isUniqueMatch: true,
      suffix: 'ct-approach',
    });
  });

  it('offers only the prefix every match agrees on when several match', () => {
    const wcs = [
      cmd({ name: 'wcs-base' }),
      cmd({ name: 'wcs-engine' }),
      cmd({ name: 'wcs-engine-mock' }),
    ];

    // 29 same-prefix skills is the reported catalog: naming one of them would
    // be wrong far more often than right.
    expect(findBestCommandGhostMatch(wcs, 'wcs')).toEqual({
      token: 'wcs-',
      isUniqueMatch: false,
      suffix: '-',
    });

    // `wcs-engine` is a real command, but `wcs-engine-mock` still shares it, so
    // the match is not unique and accept must not append a trailing space.
    expect(findBestCommandGhostMatch(wcs, 'wcs-e')).toEqual({
      token: 'wcs-engine',
      isUniqueMatch: false,
      suffix: 'ngine',
    });
  });

  it('falls back to the shortest match when they share nothing', () => {
    // exit / export / extract-approach diverge immediately after "ex". Silence
    // would cost the ghost most short prefixes, so name the shortest — but
    // without the uniqueness flag, so accept leaves the trailing space off.
    expect(findBestCommandGhostMatch(commands, 'ex')).toEqual({
      token: 'exit',
      isUniqueMatch: false,
      suffix: 'it',
    });
  });

  it('prefers a shared prefix over the fallback when one exists', () => {
    const pool = [cmd({ name: 'abcd' }), cmd({ name: 'abce' })];
    // The fallback would commit to `abcd`; the shared prefix stops at what both
    // agree on.
    expect(findBestCommandGhostMatch(pool, 'ab')).toEqual({
      token: 'abc',
      isUniqueMatch: false,
      suffix: 'c',
    });
  });

  it('returns null when the shortest fallback is the query itself', () => {
    const pool = [cmd({ name: 'exit' }), cmd({ name: 'exit-now' })];
    expect(findBestCommandGhostMatch(pool, 'exit')).toBeNull();
  });

  it('matches case-insensitively but preserves the candidate casing', () => {
    expect(findBestCommandGhostMatch([cmd({ name: 'Deploy' })], 'de')).toEqual({
      token: 'Deploy',
      isUniqueMatch: true,
      suffix: 'ploy',
    });
  });

  it('never builds a shared prefix out of candidates that disagree on casing', () => {
    // A case-insensitive prefix would emit `PLOY-` and read as "dePLOY-".
    // Neither candidate supplies that, so the fallback names one of them whole
    // and the inserted token stays a real command.
    const pool = [cmd({ name: 'DEPLOY-a' }), cmd({ name: 'deploy-b' })];
    expect(findBestCommandGhostMatch(pool, 'de')).toEqual({
      token: 'DEPLOY-a',
      isUniqueMatch: false,
      suffix: 'PLOY-a',
    });
  });

  it("treats one command's alternative spellings as a single match", () => {
    // `/tasks` carries altNames bg + background; letting them compete would
    // make an unambiguous command look ambiguous.
    const tasks = cmd({ name: 'tasks', altNames: ['bg', 'background'] });
    expect(findBestCommandGhostMatch([tasks], 'b')).toEqual({
      token: 'bg',
      isUniqueMatch: true,
      suffix: 'g',
    });
  });

  it('compares the shared prefix by code point, not code unit', () => {
    const shared = [cmd({ name: 'go😀x' }), cmd({ name: 'go😀y' })];
    expect(findBestCommandGhostMatch(shared, 'go')).toEqual({
      token: 'go😀',
      isUniqueMatch: false,
      suffix: '😀',
    });

    // Different emoji share only a high surrogate. A code-unit comparison would
    // hand back that half character as the shared prefix; a code-point one finds
    // nothing shared and drops to the fallback, which slices a whole candidate.
    const split = [cmd({ name: 'go😀x' }), cmd({ name: 'go😁y' })];
    expect(findBestCommandGhostMatch(split, 'go')).toEqual({
      token: 'go😀x',
      isUniqueMatch: false,
      suffix: '😀x',
    });
  });

  it('returns null when the query is already the complete name', () => {
    expect(findBestCommandGhostMatch(commands, 'exit')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(findBestCommandGhostMatch(commands, 'zzz')).toBeNull();
  });

  it('returns null for an empty query', () => {
    expect(findBestCommandGhostMatch(commands, '')).toBeNull();
  });

  it('skips hidden commands', () => {
    expect(
      findBestCommandGhostMatch([cmd({ name: 'secret', hidden: true })], 'se'),
    ).toBeNull();
  });

  it('matches visible commands with an empty description', () => {
    expect(
      findBestCommandGhostMatch([cmd({ name: 'claim', description: '' })], 'cla'),
    ).toEqual({
      token: 'claim',
      isUniqueMatch: true,
      suffix: 'im',
    });
  });

  it('ranks name above displayName above altName', () => {
    const pool = [
      cmd({ name: 'zzz-by-alt', altNames: ['ab-alt'] }),
      cmd({ name: 'zzz-by-display', displayName: 'ab-display' }),
      cmd({ name: 'ab-name' }),
    ];
    expect(findBestCommandGhostMatch(pool, 'ab')?.token).toBe('ab-name');

    const withoutName = pool.slice(0, 2);
    expect(findBestCommandGhostMatch(withoutName, 'ab')?.token).toBe(
      'ab-display',
    );

    expect(findBestCommandGhostMatch(pool.slice(0, 1), 'ab')?.token).toBe(
      'ab-alt',
    );
  });

  it('prunes to the best tier before computing the shared prefix', () => {
    // Mixing tiers would collapse to "ab-" and quietly undo the ranking above.
    const pool = [
      cmd({ name: 'ab-name' }),
      cmd({ name: 'zzz-by-display', displayName: 'ab-display' }),
    ];
    expect(findBestCommandGhostMatch(pool, 'ab')).toEqual({
      token: 'ab-name',
      isUniqueMatch: true,
      suffix: '-name',
    });
  });

  it('never completes to a candidate containing whitespace', () => {
    // MCP prompts carry a "server:prompt (MCP)" displayName; inserting it
    // would split the token in two. The canonical name still matches.
    const mcp = cmd({
      name: 'mcp__server__deploy',
      displayName: 'server:deploy (MCP)',
      kind: CommandKind.MCP_PROMPT,
    });
    expect(findBestCommandGhostMatch([mcp], 'server:de')).toBeNull();
    expect(findBestCommandGhostMatch([mcp], 'mcp__ser')?.token).toBe(
      'mcp__server__deploy',
    );
  });

  it('never completes to a candidate containing a slash', () => {
    // Loaders pass display names through unvalidated, and a candidate with a
    // `/` would be able to match a token the dropdown also owns.
    const namespaced = cmd({ name: 'ops', displayName: 'team/ops' });
    expect(findBestCommandGhostMatch([namespaced], 'team')).toBeNull();
    expect(findBestCommandGhostMatch([namespaced], 'op')?.token).toBe('ops');
  });

  it('matches skills the same as any other command', () => {
    const skill = cmd({
      name: 'extract-approach',
      kind: CommandKind.SKILL,
    });
    expect(findBestCommandGhostMatch([skill], 'extra')?.suffix).toBe(
      'ct-approach',
    );
  });
});
