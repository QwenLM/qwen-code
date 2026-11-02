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
      '.env~',
      'tls.pem',
      'id.key',
      'auth.p12',
      'id_rsa',
      'credentials',
      'credentials.json',
      '.git-credentials',
      'gha-creds-123.json',
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
      'id_rsa.pub',
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
    expect(args).toContain(':(glob)**/*.env~');
    expect(args).toContain(':(glob)**/*.p12');
    expect(args).toContain(':(glob)**/id_rsa*');
    expect(args).toContain(':(glob)**/*credentials*');
    expect(args).toContain(':(glob)**/gha-creds-*.json');
    // Excludes apply at workspace depth, not only the repository root.
    expect(args).toContain(':(exclude,glob)**/node_modules/**');
    expect(args).toContain(':(exclude,glob)**/dist/**');
  });
});

describe('scanIgnoredCredentials', () => {
  it('reports nested and top-level ignored credential files', () => {
    const dir = makeRepo(
      [
        'vault/.env',
        'secrets/prod.env',
        '.env~',
        '.env.local',
        'tls.pem',
        'secrets/id.key',
        'auth.p12',
        'id_rsa',
        'id_rsa.pub',
        'backup.env~',
        'secrets/credentials.json',
        '.git-credentials',
        'gha-creds-123.json',
        '.npmrc',
        '.netrc',
      ],
      [
        '.env*',
        '*.env',
        '*.env~',
        '*.pem',
        '*.key',
        '*.p12',
        'id_rsa*',
        '*credentials*',
        '.npmrc',
        '.netrc',
        'gha-creds-*.json',
        'vault/',
      ],
    );
    expect(scanIgnoredCredentials(dir)).toEqual([
      '.env.local',
      '.env~',
      '.git-credentials',
      '.netrc',
      '.npmrc',
      'auth.p12',
      'backup.env~',
      'gha-creds-123.json',
      'id_rsa',
      'secrets/credentials.json',
      'secrets/id.key',
      'secrets/prod.env',
      'tls.pem',
      'vault/.env',
    ]);
  });

  it('refuses a remote URL that carries a credential', () => {
    const dir = makeRepo(['src/app.ts'], ['node_modules/']);
    execFileSync(
      'git',
      [
        'config',
        '--local',
        'remote.origin.url',
        'https://x-access-token:ghp_secret@github.com/o/r.git',
      ],
      { cwd: dir, env: gitEnv },
    );
    expect(() => scanIgnoredCredentials(dir)).toThrow(
      /credential-bearing git config/,
    );
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('credential-bearing git config');
  });

  it('refuses a token used as the URL username and insteadOf credentials', () => {
    const dir = makeRepo(['src/app.ts'], []);
    execFileSync(
      'git',
      [
        'config',
        '--local',
        'remote.origin.url',
        'https://ghp_FAKEPAT@github.com/o/r.git',
      ],
      { cwd: dir, env: gitEnv },
    );
    expect(() => scanIgnoredCredentials(dir)).toThrow(
      /credential-bearing git config/,
    );
    const dir2 = makeRepo(['src/app.ts'], []);
    execFileSync(
      'git',
      [
        'config',
        '--local',
        'url.https://x:ghp_FAKEPAT@github.com/.insteadOf',
        'https://github.com/',
      ],
      { cwd: dir2, env: gitEnv },
    );
    expect(() => scanIgnoredCredentials(dir2)).toThrow(
      /credential-bearing git config/,
    );
  });

  // The same credential class as remote.*.url: a push URL is the natural
  // place for a PAT, and submodule URLs and the Actions-written extraheader
  // are equally readable from inside the tree with plain `git config`.
  it('refuses pushurl, submodule URL and Authorization extraheader credentials', () => {
    const cases = [
      ['remote.origin.pushurl', 'https://ghp_FAKEPAT@github.com/o/r.git'],
      ['submodule.lib.url', 'https://x:ghp_FAKEPAT@github.com/o/lib.git'],
      [
        'http.https://github.com/.extraheader',
        'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hwX0ZBS0VQQVQ=',
      ],
      [
        'http.https://proxy.internal/.extraheader',
        'Proxy-Authorization: Bearer ghp_FAKEPAT',
      ],
    ];
    for (const [key, value] of cases) {
      const dir = makeRepo(['src/app.ts'], []);
      execFileSync('git', ['config', '--local', key, value], {
        cwd: dir,
        env: gitEnv,
      });
      expect(() => scanIgnoredCredentials(dir), key).toThrow(
        /credential-bearing git config/,
      );
      const result = run(dir);
      expect(result.status, key).toBe(1);
      expect(result.stderr, key).toContain('credential-bearing git config');
    }
  });

  it('keeps a non-Authorization extraheader out of the refusal', () => {
    const dir = makeRepo(['src/app.ts'], []);
    execFileSync(
      'git',
      [
        'config',
        '--local',
        'http.https://github.com/.extraheader',
        'X-Request-Id: trace-123',
      ],
      { cwd: dir, env: gitEnv },
    );
    expect(scanIgnoredCredentials(dir)).toEqual([]);
  });

  it('keeps ssh URLs, the bare git username and public keys out of the refusal', () => {
    const dir = makeRepo(['id_rsa.pub'], ['id_rsa*']);
    execFileSync(
      'git',
      [
        'config',
        '--local',
        'remote.origin.url',
        'ssh://git@github.com/o/r.git',
      ],
      { cwd: dir, env: gitEnv },
    );
    expect(scanIgnoredCredentials(dir)).toEqual([]);
    // The conventional account name carries no secret on http(s) either;
    // refusing it would disagree with ssh://git@ on the same non-secret.
    const dir2 = makeRepo(['src/app.ts'], []);
    execFileSync(
      'git',
      [
        'config',
        '--local',
        'remote.origin.url',
        'https://git@github.com/o/r.git',
      ],
      { cwd: dir2, env: gitEnv },
    );
    expect(scanIgnoredCredentials(dir2)).toEqual([]);
    expect(run(dir2).status).toBe(0);
    // A password after the same username is still a credential.
    execFileSync(
      'git',
      [
        'config',
        '--local',
        'remote.origin.url',
        'https://git:ghp_FAKEPAT@github.com/o/r.git',
      ],
      { cwd: dir2, env: gitEnv },
    );
    expect(() => scanIgnoredCredentials(dir2)).toThrow(
      /credential-bearing git config/,
    );
  });

  it('does not refuse a vendored real git repository under node_modules', () => {
    const dir = makeRepo(['node_modules/pkg/index.js'], ['node_modules/']);
    const nested = join(dir, 'node_modules', 'pkg');
    execFileSync('git', ['init', '-q', '.'], { cwd: nested, env: gitEnv });
    execFileSync('git', ['add', '.'], { cwd: nested, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'dep'], {
      cwd: nested,
      env: gitEnv,
    });
    expect(scanIgnoredCredentials(dir)).toEqual([]);
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
