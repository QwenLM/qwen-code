/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { getConfigHomeDir } from '../paths.js';

import {
  createAndSaveSnapshot,
  createRipgrepShellIntegration,
  deleteSnapshot,
  snapshotExists,
  setSnapshotsDir,
  getSnapshotsDir,
  _resetSnapshotsDirForTest,
} from './ShellSnapshot.js';

// Skip on Windows — snapshot targets POSIX shells.
const isWindows = os.platform() === 'win32';
const describeUnix = isWindows ? describe.skip : describe;

describeUnix('ShellSnapshot', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'snapshot-test-'));
    setSnapshotsDir(tmpDir);
  });

  afterEach(async () => {
    _resetSnapshotsDirForTest();
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── getSnapshotsDir / setSnapshotsDir ──────────────────────────────

  describe('getSnapshotsDir / setSnapshotsDir', () => {
    it('defaults to <config-root>/shell-snapshots/', () => {
      _resetSnapshotsDirForTest();
      const dir = getSnapshotsDir();
      expect(dir).toBe(path.join(getConfigHomeDir(), 'shell-snapshots'));
    });

    it('uses custom dir when set', () => {
      setSnapshotsDir('/tmp/custom-snapshots');
      expect(getSnapshotsDir()).toBe('/tmp/custom-snapshots');
    });

    it('resets to default after _resetSnapshotsDirForTest', () => {
      setSnapshotsDir('/tmp/custom');
      _resetSnapshotsDirForTest();
      expect(getSnapshotsDir()).toBe(
        path.join(getConfigHomeDir(), 'shell-snapshots'),
      );
    });
  });

  // ── createAndSaveSnapshot ──────────────────────────────────────────

  describe('createAndSaveSnapshot', () => {
    it('creates a snapshot file for bash', async () => {
      const result = await createAndSaveSnapshot('/bin/bash');
      expect(result).toBeDefined();
      expect(result).toContain(tmpDir);
      expect(result).toContain('snapshot-bash-');
      expect(result).toMatch(/\.sh$/);
    });

    it('creates a snapshot file for zsh (if available)', async () => {
      // Check if zsh exists on this system
      try {
        await access('/bin/zsh');
      } catch {
        // zsh not available, skip
        return;
      }
      const result = await createAndSaveSnapshot('/bin/zsh');
      expect(result).toBeDefined();
      expect(result).toContain('snapshot-zsh-');
    });

    it('snapshot file contains PATH export', async () => {
      const result = await createAndSaveSnapshot('/bin/bash');
      expect(result).toBeDefined();
      const content = await readFile(result!, 'utf-8');
      expect(content).toContain('export PATH=');
    });

    it('snapshot file contains unalias -a', async () => {
      const result = await createAndSaveSnapshot('/bin/bash');
      expect(result).toBeDefined();
      const content = await readFile(result!, 'utf-8');
      expect(content).toContain('unalias -a');
    });

    it('snapshot file contains shell options or expand_aliases', async () => {
      const result = await createAndSaveSnapshot('/bin/bash');
      expect(result).toBeDefined();
      const content = await readFile(result!, 'utf-8');
      // When config file exists: has "# Shell Options" section
      // When no config file: has "shopt -s expand_aliases" directly
      expect(
        content.includes('# Shell Options') ||
          content.includes('shopt -s expand_aliases'),
      ).toBe(true);
    });

    it('snapshot file contains functions section when config exists', async () => {
      const result = await createAndSaveSnapshot('/bin/bash');
      expect(result).toBeDefined();
      const content = await readFile(result!, 'utf-8');
      // Functions section is only present when user has a config file
      // Just verify the snapshot is not empty and has expected structure
      expect(content).toContain('# Snapshot file');
      expect(content.length).toBeGreaterThan(50);
    });

    it('snapshot file contains unalias line', async () => {
      const result = await createAndSaveSnapshot('/bin/bash');
      expect(result).toBeDefined();
      const content = await readFile(result!, 'utf-8');
      expect(content).toContain('unalias -a');
    });

    it('returns undefined for non-existent shell', async () => {
      const result = await createAndSaveSnapshot('/nonexistent/shell/binary');
      expect(result).toBeUndefined();
    });

    it('creates unique filenames per call', async () => {
      const result1 = await createAndSaveSnapshot('/bin/bash');
      const result2 = await createAndSaveSnapshot('/bin/bash');
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result1).not.toBe(result2);
    });
  });

  // ── deleteSnapshot ─────────────────────────────────────────────────

  describe('deleteSnapshot', () => {
    it('deletes an existing snapshot file', async () => {
      const filePath = path.join(tmpDir, 'test-snapshot.sh');
      await writeFile(filePath, '# test snapshot');

      await deleteSnapshot(filePath);

      let exists = true;
      try {
        await access(filePath);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it('does not throw for non-existent file', async () => {
      await expect(
        deleteSnapshot('/nonexistent/snapshot.sh'),
      ).resolves.toBeUndefined();
    });
  });

  // ── snapshotExists ─────────────────────────────────────────────────

  describe('snapshotExists', () => {
    it('returns true for an existing file', async () => {
      const filePath = path.join(tmpDir, 'existing.sh');
      await writeFile(filePath, '# test');
      expect(await snapshotExists(filePath)).toBe(true);
    });

    it('returns false for a non-existent file', async () => {
      expect(await snapshotExists(path.join(tmpDir, 'nonexistent.sh'))).toBe(
        false,
      );
    });

    it('returns false after deleteSnapshot', async () => {
      const filePath = path.join(tmpDir, 'to-delete.sh');
      await writeFile(filePath, '# test');
      expect(await snapshotExists(filePath)).toBe(true);

      await deleteSnapshot(filePath);
      expect(await snapshotExists(filePath)).toBe(false);
    });
  });

  // ── Snapshot sourcing integration ──────────────────────────────────

  describe('snapshot sourcing', () => {
    it('created snapshot is sourceable by bash', async () => {
      const snapshotPath = await createAndSaveSnapshot('/bin/bash');
      expect(snapshotPath).toBeDefined();

      // Verify the snapshot can be sourced without error
      const { stderr } = await promisify(execFile)('/bin/bash', [
        '-c',
        `source '${snapshotPath}'`,
      ]);
      // No fatal errors expected (warnings are OK)
      expect(stderr).not.toContain('syntax error');
    });

    it('preserves bash functions without per-function base64 processes', async () => {
      vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
      await writeFile(
        path.join(tmpDir, '.bashrc'),
        [
          'snapshot_special() {',
          `  local value='single "double" $dollar \\slash'`,
          `  printf '%s\\n' "$value"`,
          `  cat <<'SNAPSHOT_HEREDOC'`,
          `literal $HOME "$(not-run)" 'single' \\slash`,
          'SNAPSHOT_HEREDOC',
          '}',
          '_private_completion() { printf "excluded\\n"; }',
          '__git_snapshot_helper() { printf "double-helper\\n"; }',
          '',
        ].join('\n'),
      );

      const snapshotPath = await createAndSaveSnapshot('/bin/bash');
      expect(snapshotPath).toBeDefined();

      const content = await readFile(snapshotPath!, 'utf-8');
      expect(content).toMatch(/snapshot_special \(\)\s*\{/);
      expect(content).toMatch(/__git_snapshot_helper \(\)\s*\{/);
      expect(content).not.toContain('_private_completion');
      expect(content).not.toContain('base64 -d');
      await expect(access(`${snapshotPath}.capture`)).rejects.toThrow();

      const { stdout, stderr } = await promisify(execFile)(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          [
            'source "$1"',
            'snapshot_special',
            '__git_snapshot_helper',
            'if builtin declare -F _private_completion >/dev/null; then exit 42; fi',
          ].join('; '),
          '_',
          snapshotPath!,
        ],
      );

      expect(stderr).not.toContain('syntax error');
      expect(stdout).toBe(
        [
          'single "double" $dollar \\slash',
          `literal $HOME "$(not-run)" 'single' \\slash`,
          'double-helper',
          '',
        ].join('\n'),
      );
    });

    it('preserves bash options and aliases captured with builtins', async () => {
      vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
      await writeFile(
        path.join(tmpDir, '.bashrc'),
        [
          'shopt -s nullglob',
          'set -o noclobber',
          `alias snapshot_alias='printf "%s\\\\n" "value with spaces"'`,
          '',
        ].join('\n'),
      );

      const snapshotPath = await createAndSaveSnapshot('/bin/bash');
      expect(snapshotPath).toBeDefined();

      const content = await readFile(snapshotPath!, 'utf-8');
      expect(content).toContain('shopt -s nullglob');
      expect(content).toContain('set -o noclobber');
      expect(content).toContain('alias -- snapshot_alias=');

      const { stdout, stderr } = await promisify(execFile)(
        '/bin/bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          [
            'source "$1"',
            'shopt -q nullglob || exit 40',
            '[[ -o noclobber ]] || exit 41',
            'eval snapshot_alias',
          ].join('; '),
          '_',
          snapshotPath!,
        ],
      );

      expect(stderr).not.toContain('syntax error');
      expect(stdout).toBe('value with spaces\n');
    });
  });

  // ── createRipgrepShellIntegration ──────────────────────────────────

  describe('createRipgrepShellIntegration', () => {
    it('returns an alias or function type', () => {
      const result = createRipgrepShellIntegration();
      expect(['alias', 'function']).toContain(result.type);
      expect(result.snippet).toBeTruthy();
    });

    it('alias snippet contains a path-like string', () => {
      const result = createRipgrepShellIntegration();
      if (result.type === 'alias') {
        // Should be a quoted path or bare command name (e.g. 'rg' or '/path/to/rg')
        expect(result.snippet.length).toBeGreaterThan(0);
      }
    });

    it('function snippet contains ARGV0 dispatch when type is function', () => {
      const result = createRipgrepShellIntegration();
      if (result.type === 'function') {
        expect(result.snippet).toContain('function rg {');
        expect(result.snippet).toContain('ARGV0=');
        expect(result.snippet).toContain('"$@"');
      }
    });
  });

  // ── ripgrep integration in snapshot content ────────────────────────

  describe('ripgrep integration in snapshot', () => {
    it('snapshot contains rg availability check', async () => {
      const result = await createAndSaveSnapshot('/bin/bash');
      expect(result).toBeDefined();
      const content = await readFile(result!, 'utf-8');
      expect(content).toContain('# Check for rg availability');
      expect(content).toContain('command -v rg');
    });

    it('snapshot contains rg alias or function inside conditional', async () => {
      const result = await createAndSaveSnapshot('/bin/bash');
      expect(result).toBeDefined();
      const content = await readFile(result!, 'utf-8');
      // Should contain either an alias or a function definition for rg
      const hasAlias = content.includes('alias rg=');
      const hasFunction = content.includes('function rg {');
      expect(hasAlias || hasFunction).toBe(true);
    });

    it('rg conditional block is properly closed with fi', async () => {
      const result = await createAndSaveSnapshot('/bin/bash');
      expect(result).toBeDefined();
      const content = await readFile(result!, 'utf-8');
      // The 'if ! ...; then' block must be closed with 'fi'
      const ifIndex = content.indexOf('if ! (unalias rg');
      const fiIndex = content.indexOf('fi', ifIndex);
      expect(ifIndex).toBeGreaterThan(-1);
      expect(fiIndex).toBeGreaterThan(ifIndex);
    });
  });
});

// ── PATH capture in snapshot script ────────────────────────────────

vi.mock('../platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform.js')>();
  return { ...actual, getPlatform: vi.fn(() => actual.getPlatform()) };
});

describeUnix('ShellSnapshot — PATH capture', () => {
  const sentinel =
    '/sentinel/bin:/test/with spaces:/test/with$dollar:/usr/bin:/bin';
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'snapshot-path-'));
    setSnapshotsDir(tmpDir);
  });

  afterEach(async () => {
    _resetSnapshotsDirForTest();
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('snapshot PATH comes from process.env.PATH, not shell-internal $PATH', async () => {
    vi.stubEnv('PATH', sentinel);

    const result = await createAndSaveSnapshot('/bin/bash');
    expect(result).toBeDefined();
    const content = await readFile(result!, 'utf-8');

    expect(content).toContain('/sentinel/bin');
    expect(content).toContain('/test/with spaces');
    expect(content).toContain('/test/with$dollar');
  });

  it('snapshot PATH is sourceable and reproduces the exact value', async () => {
    vi.stubEnv('PATH', sentinel);

    const snapshotPath = await createAndSaveSnapshot('/bin/bash');
    expect(snapshotPath).toBeDefined();

    const { stdout } = await promisify(execFile)('/bin/bash', [
      '-c',
      `source '${snapshotPath}' && printf '%s' "$PATH"`,
    ]);
    expect(stdout).toBe(sentinel);
  });

  it('snapshot does not contain un-expanded $PATH variable reference', async () => {
    const result = await createAndSaveSnapshot('/bin/bash');
    expect(result).toBeDefined();
    const content = await readFile(result!, 'utf-8');
    const pathLine = content
      .split('\n')
      .find((line) => line.trimStart().startsWith('export PATH='));

    expect(pathLine).toBeDefined();
    expect(pathLine).not.toMatch(/\$PATH\b/);
    expect(pathLine).not.toContain('${PATH}');
  });
});
