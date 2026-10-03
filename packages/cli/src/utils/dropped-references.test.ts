/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  formatDroppedReferencesNotice,
  looksLikeFileReference,
  type DroppedAtReference,
} from './dropped-references.js';

describe('formatDroppedReferencesNotice', () => {
  it('returns null when nothing was dropped', () => {
    expect(formatDroppedReferencesNotice(undefined)).toBeNull();
    expect(formatDroppedReferencesNotice([])).toBeNull();
  });

  it('names each reference and its reason', () => {
    expect(
      formatDroppedReferencesNotice([
        { path: 'a.txt', reason: 'not-found' },
        { path: 'link', reason: 'outside-workspace' },
        { path: 'locked', reason: 'unreadable' },
      ]),
    ).toBe(
      // The two refusals rank first, ahead of the plain miss.
      'Skipped 3 @-references: @link (outside the workspace), @locked (unreadable), @a.txt (not found)',
    );
  });

  it('keeps an inconclusive refusal visible behind four misses', () => {
    const drops: DroppedAtReference[] = Array.from(
      { length: 4 },
      (_, index) => ({ path: `old${index}.md`, reason: 'ignored' }),
    );
    drops.push({ path: 'guarded.ts', reason: 'unreadable' });
    const notice = formatDroppedReferencesNotice(drops);
    expect(notice).toContain('@guarded.ts (unreadable)');
  });

  it('bounds a reference long enough to flood the line', () => {
    const notice = formatDroppedReferencesNotice([
      { path: `${'a'.repeat(400)}.ts`, reason: 'not-found' },
    ]);
    expect(notice).toBeDefined();
    expect((notice as string).length).toBeLessThan(260);
    expect(notice).toContain('…');
  });

  it('keeps a refusal visible when the cap fills with misses', () => {
    const drops: DroppedAtReference[] = Array.from(
      { length: 5 },
      (_, index) => ({
        path: `old${index}.md`,
        reason: 'not-found',
      }),
    );
    drops.push({ path: 'config.json', reason: 'identity-changed' });
    const notice = formatDroppedReferencesNotice(drops);
    expect(notice).toContain('@config.json (changed after it was validated)');
    expect(notice).toContain('Skipped 6 @-references');
    expect(notice).toContain('and 1 more');
  });

  it('caps the list so a bulk drop cannot flood the transcript', () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      path: `f${index}.txt`,
      reason: 'not-found' as const,
    }));
    expect(formatDroppedReferencesNotice(many)).toBe(
      'Skipped 7 @-references: @f0.txt (not found), @f1.txt (not found), ' +
        '@f2.txt (not found), @f3.txt (not found), @f4.txt (not found), ' +
        'and 2 more',
    );
  });
});

describe('looksLikeFileReference', () => {
  it('accepts tokens that name a file', () => {
    expect(looksLikeFileReference('notes.txt')).toBe(true);
    expect(looksLikeFileReference('src/utils/helpers.ts')).toBe(true);
    expect(looksLikeFileReference('dir/readme.md')).toBe(true);
  });

  it('rejects tokens that read as prose', () => {
    expect(looksLikeFileReference('alice')).toBe(false);
    expect(looksLikeFileReference('media')).toBe(false);
    expect(looksLikeFileReference('types/node')).toBe(false);
    expect(looksLikeFileReference('google/genai')).toBe(false);
    expect(looksLikeFileReference('Makefile')).toBe(false);
    expect(looksLikeFileReference('.gitignore')).toBe(false);
  });
});
