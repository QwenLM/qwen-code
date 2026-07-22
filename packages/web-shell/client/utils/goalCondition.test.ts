/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GOAL_CLEAR_KEYWORDS,
  goalArgOf,
  isGoalClearCommand,
  isGoalClearKeyword,
  parseWebShellGoalCommand,
} from './goalCondition';

describe('goalArgOf', () => {
  it('returns an empty string for a bare /goal', () => {
    expect(goalArgOf('/goal')).toBe('');
    expect(goalArgOf('/goal   ')).toBe('');
  });

  it('returns the condition, trimmed', () => {
    expect(goalArgOf('/goal  ship it  ')).toBe('ship it');
  });

  it('is case-insensitive on the command itself', () => {
    expect(goalArgOf('/GOAL ship it')).toBe('ship it');
  });

  it('keeps a multi-line condition intact', () => {
    expect(goalArgOf('/goal line one\nline two')).toBe('line one\nline two');
  });

  it('does not strip a command that merely starts with goal', () => {
    expect(goalArgOf('/goalkeeper x')).toBe('/goalkeeper x');
  });
});

describe('parseWebShellGoalCommand', () => {
  it('parses every Goal v3 control operation', () => {
    expect(parseWebShellGoalCommand('/goal')).toEqual({ kind: 'status' });
    expect(parseWebShellGoalCommand('/goal set ship it')).toEqual({
      kind: 'set',
      objective: 'ship it',
    });
    expect(parseWebShellGoalCommand('/goal edit ship it safely')).toEqual({
      kind: 'edit',
      objective: 'ship it safely',
    });
    expect(parseWebShellGoalCommand('/goal pause')).toEqual({ kind: 'pause' });
    expect(parseWebShellGoalCommand('/goal resume')).toEqual({
      kind: 'resume',
    });
    expect(parseWebShellGoalCommand('/goal clear')).toEqual({ kind: 'clear' });
  });

  it('keeps multi-word commands as objectives and rejects missing objectives', () => {
    expect(parseWebShellGoalCommand('/goal pause after release')).toEqual({
      kind: 'set',
      objective: 'pause after release',
    });
    expect(parseWebShellGoalCommand('/goal edit')).toEqual({
      kind: 'error',
      message: '/goal edit requires an objective.',
    });
  });
});

describe('isGoalClearKeyword', () => {
  it.each([...GOAL_CLEAR_KEYWORDS])('treats %s as a clear keyword', (word) => {
    expect(isGoalClearKeyword(word)).toBe(true);
  });

  it('ignores surrounding whitespace and case', () => {
    expect(isGoalClearKeyword('  Clear ')).toBe(true);
  });

  it('keeps former aliases available as objectives', () => {
    expect(isGoalClearKeyword('stop')).toBe(false);
    expect(isGoalClearKeyword('off')).toBe(false);
    expect(isGoalClearKeyword('reset')).toBe(false);
    expect(isGoalClearKeyword('none')).toBe(false);
    expect(isGoalClearKeyword('cancel')).toBe(false);
  });

  it('does not match a real condition that merely contains a keyword', () => {
    expect(isGoalClearKeyword('clear the build cache')).toBe(false);
    expect(isGoalClearKeyword('stop the flaky test from failing')).toBe(false);
  });

  it('does not match an empty condition', () => {
    expect(isGoalClearKeyword('')).toBe(false);
  });
});

describe('isGoalClearCommand', () => {
  it('matches /goal <clear-keyword> in any case', () => {
    expect(isGoalClearCommand('/goal clear')).toBe(true);
    expect(isGoalClearCommand('/goal  CLEAR ')).toBe(true);
  });

  it('does not match a bare /goal', () => {
    expect(isGoalClearCommand('/goal')).toBe(false);
  });

  it('does not match /goal <condition>', () => {
    expect(isGoalClearCommand('/goal clear the build cache')).toBe(false);
  });

  it('requires the /goal prefix, so a bare keyword is just a message', () => {
    // `goalArgOf` returns text it does not recognise unchanged, so without an
    // explicit prefix check these all fell through to the keyword test and
    // answered true. "clear" and "stop" are ordinary things to type in a chat
    // box; treating them as goal-clear commands would be a live bug the moment
    // a caller stopped pre-validating the prefix itself.
    expect(isGoalClearCommand('clear')).toBe(false);
    expect(isGoalClearCommand('stop')).toBe(false);
    expect(isGoalClearCommand('  CANCEL  ')).toBe(false);
    expect(isGoalClearCommand('/goalie clear')).toBe(false);
    expect(isGoalClearCommand('please /goal clear')).toBe(false);
  });
});

describe('the CLI is the authority on the clear keywords', () => {
  // The Web Shell client bundles for the browser and does not depend on
  // `@qwen-code/qwen-code-core`, so this set cannot simply be imported from the
  // package that enforces it. It is duplicated, and a comment asking the next
  // person to "keep in sync" is not a mechanism. Read the CLI source and
  // compare. Drift here is silent and user-visible: the form would accept a
  // condition the daemon then reads as a command, clearing the goal it just
  // set.
  const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
  const read = (relative: string) =>
    readFileSync(join(repoRoot, relative), 'utf8');

  it('agrees with goalCommand.ts on the clear keywords', () => {
    const source = read('packages/cli/src/ui/commands/goalCommand.ts');
    expect(source).toContain(
      "if (keyword === 'clear') return { kind: 'clear' }",
    );
    expect([...GOAL_CLEAR_KEYWORDS]).toEqual(['clear']);
  });
});
