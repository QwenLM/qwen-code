/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gitScanArgs,
  isCredentialShaped,
  scanIgnoredCredentials,
} from '../../scripts/verify-pr-credential-scan.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-credential-scan.mjs', import.meta.url),
);

let tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function makeRepo(files, ignore) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-pr-scan-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-q', '.'], { cwd: dir, env: gitEnv });
  writeFileSync(join(dir, '.gitignore'), `${ignore.join('\n')}\n`);
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), 'secret');
  }
  return dir;
}

const run = (dir) =>
  spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

describe('credential basename matching', () => {
  it('matches the shapes a provider key or certificate uses', () => {
    for (const path of [
      '.env',
      '.env.local',
      'app.env',
      'secrets/prod.env',
      'tls.pem',
      'id.key',
      'credentials',
      'credentials.json',
      '.npmrc',
      '.netrc',
    ]) {
      expect(isCredentialShaped(path), path).toBe(true);
    }
    for (const path of [
      'README.md',
      'package.json',
      'keymap.ts',
      'envelope.ts',
      'environment.md',
    ]) {
      expect(isCredentialShaped(path), path).toBe(false);
    }
  });
});

describe('gitScanArgs', () => {
  it('enumerates with depth-aware credential pathspecs', () => {
    const args = gitScanArgs('/repo');
    expect(args).toContain(':(glob)**/.env');
    expect(args).toContain(':(glob)**/*.pem');
    // Excludes apply at workspace depth, not only the repository root.
    expect(args).toContain(':(exclude,glob)**/node_modules/**');
    expect(args).toContain(':(exclude,glob)**/dist/**');
  });
});

describe('scanIgnoredCredentials', () => {
  it('reports nested and top-level ignored credential files', () => {
    const dir = makeRepo(
      ['vault/.env', 'secrets/prod.env', 'tls.pem', '.npmrc', '.netrc'],
      [
        '.env',
        '*.env',
        '*.pem',
        '*.key',
        'credentials*',
        '.npmrc',
        '.netrc',
        'vault/',
      ],
    );
    expect(scanIgnoredCredentials(dir)).toEqual([
      '.netrc',
      '.npmrc',
      'secrets/prod.env',
      'tls.pem',
      'vault/.env',
    ]);
  });

  it('does not refuse an installed tree or build output at any depth', () => {
    const dir = makeRepo(
      [
        'node_modules/pkg/credentials.json',
        'dist/app.pem',
        'packages/foo/node_modules/pkg/credentials.json',
        'packages/foo/dist/credentials.js',
        'packages/foo/dist/app.pem',
        'src/app.ts',
      ],
      ['node_modules/', 'dist/', '*.pem', 'credentials*'],
    );
    expect(scanIgnoredCredentials(dir)).toEqual([]);
  });

  it('limits enumeration with pathspecs instead of buffering the tree', () => {
    const files = Array.from(
      { length: 3000 },
      (_, index) =>
        `packages/foo/node_modules/pkg/dependency-with-a-long-name-${index}.js`,
    );
    files.push('vault/.env');
    const dir = makeRepo(files, ['node_modules/', 'vault/']);
    // A 64 KiB ceiling is far below the dependency listing: only the
    // pathspec-restricted output (the nested .env) fits without ENOBUFS.
    expect(scanIgnoredCredentials(dir, { maxBuffer: 64 * 1024 })).toEqual([
      'vault/.env',
    ]);
  });

  it('refuses a nested repository instead of silently skipping it', () => {
    const dir = makeRepo(['tmp/pr-clone/.env'], ['tmp/']);
    execFileSync('git', ['init', '-q', '.'], {
      cwd: join(dir, 'tmp', 'pr-clone'),
      env: gitEnv,
    });
    expect(() => scanIgnoredCredentials(dir)).toThrow(
      /nested git repository under tmp\/pr-clone/,
    );
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nested git repository');
  });

  it('stays silent on a clean tree', () => {
    const dir = makeRepo(['src/app.ts'], ['node_modules/']);
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 1 and names each entry when one is found', () => {
    const dir = makeRepo(['vault/.env'], ['.env', 'vault/']);
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'credential-shaped ignored entry: vault/.env',
    );
  });

  it('exits 2 without a root and 1 when git cannot list files', () => {
    expect(
      spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status,
    ).toBe(2);
    const notRepo = mkdtempSync(join(tmpdir(), 'verify-pr-scan-nogit-'));
    tmpDirs.push(notRepo);
    const result = run(notRepo);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /could not list (nested repositories|ignored files)/,
    );
  });
});
