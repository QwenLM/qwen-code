import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRawSourcePermissions,
  loadSourcePermissionsConfig,
} from '../permissions-config.ts';

describe('source permissions slug validation', () => {
  it('returns null for invalid source slugs instead of throwing', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'source-permissions-'));
    const invalidDir = join(workspaceRoot, 'sources', 'legacy-source-');
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(join(invalidDir, 'permissions.json'), '{}');

    expect(loadSourcePermissionsConfig(workspaceRoot, 'legacy-source-')).toBeNull();
    expect(loadRawSourcePermissions(workspaceRoot, 'legacy-source-')).toBeNull();
  });
});
