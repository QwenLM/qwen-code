/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIST_PREREQUISITES,
  GENERATED_PREREQUISITES,
  checkAndReport,
  findMissingPrerequisites,
  formatPrerequisiteMessage,
  normalizePackageKey,
} from '../vitest-global-setup.js';

// Mirrors the real manifest shapes: most channel packages declare their entry
// via exports['.'].default, while acp-bridge/web-templates use exports['.'].import.
function manifestFor(rel) {
  if (
    rel === 'packages/acp-bridge' ||
    rel === 'packages/web-templates' ||
    rel === 'packages/core'
  ) {
    return {
      name: `fake-${path.basename(rel)}`,
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      },
    };
  }
  return {
    name: `fake-${path.basename(rel)}`,
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    },
  };
}

function buildFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'vitest-prereq-'));
  for (const deps of Object.values(DIST_PREREQUISITES)) {
    for (const rel of deps) {
      mkdirSync(path.join(root, rel, 'dist'), { recursive: true });
      writeFileSync(
        path.join(root, rel, 'package.json'),
        JSON.stringify(manifestFor(rel)),
      );
      writeFileSync(path.join(root, rel, 'dist', 'index.js'), '');
    }
  }
  for (const files of Object.values(GENERATED_PREREQUISITES)) {
    for (const rel of files) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), '');
    }
  }
  return root;
}

describe('normalizePackageKey', () => {
  it('maps win32 backslash separators onto the forward-slash keys', () => {
    expect(normalizePackageKey('packages\\cli')).toBe('packages/cli');
    expect(normalizePackageKey('packages/cli')).toBe('packages/cli');
    expect(normalizePackageKey('packages\\cli\\')).toBe('packages/cli');
  });
});

describe('vitest-global-setup prerequisite guard', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    vi.restoreAllMocks();
  });

  it('reports nothing when every prerequisite exists', () => {
    root = buildFixtureRoot();
    expect(findMissingPrerequisites('packages/cli', root)).toEqual([]);
    expect(findMissingPrerequisites('packages/core', root)).toEqual([]);
  });

  it('accepts a win32-style relative key', () => {
    root = buildFixtureRoot();
    expect(findMissingPrerequisites('packages\\cli', root)).toEqual([]);
  });

  it('reports an unbuilt workspace package and a missing generated file', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/channels/base/dist/index.js'));
    rmSync(path.join(root, 'packages/cli/src/generated/git-commit.ts'));

    const missing = findMissingPrerequisites('packages/cli', root);
    expect(missing).toHaveLength(2);
    expect(missing[0]).toContain('packages/channels/base');
    expect(missing[0]).toContain('has not been built');
    expect(missing[1]).toContain('packages/cli/src/generated/git-commit.ts');
  });

  it('reports a missing package directory instead of throwing', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/web-templates'), { recursive: true });

    const missing = findMissingPrerequisites('packages/cli', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('packages/web-templates');
    expect(missing[0]).toContain('missing/unreadable');
  });

  it('skips packages without known prerequisites', () => {
    root = buildFixtureRoot();
    expect(findMissingPrerequisites('packages/web-shell', root)).toEqual([]);
  });

  it('reports an unbuilt packages/core dist for core tests', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/core/dist/index.js'));

    const missing = findMissingPrerequisites('packages/core', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('packages/core');
    expect(missing[0]).toContain('has not been built');
  });

  it('names the fix command in the formatted message', () => {
    const message = formatPrerequisiteMessage(['  - packages/x: nope']);
    expect(message).toContain('npm run build');
    expect(message).toContain('packages/x: nope');
    expect(message).toContain('npm run generate');
  });
});

describe('subpath exports entries are probed', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('probes main entries spelled without a leading ./', () => {
    root = buildFixtureRoot();
    writeFileSync(
      path.join(root, 'packages/core', 'package.json'),
      JSON.stringify({ name: 'fake-core', main: 'dist/index.js' }),
    );
    rmSync(path.join(root, 'packages/core/dist/index.js'));

    const missing = findMissingPrerequisites('packages/core', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('has not been built');
  });

  it('skips wildcard pattern entries instead of treating them as files', () => {
    root = buildFixtureRoot();
    writeFileSync(
      path.join(root, 'packages/core', 'package.json'),
      JSON.stringify({
        name: 'fake-core',
        exports: {
          '.': { import: './dist/index.js' },
          './dist/*': './dist/*',
          './src/*': './src/*',
        },
      }),
    );
    expect(findMissingPrerequisites('packages/core', root)).toEqual([]);
  });

  it('flags a missing subpath dist file even when the . entry exists', () => {
    root = buildFixtureRoot();
    const bridgeDir = path.join(root, 'packages/acp-bridge');
    writeFileSync(
      path.join(bridgeDir, 'package.json'),
      JSON.stringify({
        name: 'fake-acp-bridge',
        exports: {
          '.': { import: './dist/index.js' },
          './sessionRestoreTimeout': {
            import: './dist/session-restore-timeout.js',
          },
        },
      }),
    );
    // dist/index.js exists; the subpath target does not.
    const missing = findMissingPrerequisites('packages/cli', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('session-restore-timeout.js');
  });
});

describe('checkAndReport', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    vi.restoreAllMocks();
  });

  it('returns 0 and prints nothing when prerequisites are satisfied', () => {
    root = buildFixtureRoot();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = path.join(root, 'packages/cli');
    expect(checkAndReport({ cwd, root })).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('returns 1 and prints the actionable message when prerequisites are missing', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/channels/base/dist/index.js'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = path.join(root, 'packages/cli');
    expect(checkAndReport({ cwd, root })).toBe(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const printed = errSpy.mock.calls[0][0];
    expect(printed).toContain('npm run build');
    expect(printed).toContain('packages/channels/base');
  });

  it('derives the key from cwd relative to root (win32 separators tolerated)', () => {
    root = buildFixtureRoot();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // cwd deeper than the package dir still resolves to the package key only
    // when it is exactly the package dir; a mismatched cwd yields no known
    // key and therefore no prerequisites (guard yields silently by design).
    expect(checkAndReport({ cwd: root, root })).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

function registryChannelEntries() {
  const registryPath = fileURLToPath(
    new URL(
      '../../packages/cli/src/commands/channel/channel-registry.ts',
      import.meta.url,
    ),
  );
  const source = readFileSync(registryPath, 'utf8');
  // npm package names may contain digits; the class must tolerate them or a
  // future builtin channel silently escapes this drift check.
  const specifiers = [
    ...source.matchAll(/import\('@qwen-code\/(channel-[a-z0-9-]+)'\)/g),
  ].map((match) => match[1]);
  return specifiers.map(
    (name) => `packages/channels/${name.replace('channel-', '')}`,
  );
}

describe('DIST_PREREQUISITES stays in sync with channel-registry', () => {
  it('every builtin channel dynamically imported by channel-registry.ts is listed', () => {
    const entries = registryChannelEntries();
    expect(entries.length).toBeGreaterThan(0);
    const listed = DIST_PREREQUISITES['packages/cli'];
    for (const entry of entries) {
      expect(listed, `missing prerequisite entry for ${entry}`).toContain(
        entry,
      );
    }
  });

  it('every listed packages/channels/* entry maps back to a registry import', () => {
    const imported = new Set(registryChannelEntries());
    // channel-base is a build dependency of the channel packages even though
    // the registry never imports it directly.
    imported.add('packages/channels/base');
    for (const entry of DIST_PREREQUISITES['packages/cli']) {
      if (!entry.startsWith('packages/channels/')) continue;
      expect(
        imported,
        `stale prerequisite entry ${entry}: no matching channel-registry import`,
      ).toContain(entry);
    }
  });
});
