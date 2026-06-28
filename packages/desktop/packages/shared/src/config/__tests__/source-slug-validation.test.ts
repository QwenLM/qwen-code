import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAllPermissions, validateAllSources, validateSource, validateSourcePermissions } from '../validators.ts';

describe('source slug validation in config validators', () => {
  it('returns a validation error instead of joining invalid source slugs', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-validator-'));

    const result = validateSource(workspaceRoot, '../sessions');

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.file).toBe('sources/<invalid>/config.json');
    expect(result.errors[0]?.message).toBe('Invalid source slug: "../sessions"');
  });

  it('skips legacy invalid source directories during permissions validation', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'permissions-validator-'));
    const sourcesDir = join(workspaceRoot, 'sources');
    mkdirSync(join(sourcesDir, 'legacy-source-'), { recursive: true });
    mkdirSync(join(sourcesDir, 'valid-source'), { recursive: true });
    writeFileSync(join(sourcesDir, 'valid-source', 'permissions.json'), '{}');

    const result = validateAllPermissions(workspaceRoot);

    expect(result.errors).toHaveLength(0);
    expect(
      result.warnings.some(
        warning =>
          warning.file === 'sources/legacy-source-/permissions.json' &&
          warning.message.includes('invalid slug format')
      )
    ).toBe(true);
  });

  it('skips legacy invalid source directories during all source validation', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'all-sources-validator-'));
    const sourcesDir = join(workspaceRoot, 'sources');
    mkdirSync(join(sourcesDir, 'legacy-source-'), { recursive: true });
    mkdirSync(join(sourcesDir, 'valid-source'), { recursive: true });
    writeFileSync(
      join(sourcesDir, 'valid-source', 'config.json'),
      JSON.stringify({
        id: 'valid-source',
        name: 'Valid Source',
        slug: 'valid-source',
        enabled: true,
        provider: 'test',
        type: 'local',
        local: { path: workspaceRoot },
      })
    );

    const result = validateAllSources(workspaceRoot);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(
      result.warnings.some(
        warning =>
          warning.file === 'sources/legacy-source-/config.json' &&
          warning.message.includes('invalid slug format')
      )
    ).toBe(true);
  });

  it('returns a validation error for direct invalid source permissions validation', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-permissions-validator-'));

    const result = validateSourcePermissions(workspaceRoot, 'legacy-source-');

    expect(result.valid).toBe(false);
    expect(result.errors[0]?.file).toBe('sources/<invalid>/permissions.json');
    expect(result.errors[0]?.message).toBe('Invalid source slug: "legacy-source-"');
  });
});
