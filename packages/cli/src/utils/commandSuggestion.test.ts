/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { damerauLevenshtein, findClosestCommand } from './commandSuggestion.js';

describe('commandSuggestion', () => {
  describe('damerauLevenshtein', () => {
    it('returns 0 for identical strings', () => {
      expect(damerauLevenshtein('update', 'update')).toBe(0);
    });

    it('counts a single adjacent transposition as one edit', () => {
      expect(damerauLevenshtein('udpate', 'update')).toBe(1);
      expect(damerauLevenshtein('updaet', 'update')).toBe(1);
    });

    it('counts a single deletion as one edit', () => {
      expect(damerauLevenshtein('updatge', 'update')).toBe(1);
    });

    it('counts a single insertion as one edit', () => {
      expect(damerauLevenshtein('updte', 'update')).toBe(1);
    });

    it('scores two-edit pairs above the threshold', () => {
      expect(damerauLevenshtein('stat', 'status')).toBe(2); // two insertions
      expect(damerauLevenshtein('book', 'back')).toBe(2); // two substitutions
    });

    it('returns the length when one side is empty', () => {
      expect(damerauLevenshtein('', 'update')).toBe(6);
      expect(damerauLevenshtein('update', '')).toBe(6);
    });
  });

  describe('findClosestCommand', () => {
    const commands = [
      { name: 'update' },
      { name: 'status' },
      { name: 'plugins', aliases: ['plugin'] },
      { name: 'help' },
    ];

    it('finds a command within the default distance of 1', () => {
      expect(findClosestCommand('updatge', commands)).toBe('update');
      expect(findClosestCommand('udpate', commands)).toBe('update');
    });

    it('returns undefined for a distance-2 token at threshold 1', () => {
      expect(findClosestCommand('stat', commands)).toBeUndefined();
      expect(findClosestCommand('foobar', commands)).toBeUndefined();
      expect(findClosestCommand('deploy', commands)).toBeUndefined();
    });

    it('respects a custom maxEditDistance', () => {
      expect(findClosestCommand('stat', commands, { maxEditDistance: 2 })).toBe(
        'status',
      );
    });

    it('matches an alias and returns the exact matched string', () => {
      // "plugih" is distance 1 from the alias "plugin" but distance 2 from
      // the canonical "plugins", so the alias must win and be returned.
      expect(findClosestCommand('plugih', commands)).toBe('plugin');
    });

    it('keeps the first candidate on a tie', () => {
      // "cat" is distance 1 from both "car" (t->r) and "bat" (c->b); the
      // first candidate in iteration order must win deterministically.
      const tied = [{ name: 'car' }, { name: 'bat' }];
      expect(findClosestCommand('cat', tied)).toBe('car');
    });

    it('returns undefined for an empty candidate list', () => {
      expect(findClosestCommand('update', [])).toBeUndefined();
    });
  });
});
