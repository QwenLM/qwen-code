import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteSource, generateSourceSlug, getSourcePath } from '../storage.ts';

describe('source storage slug validation', () => {
  it('resolves valid source slugs under the workspace sources directory', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-slug-'));

    expect(getSourcePath(workspaceRoot, 'craft-kb')).toBe(
      join(workspaceRoot, 'sources', 'craft-kb')
    );
    expect(getSourcePath(workspaceRoot, 'source2')).toBe(
      join(workspaceRoot, 'sources', 'source2')
    );
  });

  it('rejects traversal and malformed source slugs before path construction', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-slug-'));
    const unsafeSlugs = [
      '../sessions',
      '..\\sessions',
      '/sessions',
      'source/child',
      'source\\child',
      '-source',
      'source-',
      'source--child',
      'Source',
      '',
    ];

    for (const slug of unsafeSlugs) {
      expect(() => getSourcePath(workspaceRoot, slug)).toThrow(
        `Invalid source slug: ${JSON.stringify(slug)}`
      );
    }
  });

  it('does not delete sibling directories when given an unsafe slug', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-delete-'));
    const sessionsDir = join(workspaceRoot, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'marker.txt'), 'keep');

    for (const slug of ['../sessions', '..\\sessions']) {
      expect(() => deleteSource(workspaceRoot, slug)).toThrow(
        `Invalid source slug: ${JSON.stringify(slug)}`
      );
    }
    expect(existsSync(join(sessionsDir, 'marker.txt'))).toBe(true);
  });

  it('trims after truncating generated slugs so they remain deletable', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-generate-'));

    expect(generateSourceSlug(workspaceRoot, `${'a'.repeat(49)}!b`)).toBe('a'.repeat(49));
  });
});
