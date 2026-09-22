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
  sortDependencyEntries,
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
  let root;

  beforeEach(async () => {
    // realpath: on macOS the temp dir sits behind /var -> /private/var, and
    // the traversal reports real directories.
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'notices-tree-')),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writePackage(dir, manifest) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(manifest),
    );
  }

  it('follows a workspace link to its dependencies without listing it', async () => {
    const companion = path.join(root, 'packages', 'companion');
    const core = path.join(root, 'packages', 'core');
    await writePackage(companion, { name: 'companion' });
    await writePackage(core, {
      name: '@qwen-code/core',
      version: '0.1.0',
      dependencies: { nested: '^1.0.0' },
    });
    await writePackage(path.join(core, 'node_modules', 'nested'), {
      name: 'nested',
      version: '1.0.0',
    });
    await fs.mkdir(path.join(root, 'node_modules', '@qwen-code'), {
      recursive: true,
    });
    await fs.symlink(
      core,
      path.join(root, 'node_modules', '@qwen-code', 'core'),
      'junction',
    );
    const dependencies = new Map();

    await collectDependencies(
      '@qwen-code/core',
      companion,
      dependencies,
      new Set(),
    );

    expect([...dependencies.values()]).toEqual([
      {
        name: 'nested',
        version: '1.0.0',
        dir: path.join(core, 'node_modules', 'nested'),
      },
    ]);
  });

  it('resolves each dependency from the nearest node_modules above it', async () => {
    const companion = path.join(root, 'packages', 'companion');
    await writePackage(companion, { name: 'companion' });
    await writePackage(path.join(root, 'node_modules', 'hoisted'), {
      name: 'hoisted',
      version: '2.0.0',
      dependencies: { leaf: '^3.0.0' },
    });
    // The nested copy wins over the hoisted one for the package that nests it.
    await writePackage(
      path.join(root, 'node_modules', 'hoisted', 'node_modules', 'leaf'),
      { name: 'leaf', version: '3.1.0' },
    );
    await writePackage(path.join(root, 'node_modules', 'leaf'), {
      name: 'leaf',
      version: '4.0.0',
    });
    const dependencies = new Map();

    await collectDependencies('hoisted', companion, dependencies, new Set());

    expect([...dependencies.keys()]).toEqual(['hoisted@2.0.0', 'leaf@3.1.0']);
  });
});

describe('sortDependencyEntries', () => {
  it('orders entries independently of how they were collected', () => {
    const entries = [
      { name: 'zod', version: '4.4.3' },
      { name: '@modelcontextprotocol/sdk', version: '1.30.0' },
      { name: 'zod-to-json-schema', version: '3.25.2' },
      { name: 'zod', version: '3.25.76' },
      { name: '@agentclientprotocol/sdk', version: '0.14.1' },
    ];
    const expected = [
      '@agentclientprotocol/sdk@0.14.1',
      '@modelcontextprotocol/sdk@1.30.0',
      'zod@3.25.76',
      'zod@4.4.3',
      'zod-to-json-schema@3.25.2',
    ];

    const format = (list) => list.map((e) => `${e.name}@${e.version}`);
    expect(format(sortDependencyEntries(entries))).toEqual(expected);
    expect(format(sortDependencyEntries([...entries].reverse()))).toEqual(
      expected,
    );
    // The input is left untouched.
    expect(entries[0].name).toBe('zod');
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
