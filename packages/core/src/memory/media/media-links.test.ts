/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { computeAutoLinks } from './media-links.js';
import type { StoredMediaRecord } from './media-memory-store.js';

function rec(hash: string, p: string, links: string[] = []): StoredMediaRecord {
  return {
    hash,
    modality: 'image',
    path: p,
    summary: 's',
    links,
    updatedAt: '2026-01-01',
    body: 'b',
  };
}

describe('media auto-linking', () => {
  it('links files in the same directory', () => {
    const links = computeAutoLinks({ hash: 'a', path: '/proj/media/a.png' }, [
      rec('b', '/proj/media/b.png'),
      rec('c', '/other/c.png'),
    ]);
    expect(links).toContain('b');
    expect(links).not.toContain('c');
  });

  it('includes explicit derived-from provenance', () => {
    const links = computeAutoLinks(
      { hash: 'a', path: '/proj/a.mp4', derivedFrom: 'src' },
      [],
    );
    expect(links).toContain('src');
  });

  it('links records that were derived from this file', () => {
    const links = computeAutoLinks({ hash: 'src', path: '/x/v.mp4' }, [
      rec('deriv', '/y/t.txt', ['src']),
    ]);
    expect(links).toContain('deriv');
  });

  it('never links a file to itself', () => {
    const links = computeAutoLinks({ hash: 'a', path: '/proj/a.png' }, [
      rec('a', '/proj/a.png'),
    ]);
    expect(links).not.toContain('a');
  });
});
