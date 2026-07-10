import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf-8');
}

describe('interceptor packaging contract', () => {
  it('includes interceptor-request-utils.ts in the packaging manifest', () => {
    const builderYml = readRepoFile('apps/electron/electron-builder.yml');

    expect(builderYml).toContain('packages/shared/src/interceptor-request-utils.ts');
  });
});
