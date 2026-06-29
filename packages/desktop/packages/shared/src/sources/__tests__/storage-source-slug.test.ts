import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deleteSource,
  generateSourceSlug,
  getSourcePath,
  loadSourceConfig,
  loadSourceGuide,
  loadWorkspaceSources,
  sourceExists,
} from '../storage.ts';

describe('source storage slug validation', () => {
  it('resolves valid source slugs under the workspace sources directory', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-slug-'));

    expect(getSourcePath(workspaceRoot, 'craft-kb')).toBe(
      join(workspaceRoot, 'sources', 'craft-kb')
    );
    expect(getSourcePath(workspaceRoot, 'source2')).toBe(
      join(workspaceRoot, 'sources', 'source2')
    );
    expect(getSourcePath(workspaceRoot, 'my-source-123')).toBe(
      join(workspaceRoot, 'sources', 'my-source-123')
    );
  });

  it('rejects traversal and malformed source slugs before path construction', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-slug-'));
    const unsafeSlugs = [
      '../sessions',
      '..\\sessions',
      '/sessions',
      resolve(workspaceRoot, 'sessions'),
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

  it('deletes valid source directories and ignores valid slugs that do not exist', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-delete-valid-'));
    const sourceDir = join(workspaceRoot, 'sources', 'good-source');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'config.json'), '{}');

    deleteSource(workspaceRoot, 'good-source');
    expect(existsSync(sourceDir)).toBe(false);

    expect(() => deleteSource(workspaceRoot, 'missing-source')).not.toThrow();
  });

  it('trims after truncating generated slugs so they remain deletable', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-generate-'));

    expect(generateSourceSlug(workspaceRoot, `${'a'.repeat(49)}!b`)).toBe('a'.repeat(49));
  });

  it('preserves null-return and source listing behavior for legacy invalid source directories', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-legacy-'));
    const invalidDir = join(workspaceRoot, 'sources', 'legacy-source-');
    const validDir = join(workspaceRoot, 'sources', 'valid-source');

    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(join(invalidDir, 'config.json'), '{}');
    writeFileSync(join(invalidDir, 'guide.md'), '# Legacy');

    mkdirSync(validDir, { recursive: true });
    writeFileSync(
      join(validDir, 'config.json'),
      JSON.stringify({
        id: 'valid-source_12345678',
        name: 'Valid Source',
        slug: 'valid-source',
        enabled: true,
        provider: 'custom',
        type: 'local',
        local: { path: './docs' },
      })
    );
    writeFileSync(join(validDir, 'guide.md'), '# Valid Source');

    expect(loadSourceConfig(workspaceRoot, 'legacy-source-')).toBeNull();
    expect(loadSourceGuide(workspaceRoot, 'legacy-source-')).toBeNull();
    expect(sourceExists(workspaceRoot, 'legacy-source-')).toBe(false);
    expect(loadWorkspaceSources(workspaceRoot).map((source) => source.config.slug)).toEqual(['valid-source']);
  });
});
