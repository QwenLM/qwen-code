/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

const windows = process.platform === 'win32';
const installer = path.resolve(
  `scripts/installation/install-opentui-preview.${windows ? 'ps1' : 'sh'}`,
);
const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
const hash = (data) => createHash('sha256').update(data).digest('hex');

function tree(root) {
  if (!existsSync(root)) return null;
  const entries = {};
  const visit = (file) => {
    const stat = lstatSync(file);
    const row = { mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) row.link = readlinkSync(file);
    else if (stat.isDirectory()) {
      row.directory = true;
      for (const child of readdirSync(file).sort())
        visit(path.join(file, child));
    } else row.sha256 = hash(readFileSync(file));
    entries[path.relative(root, file)] = row;
  };
  visit(root);
  return entries;
}

function put(file, content, executable = false) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (executable) chmodSync(file, 0o755);
}

function checked(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15000,
    ...options,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'qwen-preview-preserve-'));
  const dir = path.join(root, 'preview');
  const live = path.join(dir, 'qwen-code');
  const protectedRoot = path.join(root, 'classic-and-path');
  put(path.join(protectedRoot, 'classic', 'userdata'), 'CLASSIC_DATA\n');
  put(path.join(protectedRoot, 'bin', 'qwen'), 'CLASSIC_ENTRY\n');
  put(path.join(protectedRoot, '.profile'), 'ORIGINAL_PATH_CONFIG\n');
  put(path.join(root, 'home', '.profile'), 'OWNED_HOME_PROFILE\n');
  mkdirSync(path.join(root, 'tmp'));
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    ...(windows
      ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec }
      : { LC_ALL: 'C' }),
  };
  const initialPath = process.env.PATH;
  const initialProtected = tree(protectedRoot);
  const initialHome = tree(path.join(root, 'home'));
  const entry = (base) => path.join(base, 'bin', windows ? 'qwen.cmd' : 'qwen');
  const seed = (base, marker) => {
    put(
      entry(base),
      windows
        ? `@echo off\r\necho ${marker}\r\n`
        : `#!/bin/sh\nprintf '%s\\n' ${quote(marker)}\n`,
      true,
    );
    put(path.join(base, 'userdata-sentinel.txt'), `${marker}_USERDATA_甲\n`);
  };
  seed(live, 'OLD_PREVIEW');
  put(path.join(dir, 'outside-preview-data'), 'PRESERVE_SIBLING\n');
  const oldTree = tree(live);
  const launch = () => {
    const result = windows
      ? checked(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `& ${psQuote(entry(live))}; exit $LASTEXITCODE`,
          ],
          { env },
        )
      : checked(entry(live), [], { env });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  const installArgs = (archive) =>
    windows
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          installer,
          '-Archive',
          archive,
          '-Dir',
          dir,
        ]
      : [
          installer,
          '--archive',
          archive,
          '--target',
          'darwin-arm64',
          '--dir',
          dir,
        ];
  const install = (archive, overrides = {}) =>
    checked(windows ? powershell : '/bin/sh', installArgs(archive), {
      cwd: root,
      env: { ...env, ...overrides },
    });
  const archive = (name, kind = 'valid') => {
    const payload = path.join(root, `payload-${name}`);
    const packageRoot = path.join(payload, 'qwen-code');
    mkdirSync(packageRoot, { recursive: true });
    if (kind !== 'invalid') {
      seed(packageRoot, 'NEW_PREVIEW');
      put(
        path.join(packageRoot, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          version: '0.0.1',
          runtime: 'bun',
          target: windows ? 'win-x64' : 'darwin-arm64',
        }),
      );
      put(path.join(packageRoot, 'lib', 'cli.js'), 'export {};\n');
      put(path.join(packageRoot, 'lib', 'cli-entry.js'), 'export {};\n');
      put(path.join(packageRoot, 'lib', 'package.json'), '{"type":"module"}\n');
      for (const runtime of windows
        ? ['bun/bun.exe', 'node/node.exe']
        : ['bun/bin/bun', 'node/bin/node']) {
        put(path.join(packageRoot, runtime), '#!/bin/sh\nexit 0\n', true);
      }
    } else put(path.join(packageRoot, 'unrelated'), 'NOT_A_PREVIEW\n');
    const members = ['qwen-code'];
    if (kind === 'outside') {
      put(path.join(payload, 'unexpected-top-level'), 'OUTSIDE_PACKAGE\n');
      members.push('unexpected-top-level');
    }
    if (kind === 'symlink') {
      const external = path.join(root, `archive-link-target-${name}`);
      put(external, 'OWNED_EXTERNAL_LINK_TARGET\n');
      rmSync(path.join(packageRoot, 'lib', 'cli.js'));
      symlinkSync(external, path.join(packageRoot, 'lib', 'cli.js'));
    }
    const file = path.join(root, `${name}.${windows ? 'zip' : 'tar.gz'}`);
    const packed = windows
      ? checked(
          powershell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Compress-Archive -LiteralPath @(${members.map((member) => psQuote(path.join(payload, member))).join(',')}) -DestinationPath ${psQuote(file)}`,
          ],
          { env },
        )
      : checked('tar', ['-czf', file, '-C', payload, ...members], { env });
    expect(packed.status, packed.stderr).toBe(0);
    return file;
  };
  return {
    root,
    dir,
    live,
    env,
    archive,
    install,
    installArgs,
    launch,
    assertOld() {
      expect(tree(live)).toEqual(oldTree);
      expect(launch()).toBe('OLD_PREVIEW');
    },
    assertProtected() {
      expect(tree(protectedRoot)).toEqual(initialProtected);
      expect(tree(path.join(root, 'home'))).toEqual(initialHome);
      expect(process.env.PATH).toBe(initialPath);
      expect(readFileSync(path.join(dir, 'outside-preview-data'), 'utf8')).toBe(
        'PRESERVE_SIBLING\n',
      );
    },
    assertNoStaging() {
      expect(readdirSync(dir).sort()).toEqual([
        'outside-preview-data',
        'qwen-code',
      ]);
    },
  };
}

async function withFixture(check) {
  const f = fixture();
  try {
    await check(f);
    f.assertProtected();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

function rejected(result) {
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
}

describe(`real ${windows ? 'PowerShell' : 'POSIX'} preview installer preservation`, () => {
  it.each(['truncated', 'bad-format'])(
    'rejects %s archives without deleting the prior executable or data',
    async (kind) => {
      await withFixture(async (f) => {
        const file = path.join(f.root, `broken.${windows ? 'zip' : 'tar.gz'}`);
        writeFileSync(
          file,
          kind === 'truncated'
            ? Buffer.from(windows ? '504b0304' : '1f8b0800000000000003', 'hex')
            : Buffer.from('THIS_IS_NOT_AN_ARCHIVE\n'),
        );
        rejected(f.install(file));
        f.assertOld();
        f.assertNoStaging();
      });
    },
  );

  it('rejects an extractable package missing the launcher/runtime structure', async () => {
    await withFixture(async (f) => {
      rejected(f.install(f.archive('invalid-structure', 'invalid')));
      f.assertOld();
      f.assertNoStaging();
    });
  });

  it('rejects an archive with an unexpected top-level member before activation', async () => {
    await withFixture(async (f) => {
      rejected(f.install(f.archive('outside', 'outside')));
      f.assertOld();
      expect(existsSync(path.join(f.dir, 'unexpected-top-level'))).toBe(false);
      f.assertNoStaging();
    });
  });

  it('activates a complete preview and leaves classic entry, PATH config and siblings alone', async () => {
    await withFixture(async (f) => {
      const result = f.install(f.archive('complete'));
      expect(result.status, result.stderr).toBe(0);
      expect(f.launch()).toBe('NEW_PREVIEW');
      expect(
        readFileSync(path.join(f.live, 'userdata-sentinel.txt'), 'utf8'),
      ).toBe('NEW_PREVIEW_USERDATA_甲\n');
      expect(
        existsSync(path.join(f.live, 'bun', windows ? 'bun.exe' : 'bin/bun')),
      ).toBe(true);
      f.assertNoStaging();
    });
  });

  it('rejects a non-directory live destination without removing its contents', async () => {
    await withFixture(async (f) => {
      const file = f.archive('non-directory');
      rmSync(f.live, { recursive: true });
      writeFileSync(f.live, 'OWNED_EXISTING_FILE\n');
      const before = tree(f.live);
      rejected(f.install(file));
      expect(tree(f.live)).toEqual(before);
      f.assertNoStaging();
    });
  });

  it('rejects a live symlink or junction without touching its target', async () => {
    await withFixture(async (f) => {
      const file = f.archive('linked');
      const external = path.join(f.root, 'owned-other-install');
      mkdirSync(external);
      put(path.join(external, 'userdata'), 'LINK_TARGET_DATA\n');
      const before = tree(external);
      rmSync(f.live, { recursive: true });
      symlinkSync(external, f.live, windows ? 'junction' : 'dir');
      const link = readlinkSync(f.live);
      rejected(f.install(file));
      expect(lstatSync(f.live).isSymbolicLink()).toBe(true);
      expect(readlinkSync(f.live)).toBe(link);
      expect(tree(external)).toEqual(before);
      f.assertNoStaging();
    });
  });

  it('rejects an occupied install lock without modifying the active install or lock owner', async () => {
    await withFixture(async (f) => {
      const file = f.archive('occupied-lock');
      const lock = path.join(f.dir, '.qwen-preview-install.lock');
      if (windows) writeFileSync(lock, 'OTHER_INSTALLER\n');
      else {
        mkdirSync(lock);
        put(path.join(lock, 'owner'), 'OTHER_INSTALLER\n');
      }
      const before = tree(lock);
      rejected(f.install(file));
      f.assertOld();
      expect(tree(lock)).toEqual(before);
    });
  });
});

it.skipIf(windows)(
  'rejects a real archive symlink without touching its owned target',
  async () => {
    await withFixture(async (f) => {
      const file = f.archive('linked-entry', 'symlink');
      const external = path.join(f.root, 'archive-link-target-linked-entry');
      const before = tree(external);
      rejected(f.install(file));
      f.assertOld();
      expect(tree(external)).toEqual(before);
      f.assertNoStaging();
    });
  },
);

it.skipIf(windows)(
  'restores the prior tree if actual final activation fails',
  async () => {
    await withFixture(async (f) => {
      const file = f.archive('failed-activation');
      const shims = path.join(f.root, 'shims');
      const activationAttempt = path.join(f.root, 'activation-attempted');
      put(
        path.join(shims, 'mv'),
        '#!/bin/sh\n' +
          'for arg do\n' +
          ` case "$arg" in */.qwen-preview-stage.*/qwen-code) : > ${quote(activationAttempt)}; exit 71 ;; esac\n` +
          'done\nexec /bin/mv "$@"\n',
        true,
      );
      const result = f.install(file, { PATH: `${shims}:${f.env.PATH}` });
      rejected(result);
      expect(existsSync(activationAttempt)).toBe(true);
      expect(result.stderr).toContain('failed to activate preview');
      f.assertOld();
      f.assertNoStaging();
    });
  },
);

it.skipIf(windows)(
  'excludes a second real installer while the first extracts',
  async () => {
    await withFixture(async (f) => {
      const file = f.archive('concurrent');
      const shims = path.join(f.root, 'shims');
      const ready = path.join(f.root, 'extracting');
      const release = path.join(f.root, 'release-extraction');
      put(
        path.join(shims, 'tar'),
        '#!/bin/sh\n' +
          'if [ "$1" = -xzf ]; then\n' +
          ` : > ${quote(ready)}\n` +
          ' n=0\n' +
          ` while [ ! -f ${quote(release)} ]; do\n` +
          '  n=$((n + 1)); [ "$n" -lt 100 ] || exit 72\n' +
          '  sleep 0.05\n done\nfi\nexec /usr/bin/tar "$@"\n',
        true,
      );
      const first = spawn('/bin/sh', f.installArgs(file), {
        cwd: f.root,
        env: { ...f.env, PATH: `${shims}:${f.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      first.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      first.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const exited = new Promise((resolve, reject) => {
        first.once('error', reject);
        first.once('exit', (code, signal) => resolve({ code, signal }));
      });
      try {
        const deadline = Date.now() + 4000;
        while (!existsSync(ready) && Date.now() < deadline) await delay(20);
        expect(existsSync(ready), stdout + stderr).toBe(true);
        rejected(f.install(file));
        f.assertOld();
      } finally {
        writeFileSync(release, 'RELEASE\n');
        const result = await exited;
        expect(result, stdout + stderr).toEqual({ code: 0, signal: null });
      }
      expect(f.launch()).toBe('NEW_PREVIEW');
      f.assertNoStaging();
    });
  },
);
