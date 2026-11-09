/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isOfflineRemoteShow } from './git-remote-show-offline.js';

describe('isOfflineRemoteShow', () => {
  it.each([
    'git remote show -n origin',
    'git remote show origin -n',
    'git remote show -n https://evil.example/leak',
    'git remote show -n git@evil.example:owner/repo',
    'git remote -v show -n origin',
    'git\tremote\tshow\t-n\torigin',
    '  git remote show -n origin  ',
    '\t git remote show -n origin \t',
    'GIT_TRACE=1 git remote show -n origin',
    'git remote show -n --end-of-options origin',
  ])('proves -n in %j', (command) => {
    expect(isOfflineRemoteShow(command)).toBe(true);
  });

  it.each([
    ['no -n', 'git remote show origin'],
    ['-n after --', 'git remote show origin -- -n'],
    ['-n after --end-of-options', 'git remote show origin --end-of-options -n'],
    ['no show', 'git remote -n'],
    ['no remote', 'git show -n'],
    ['show before remote', 'git show remote -n'],
    ['blanks only', ' \t '],
    ['empty text', ''],
  ])('finds no -n with %s', (_label, command) => {
    expect(isOfflineRemoteShow(command)).toBe(false);
  });

  // Each of these characters means bash may build different words from the
  // text than a plain split does, so the -n beside it is not proof.
  it.each([
    ['an escaped blank', 'git remote show origin \\ -n'],
    ['an escaped tab', 'git remote show origin \\\t-n'],
    ['a single quote', "git remote show -n 'origin'"],
    ['a double quote', 'git remote show -n "origin"'],
    ['an expansion', 'git remote show -n $REMOTE'],
    ['a backtick', 'git remote show -n `echo origin`'],
    ['an input redirection', 'git remote show origin <<<-n'],
    ['a heredoc', 'git remote show origin <<- -n'],
    ['an output redirection', 'git remote show -n origin >out'],
    ['a comment', 'git remote show origin # -n'],
    ['a tilde', 'git remote show -n ~/repo'],
    ['a bracket glob', 'git remote show origin [--][--] -n'],
    ['a star glob', 'git remote show origin * -n'],
    ['a question glob', 'git remote show origin ?? -n'],
    ['a brace', 'git remote show origin {--,x} -n'],
    ['a separator', 'git remote show origin; -n'],
    ['a pipe', 'git remote show origin | -n'],
    ['an ampersand', 'git remote show origin & -n'],
    ['a carriage return', 'git remote show origin\r-n'],
    ['a vertical tab', 'git remote show origin\v-n'],
    ['a form feed', 'git remote show origin\f-n'],
    ['a newline', 'git remote show origin\n-n'],
    ['an ideographic space', 'git remote show origin　-n'],
  ])('takes %s as no proof', (_label, command) => {
    expect(isOfflineRemoteShow(command)).toBe(false);
  });
});
