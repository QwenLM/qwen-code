import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCredentialCachePath, readCredentialCache } from './credential-cache';

describe('credential cache source slug validation', () => {
  it('resolves valid source slugs under the workspace sources directory', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'credential-cache-'));

    expect(getCredentialCachePath(workspaceRoot, 'valid-source')).toBe(
      join(workspaceRoot, 'sources', 'valid-source', '.credential-cache.json')
    );
  });

  it('rejects traversal source slugs before constructing credential cache paths', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'credential-cache-'));

    expect(() => getCredentialCachePath(workspaceRoot, '../sessions')).toThrow(
      'Invalid source slug: "../sessions"'
    );
  });

  it('returns null for invalid source slugs instead of reading neighboring cache files', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'credential-cache-'));
    const sessionsDir = join(workspaceRoot, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, '.credential-cache.json'), JSON.stringify({ value: 'secret-token' }));

    expect(readCredentialCache(workspaceRoot, '../sessions')).toBeNull();
  });
});
