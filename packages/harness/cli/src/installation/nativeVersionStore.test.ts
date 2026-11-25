/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readdir,
  symlink,
  readlink,
  chmod,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@qwen-code/core', () => ({
  runLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
  },
}));

import { createNativeVersionStore } from './nativeVersionStore.js';
import { compareVersions } from './versions.js';
import { MAX_KEPT_VERSIONS } from './update/updateTypes.js';
import type { ManifestFile } from './update/updateTypes.js';

type Store = ReturnType<typeof createNativeVersionStore>;
let fixtureDir: string;
let updateLink: Store['updateLink'];
let cleanupOldVersions: Store['cleanupOldVersions'];
let parseVersionFromFilename: Store['parseVersionFromFilename'];
let getActiveLinkedVersion: Store['getActiveLinkedVersion'];
let extractArchive: Store['extractArchive'];
beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'native-store-test-'));
  ({
    updateLink, cleanupOldVersions, parseVersionFromFilename,
    getActiveLinkedVersion, extractArchive,
  } = createNativeVersionStore({
    binaryName: 'test-cli',
    binDir: fixtureDir,
    linkPath: join(fixtureDir, 'entry'),
  }));
});
afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseVersionFromFilename', () => {
  it('should parse version from standard filename', () => {
    expect(parseVersionFromFilename('test-cli-0.2.0')).toBe('0.2.0');
  });

  it('should parse version from .exe filename', () => {
    expect(parseVersionFromFilename('test-cli-1.0.0.exe')).toBe('1.0.0');
  });

  it('should parse version from full path', () => {
    expect(
      parseVersionFromFilename('/home/user/.qwen/bin/test-cli/test-cli-0.3.1'),
    ).toBe('0.3.1');
  });

  it('should return null for non-matching filename', () => {
    expect(parseVersionFromFilename('other-binary-0.1.0')).toBeNull();
  });

  it('should return null for bare binary name', () => {
    expect(parseVersionFromFilename('test-cli')).toBeNull();
  });

  it('should handle pre-release version', () => {
    expect(parseVersionFromFilename('test-cli-0.2.0-alpha.1')).toBe(
      '0.2.0-alpha.1',
    );
  });
});

describe('updateLink', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'link-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should create a symlink from linkPath to target', async () => {
    const target = join(tmpDir, 'test-cli-0.2.0');
    const linkPath = join(tmpDir, 'links', 'test-cli');

    // Create the target file
    await writeFile(target, 'binary-content');
    await chmod(target, 0o755);

    await updateLink(target, linkPath);

    // Verify symlink exists and points to target
    const resolvedTarget = await readlink(linkPath);
    expect(resolvedTarget).toBe(target);
  });

  it('should replace an existing symlink', async () => {
    const oldTarget = join(tmpDir, 'test-cli-0.1.0');
    const newTarget = join(tmpDir, 'test-cli-0.2.0');
    const linkPath = join(tmpDir, 'test-cli');

    await writeFile(oldTarget, 'old-binary');
    await writeFile(newTarget, 'new-binary');

    // Create old symlink
    await symlink(oldTarget, linkPath);

    // Update to new target
    await updateLink(newTarget, linkPath);

    const resolvedTarget = await readlink(linkPath);
    expect(resolvedTarget).toBe(newTarget);
  });

  it('should create parent directory if needed', async () => {
    const target = join(tmpDir, 'test-cli-0.2.0');
    const linkPath = join(tmpDir, 'deep', 'nested', 'dir', 'test-cli');

    await writeFile(target, 'binary-content');

    await updateLink(target, linkPath);

    expect(existsSync(linkPath)).toBe(true);
  });
});

describe('cleanupOldVersions', () => {
  let binDir: string;

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'cleanup-test-'));
  });

  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true });
  });

  async function createVersionFile(
    version: string,
    ageMs: number = 0,
  ): Promise<void> {
    const filePath = join(binDir, `test-cli-${version}`);
    await writeFile(filePath, `binary-${version}`);
    // Set mtime to simulate age
    if (ageMs > 0) {
      const mtime = new Date(Date.now() - ageMs);
      const { utimes } = await import('node:fs/promises');
      await utimes(filePath, mtime, mtime);
    }
  }

  it('should keep the most recent N versions', async () => {
    // Create 5 versions with different ages
    await createVersionFile('0.5.0', 0); // newest
    await createVersionFile('0.4.0', 10_000);
    await createVersionFile('0.3.0', 20_000);
    await createVersionFile('0.2.0', 30_000);
    await createVersionFile('0.1.0', 40_000); // oldest

    await cleanupOldVersions(binDir, 3); // keep 3

    const remaining = (await readdir(binDir)).sort();
    expect(remaining).toHaveLength(3);
    expect(remaining).toContain('test-cli-0.5.0');
    expect(remaining).toContain('test-cli-0.4.0');
    expect(remaining).toContain('test-cli-0.3.0');
    expect(remaining).not.toContain('test-cli-0.2.0');
    expect(remaining).not.toContain('test-cli-0.1.0');
  });

  it('should not delete anything if within limit', async () => {
    await createVersionFile('0.2.0', 0);
    await createVersionFile('0.1.0', 10_000);

    await cleanupOldVersions(binDir, 3); // keep 3, only 2 exist

    const remaining = await readdir(binDir);
    expect(remaining).toHaveLength(2);
  });

  it('should ignore non-versioned files', async () => {
    await createVersionFile('0.2.0', 0);
    await createVersionFile('0.1.0', 10_000);
    // Create a non-versioned file
    await writeFile(join(binDir, 'README.txt'), 'readme');

    await cleanupOldVersions(binDir, 1);

    const remaining = await readdir(binDir);
    // Should keep 1 version + the non-versioned file
    expect(remaining).toContain('README.txt');
    expect(remaining).toContain('test-cli-0.2.0');
    expect(remaining).not.toContain('test-cli-0.1.0');
  });

  it('should never remove the active version even if it sorts lowest', async () => {
    // Simulate: nightly (0.2.0-nightly) installed over several higher-versioned betas.
    // Without activeVersion protection, 0.2.0-nightly would be cleaned up
    // because semver sorts it below all 0.2.x releases.
    await createVersionFile('0.2.2-beta2');
    await createVersionFile('0.2.2-beta1');
    await createVersionFile('0.2.1');
    await createVersionFile('0.2.0');
    await createVersionFile('0.1.9');
    await createVersionFile('0.2.0-nightly.20260428.9e2eaf6'); // active symlink target

    // keep=3 → 0.2.0-nightly would normally be outside the retained set
    await cleanupOldVersions(binDir, 3, '0.2.0-nightly.20260428.9e2eaf6');

    const remaining = await readdir(binDir);
    // The active version MUST survive
    expect(remaining).toContain('test-cli-0.2.0-nightly.20260428.9e2eaf6');
    // Older non-active versions should be removed instead
    expect(remaining).not.toContain('test-cli-0.2.0');
    expect(remaining).not.toContain('test-cli-0.1.9');
  });

  it('should handle empty directory gracefully', async () => {
    await expect(cleanupOldVersions(binDir, 3)).resolves.toBeUndefined();
  });

  it('should handle non-existent directory gracefully', async () => {
    await expect(
      cleanupOldVersions(join(tmpdir(), 'nonexistent-dir-12345'), 3),
    ).resolves.toBeUndefined();
  });
});

describe('getActiveLinkedVersion', () => {
  it('returns null when the fixture has no program entry', async () => {
    expect(await getActiveLinkedVersion()).toBeNull();
  });
});

describe('compareVersions', () => {
  // Basic semver comparison
  it('should return 1 when a > b (patch)', () => {
    expect(compareVersions('0.2.1', '0.2.0')).toBe(1);
  });

  it('should return -1 when a < b (patch)', () => {
    expect(compareVersions('0.2.0', '0.2.1')).toBe(-1);
  });

  it('should return 1 when a > b (minor)', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBe(1);
  });

  it('should return -1 when a < b (minor)', () => {
    expect(compareVersions('0.2.9', '0.3.0')).toBe(-1);
  });

  it('should return 1 when a > b (major)', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });

  it('should return 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  // Leading 'v' prefix
  it('should strip leading v prefix', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('should strip leading V prefix', () => {
    expect(compareVersions('V1.2.3', '1.2.3')).toBe(0);
  });

  it('should handle both versions having v prefix', () => {
    expect(compareVersions('v1.2.3', 'v1.2.4')).toBe(-1);
  });

  // Different segment lengths
  it('should treat missing segments as 0', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('should handle 1.0 vs 1.0.1', () => {
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
  });

  it('should handle single segment versions', () => {
    expect(compareVersions('2', '1.9.9')).toBe(1);
  });

  // Pre-release ordering (semver §11)
  it('should order release > pre-release (1.0.0 > 1.0.0-alpha)', () => {
    expect(compareVersions('1.0.0', '1.0.0-alpha')).toBe(1);
  });

  it('should order pre-release < release (1.0.0-beta < 1.0.0)', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
  });

  it('should compare pre-release identifiers alphabetically', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });

  it('should compare pre-release with numeric identifiers', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
  });

  it('should rank numeric identifiers lower than alphanumeric', () => {
    // Per semver §11.4.4: numeric < alphanumeric
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('should handle equal pre-release versions', () => {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.1')).toBe(0);
  });

  it('should handle pre-release with more identifiers', () => {
    // 1.0.0-alpha < 1.0.0-alpha.1 (fewer fields = lower precedence)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  });

  // Edge cases
  it('should handle 0.0.0 versions', () => {
    expect(compareVersions('0.0.0', '0.0.1')).toBe(-1);
  });

  it('should handle large version numbers', () => {
    expect(compareVersions('100.200.300', '100.200.301')).toBe(-1);
  });

  it('should handle four-segment versions', () => {
    expect(compareVersions('1.2.3.4', '1.2.3.5')).toBe(-1);
  });

  it('should handle four-segment equal to three-segment', () => {
    expect(compareVersions('1.2.3.0', '1.2.3')).toBe(0);
  });

  // Real-world versions
  it('should correctly compare real test-cli versions', () => {
    expect(compareVersions('0.1.9', '0.2.0')).toBe(-1);
    expect(compareVersions('0.3.0', '0.2.5')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
  });
});

describe('extractArchive failure attribution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'binary-updater-extract-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function archiveFile(name: string): ManifestFile {
    return {
      os: process.platform === 'win32' ? 'windows' : process.platform,
      arch: process.arch,
      url: `https://cdn.example.com/releases/${name}`,
      sha256: 'irrelevant-for-extraction',
    };
  }

  it('names the failing archive tool and its exit code', async () => {
    const archivePath = join(tmpDir, 'corrupt.tar.gz');
    await writeFile(archivePath, 'this is definitely not a gzip archive');
    const extractDir = join(tmpDir, 'out');
    await mkdir(extractDir, { recursive: true });

    const error = await extractArchive(
      archivePath,
      extractDir,
      archiveFile('corrupt.tar.gz'),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('tar xzf');
    expect((error as Error).message).toMatch(/exit \d+/);
  });
});

// Existing real-filesystem cases moved with the internal mechanics.
describe('native version-store integration', () => {
  // =========================================================================
  // 7. cleanupOldVersions keeps MAX_KEPT_VERSIONS
  // =========================================================================

  describe('cleanupOldVersions keeps MAX_KEPT_VERSIONS', () => {
    let binDir: string;

    beforeEach(async () => {
      binDir = await mkdtemp(join(fixtureDir, 'cleanup-'));
    });

    async function createVersionFile(version: string): Promise<void> {
      const filePath = join(binDir, `test-cli-${version}`);
      await writeFile(filePath, `binary-${version}`);
    }

    it('removes oldest when 7 versions exist and keep=MAX_KEPT_VERSIONS', async () => {
      await createVersionFile('0.1.0');
      await createVersionFile('0.2.0');
      await createVersionFile('0.3.0');
      await createVersionFile('0.4.0');
      await createVersionFile('0.5.0');
      await createVersionFile('0.6.0');
      await createVersionFile('0.7.0');

      await cleanupOldVersions(binDir, MAX_KEPT_VERSIONS);

      const remaining = (await readdir(binDir)).sort();
      expect(remaining).toHaveLength(MAX_KEPT_VERSIONS);

      // Newest versions by semver
      expect(remaining).toContain('test-cli-0.7.0');
      expect(remaining).toContain('test-cli-0.6.0');
      expect(remaining).toContain('test-cli-0.5.0');

      // Older versions removed
      expect(remaining).not.toContain('test-cli-0.4.0');
      expect(remaining).not.toContain('test-cli-0.3.0');
      expect(remaining).not.toContain('test-cli-0.2.0');
      expect(remaining).not.toContain('test-cli-0.1.0');
    });

    it('does not delete anything when count is within keep limit', async () => {
      await createVersionFile('0.1.0');
      await createVersionFile('0.2.0');
      await createVersionFile('0.3.0');

      await cleanupOldVersions(binDir, MAX_KEPT_VERSIONS);

      const remaining = await readdir(binDir);
      expect(remaining).toHaveLength(3);
    });

    it('ignores non-versioned files', async () => {
      await createVersionFile('0.1.0');
      await createVersionFile('0.2.0');
      await createVersionFile('0.3.0');
      await writeFile(join(binDir, 'README.txt'), 'readme');
      await writeFile(join(binDir, 'config.json'), '{}');

      await cleanupOldVersions(binDir, 2);

      const remaining = (await readdir(binDir)).sort();
      // 2 versioned files + 2 non-versioned files
      expect(remaining).toContain('test-cli-0.3.0');
      expect(remaining).toContain('test-cli-0.2.0');
      expect(remaining).toContain('README.txt');
      expect(remaining).toContain('config.json');
      expect(remaining).not.toContain('test-cli-0.1.0');
    });

    it('sorts by semver, not lexicographically', async () => {
      // Lexical: 0.10.0 < 0.2.0 < 0.9.0 — WRONG
      // Semver:  0.2.0 < 0.9.0 < 0.10.0 — CORRECT
      await createVersionFile('0.2.0');
      await createVersionFile('0.9.0');
      await createVersionFile('0.10.0');

      await cleanupOldVersions(binDir, 2);

      const remaining = await readdir(binDir);
      expect(remaining).toHaveLength(2);
      expect(remaining).toContain('test-cli-0.10.0');
      expect(remaining).toContain('test-cli-0.9.0');
      expect(remaining).not.toContain('test-cli-0.2.0');
    });

    it('handles pre-release versions in cleanup ordering', async () => {
      // semver: 0.3.0-beta < 0.3.0
      await createVersionFile('0.1.0');
      await createVersionFile('0.2.0');
      await createVersionFile('0.3.0-beta');
      await createVersionFile('0.3.0');

      await cleanupOldVersions(binDir, 2);

      const remaining = await readdir(binDir);
      expect(remaining).toHaveLength(2);
      // Newest 2: 0.3.0 then 0.3.0-beta
      expect(remaining).toContain('test-cli-0.3.0');
      expect(remaining).toContain('test-cli-0.3.0-beta');
    });

    it('handles empty directory gracefully', async () => {
      await expect(
        cleanupOldVersions(binDir, MAX_KEPT_VERSIONS),
      ).resolves.toBeUndefined();
    });

    it('handles non-existent directory gracefully', async () => {
      await expect(
        cleanupOldVersions(
          join(fixtureDir, 'nonexistent-dir-xyz'),
          MAX_KEPT_VERSIONS,
        ),
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // 8. parseVersionFromFilename tests
  // =========================================================================

  describe('parseVersionFromFilename', () => {
    it("'test-cli-0.2.0' → '0.2.0'", () => {
      expect(parseVersionFromFilename('test-cli-0.2.0')).toBe('0.2.0');
    });

    it("'test-cli-0.2.0.exe' → '0.2.0'", () => {
      expect(parseVersionFromFilename('test-cli-0.2.0.exe')).toBe('0.2.0');
    });

    it("'somethingelse-0.2.0' → null", () => {
      expect(parseVersionFromFilename('somethingelse-0.2.0')).toBeNull();
    });

    it('extracts version from full path', () => {
      expect(
        parseVersionFromFilename(
          '/home/user/.qwen/bin/test-cli/test-cli-1.5.3',
        ),
      ).toBe('1.5.3');
    });

    it('returns null for bare binary name without version', () => {
      expect(parseVersionFromFilename('test-cli')).toBeNull();
    });

    it('handles pre-release versions', () => {
      expect(parseVersionFromFilename('test-cli-1.0.0-alpha.1')).toBe(
        '1.0.0-alpha.1',
      );
    });

    it('handles .bin extension', () => {
      expect(parseVersionFromFilename('test-cli-2.0.0.bin')).toBe('2.0.0');
    });

    it('handles Windows .exe with pre-release', () => {
      expect(parseVersionFromFilename('test-cli-0.5.0-rc.2.exe')).toBe(
        '0.5.0-rc.2',
      );
    });
  });

  // =========================================================================
  // Additional: updateLink integration with real temp directories
  // =========================================================================

  describe('updateLink integration', () => {
    it('creates a symlink from linkPath to target', async () => {
      const target = join(fixtureDir, 'test-cli-0.3.0');
      const linkPath = join(fixtureDir, 'links', 'test-cli');

      await writeFile(target, 'binary-content');

      await updateLink(target, linkPath);

      const { readlink } = await import('node:fs/promises');
      const resolvedTarget = await readlink(linkPath);
      expect(resolvedTarget).toBe(target);
    });

    it('replaces an existing symlink', async () => {
      const { symlink, readlink } = await import('node:fs/promises');

      const oldTarget = join(fixtureDir, 'test-cli-0.2.0');
      const newTarget = join(fixtureDir, 'test-cli-0.3.0');
      const linkPath = join(fixtureDir, 'test-cli');

      await writeFile(oldTarget, 'old-binary');
      await writeFile(newTarget, 'new-binary');
      await symlink(oldTarget, linkPath);

      await updateLink(newTarget, linkPath);

      const resolved = await readlink(linkPath);
      expect(resolved).toBe(newTarget);
    });

    it('creates parent directories if they do not exist', async () => {
      const { readlink } = await import('node:fs/promises');

      const target = join(fixtureDir, 'test-cli-0.3.0');
      const linkPath = join(fixtureDir, 'deep', 'nested', 'dir', 'test-cli');

      await writeFile(target, 'binary-content');
      await updateLink(target, linkPath);

      // Verify symlink was created (readlink throws if it doesn't exist)
      const resolved = await readlink(linkPath);
      expect(resolved).toBe(target);
    });
  });

});
