/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as tar from 'tar';
import {
  acquireLock,
  rollbackStandaloneUpdate,
  ensureBinWrapper,
  ensurePathInShellRc,
  cleanupFirstTimeMigrationArtifacts,
  performStandaloneUpdate,
  prepareStandaloneUpdate,
  isSafeTarEntryPath,
  isSafeTarEntry,
  isSafeTarLinkTarget,
} from './standalone-update.js';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/load-undici.js', () => ({
  loadUndici: async () => ({ fetch: mockFetch }),
}));

// Arms rmSync failures for specific paths only; every other call delegates.
// (The ESM namespace cannot be spied on directly, so this is the seam.)
const rmSyncFailures = vi.hoisted(() => ({
  targets: [] as string[],
  smoke: false,
}));
const allocations = vi.hoisted(() => ({ prefixes: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
      allocations.prefixes.push(String(args[0]));
      const directory = actual.mkdtempSync(...args);
      if (
        rmSyncFailures.smoke &&
        String(args[0]).endsWith('qwen-code-smoke-')
      ) {
        rmSyncFailures.targets.push(directory);
      }
      return directory;
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const target = String(args[0]);
      if (rmSyncFailures.targets.includes(target)) {
        throw new Error(`EBUSY: resource busy or locked at ${target}`);
      }
      return actual.rmSync(...args);
    },
  };
});

describe('standalone-update', () => {
  let testRoot: string;
  let tempDir: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-update-test-'));
    tempDir = path.join(testRoot, 'work');
    fs.mkdirSync(tempDir);
    vi.stubEnv('HOME', testRoot);
    vi.stubEnv('SHELL', '');
    vi.stubEnv('QWEN_UPDATE_BASE_URL', undefined);
    vi.stubEnv('QWEN_REQUIRE_SIGNATURE', undefined);
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe('rollbackStandaloneUpdate', () => {
    it('returns no-old when .old directory does not exist', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      fs.mkdirSync(standaloneDir);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
        }),
      );

      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result.ok).toBe(false);
      expect(result).toHaveProperty('reason', 'no-old');
    });

    it('returns no-manifest when .old directory has no manifest.json', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
        }),
      );

      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result.ok).toBe(false);
      expect(result).toHaveProperty('reason', 'no-manifest');
    });

    it('swaps current with .old directory on valid rollback', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);

      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
          version: '0.17.0',
        }),
      );
      fs.writeFileSync(path.join(standaloneDir, 'marker.txt'), 'new');

      fs.writeFileSync(
        path.join(oldDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
          version: '0.16.2',
        }),
      );
      fs.writeFileSync(path.join(oldDir, 'marker.txt'), 'old');

      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result.ok).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf-8'),
      );
      expect(manifest.version).toBe('0.16.2');
      expect(
        fs.readFileSync(path.join(standaloneDir, 'marker.txt'), 'utf-8'),
      ).toBe('old');
      expect(fs.existsSync(oldDir)).toBe(false);
    });

    it('succeeds even with minimal manifest in .old', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);

      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.17.0' }),
      );
      fs.writeFileSync(path.join(oldDir, 'manifest.json'), '{}');

      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result.ok).toBe(true);
    });
  });

  describe('ensureBinWrapper', () => {
    it('uses an independent launcher wait budget in the deferred Windows swap script', () => {
      const source = fs.readFileSync(
        path.resolve('src/ui/standalone-update.ts'),
        'utf8',
      );

      expect(source).toContain('set /a TRIES=0');
      expect(source).toContain('set /a LAUNCHER_TRIES=0');
      expect(source).toContain('goto wait_launcher');
    });

    // Unix wrapper test relies on POSIX file permissions (mode bits) and
    // the SHELL env var, neither of which behave consistently on Windows.
    it.skipIf(process.platform === 'win32')(
      'creates a Unix shell wrapper script',
      () => {
        const libDir = path.join(tempDir, '.local', 'lib');
        const standaloneDir = path.join(libDir, 'qwen-code');
        fs.mkdirSync(standaloneDir, { recursive: true });

        // Isolate HOME so ensurePathInShellRc doesn't touch real shell rc
        const origHome = process.env['HOME'];
        const origShell = process.env['SHELL'];
        process.env['HOME'] = tempDir;
        process.env['SHELL'] = '/bin/zsh';
        try {
          ensureBinWrapper(standaloneDir, 'darwin-arm64');
        } finally {
          process.env['HOME'] = origHome;
          process.env['SHELL'] = origShell;
        }

        const wrapperPath = path.join(tempDir, '.local', 'bin', 'qwen');
        expect(fs.existsSync(wrapperPath)).toBe(true);
        const content = fs.readFileSync(wrapperPath, 'utf-8');
        expect(content).toContain('#!/usr/bin/env sh');
        expect(content).toContain(standaloneDir);
        const mode = fs.statSync(wrapperPath).mode;
        expect(mode & 0o111).toBeGreaterThan(0);
      },
    );

    it('creates a Windows cmd wrapper', () => {
      const libDir = path.join(tempDir, '.local', 'lib');
      const standaloneDir = path.join(libDir, 'qwen-code');
      fs.mkdirSync(standaloneDir, { recursive: true });

      ensureBinWrapper(standaloneDir, 'win-x64');

      const wrapperPath = path.join(tempDir, '.local', 'bin', 'qwen.cmd');
      expect(fs.existsSync(wrapperPath)).toBe(true);
      const content = fs.readFileSync(wrapperPath, 'utf-8');
      expect(content).toContain('@echo off');
    });

    it.skipIf(process.platform === 'win32')(
      'escapes single quotes in Unix wrapper paths',
      () => {
        const libDir = path.join(tempDir, "o'brien", '.local', 'lib');
        const standaloneDir = path.join(libDir, 'qwen-code');
        fs.mkdirSync(standaloneDir, { recursive: true });

        const origHome = process.env['HOME'];
        const origShell = process.env['SHELL'];
        process.env['HOME'] = tempDir;
        process.env['SHELL'] = '/bin/zsh';
        try {
          ensureBinWrapper(standaloneDir, 'linux-x64');
        } finally {
          process.env['HOME'] = origHome;
          process.env['SHELL'] = origShell;
        }

        const wrapperPath = path.join(
          tempDir,
          "o'brien",
          '.local',
          'bin',
          'qwen',
        );
        const content = fs.readFileSync(wrapperPath, 'utf-8');
        expect(content).toContain("o'\\''brien");
      },
    );

    it.skipIf(process.platform === 'win32')(
      'allows shell metacharacters in single-quoted Unix wrapper paths',
      () => {
        const libDir = path.join(tempDir, 'with$dollar', '.local', 'lib');
        const standaloneDir = path.join(libDir, 'qwen-code');
        fs.mkdirSync(standaloneDir, { recursive: true });

        const origHome = process.env['HOME'];
        const origShell = process.env['SHELL'];
        process.env['HOME'] = tempDir;
        process.env['SHELL'] = '/bin/zsh';
        try {
          ensureBinWrapper(standaloneDir, 'linux-x64');
        } finally {
          process.env['HOME'] = origHome;
          process.env['SHELL'] = origShell;
        }

        const wrapperPath = path.join(
          tempDir,
          'with$dollar',
          '.local',
          'bin',
          'qwen',
        );
        const content = fs.readFileSync(wrapperPath, 'utf-8');
        expect(content).toContain('with$dollar');
      },
    );

    it.skipIf(process.platform === 'win32')(
      'does not overwrite existing wrapper',
      () => {
        const libDir = path.join(tempDir, '.local', 'lib');
        const standaloneDir = path.join(libDir, 'qwen-code');
        const binDir = path.join(tempDir, '.local', 'bin');
        fs.mkdirSync(standaloneDir, { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        const origHome = process.env['HOME'];
        const origShell = process.env['SHELL'];
        process.env['HOME'] = tempDir;
        process.env['SHELL'] = '/bin/zsh';

        const wrapperPath = path.join(binDir, 'qwen');
        fs.writeFileSync(wrapperPath, 'existing-content', { mode: 0o755 });

        try {
          ensureBinWrapper(standaloneDir, 'linux-x64');
          expect(fs.readFileSync(wrapperPath, 'utf-8')).toBe(
            'existing-content',
          );
        } finally {
          process.env['HOME'] = origHome;
          process.env['SHELL'] = origShell;
        }
      },
    );

    it.skipIf(process.platform === 'win32')(
      'throws when wrapper creation fails safety validation',
      () => {
        const libDir = path.join(tempDir, 'bad\npath', '.local', 'lib');
        const standaloneDir = path.join(libDir, 'qwen-code');
        fs.mkdirSync(standaloneDir, { recursive: true });

        expect(() => ensureBinWrapper(standaloneDir, 'linux-x64')).toThrow(
          'Failed to create bin wrapper',
        );
      },
    );
  });

  describe('performStandaloneUpdate', () => {
    it('rejects invalid version format', async () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      fs.mkdirSync(standaloneDir);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
        }),
      );

      await expect(
        performStandaloneUpdate(standaloneDir, 'not-a-version'),
      ).rejects.toThrow('Invalid version format');
    });

    it('rejects directory without manifest as non-managed install', async () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      fs.mkdirSync(standaloneDir);
      // No manifest.json — could be user data

      await expect(
        performStandaloneUpdate(standaloneDir, '1.0.0'),
      ).rejects.toThrow('not a Qwen Code standalone install');
    });

    it('rejects unknown target in manifest', async () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      fs.mkdirSync(standaloneDir);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'freebsd-mips',
        }),
      );

      await expect(
        performStandaloneUpdate(standaloneDir, '1.0.0'),
      ).rejects.toThrow('Unknown target');
    });

    it('fails gracefully when another update is in progress', async () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const parentDir = path.dirname(standaloneDir);
      fs.mkdirSync(standaloneDir, { recursive: true });
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'darwin-arm64',
        }),
      );

      // Simulate held lock from a live process (current PID)
      const lockPath = path.join(parentDir, '.qwen-update.lock');
      fs.writeFileSync(lockPath, String(process.pid));

      await expect(
        performStandaloneUpdate(standaloneDir, '1.0.0'),
      ).rejects.toThrow('Another update is already in progress');

      // Clean up lock
      fs.unlinkSync(lockPath);
    });

    it('self-heals a leftover pending swap behind a stale lock', async () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const parentDir = path.dirname(standaloneDir);
      fs.mkdirSync(standaloneDir, { recursive: true });
      fs.mkdirSync(`${standaloneDir}.new`);
      // Age the residue past the staleness bound: a marker-less .new only
      // heals when no in-flight swap can still own it.
      const aged = new Date(Date.now() - 16 * 60 * 1000);
      fs.utimesSync(`${standaloneDir}.new`, aged, aged);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({
          name: '@qwen-code/qwen-code',
          target: 'win-x64',
        }),
      );

      const lockPath = path.join(parentDir, '.qwen-update.lock');
      fs.writeFileSync(lockPath, '999999999');

      // No deferred bat process is alive, so the stale .new residue must not
      // block the update; it is removed and the run proceeds past the swap
      // check (it then fails for an unrelated reason: no fetch mock here).
      const err = await performStandaloneUpdate(standaloneDir, '1.0.0').catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain('pending swap');
      expect(fs.existsSync(`${standaloneDir}.new`)).toBe(false);
    });
  });

  describe('download sources', () => {
    const baseUrl = 'https://downloads.example.com/qwen-code';
    const filename = 'qwen-code-linux-x64.tar.gz';
    let standaloneDir: string;
    let originalManifest: string;

    beforeEach(() => {
      standaloneDir = path.join(tempDir, 'installed');
      originalManifest = JSON.stringify({
        target: 'linux-x64',
        version: '0.1.0',
      });
      fs.mkdirSync(standaloneDir);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        originalManifest,
      );
    });

    function expectInstallationPreserved() {
      expect(
        fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
      ).toBe(originalManifest);
      expect(fs.existsSync(`${standaloneDir}.old`)).toBe(false);
      expect(fs.existsSync(path.join(tempDir, '.qwen-update.lock'))).toBe(
        false,
      );
      expect(
        fs
          .readdirSync(tempDir)
          .some((entry) => entry.startsWith('.qwen-code-update-')),
      ).toBe(false);
    }

    async function serveArchive(
      options: {
        badChecksum?: boolean;
        runnable?: boolean;
        runtime?: 'node' | 'bun';
        manifest?: Record<string, unknown>;
        rawManifest?: string;
        target?: string;
        interpreterIdentity?: string;
        interpreterPath?: string;
        interpreterExitCode?: number;
        cliSource?: string;
      } = {},
    ) {
      const fixtureTarget = options.target ?? 'linux-x64';
      const archiveFilename =
        options.target || options.runtime === 'bun'
          ? `qwen-code-${fixtureTarget}${options.runtime === 'bun' ? '-opentui-preview' : ''}.tar.gz`
          : filename;
      const fixture = path.join(tempDir, 'fixture');
      fs.mkdirSync(path.join(fixture, 'qwen-code'), { recursive: true });
      fs.writeFileSync(
        path.join(fixture, 'qwen-code', 'manifest.json'),
        options.rawManifest ??
          JSON.stringify({
            target: fixtureTarget,
            version: '1.2.3',
            name: '@qwen-code/qwen-code',
            runtime: options.runtime ?? 'node',
            ...options.manifest,
          }),
      );
      if (options.runnable) {
        fs.mkdirSync(
          path.join(fixture, 'qwen-code', options.runtime ?? 'node', 'bin'),
          {
            recursive: true,
          },
        );
        fs.mkdirSync(path.join(fixture, 'qwen-code', 'lib'));
        fs.writeFileSync(
          path.join(
            fixture,
            'qwen-code',
            options.runtime ?? 'node',
            'bin',
            options.runtime ?? 'node',
          ),
          `#!/bin/sh\nif [ "$1" = "-e" ]; then\n  printf '%s\\n' '${options.interpreterIdentity ?? JSON.stringify({ runtime: options.runtime ?? 'node', platform: fixtureTarget.split('-')[0], arch: fixtureTarget.split('-')[1] })}'\n  exit ${options.interpreterExitCode ?? 0}\nelse\n  printf "1.2.3\\n"\nfi\n`,
          { mode: 0o755 },
        );
        fs.writeFileSync(path.join(fixture, 'qwen-code', 'lib', 'cli.js'), '');
        fs.writeFileSync(
          path.join(fixture, 'qwen-code', 'lib', 'cli-entry.js'),
          'import "./cli.js";',
        );
      }
      if (options.interpreterPath) {
        const runtime = options.runtime ?? 'node';
        const interpreter = path.join(
          fixture,
          'qwen-code',
          runtime,
          'bin',
          runtime,
        );
        fs.copyFileSync(options.interpreterPath, interpreter);
        fs.chmodSync(interpreter, 0o755);
        fs.writeFileSync(
          path.join(fixture, 'qwen-code', 'lib', 'cli.js'),
          options.cliSource ?? 'console.log("1.2.3");',
        );
      }
      const archivePath = path.join(tempDir, 'release.tar.gz');
      await tar.c({ gzip: true, cwd: fixture, file: archivePath }, [
        'qwen-code',
      ]);
      const archive = fs.readFileSync(archivePath);
      const checksum = options.badChecksum
        ? '0'.repeat(64)
        : createHash('sha256').update(archive).digest('hex');
      mockFetch.mockImplementation(async (url: string) => {
        if (url.endsWith(`/${archiveFilename}`)) {
          return new Response(new Uint8Array(archive));
        }
        if (url.endsWith('/SHA256SUMS')) {
          return new Response(`${checksum}  ${archiveFilename}\n`);
        }
        return new Response('', { status: 404 });
      });
    }

    it.each([
      ['direct', 'deno'],
      ['direct', null],
      ['prepared', 'deno'],
      ['prepared', null],
    ])(
      'rejects an unknown installed runtime before download (%s, %s)',
      async (mode, runtime) => {
        originalManifest = JSON.stringify({ target: 'linux-x64', runtime });
        fs.writeFileSync(
          path.join(standaloneDir, 'manifest.json'),
          originalManifest,
        );
        fs.writeFileSync(path.join(standaloneDir, 'sentinel'), 'live');
        const backup = `${standaloneDir}.old`;
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'sentinel'), 'backup');
        await expect(
          mode === 'prepared'
            ? prepareStandaloneUpdate(standaloneDir, '1.2.3')
            : performStandaloneUpdate(standaloneDir, '1.2.3'),
        ).rejects.toThrow('Unknown standalone runtime');
        expect(mockFetch).not.toHaveBeenCalled();
        expect(
          fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
        ).toBe(originalManifest);
        expect(
          fs.readFileSync(path.join(standaloneDir, 'sentinel'), 'utf8'),
        ).toBe('live');
        expect(fs.readFileSync(path.join(backup, 'sentinel'), 'utf8')).toBe(
          'backup',
        );
        expect(fs.readdirSync(tempDir).sort()).toEqual([
          'installed',
          'installed.old',
        ]);
      },
    );

    it.each(['direct', 'prepared'] as const)(
      'rejects malformed installed manifests before allocations (%s)',
      async (mode) => {
        const downloadTmp = path.join(tempDir, 'download-tmp');
        fs.mkdirSync(downloadTmp);
        for (const name of ['TMPDIR', 'TEMP', 'TMP']) {
          vi.stubEnv(name, downloadTmp);
        }
        const backup = `${standaloneDir}.old`;
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'sentinel'), 'backup');
        for (const raw of [
          'null',
          '123',
          '[]',
          'true',
          '"private manifest content"',
          '{',
        ]) {
          fs.writeFileSync(path.join(standaloneDir, 'manifest.json'), raw);
          const start = allocations.prefixes.length;
          await expect(
            mode === 'prepared'
              ? prepareStandaloneUpdate(standaloneDir, '1.2.3')
              : performStandaloneUpdate(standaloneDir, '1.2.3'),
          ).rejects.toThrow(
            `Invalid installed standalone manifest at ${path.join(standaloneDir, 'manifest.json')}. ` +
              "Restore this installation's manifest from a known-good backup, or " +
              'reinstall the same runtime flavor in a new directory. ' +
              'Keep the current installation and backup until recovery is verified.',
          );
          expect(allocations.prefixes.slice(start)).toEqual([]);
          expect(mockFetch).not.toHaveBeenCalled();
          expect(
            fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
          ).toBe(raw);
          expect(fs.readFileSync(path.join(backup, 'sentinel'), 'utf8')).toBe(
            'backup',
          );
          expect(fs.readdirSync(downloadTmp)).toEqual([]);
          expect(fs.readdirSync(tempDir).sort()).toEqual([
            'download-tmp',
            'installed',
            'installed.old',
          ]);
        }
        // Positive control for both allocation families on the same observer.
        await serveArchive();
        const start = allocations.prefixes.length;
        fs.writeFileSync(
          path.join(standaloneDir, 'manifest.json'),
          originalManifest,
        );
        const pending = await prepareStandaloneUpdate(standaloneDir, '1.2.3');
        try {
          await expect(pending.activate()).rejects.toThrow(
            'Smoke test failed:',
          );
          expect(
            allocations.prefixes
              .slice(start)
              .some((p) => path.basename(p) === 'qwen-code-update-'),
          ).toBe(true);
          expect(
            allocations.prefixes
              .slice(start)
              .some((p) => path.basename(p) === '.qwen-code-update-'),
          ).toBe(true);
        } finally {
          pending.cleanup();
        }
        expect(fs.readdirSync(downloadTmp)).toEqual([]);
      },
    );

    it('retains the legacy Node fallback when the installed runtime is absent', async () => {
      await serveArchive();
      const pending = await prepareStandaloneUpdate(standaloneDir, '1.2.3');
      try {
        expect(mockFetch.mock.calls[0][0]).toContain(
          '/qwen-code-linux-x64.tar.gz',
        );
        expectInstallationPreserved();
      } finally {
        pending.cleanup();
      }
    });

    it.skipIf(process.platform === 'win32')(
      'keeps the Bun preview runtime through activation and rollback',
      async () => {
        const installed = path.join(tempDir, 'installed');
        fs.mkdirSync(installed, { recursive: true });
        const oldManifest = JSON.stringify({
          target: 'linux-x64',
          runtime: 'bun',
          version: '1.0.0',
        });
        fs.writeFileSync(path.join(installed, 'manifest.json'), oldManifest);
        await serveArchive({ runnable: true, runtime: 'bun' });
        const prepared = await prepareStandaloneUpdate(installed, '1.2.3');
        expect(mockFetch.mock.calls[0][0]).toContain(
          'qwen-code-linux-x64-opentui-preview.tar.gz',
        );
        expect(await prepared.activate()).toBe('done');
        expect(
          JSON.parse(
            fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'),
          ).runtime,
        ).toBe('bun');
        expect(rollbackStandaloneUpdate(installed)).toEqual({ ok: true });
        expect(
          fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'),
        ).toBe(oldManifest);
      },
    );

    it.skipIf(process.platform === 'win32').each(['front', 'exit'])(
      'updates with a real interpreter despite inherited %s preload output',
      async (mode) => {
        const runtime = process.versions['bun'] ? 'bun' : 'node';
        const target = `${os.platform()}-${os.arch()}`;
        const preload = path.join(tempDir, 'tracer.cjs');
        fs.writeFileSync(
          preload,
          mode === 'front'
            ? 'console.log("synthetic-secret-front");'
            : 'process.on("exit", () => console.log("synthetic-secret-exit"));',
        );
        vi.stubEnv('NODE_OPTIONS', `--require ${preload}`);
        vi.stubEnv('BUN_OPTIONS', `--preload ${preload}`);
        vi.stubEnv('QWEN_UPDATE_TEST_ENV', 'preserved');
        vi.stubEnv('CLI_VERSION', '9.9.9');
        vi.stubEnv('QWEN_CODE_RELAUNCH_ARGS', '["--help"]');
        vi.stubEnv('cli_version', '9.9.9');
        vi.stubEnv('qwen_code_relaunch_args', '["--help"]');
        for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, tempDir);
        const installedManifest = JSON.stringify({ target, runtime });
        fs.writeFileSync(
          path.join(standaloneDir, 'manifest.json'),
          installedManifest,
        );
        await serveArchive({
          runnable: true,
          runtime,
          target,
          interpreterPath: process.execPath,
          cliSource:
            'if (process.env.QWEN_UPDATE_TEST_ENV !== "preserved" || Object.keys(process.env).some(key => /^(CLI_VERSION|QWEN_CODE_RELAUNCH_ARGS)$/i.test(key))) process.exit(9); console.log("1.2.3");',
        });
        expect(await performStandaloneUpdate(standaloneDir, '1.2.3')).toBe(
          'done',
        );
        expect(
          JSON.parse(
            fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
          ).version,
        ).toBe('1.2.3');
        expect(process.env['NODE_OPTIONS']).toContain(preload);
        expect(process.env['BUN_OPTIONS']).toContain(preload);
        expect(process.env['CLI_VERSION']).toBe('9.9.9');
        expect(process.env['QWEN_CODE_RELAUNCH_ARGS']).toBe('["--help"]');
        expect(process.env['cli_version']).toBe('9.9.9');
        expect(process.env['qwen_code_relaunch_args']).toBe('["--help"]');
        expect(
          fs
            .readdirSync(tempDir)
            .filter(
              (entry) =>
                entry.startsWith('.qwen-code-update-') ||
                entry.startsWith('qwen-code-update-'),
            ),
        ).toEqual([]);
        expect(rollbackStandaloneUpdate(standaloneDir)).toEqual({ ok: true });
        expect(
          fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
        ).toBe(installedManifest);
      },
    );

    it.skipIf(process.platform === 'win32').each([
      [
        'malformed',
        'synthetic-secret-not-json',
        0,
        'invalid interpreter identity',
      ],
      [
        'multiple records',
        '{"runtime":"node","platform":"linux","arch":"x64"}\n{"runtime":"bun","platform":"linux","arch":"x64"}',
        0,
        'invalid interpreter identity',
      ],
      [
        'nonzero exit',
        '{"runtime":"node","platform":"linux","arch":"x64"}',
        7,
        'interpreter identity does not match',
      ],
    ])(
      'rejects %s identity without exposing output or changing the installation',
      async (_name, identity, exitCode, message) => {
        for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, tempDir);
        const backup = `${standaloneDir}.old`;
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'sentinel'), 'backup');
        await serveArchive({
          runnable: true,
          interpreterIdentity: String(identity),
          interpreterExitCode: Number(exitCode),
        });
        const error = await performStandaloneUpdate(
          standaloneDir,
          '1.2.3',
        ).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain(message);
        expect(String(error)).not.toContain('synthetic-secret');
        expect(String(error)).not.toContain(String(identity));
        expect(
          fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
        ).toBe(originalManifest);
        expect(fs.readFileSync(path.join(backup, 'sentinel'), 'utf8')).toBe(
          'backup',
        );
        expect(fs.existsSync(path.join(tempDir, '.qwen-update.lock'))).toBe(
          false,
        );
        expect(
          fs
            .readdirSync(tempDir)
            .filter(
              (entry) =>
                entry.startsWith('.qwen-code-update-') ||
                entry.startsWith('qwen-code-update-'),
            ),
        ).toEqual([]);
      },
    );

    it.skipIf(process.platform === 'win32').each([
      [
        'version output',
        'console.log("synthetic-secret-version");',
        'unexpected version output',
      ],
      [
        'CLI exit',
        'console.error("synthetic-secret-stderr"); process.exit(7);',
        'new binary exited with code 7',
      ],
      [
        'invalid numeric semver',
        'console.log("01.2.3");',
        'CLI version does not match the expected version',
      ],
    ])(
      'redacts real interpreter %s errors and preserves the rollback installation',
      async (_name, cliSource, message) => {
        for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, tempDir);
        const runtime = process.versions['bun'] ? 'bun' : 'node';
        const target = `${os.platform()}-${os.arch()}`;
        originalManifest = JSON.stringify({ target, runtime });
        fs.writeFileSync(
          path.join(standaloneDir, 'manifest.json'),
          originalManifest,
        );
        const backup = `${standaloneDir}.old`;
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'sentinel'), 'backup');
        await serveArchive({
          runnable: true,
          target,
          runtime,
          interpreterPath: process.execPath,
          cliSource,
        });
        const error = await performStandaloneUpdate(
          standaloneDir,
          '1.2.3',
        ).catch((error: unknown) => error);
        expect(String(error)).toContain(message);
        expect(String(error)).not.toContain('synthetic-secret');
        expect(
          fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
        ).toBe(originalManifest);
        expect(fs.readFileSync(path.join(backup, 'sentinel'), 'utf8')).toBe(
          'backup',
        );
        expect(fs.existsSync(path.join(tempDir, '.qwen-update.lock'))).toBe(
          false,
        );
        expect(
          fs
            .readdirSync(tempDir)
            .filter(
              (entry) =>
                entry.startsWith('.qwen-code-update-') ||
                entry.startsWith('qwen-code-update-'),
            ),
        ).toEqual([]);
      },
    );

    it.skipIf(process.platform === 'win32').each([
      ['direct', '0.0.9', false],
      ['direct', '9.9.9', false],
      ['prepared', '0.0.9', false],
      ['prepared', '9.9.9', false],
      ['direct', '0.0.9', true],
      ['direct', '9.9.9', true],
      ['prepared', '0.0.9', true],
      ['prepared', '9.9.9', true],
    ])(
      'rejects a legal CLI version mismatch before replacing live or backup (%s, %s, ambient: %s)',
      async (mode, actualVersion, ambient) => {
        if (ambient) vi.stubEnv('CLI_VERSION', '1.2.3');
        for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, tempDir);
        const runtime = process.versions['bun'] ? 'bun' : 'node';
        const target = `${os.platform()}-${os.arch()}`;
        originalManifest = JSON.stringify({
          target,
          runtime,
          version: '0.1.0',
        });
        fs.writeFileSync(
          path.join(standaloneDir, 'manifest.json'),
          originalManifest,
        );
        const backup = `${standaloneDir}.old`;
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'sentinel'), 'backup');
        await serveArchive({
          runnable: true,
          runtime,
          target,
          interpreterPath: process.execPath,
          cliSource: ambient
            ? `console.log(process.env.CLI_VERSION || ${JSON.stringify(actualVersion)});`
            : `console.log(${JSON.stringify(actualVersion)});`,
        });
        const envBefore = { ...process.env };
        const pending =
          mode === 'prepared'
            ? await prepareStandaloneUpdate(standaloneDir, '1.2.3')
            : undefined;
        try {
          await expect(
            pending
              ? pending.activate()
              : performStandaloneUpdate(standaloneDir, '1.2.3'),
          ).rejects.toThrow(
            'Smoke test failed: CLI version does not match the expected version',
          );
        } finally {
          pending?.cleanup();
        }
        expect({ ...process.env }).toEqual(envBefore);
        expect(
          fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
        ).toBe(originalManifest);
        expect(fs.readFileSync(path.join(backup, 'sentinel'), 'utf8')).toBe(
          'backup',
        );
        expect(fs.existsSync(path.join(tempDir, '.qwen-update.lock'))).toBe(
          false,
        );
        expect(
          fs
            .readdirSync(tempDir)
            .filter((entry) =>
              /^(?:\.?qwen-code-update-|qwen-code-smoke-)/.test(entry),
            ),
        ).toEqual([]);
      },
    );

    it.skipIf(process.platform === 'win32').each([false, true])(
      'preserves smoke outcome when cleanup fails (valid CLI: %s)',
      async (valid) => {
        for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, tempDir);
        const runtime = process.versions['bun'] ? 'bun' : 'node';
        const target = `${os.platform()}-${os.arch()}`;
        const installedManifest = JSON.stringify({ target, runtime });
        fs.writeFileSync(
          path.join(standaloneDir, 'manifest.json'),
          installedManifest,
        );
        const backup = `${standaloneDir}.old`;
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'sentinel'), 'backup');
        await serveArchive({
          runnable: true,
          runtime,
          target,
          interpreterPath: process.execPath,
          cliSource: valid
            ? 'console.log("1.2.3");'
            : 'console.log("synthetic-secret-version");',
        });
        rmSyncFailures.smoke = true;
        try {
          if (valid) {
            expect(await performStandaloneUpdate(standaloneDir, '1.2.3')).toBe(
              'done',
            );
            expect(rollbackStandaloneUpdate(standaloneDir)).toEqual({
              ok: true,
            });
          } else {
            const error = await performStandaloneUpdate(
              standaloneDir,
              '1.2.3',
            ).catch((error: unknown) => error);
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe(
              'Smoke test failed: unexpected version output',
            );
            expect(String(error)).not.toContain(tempDir);
            expect(String(error)).not.toContain('synthetic-secret');
            expect(
              fs.readFileSync(
                path.join(standaloneDir, 'manifest.json'),
                'utf8',
              ),
            ).toBe(installedManifest);
            expect(fs.readFileSync(path.join(backup, 'sentinel'), 'utf8')).toBe(
              'backup',
            );
          }
          expect(rmSyncFailures.targets).toHaveLength(1);
          // The injected removal failure leaves a directory; cleanup is retried by the test.
          expect(fs.existsSync(rmSyncFailures.targets[0])).toBe(true);
          expect(fs.existsSync(path.join(tempDir, '.qwen-update.lock'))).toBe(
            false,
          );
        } finally {
          rmSyncFailures.smoke = false;
          const retained = rmSyncFailures.targets.splice(0);
          for (const directory of retained)
            fs.rmSync(directory, { recursive: true, force: true });
        }
        expect(
          fs
            .readdirSync(tempDir)
            .filter((entry) => entry.startsWith('qwen-code-smoke-')),
        ).toEqual([]);
      },
    );

    it.skipIf(process.platform === 'win32').each(['direct', 'prepared'])(
      'rejects a real host interpreter disguised as the other runtime (%s)',
      async (mode) => {
        const runtime = process.versions['bun'] ? 'node' : 'bun';
        const target = `${os.platform()}-${os.arch()}`;
        const original = JSON.stringify({ target, runtime, version: '0.1.0' });
        fs.writeFileSync(path.join(standaloneDir, 'manifest.json'), original);
        fs.writeFileSync(
          path.join(standaloneDir, 'sentinel'),
          'active installation',
        );
        const backup = `${standaloneDir}.old`;
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'sentinel'), 'previous rollback');
        for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, tempDir);
        await serveArchive({
          runnable: true,
          runtime,
          target,
          interpreterPath: process.execPath,
        });
        const pending =
          mode === 'prepared'
            ? await prepareStandaloneUpdate(standaloneDir, '1.2.3')
            : undefined;
        if (pending) mockFetch.mockRejectedValue(new Error('offline'));
        const fetchCount = mockFetch.mock.calls.length;
        await expect(
          pending
            ? pending.activate()
            : performStandaloneUpdate(standaloneDir, '1.2.3'),
        ).rejects.toThrow(
          'interpreter identity does not match the expected runtime and target',
        );
        if (pending) expect(mockFetch).toHaveBeenCalledTimes(fetchCount);
        expect(
          fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
        ).toBe(original);
        expect(
          fs.readFileSync(path.join(standaloneDir, 'sentinel'), 'utf8'),
        ).toBe('active installation');
        expect(fs.readFileSync(path.join(backup, 'sentinel'), 'utf8')).toBe(
          'previous rollback',
        );
        expect(fs.existsSync(path.join(tempDir, '.qwen-update.lock'))).toBe(
          false,
        );
        expect(
          fs
            .readdirSync(tempDir)
            .filter(
              (entry) =>
                entry.startsWith('.qwen-code-update-') ||
                entry.startsWith('qwen-code-update-'),
            ),
        ).toEqual([]);
      },
    );

    it.skipIf(process.platform === 'win32').each([
      ['runtime', { runtime: 'node', platform: 'linux', arch: 'x64' }],
      ['platform', { runtime: 'bun', platform: 'darwin', arch: 'x64' }],
      ['arch', { runtime: 'bun', platform: 'linux', arch: 'arm64' }],
      ['shape', []],
    ])(
      'rejects a mismatched interpreter %s before replacement',
      async (_name, identity) => {
        fs.writeFileSync(
          path.join(standaloneDir, 'manifest.json'),
          JSON.stringify({
            target: 'linux-x64',
            runtime: 'bun',
            version: '0.1.0',
          }),
        );
        const original = fs.readFileSync(
          path.join(standaloneDir, 'manifest.json'),
          'utf8',
        );
        const backup = `${standaloneDir}.old`;
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'sentinel'), 'previous rollback');
        await serveArchive({
          runnable: true,
          runtime: 'bun',
          interpreterIdentity: JSON.stringify(identity),
        });
        const prepared = await prepareStandaloneUpdate(standaloneDir, '1.2.3');
        mockFetch.mockRejectedValue(new Error('offline'));
        await expect(prepared.activate()).rejects.toThrow(
          'interpreter identity',
        );
        expect(
          fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
        ).toBe(original);
        expect(fs.readFileSync(path.join(backup, 'sentinel'), 'utf8')).toBe(
          'previous rollback',
        );
        expect(fs.existsSync(path.join(tempDir, '.qwen-update.lock'))).toBe(
          false,
        );
        expect(
          fs
            .readdirSync(tempDir)
            .some(
              (entry) =>
                entry.startsWith('.qwen-code-update-') ||
                entry.startsWith('qwen-code-update-'),
            ),
        ).toBe(false);
      },
    );

    it.skipIf(process.platform === 'win32').each(['version', 'directory'])(
      'rejects a changed pending installation identity (%s) without touching its backup',
      async (change) => {
        for (const key of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(key, tempDir);
        vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
        await serveArchive({ runnable: true });
        const backup = `${standaloneDir}.old`;
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'sentinel'), 'previous rollback');
        const pending = await prepareStandaloneUpdate(standaloneDir, '1.2.3');
        if (change === 'version') {
          fs.writeFileSync(
            path.join(standaloneDir, 'manifest.json'),
            JSON.stringify({
              target: 'linux-x64',
              version: '0.1.0+concurrent',
            }),
          );
        } else {
          fs.renameSync(standaloneDir, `${standaloneDir}.displaced`);
          fs.mkdirSync(standaloneDir);
          fs.writeFileSync(
            path.join(standaloneDir, 'manifest.json'),
            originalManifest,
          );
        }
        const manifest = fs.readFileSync(
          path.join(standaloneDir, 'manifest.json'),
          'utf8',
        );
        await expect(pending.activate()).rejects.toThrow(
          'changed during download',
        );
        expect(
          fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
        ).toBe(manifest);
        expect(fs.readFileSync(path.join(backup, 'sentinel'), 'utf8')).toBe(
          'previous rollback',
        );
        expect(fs.existsSync(path.join(tempDir, '.qwen-update.lock'))).toBe(
          false,
        );
        expect(
          fs
            .readdirSync(tempDir)
            .some(
              (entry) =>
                entry.startsWith('.qwen-code-update-') ||
                entry.startsWith('qwen-code-update-'),
            ),
        ).toBe(false);
      },
    );

    it.skipIf(process.platform === 'win32').each([
      ['missing target', { target: undefined }, 'requires an explicit target'],
      ['null target', { target: null }, 'requires an explicit target'],
      ['unknown target', { target: 'plan9-x64' }, 'Unknown target'],
      [
        'wrong target',
        { target: 'linux-arm64' },
        'does not match the expected target, runtime and version',
      ],
      ['missing runtime', { runtime: undefined }, 'requires a valid runtime'],
      ['null runtime', { runtime: null }, 'requires a valid runtime'],
      ['unknown runtime', { runtime: 'deno' }, 'requires a valid runtime'],
      [
        'wrong runtime',
        { runtime: 'bun' },
        'does not match the expected target, runtime and version',
      ],
      [
        'missing name',
        { name: undefined },
        'Invalid downloaded standalone name or version',
      ],
      [
        'wrong name',
        { name: 'unrelated' },
        'Invalid downloaded standalone name or version',
      ],
      [
        'missing version',
        { version: undefined },
        'Invalid downloaded standalone name or version',
      ],
      [
        'invalid version',
        { version: 'invalid' },
        'Invalid downloaded standalone name or version',
      ],
      [
        'wrong version',
        { version: '1.2.4' },
        'does not match the expected target, runtime and version',
      ],
    ] as const)(
      'rejects a downloaded manifest with %s',
      async (_name, manifest, error) => {
        for (const key of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(key, tempDir);
        vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
        await serveArchive({ manifest, runnable: true });
        const backup = `${standaloneDir}.old`;
        fs.mkdirSync(backup);
        fs.writeFileSync(path.join(backup, 'sentinel'), 'previous rollback');
        await expect(
          performStandaloneUpdate(standaloneDir, '1.2.3'),
        ).rejects.toThrow(error);
        expect(
          fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
        ).toBe(originalManifest);
        expect(fs.readFileSync(path.join(backup, 'sentinel'), 'utf8')).toBe(
          'previous rollback',
        );
        expect(fs.existsSync(path.join(tempDir, '.qwen-update.lock'))).toBe(
          false,
        );
        expect(
          fs
            .readdirSync(tempDir)
            .some(
              (entry) =>
                entry.startsWith('.qwen-code-update-') ||
                entry.startsWith('qwen-code-update-'),
            ),
        ).toBe(false);
      },
    );

    it.each(['{', 'null', '[]'])(
      'rejects malformed or non-object downloaded JSON (%s)',
      async (rawManifest) => {
        vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
        await serveArchive({ rawManifest });
        await expect(
          performStandaloneUpdate(standaloneDir, '1.2.3'),
        ).rejects.toThrow();
        expectInstallationPreserved();
      },
    );

    it.skipIf(process.platform === 'win32')(
      'activates a prepared first npm migration with explicit Node metadata',
      async () => {
        vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
        vi.stubEnv('SHELL', '');
        await serveArchive({
          runnable: true,
          target: `${os.platform()}-${os.arch()}`,
        });
        fs.rmSync(standaloneDir, { recursive: true });
        const pending = await prepareStandaloneUpdate(standaloneDir, '1.2.3');
        expect(fs.existsSync(standaloneDir)).toBe(false);
        await expect(pending.activate()).resolves.toBe('done');
        expect(
          JSON.parse(
            fs.readFileSync(path.join(standaloneDir, 'manifest.json'), 'utf8'),
          ).runtime,
        ).toBe('node');
        expect(fs.existsSync(`${standaloneDir}.old`)).toBe(false);
        expect(fs.existsSync(path.join(tempDir, '.qwen-update.lock'))).toBe(
          false,
        );
      },
    );

    it('rejects a runtime switch while a verified update is prepared', async () => {
      const installed = path.join(tempDir, 'installed');
      fs.mkdirSync(installed, { recursive: true });
      fs.writeFileSync(
        path.join(installed, 'manifest.json'),
        JSON.stringify({
          target: 'linux-x64',
          runtime: 'bun',
          version: '1.0.0',
        }),
      );
      await serveArchive({ runnable: true, runtime: 'bun' });
      const prepared = await prepareStandaloneUpdate(installed, '1.2.3');
      const switched = JSON.stringify({
        target: 'linux-x64',
        runtime: 'node',
        version: '1.0.0',
      });
      fs.writeFileSync(path.join(installed, 'manifest.json'), switched);
      await expect(prepared.activate()).rejects.toThrow(
        'changed during download',
      );
      expect(
        fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'),
      ).toBe(switched);
      expect(fs.existsSync(`${installed}.old`)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')(
      'prepares a verified archive without changing the installation, then activates offline',
      async () => {
        vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
        vi.stubEnv('SHELL', '');
        await serveArchive({ runnable: true });
        const installed = path.join(tempDir, 'install', 'qwen-code');
        fs.mkdirSync(installed, { recursive: true });
        fs.writeFileSync(
          path.join(installed, 'manifest.json'),
          originalManifest,
        );
        const pending = await prepareStandaloneUpdate(installed, '1.2.3');
        try {
          expect(
            fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'),
          ).toBe(originalManifest);
          expect(fs.existsSync(`${installed}.old`)).toBe(false);
          expect(fs.readdirSync(path.dirname(installed))).toEqual([
            'qwen-code',
          ]);
          const fetchCount = mockFetch.mock.calls.length;
          mockFetch.mockRejectedValue(new Error('offline after download'));

          await expect(pending.activate()).resolves.toBe('done');

          expect(mockFetch).toHaveBeenCalledTimes(fetchCount);
          expect(
            JSON.parse(
              fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'),
            ),
          ).toMatchObject({ version: '1.2.3' });
          expect(
            fs.readFileSync(
              path.join(`${installed}.old`, 'manifest.json'),
              'utf8',
            ),
          ).toBe(originalManifest);
        } finally {
          pending.cleanup();
        }
      },
    );

    it.skipIf(process.platform === 'win32').each(['1.2.3', '1.2.4'])(
      'preserves an already installed version and its rollback when a prepared update becomes stale (%s)',
      async (installedVersion) => {
        vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
        vi.stubEnv('SHELL', '');
        await serveArchive({ runnable: true });
        const installed = path.join(tempDir, 'install', 'qwen-code');
        fs.mkdirSync(installed, { recursive: true });
        fs.writeFileSync(
          path.join(installed, 'manifest.json'),
          originalManifest,
        );
        const pending = await prepareStandaloneUpdate(installed, '1.2.3');
        const newerManifest = JSON.stringify({
          target: 'linux-x64',
          version: installedVersion,
        });
        const rollbackManifest = JSON.stringify({
          target: 'linux-x64',
          version: '1.2.2',
        });
        fs.writeFileSync(path.join(installed, 'manifest.json'), newerManifest);
        fs.mkdirSync(`${installed}.old`);
        fs.writeFileSync(
          path.join(`${installed}.old`, 'manifest.json'),
          rollbackManifest,
        );
        try {
          await expect(pending.activate()).resolves.toBe('done');
          expect(
            fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'),
          ).toBe(newerManifest);
          expect(
            fs.readFileSync(
              path.join(`${installed}.old`, 'manifest.json'),
              'utf8',
            ),
          ).toBe(rollbackManifest);
          expect(
            fs.existsSync(
              path.join(path.dirname(installed), '.qwen-update.lock'),
            ),
          ).toBe(false);
        } finally {
          pending.cleanup();
        }
      },
    );

    it('cleans downloaded archives after cancellation, verification failure and activation failure', async () => {
      vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
      for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, tempDir);
      const exitListeners = process.listenerCount('exit');
      const cachedArchives = () =>
        fs
          .readdirSync(tempDir)
          .filter((entry) => entry.startsWith('qwen-code-update-'));
      let pending:
        | Awaited<ReturnType<typeof prepareStandaloneUpdate>>
        | undefined;
      try {
        await serveArchive();
        const cancelled = await prepareStandaloneUpdate(standaloneDir, '1.2.3');
        pending = cancelled;
        expect(cachedArchives()).toHaveLength(1);
        expectInstallationPreserved();
        cancelled.cleanup();
        cancelled.cleanup();
        expect(cachedArchives()).toHaveLength(0);

        const failed = await prepareStandaloneUpdate(standaloneDir, '1.2.3');
        pending = failed;
        await expect(failed.activate()).rejects.toThrow('Smoke test failed');
        expect(cachedArchives()).toHaveLength(0);
        expectInstallationPreserved();

        await serveArchive({ badChecksum: true });
        await expect(
          prepareStandaloneUpdate(standaloneDir, '1.2.3'),
        ).rejects.toThrow('Checksum mismatch');
        expect(cachedArchives()).toHaveLength(0);
        expect(process.listenerCount('exit')).toBe(exitListeners);
      } finally {
        pending?.cleanup();
      }
    });

    it.each([baseUrl, `${baseUrl}/`, `  ${baseUrl}///  `])(
      'downloads and verifies every resource from the configured root %s',
      async (configured) => {
        vi.stubEnv('QWEN_UPDATE_BASE_URL', configured);
        await serveArchive();

        // The verified archive deliberately has no runtime, so it cannot replace
        // the fixture installation even if the download and checksum succeed.
        await expect(
          performStandaloneUpdate(standaloneDir, '1.2.3'),
        ).rejects.toThrow('Smoke test failed: node binary not found');

        expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
          `${baseUrl}/v1.2.3/${filename}`,
          `${baseUrl}/v1.2.3/SHA256SUMS`,
          `${baseUrl}/v1.2.3/SHA256SUMS.sig`,
        ]);
        expectInstallationPreserved();
      },
    );

    it('keeps one configured source for the whole update', async () => {
      vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
      await serveArchive();
      const fetchResource = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation(async (url: string) => {
        vi.stubEnv(
          'QWEN_UPDATE_BASE_URL',
          'https://other.example.com/releases',
        );
        return fetchResource(url);
      });

      await expect(
        performStandaloneUpdate(standaloneDir, 'v1.2.3'),
      ).rejects.toThrow('Smoke test failed: node binary not found');
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
        `${baseUrl}/v1.2.3/${filename}`,
        `${baseUrl}/v1.2.3/SHA256SUMS`,
        `${baseUrl}/v1.2.3/SHA256SUMS.sig`,
      ]);
    });

    it.each([undefined, '', '  '])(
      'preserves default fallback when unset (%s)',
      async (value) => {
        vi.stubEnv('QWEN_UPDATE_BASE_URL', value);
        mockFetch.mockImplementation(
          async () => new Response('', { status: 503 }),
        );

        await expect(
          performStandaloneUpdate(standaloneDir, '1.2.3'),
        ).rejects.toThrow('OSS (HTTP 503');
        expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
          `https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/releases/qwen-code/v1.2.3/${filename}`,
          `https://github.com/QwenLM/qwen-code/releases/download/v1.2.3/${filename}`,
        ]);
        expectInstallationPreserved();
      },
    );

    it('reports a custom-source failure without trying default sources', async () => {
      vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
      mockFetch.mockImplementation(
        async () => new Response('', { status: 503 }),
      );

      await expect(
        performStandaloneUpdate(standaloneDir, '1.2.3'),
      ).rejects.toThrow(
        `Failed to download ${filename} from QWEN_UPDATE_BASE_URL: HTTP 503`,
      );
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
        `${baseUrl}/v1.2.3/${filename}`,
      ]);
      expectInstallationPreserved();
    });

    it('preserves the installation when the custom source serves a bad checksum', async () => {
      vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
      await serveArchive({ badChecksum: true });

      await expect(
        performStandaloneUpdate(standaloneDir, '1.2.3'),
      ).rejects.toThrow('Checksum mismatch');
      expectInstallationPreserved();
    });

    it('still requires a signature when explicitly enabled', async () => {
      vi.stubEnv('QWEN_UPDATE_BASE_URL', baseUrl);
      vi.stubEnv('QWEN_REQUIRE_SIGNATURE', '1');
      await serveArchive();

      await expect(
        performStandaloneUpdate(standaloneDir, '1.2.3'),
      ).rejects.toThrow(
        'SHA256SUMS.sig not found and QWEN_REQUIRE_SIGNATURE=1 is set',
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expectInstallationPreserved();
    });

    it.each([
      'not-a-url',
      '/releases',
      'http://downloads.example.com/releases',
      'file:///releases',
      'https:downloads.example.com/releases',
      'https://example:example@downloads.example.com/releases',
      `${baseUrl}?channel=latest`,
      `${baseUrl}?`,
      `${baseUrl}#fragment`,
      `${baseUrl}#`,
      'https://downloads.example.com/rele\nases',
    ])(
      'rejects invalid configuration before filesystem or network changes: %s',
      async (value) => {
        vi.stubEnv('QWEN_UPDATE_BASE_URL', value);
        const parent = path.join(tempDir, 'not-created');
        await expect(
          performStandaloneUpdate(path.join(parent, 'qwen-code'), '1.2.3'),
        ).rejects.toThrow(
          'QWEN_UPDATE_BASE_URL must be an absolute HTTPS URL without credentials, query parameters, or a fragment.',
        );
        expect(mockFetch).not.toHaveBeenCalled();
        expect(fs.existsSync(parent)).toBe(false);
      },
    );
  });

  describe('isSafeTarEntryPath', () => {
    it('allows double dots inside a filename segment', () => {
      expect(isSafeTarEntryPath('qwen-code/release..notes.md')).toBe(true);
      expect(isSafeTarEntryPath('qwen-code/node/lib/foo..bar')).toBe(true);
      expect(isSafeTarEntryPath('qwen-code/.../file.txt')).toBe(true);
      expect(isSafeTarEntryPath('./qwen-code/bin/qwen')).toBe(true);
    });

    it('rejects parent-directory segments and absolute paths', () => {
      expect(isSafeTarEntryPath('../qwen-code/manifest.json')).toBe(false);
      expect(isSafeTarEntryPath('qwen-code/../manifest.json')).toBe(false);
      expect(isSafeTarEntryPath('qwen-code\\..\\manifest.json')).toBe(false);
      expect(isSafeTarEntryPath('/tmp/qwen-code/manifest.json')).toBe(false);
      expect(isSafeTarEntryPath('C:\\tmp\\qwen-code\\manifest.json')).toBe(
        false,
      );
      expect(isSafeTarEntryPath('')).toBe(false);
    });
  });

  describe('isSafeTarLinkTarget', () => {
    it('allows relative link targets inside the extraction directory', () => {
      const dest = path.join(tempDir, 'extract');
      expect(
        isSafeTarLinkTarget('qwen-code/bin/qwen', '../lib/cli.js', dest),
      ).toBe(true);
      expect(isSafeTarLinkTarget('qwen-code/bin/qwen', './qwen', dest)).toBe(
        true,
      );
    });

    it('allows symlink targets in child directories starting with two dots', () => {
      const dest = path.join(tempDir, 'extract');
      expect(
        isSafeTarLinkTarget('qwen-code/bin/qwen', '../..hidden/tool', dest),
      ).toBe(true);
    });

    it('rejects symlink targets outside the extraction directory', () => {
      const dest = path.join(tempDir, 'extract');
      expect(
        isSafeTarLinkTarget('qwen-code/bin/qwen', '../../../etc/passwd', dest),
      ).toBe(false);
      expect(
        isSafeTarLinkTarget('qwen-code/bin/qwen', '/etc/passwd', dest),
      ).toBe(false);
      expect(
        isSafeTarLinkTarget(
          'qwen-code/bin/qwen',
          'C:\\Windows\\System32',
          dest,
        ),
      ).toBe(false);
    });

    it('rejects symlink targets outside the archive root that will be installed', () => {
      const dest = path.join(tempDir, 'extract');
      expect(
        isSafeTarLinkTarget('qwen-code/bin/qwen', '../../shared/node', dest),
      ).toBe(false);
      expect(
        isSafeTarLinkTarget('./qwen-code/bin/qwen', '../../shared/node', dest),
      ).toBe(false);
    });
  });

  describe('isSafeTarEntry', () => {
    it('rejects hardlinks outright', () => {
      const dest = path.join(tempDir, 'extract');
      expect(
        isSafeTarEntry(
          'qwen-code/bin/qwen',
          { type: 'Link', linkpath: '../poc.txt' },
          dest,
        ),
      ).toBe(false);
    });

    it('allows safe regular entries and safe symlinks', () => {
      const dest = path.join(tempDir, 'extract');
      expect(isSafeTarEntry('qwen-code/bin/qwen', { type: 'File' }, dest)).toBe(
        true,
      );
      expect(isSafeTarEntry('qwen-code/lib', { type: 'Directory' }, dest)).toBe(
        true,
      );
      expect(
        isSafeTarEntry(
          'qwen-code/bin/qwen',
          { type: 'SymbolicLink', linkpath: '../lib/cli.js' },
          dest,
        ),
      ).toBe(true);
    });

    it('accepts fs stats entries from tar filter typing', () => {
      const dest = path.join(tempDir, 'extract');
      const filePath = path.join(tempDir, 'entry.txt');
      fs.writeFileSync(filePath, 'entry');

      expect(
        isSafeTarEntry('qwen-code/bin/qwen', fs.statSync(filePath), dest),
      ).toBe(true);
    });

    it('rejects special archive entry types', () => {
      const dest = path.join(tempDir, 'extract');
      for (const type of [
        'BlockDevice',
        'CharacterDevice',
        'FIFO',
        'ContiguousFile',
      ]) {
        expect(isSafeTarEntry('qwen-code/bin/qwen', { type }, dest)).toBe(
          false,
        );
      }
    });
  });

  describe('cleanupFirstTimeMigrationArtifacts', () => {
    it.skipIf(process.platform === 'win32')(
      'removes the wrapper and PATH block created during a failed migration',
      () => {
        const originalHome = process.env['HOME'];
        const originalShell = process.env['SHELL'];
        const home = path.join(tempDir, 'home');
        process.env['HOME'] = home;
        process.env['SHELL'] = '/bin/bash';

        try {
          const standaloneDir = path.join(home, '.local', 'lib', 'qwen-code');
          const artifacts = ensureBinWrapper(standaloneDir, 'linux-x64');
          const wrapperPath = path.join(home, '.local', 'bin', 'qwen');
          const bashrc = path.join(home, '.bashrc');

          expect(fs.existsSync(wrapperPath)).toBe(true);
          expect(fs.readFileSync(bashrc, 'utf-8')).toContain(
            '# Qwen Code PATH block begin',
          );

          cleanupFirstTimeMigrationArtifacts(artifacts);

          expect(fs.existsSync(wrapperPath)).toBe(false);
          expect(fs.readFileSync(bashrc, 'utf-8')).not.toContain(
            '# Qwen Code PATH block begin',
          );
        } finally {
          process.env['HOME'] = originalHome;
          process.env['SHELL'] = originalShell;
        }
      },
    );
  });

  describe('rollbackStandaloneUpdate — concurrent lock protection', () => {
    it('returns error when an active update holds the lock', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);
      fs.writeFileSync(path.join(standaloneDir, 'manifest.json'), '{}');
      fs.writeFileSync(path.join(oldDir, 'manifest.json'), '{}');
      fs.writeFileSync(lockPath, String(process.pid));
      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).toContain('auto-update is currently in progress');
      }
      fs.unlinkSync(lockPath);
    });

    it('proceeds when lock has dead PID', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.17.0' }),
      );
      fs.writeFileSync(
        path.join(oldDir, 'manifest.json'),
        JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.16.0' }),
      );
      fs.writeFileSync(lockPath, '999999999');
      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result.ok).toBe(true);
    });

    // Pin the permissive direction at the rollback lock check: a lock whose
    // content cannot name a live process must not wedge rollback. The marker
    // path in checkDeferredSwap intentionally fails closed on the same class
    // — the two directions are deliberate, not an inconsistency to resolve.
    it('proceeds when the lock content is not a parseable PID', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.17.0' }),
      );
      fs.writeFileSync(
        path.join(oldDir, 'manifest.json'),
        JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.16.0' }),
      );
      fs.writeFileSync(lockPath, 'not-a-pid');
      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result.ok).toBe(true);
    });

    it('proceeds when the lock holds an out-of-range PID', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const oldDir = `${standaloneDir}.old`;
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(standaloneDir);
      fs.mkdirSync(oldDir);
      fs.writeFileSync(
        path.join(standaloneDir, 'manifest.json'),
        JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.17.0' }),
      );
      fs.writeFileSync(
        path.join(oldDir, 'manifest.json'),
        JSON.stringify({ name: '@qwen-code/qwen-code', version: '0.16.0' }),
      );
      fs.writeFileSync(lockPath, '99999999999999');
      const result = rollbackStandaloneUpdate(standaloneDir);
      expect(result.ok).toBe(true);
    });
  });

  describe('acquireLock deferred marker handling', () => {
    it('rejects lock takeover while a deferred bat process is alive', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.writeFileSync(lockPath, '999999999');
      fs.writeFileSync(`${standaloneDir}.deferred`, String(process.pid));

      expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
        'A previous update is still being applied',
      );
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.existsSync(`${standaloneDir}.deferred`)).toBe(true);
    });

    it('still waits on a below-threshold deferred marker with a live PID', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      const markerPath = `${standaloneDir}.deferred`;
      fs.writeFileSync(markerPath, String(process.pid));
      const belowThreshold = new Date(Date.now() - 14 * 60 * 1000);
      fs.utimesSync(markerPath, belowThreshold, belowThreshold);

      // A marker younger than PENDING_SWAP_STALE_MS can still belong to a
      // genuinely running swap — the wait-and-retry answer stays.
      expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
        'A previous update is still being applied',
      );
    });

    it('routes an aged deferred marker with a live PID to the marker remedy', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      const markerPath = `${standaloneDir}.deferred`;
      fs.mkdirSync(`${standaloneDir}.new`, { recursive: true });
      fs.writeFileSync(markerPath, String(process.pid));
      const aged = new Date(Date.now() - 16 * 60 * 1000);
      fs.utimesSync(markerPath, aged, aged);

      // A live bat PID with an aged marker is a hung bat or a reused PID;
      // "please wait" can never resolve it. The escape must name the marker
      // itself: removing only .new and the lock leaves the marker in place
      // and the next update hits this same branch again. And because the
      // branch fires precisely when a PID reads alive, the guard must stay
      // actionable when a qwen-update.bat really is running (hung bat) —
      // "act only if no bat is running" would be a dead end here. The
      // residue must not be disturbed: a stale marker proves the bat is
      // gone, not that .new is safe to delete, so swapProvenDead stays
      // false.
      expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
        `A previous update left a deferred-swap marker at ${markerPath}. ` +
          'If a qwen-update.bat process is still running, end it first; ' +
          `then remove the marker, the pending swap at ${standaloneDir}.new, and .qwen-update.lock, and try again.`,
      );
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.existsSync(`${standaloneDir}.new`)).toBe(true);
      // The freshly taken lock must be released on the way out.
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('cleans a stale deferred marker before taking over a dead lock', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.writeFileSync(lockPath, '999999999');
      fs.writeFileSync(`${standaloneDir}.deferred`, '999999998');

      expect(acquireLock(lockPath, standaloneDir)).toBe(true);
      expect(fs.existsSync(`${standaloneDir}.deferred`)).toBe(false);
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
    });

    it('fails closed on an unparseable deferred marker', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.writeFileSync(lockPath, '999999999');
      fs.writeFileSync(`${standaloneDir}.deferred`, 'not-a-pid');

      // A torn marker cannot prove the bat is gone — the lock stays and the
      // marker is left for inspection instead of being swept under a heal.
      // The remedy names the marker itself: it is the artifact that keeps
      // re-triggering this branch once .new and the lock are removed.
      expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
        `A previous update left a deferred-swap marker at ${standaloneDir}.deferred. ` +
          'If no qwen-update.bat process is running, remove the marker, ' +
          `the pending swap at ${standaloneDir}.new, and .qwen-update.lock, then try again.`,
      );
      expect(fs.existsSync(`${standaloneDir}.deferred`)).toBe(true);
    });

    it('removes a leftover .new directory when the deferred bat process is dead', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(`${standaloneDir}.new`, { recursive: true });
      fs.writeFileSync(`${standaloneDir}.deferred`, '999999998');

      expect(acquireLock(lockPath, standaloneDir)).toBe(true);
      expect(fs.existsSync(`${standaloneDir}.deferred`)).toBe(false);
      expect(fs.existsSync(`${standaloneDir}.new`)).toBe(false);
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
    });

    it('keeps a fresh marker-less .new that could still be mid-swap', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(`${standaloneDir}.new`, { recursive: true });

      // The parent spawns the bat before writing the marker, so a fresh
      // marker-less .new may belong to a swap in flight right now. Pin the
      // exact marker-less message: with no .deferred marker on disk the
      // pending swap really is the blocking artifact, and this text must
      // stay byte-identical.
      expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
        `A previous update left a pending swap at ${standaloneDir}.new. ` +
          'If no qwen-update.bat process is running, remove the pending swap and .qwen-update.lock, then try again.',
      );
      expect(fs.existsSync(`${standaloneDir}.new`)).toBe(true);
    });

    it('removes a stale leftover .new directory when no deferred marker exists', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(`${standaloneDir}.new`, { recursive: true });
      const aged = new Date(Date.now() - 16 * 60 * 1000);
      fs.utimesSync(`${standaloneDir}.new`, aged, aged);

      expect(acquireLock(lockPath, standaloneDir)).toBe(true);
      expect(fs.existsSync(`${standaloneDir}.new`)).toBe(false);
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
    });

    it('fails closed when the stale .new cannot be removed', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(`${standaloneDir}.new`, { recursive: true });
      const aged = new Date(Date.now() - 16 * 60 * 1000);
      fs.utimesSync(`${standaloneDir}.new`, aged, aged);
      // An unremovable residue (a held file, EPERM on win32) must abort the
      // update: continuing would let atomicReplace delete the .old rollback
      // snapshot before its own retry fails with the same error.
      rmSyncFailures.targets.push(`${standaloneDir}.new`);
      try {
        expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
          'could not be removed',
        );
        expect(fs.existsSync(`${standaloneDir}.new`)).toBe(true);
        // The freshly taken lock must be released on the way out.
        expect(fs.existsSync(lockPath)).toBe(false);
      } finally {
        rmSyncFailures.targets.length = 0;
      }
    });

    it('keeps a leftover .new directory while the deferred bat process is alive', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(`${standaloneDir}.new`, { recursive: true });
      fs.writeFileSync(`${standaloneDir}.deferred`, String(process.pid));

      expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
        'A previous update is still being applied',
      );
      // The in-flight swap must not be disturbed.
      expect(fs.existsSync(`${standaloneDir}.new`)).toBe(true);
      expect(fs.existsSync(`${standaloneDir}.deferred`)).toBe(true);
    });

    it('fails closed when the deferred bat PID cannot be signalled', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(`${standaloneDir}.new`, { recursive: true });
      fs.writeFileSync(`${standaloneDir}.deferred`, '999999998');

      // Same fixture as the dead-bat case above; only the probe's answer
      // differs. EPERM — an elevated bat seen from an unelevated shell — means
      // the process exists, so it is not proof of death and the staged swap
      // must survive rather than be deleted mid-update.
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      });
      try {
        expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
          'A previous update is still being applied',
        );
        expect(fs.existsSync(`${standaloneDir}.new`)).toBe(true);
        expect(fs.existsSync(`${standaloneDir}.deferred`)).toBe(true);
        // Fast path only: acquireLock wrote this lock itself, so the throw has
        // to release it. The release is keyed on the thrown message text, so
        // rewording that literal must not silently start leaking the lock.
        expect(fs.existsSync(lockPath)).toBe(false);
      } finally {
        kill.mockRestore();
      }
    });

    it('fails closed on the lock-theft path when the bat PID cannot be signalled', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      // The shape the fix exists for: a deferred swap keeps the lock (the
      // finally in performStandaloneUpdate releases it only when the result is
      // not 'deferred') and the bat deletes marker-then-lock only at its
      // :cleanup label, so the lock is present holding the exited CLI's PID
      // while the elevated bat lives. acquireLock therefore reaches the gate
      // by stealing the lock, not through the fast path.
      fs.writeFileSync(lockPath, '999999999');
      fs.mkdirSync(`${standaloneDir}.new`, { recursive: true });
      fs.writeFileSync(`${standaloneDir}.deferred`, '999999998');

      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      });
      try {
        expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
          'A previous update is still being applied',
        );
        expect(fs.existsSync(`${standaloneDir}.new`)).toBe(true);
        expect(fs.existsSync(`${standaloneDir}.deferred`)).toBe(true);
        // Theft path: this process never owned the lock, so it must survive —
        // the opposite of the fast-path assertion above.
        expect(fs.readFileSync(lockPath, 'utf-8')).toBe('999999999');
      } finally {
        kill.mockRestore();
      }
    });

    it('still steals a lock whose holder cannot be signalled', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.writeFileSync(lockPath, '999999999');

      // Pins the permissive direction the comment on isProcessProvablyGone
      // declares: the lock-liveness callers keep using isProcessAlive on
      // purpose. No marker and no .new here, so nothing but the lock check is
      // under test — treating an unsignalable holder as alive would make the
      // lock un-stealable and re-block updates forever.
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      });
      try {
        expect(acquireLock(lockPath, standaloneDir)).toBe(true);
        expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
      } finally {
        kill.mockRestore();
      }
    });

    it('routes an impossible deferred PID to the remediation message', () => {
      const standaloneDir = path.join(tempDir, 'qwen-code');
      const lockPath = path.join(tempDir, '.qwen-update.lock');
      fs.mkdirSync(`${standaloneDir}.new`, { recursive: true });
      // Parses as a number but cannot be a PID, so process.kill answers
      // ERR_INVALID_ARG_TYPE rather than ESRCH and the probe says nothing
      // about liveness. This is a torn marker, not a live bat, so the user
      // needs the removal steps instead of being told to wait — and, being a
      // marker-present branch, the remedy must name the marker itself.
      fs.writeFileSync(`${standaloneDir}.deferred`, '99999999999999');

      expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
        `A previous update left a deferred-swap marker at ${standaloneDir}.deferred. ` +
          'If no qwen-update.bat process is running, remove the marker, ' +
          `the pending swap at ${standaloneDir}.new, and .qwen-update.lock, then try again.`,
      );
      expect(fs.existsSync(`${standaloneDir}.new`)).toBe(true);
      expect(fs.existsSync(`${standaloneDir}.deferred`)).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('routes a non-positive deferred PID to the remediation message even when the probe succeeds', () => {
      // process.kill(0, 0) signals the caller's own process group and
      // process.kill(-1, 0) signals every process the user may signal, so both
      // SUCCEED: a marker of 0 or -1 would probe as a live bat and the user
      // would be told to wait for a swap that cannot exist. The `<= 0` clause
      // is what routes it to the error carrying the removal steps instead.
      for (const marker of ['0', '-1']) {
        const standaloneDir = path.join(tempDir, `qwen-${marker}`);
        const lockPath = path.join(tempDir, `lock-${marker}.lock`);
        fs.mkdirSync(`${standaloneDir}.new`, { recursive: true });
        fs.writeFileSync(`${standaloneDir}.deferred`, marker);

        // The probe is mocked to look alive, so the clause under test is the
        // only thing standing between a torn marker and the "please wait"
        // dead end. This fragment is unique to deferredMarkerError: the
        // aged-marker escape says "If a qwen-update.bat process is still
        // running" and the wait branch carries no removal steps at all.
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
        try {
          expect(() => acquireLock(lockPath, standaloneDir)).toThrow(
            'If no qwen-update.bat process is running, remove the marker',
          );
          // Neither the staged swap nor the torn marker may be disturbed.
          expect(fs.existsSync(`${standaloneDir}.new`)).toBe(true);
          expect(fs.existsSync(`${standaloneDir}.deferred`)).toBe(true);
          // Fast path only: the lock acquireLock wrote must be released.
          expect(fs.existsSync(lockPath)).toBe(false);
        } finally {
          kill.mockRestore();
        }
      }
    });
  });

  describe.skipIf(process.platform === 'win32')('ensurePathInShellRc', () => {
    it('appends PATH export to zshrc when SHELL is zsh', () => {
      const binDir = path.join(tempDir, 'bin');
      const zshrc = path.join(tempDir, '.zshrc');
      fs.writeFileSync(zshrc, '# existing config\n');

      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/zsh';
      process.env['HOME'] = tempDir;

      try {
        ensurePathInShellRc(binDir);
        const content = fs.readFileSync(zshrc, 'utf-8');
        expect(content).toContain('# Qwen Code PATH block begin');
        expect(content).toContain('# Qwen Code PATH block end');
        // Uses single-quoted paths matching install-qwen-standalone.sh shell_quote
        expect(content).toContain(`export PATH='${binDir}':$PATH`);
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('skips if block markers already in rc file', () => {
      const binDir = path.join(tempDir, 'bin');
      const zshrc = path.join(tempDir, '.zshrc');
      fs.writeFileSync(
        zshrc,
        `# Qwen Code PATH block begin\nexport PATH='${binDir}':$PATH\n# Qwen Code PATH block end\n`,
      );

      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/zsh';
      process.env['HOME'] = tempDir;

      try {
        ensurePathInShellRc(binDir);
        const content = fs.readFileSync(zshrc, 'utf-8');
        const matches = content.match(/# Qwen Code PATH block begin/g);
        expect(matches).toHaveLength(1);
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('skips if legacy marker already in rc file', () => {
      const binDir = path.join(tempDir, 'bin');
      const zshrc = path.join(tempDir, '.zshrc');
      fs.writeFileSync(
        zshrc,
        `# Added by Qwen Code standalone installer\nexport PATH="${binDir}:$PATH"\n`,
      );

      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/zsh';
      process.env['HOME'] = tempDir;

      try {
        ensurePathInShellRc(binDir);
        const content = fs.readFileSync(zshrc, 'utf-8');
        const matches = content.match(/export PATH/g);
        expect(matches).toHaveLength(1);
        expect(content).not.toContain('# Qwen Code PATH block begin');
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('uses .bashrc before .bash_profile for bash shells', () => {
      const binDir = path.join(tempDir, 'bin');
      const bashrc = path.join(tempDir, '.bashrc');
      const profile = path.join(tempDir, '.bash_profile');
      fs.writeFileSync(bashrc, '# bashrc\n');
      fs.writeFileSync(profile, '# profile\n');

      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/bash';
      process.env['HOME'] = tempDir;

      try {
        ensurePathInShellRc(binDir);
        expect(fs.readFileSync(bashrc, 'utf-8')).toContain(
          '# Qwen Code PATH block begin',
        );
        expect(fs.readFileSync(profile, 'utf-8')).toBe('# profile\n');
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('falls back to .bash_profile for bash when .bashrc is absent', () => {
      const binDir = path.join(tempDir, 'bin');
      const profile = path.join(tempDir, '.bash_profile');
      fs.writeFileSync(profile, '# profile\n');

      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/bash';
      process.env['HOME'] = tempDir;

      try {
        ensurePathInShellRc(binDir);
        expect(fs.readFileSync(profile, 'utf-8')).toContain(
          '# Qwen Code PATH block begin',
        );
        expect(fs.existsSync(path.join(tempDir, '.bashrc'))).toBe(false);
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('appends set -gx PATH for fish shell (matching install script)', () => {
      const binDir = path.join(tempDir, 'bin');
      const fishDir = path.join(tempDir, '.config', 'fish');
      const fishConfig = path.join(fishDir, 'config.fish');
      fs.mkdirSync(fishDir, { recursive: true });
      fs.writeFileSync(fishConfig, '# existing config\n');
      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/usr/bin/fish';
      process.env['HOME'] = tempDir;
      try {
        ensurePathInShellRc(binDir);
        const content = fs.readFileSync(fishConfig, 'utf-8');
        // Matches install-qwen-standalone.sh's maybe_update_shell_path fish branch
        expect(content).toContain('set -gx PATH');
        expect(content).toContain('# Qwen Code PATH block begin');
        expect(content).toContain('# Qwen Code PATH block end');
        expect(content).toContain(binDir);
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('escapes single quotes in fish PATH entries', () => {
      const binDir = path.join(tempDir, "o'brien", 'bin');
      const fishDir = path.join(tempDir, '.config', 'fish');
      const fishConfig = path.join(fishDir, 'config.fish');
      fs.mkdirSync(fishDir, { recursive: true });
      fs.writeFileSync(fishConfig, '# existing config\n');
      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/usr/bin/fish';
      process.env['HOME'] = tempDir;
      try {
        ensurePathInShellRc(binDir);
        const content = fs.readFileSync(fishConfig, 'utf-8');
        expect(content).toContain("set -gx PATH '");
        expect(content).toContain("o'\\''brien");
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('creates fish config parent directories before appending PATH', () => {
      const binDir = path.join(tempDir, 'bin');
      const fishConfig = path.join(tempDir, '.config', 'fish', 'config.fish');
      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/usr/bin/fish';
      process.env['HOME'] = tempDir;
      try {
        expect(fs.existsSync(path.dirname(fishConfig))).toBe(false);
        ensurePathInShellRc(binDir);
        const content = fs.readFileSync(fishConfig, 'utf-8');
        expect(content).toContain('set -gx PATH');
        expect(content).toContain(binDir);
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('allows shell metacharacters in single-quoted PATH entries', () => {
      const binDir = path.join(tempDir, 'bin$(evil)');
      const zshrc = path.join(tempDir, '.zshrc');
      fs.writeFileSync(zshrc, '# existing config\n');
      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/zsh';
      process.env['HOME'] = tempDir;
      try {
        ensurePathInShellRc(binDir);
        expect(fs.readFileSync(zshrc, 'utf-8')).toContain(
          `export PATH='${binDir}':$PATH`,
        );
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('rejects binDir with newlines', () => {
      const binDir = path.join(tempDir, 'bin\nevil');
      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/zsh';
      process.env['HOME'] = tempDir;
      try {
        expect(() => ensurePathInShellRc(binDir)).toThrow(
          'unsafe for shell embedding',
        );
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('rejects binDir with null bytes', () => {
      const binDir = path.join(tempDir, 'bin\0evil');
      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/zsh';
      process.env['HOME'] = tempDir;
      try {
        expect(() => ensurePathInShellRc(binDir)).toThrow(
          'unsafe for shell embedding',
        );
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('rejects binDir with carriage returns', () => {
      const binDir = path.join(tempDir, 'bin\revil');
      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/zsh';
      process.env['HOME'] = tempDir;
      try {
        expect(() => ensurePathInShellRc(binDir)).toThrow(
          'unsafe for shell embedding',
        );
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });

    it('does nothing for unknown shells', () => {
      const binDir = path.join(tempDir, 'bin');
      const origShell = process.env['SHELL'];
      const origHome = process.env['HOME'];
      process.env['SHELL'] = '/bin/csh';
      process.env['HOME'] = tempDir;

      try {
        ensurePathInShellRc(binDir);
        // No rc file should be created
        expect(
          fs.readdirSync(tempDir).filter((f) => f.startsWith('.')),
        ).toHaveLength(0);
      } finally {
        process.env['SHELL'] = origShell;
        process.env['HOME'] = origHome;
      }
    });
  });
});
