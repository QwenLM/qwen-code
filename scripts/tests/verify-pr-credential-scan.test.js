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
      'tls.pfx',
      'id_rsa',
      'id_ed25519',
      'id_ecdsa',
      'id_dsa',
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
    expect(args).toContain(':(glob)**/*.pfx');
    expect(args).toContain(':(glob)**/id_rsa*');
    expect(args).toContain(':(glob)**/id_ed25519*');
    expect(args).toContain(':(glob)**/id_ecdsa*');
    expect(args).toContain(':(glob)**/id_dsa*');
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
        'secrets/tls.pfx',
        'id_rsa',
        'id_rsa.pub',
        'secrets/id_ed25519',
        'secrets/id_ecdsa',
        'secrets/id_dsa',
        'backup.env~',
        'secrets/credentials.json',
        '.git-credentials',
        'gha-creds-123.json',
        '.npmrc',
        'packages/foo/.npmrc',
        '.netrc',
      ],
      [
        '.env*',
        '*.env',
        '*.env~',
        '*.pem',
        '*.key',
        '*.p12',
        '*.pfx',
        'id_rsa*',
        'id_ed25519*',
        'id_ecdsa*',
        'id_dsa*',
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
      'packages/foo/.npmrc',
      'secrets/credentials.json',
      'secrets/id.key',
      'secrets/id_dsa',
      'secrets/id_ecdsa',
      'secrets/id_ed25519',
      'secrets/prod.env',
      'secrets/tls.pfx',
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

  // The guard inspects VALUES, not a key allowlist: any config value can
  // carry a token URL, and the URL-bearing key families (rewrites, http
  // sections) carry theirs in the key. Restoring a fixed key list must turn
  // these red — a novel key is the witness that no list converges.
  it('refuses credential-bearing values and keys outside any fixed list', () => {
    const cases = [
      // pushInsteadOf: the one-word sibling of insteadOf, credential in KEY.
      [
        'url.https://x:ghp_FAKEPAT@github.com/.pushInsteadOf',
        'https://github.com/',
      ],
      // http.proxy: credential in VALUE, a key no allowlist enumerated.
      ['http.proxy', 'http://user:ghp_FAKEPAT@proxy.internal:3128'],
      // A novel key entirely: only value inspection can see this.
      ['custom.mirror', 'https://ghp_FAKEPAT@mirror.internal/o/r.git'],
      // http.<url> section with the token in the KEY, benign value.
      ['http.https://ghp_FAKEPAT@github.com/.extraheader', 'X-Thing: 1'],
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
      // The refusal names the key, never the value: when the credential sits
      // in the value, the token must not appear in the output at all. Git
      // lowercases the variable name but preserves the URL subsection's
      // case, so only the last segment is folded here.
      const reportedKey = key.replace(/\.[^.]+$/, (segment) =>
        segment.toLowerCase(),
      );
      expect(result.stderr, key).toContain(reportedKey);
      if (!key.toLowerCase().includes('ghp_fakepat')) {
        expect(result.stderr, key).not.toContain('ghp_FAKEPAT');
      }
    }
    // A proxy without userinfo stays clean: the widening added recognition,
    // not a blanket refusal of the key.
    const dir = makeRepo(['src/app.ts'], []);
    execFileSync(
      'git',
      ['config', '--local', 'http.proxy', 'http://proxy.internal:3128'],
      { cwd: dir, env: gitEnv },
    );
    expect(scanIgnoredCredentials(dir)).toEqual([]);
  });

  // The credential-side twin of prepare's include.path filter bypass:
  // `--local` alone names one file, while the `git config --get` PR code
  // uses follows includes — an included credential must be refused too.
  it('refuses credentials that arrive through include.path', () => {
    const cases = [
      '[remote "origin"]\n\turl = https://ghp_FAKEPAT@github.com/o/r.git\n',
      '[remote "origin"]\n\tpushurl = https://ghp_FAKEPAT@github.com/o/r.git\n',
      '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hwX0ZBS0VQQVQ=\n',
    ];
    for (const content of cases) {
      const dir = makeRepo(['src/app.ts'], ['tmp/']);
      mkdirSync(join(dir, 'tmp'), { recursive: true });
      writeFileSync(join(dir, 'tmp', 'creds.inc'), content);
      execFileSync(
        'git',
        ['config', '--local', 'include.path', '../tmp/creds.inc'],
        { cwd: dir, env: gitEnv },
      );
      expect(() => scanIgnoredCredentials(dir), content).toThrow(
        /credential-bearing git config/,
      );
      const result = run(dir);
      expect(result.status, content).toBe(1);
      expect(result.stderr, content).toContain('credential-bearing git config');
    }
    // A credential-free include is zero collateral: same shape, benign URL.
    const dir = makeRepo(['src/app.ts'], ['tmp/']);
    mkdirSync(join(dir, 'tmp'), { recursive: true });
    writeFileSync(
      join(dir, 'tmp', 'creds.inc'),
      '[remote "origin"]\n\turl = https://github.com/o/r.git\n',
    );
    execFileSync(
      'git',
      ['config', '--local', 'include.path', '../tmp/creds.inc'],
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
    // Account names are case-insensitive: the uppercase spellings carry
    // the same non-secret and must not re-introduce the false refusal.
    for (const spelling of ['GIT', 'Git']) {
      execFileSync(
        'git',
        [
          'config',
          '--local',
          'remote.origin.url',
          `https://${spelling}@github.com/o/r.git`,
        ],
        { cwd: dir2, env: gitEnv },
      );
      expect(scanIgnoredCredentials(dir2), spelling).toEqual([]);
      expect(run(dir2).status, spelling).toBe(0);
    }
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
    // The dependency files MATCH a credential pathspec (*credentials*): with
    // the pathspecs dropped, this listing overflows the 64 KiB ceiling, so
    // the test actually exercises the restriction it names.
    const files = Array.from(
      { length: 3000 },
      (_, index) =>
        `packages/foo/node_modules/pkg/pkg-credentials-${index}.json`,
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

  // A round's own `git clone` leaves an UNTRACKED, non-ignored clone: the
  // ignored-only enumeration never saw it, and git does not descend into it
  // for the credential file scan either.
  it('refuses an untracked non-ignored nested clone', () => {
    const dir = makeRepo(['src/app.ts'], []);
    const nested = join(dir, 'tools', 'clone');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q', '.'], { cwd: nested, env: gitEnv });
    writeFileSync(join(nested, '.env'), 'OPENAI_API_KEY=sk-from-clone\n');
    expect(() => scanIgnoredCredentials(dir)).toThrow(
      /nested git repository under tools\/clone/,
    );
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nested git repository');
  });

  // A populated submodule is a gitlink whose working tree git will not
  // descend into; an unpopulated one has no tree to read (its URL is covered
  // by the config value scan instead).
  it('refuses a populated submodule but not an unpopulated gitlink', () => {
    const dir = makeRepo(['src/app.ts'], []);
    const nested = join(dir, 'vendor', 'up');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['init', '-q', '.'], { cwd: nested, env: gitEnv });
    writeFileSync(join(nested, '.env'), 'OPENAI_API_KEY=sk-from-submodule\n');
    execFileSync('git', ['add', '.'], { cwd: nested, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'sub'], {
      cwd: nested,
      env: gitEnv,
    });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: nested,
      env: gitEnv,
      encoding: 'utf8',
    }).trim();
    execFileSync(
      'git',
      ['update-index', '--add', '--cacheinfo', `160000,${sha},vendor/up`],
      { cwd: dir, env: gitEnv },
    );
    expect(() => scanIgnoredCredentials(dir)).toThrow(
      /nested git repository under vendor\/up/,
    );
    expect(run(dir).status).toBe(1);

    // Unpopulated: the gitlink stays, the working tree goes.
    rmSync(nested, { recursive: true, force: true });
    expect(scanIgnoredCredentials(dir)).toEqual([]);
    expect(run(dir).status).toBe(0);
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
