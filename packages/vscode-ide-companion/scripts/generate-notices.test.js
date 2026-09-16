/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectDependencies,
  findLicenseFile,
  findNoticeFile,
  findSupplementaryLicenseFiles,
  getFallbackLicenseText,
  normalizeRepositoryUrl,
  runNoticeGeneration,
} from './generate-notices.js';

describe('runNoticeGeneration', () => {
  it('skips generation during dependency-only worktree setup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Stubbed no-op so a regression that drops the early return rewrites the
    // tracked NOTICES.txt instead of merely failing this assertion.
    const write = vi.spyOn(fs, 'writeFile').mockImplementation(async () => {});

    try {
      await runNoticeGeneration({
        npm_lifecycle_event: 'generate:notices',
        QWEN_SKIP_NOTICE_GENERATION: '1',
      });

      expect(log).toHaveBeenCalledWith(
        'Skipping VS Code notice generation during worktree bootstrap.',
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
  });

  it('still generates notices when the skip flag is absent', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Empty dependency graph: main() reaches the write without touching the
    // real node_modules, and a failing main() cannot process.exit the worker.
    const read = vi.spyOn(fs, 'readFile').mockImplementation(async (file) => {
      const name = String(file);
      if (name.endsWith('package.json')) {
        return JSON.stringify({ dependencies: {} });
      }
      if (name.endsWith('package-lock.json')) {
        return JSON.stringify({ packages: {} });
      }
      throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
    });
    const write = vi.spyOn(fs, 'writeFile').mockImplementation(async () => {});

    try {
      await runNoticeGeneration({ npm_lifecycle_event: 'generate:notices' });

      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]?.[1])).toContain(
        'third-party software notices and license terms',
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
      read.mockRestore();
      write.mockRestore();
    }
  });
});

describe('findLicenseFile', () => {
  let packageDir;

  beforeEach(async () => {
    packageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notices-test-'));
  });

  afterEach(async () => {
    await fs.rm(packageDir, { recursive: true, force: true });
  });

  // Regression guard: the Linux CI drift check runs generation and comparison
  // on the same case-sensitive filesystem, so a revert to case-sensitive
  // matching would produce consistent-but-wrong output and pass the check.
  // This asserts the lookup resolves a mixed-case file regardless of platform.
  it('resolves a mixed-case license file', async () => {
    await fs.writeFile(path.join(packageDir, 'License'), 'MIT');

    const resolved = await findLicenseFile(packageDir);

    expect(resolved).toBe(path.join(packageDir, 'License'));
  });

  it('prefers LICENSE over other variants', async () => {
    await fs.writeFile(path.join(packageDir, 'LICENSE'), 'Apache-2.0');
    await fs.writeFile(path.join(packageDir, 'LICENSE.md'), 'MIT');

    const resolved = await findLicenseFile(packageDir);

    expect(resolved).toBe(path.join(packageDir, 'LICENSE'));
  });

  it('honors the package.json licenseFile hint', async () => {
    await fs.writeFile(path.join(packageDir, 'COPYING'), 'GPL');

    const resolved = await findLicenseFile(packageDir, 'COPYING');

    expect(resolved).toBe(path.join(packageDir, 'COPYING'));
  });

  it('returns undefined when no license file exists', async () => {
    const resolved = await findLicenseFile(packageDir);

    expect(resolved).toBeUndefined();
  });
});

describe('collectDependencies', () => {
  it('resolves workspace dependencies from the linked package location', () => {
    const packageLock = {
      packages: {
        'packages/companion/node_modules/@qwen-code/core': {
          link: true,
          resolved: 'packages/core',
        },
        'packages/core': { dependencies: { nested: '1.0.0' } },
        'packages/core/node_modules/nested': { version: '1.0.0' },
      },
    };
    const dependencies = new Map();

    collectDependencies(
      '@qwen-code/core',
      packageLock,
      dependencies,
      'packages/companion',
      new Set(),
    );

    expect([...dependencies.values()]).toEqual([
      {
        name: 'nested',
        version: '1.0.0',
        resolvedKey: 'packages/core/node_modules/nested',
      },
    ]);
  });
});

describe('normalizeRepositoryUrl', () => {
  it('returns object-form repository urls unchanged', () => {
    expect(
      normalizeRepositoryUrl({
        type: 'git',
        url: 'git+https://github.com/nodejs/undici.git',
      }),
    ).toBe('git+https://github.com/nodejs/undici.git');
  });

  it('accepts string-form repository urls', () => {
    expect(
      normalizeRepositoryUrl(
        'https://github.com/theKashey/react-remove-scroll-bar',
      ),
    ).toBe('https://github.com/theKashey/react-remove-scroll-bar');
  });

  it('expands bare GitHub shorthand strings', () => {
    expect(normalizeRepositoryUrl('yargs/cliui')).toBe(
      'https://github.com/yargs/cliui',
    );
  });

  it('expands github:-prefixed shorthand strings', () => {
    expect(
      normalizeRepositoryUrl('github:anthropics/anthropic-sdk-typescript'),
    ).toBe('https://github.com/anthropics/anthropic-sdk-typescript');
  });

  it('normalizes git://, git+https:// and scp-style string urls', () => {
    expect(
      normalizeRepositoryUrl('git://github.com/komagata/eastasianwidth.git'),
    ).toBe('https://github.com/komagata/eastasianwidth.git');
    expect(
      normalizeRepositoryUrl('git+https://github.com/jsdom/tr46.git'),
    ).toBe('https://github.com/jsdom/tr46.git');
    expect(
      normalizeRepositoryUrl('git@github.com:kwsites/file-exists.git'),
    ).toBe('https://github.com/kwsites/file-exists.git');
  });

  it('returns undefined for absent or empty repository values', () => {
    expect(normalizeRepositoryUrl(undefined)).toBeUndefined();
    expect(normalizeRepositoryUrl({})).toBeUndefined();
    expect(normalizeRepositoryUrl('   ')).toBeUndefined();
  });
});

describe('findNoticeFile', () => {
  let packageDir;

  beforeEach(async () => {
    packageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notices-test-'));
  });

  afterEach(async () => {
    await fs.rm(packageDir, { recursive: true, force: true });
  });

  it('resolves a mixed-case NOTICE file', async () => {
    await fs.writeFile(path.join(packageDir, 'Notice'), 'Apache ECharts');

    const resolved = await findNoticeFile(packageDir);

    expect(resolved).toBe(path.join(packageDir, 'Notice'));
  });

  it('prefers NOTICE over NOTICE.txt', async () => {
    await fs.writeFile(path.join(packageDir, 'NOTICE'), 'notice');
    await fs.writeFile(path.join(packageDir, 'NOTICE.txt'), 'notice.txt');

    const resolved = await findNoticeFile(packageDir);

    expect(resolved).toBe(path.join(packageDir, 'NOTICE'));
  });

  it('returns undefined when no NOTICE file exists', async () => {
    const resolved = await findNoticeFile(packageDir);

    expect(resolved).toBeUndefined();
  });
});

describe('findSupplementaryLicenseFiles', () => {
  let packageDir;

  beforeEach(async () => {
    packageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notices-test-'));
  });

  afterEach(async () => {
    await fs.rm(packageDir, { recursive: true, force: true });
  });

  it('lists files in the licenses directory sorted', async () => {
    await fs.mkdir(path.join(packageDir, 'licenses'));
    await fs.writeFile(path.join(packageDir, 'licenses', 'LICENSE-d3'), 'BSD');
    await fs.writeFile(path.join(packageDir, 'licenses', 'LICENSE-abc'), 'MIT');

    const resolved = await findSupplementaryLicenseFiles(packageDir);

    expect(resolved).toEqual([
      path.join(packageDir, 'licenses', 'LICENSE-abc'),
      path.join(packageDir, 'licenses', 'LICENSE-d3'),
    ]);
  });

  it('ignores the uppercase REUSE-style LICENSES directory', async () => {
    await fs.mkdir(path.join(packageDir, 'LICENSES'));
    await fs.writeFile(
      path.join(packageDir, 'LICENSES', 'Apache-2.0.txt'),
      'Apache-2.0',
    );

    const resolved = await findSupplementaryLicenseFiles(packageDir);

    expect(resolved).toEqual([]);
  });

  it('returns an empty list when the package has no licenses directory', async () => {
    const resolved = await findSupplementaryLicenseFiles(packageDir);

    expect(resolved).toEqual([]);
  });
});

describe('getFallbackLicenseText', () => {
  it('returns standard MIT text with the copyright holder from a string author', () => {
    const text = getFallbackLicenseText('MIT', 'Wilson Page');

    expect(text).toContain('Standard MIT license text');
    expect(text).toContain('Copyright (c) Wilson Page');
    expect(text).toContain('Permission is hereby granted, free of charge');
  });

  // MIT requires the permission notice to be included verbatim; the
  // fallback body must carry the canonical disclaimer wording so every
  // regenerated NOTICES.txt entry matches the other MIT entries.
  it('emits the canonical MIT disclaimer wording verbatim', () => {
    const text = getFallbackLicenseText('MIT', undefined);

    expect(text).toContain(
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    );
    expect(text).not.toContain('THE USE OF OTHER DEALINGS');
  });

  it('reads the author name from object-form authors', () => {
    const text = getFallbackLicenseText('MIT', { name: 'Junyoung Choi' });

    expect(text).toContain('Copyright (c) Junyoung Choi');
  });

  it('strips the trailing homepage from npm author strings', () => {
    const text = getFallbackLicenseText(
      'MIT',
      'Junyoung Choi <fluke8259@gmail.com> (https://rokt33r.github.io)',
    );

    expect(text).toContain('Copyright (c) Junyoung Choi <fluke8259@gmail.com>');
    expect(text).not.toContain('rokt33r.github.io');
  });

  it('omits the copyright line when no author is declared', () => {
    const text = getFallbackLicenseText('MIT', undefined);

    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).not.toContain('Copyright (c)');
  });

  it('returns undefined for non-MIT declarations', () => {
    expect(getFallbackLicenseText('Apache-2.0', 'Some Author')).toBeUndefined();
    expect(getFallbackLicenseText(undefined, 'Some Author')).toBeUndefined();
  });
});
