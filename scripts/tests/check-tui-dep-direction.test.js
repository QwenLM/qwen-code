/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  bannedFamily,
  checkRule,
  findImports,
  listSourceFiles,
} from '../check-tui-dep-direction.mjs';

const temporaryDirectories = [];

function makeTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'tui-dep-direction-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('bannedFamily', () => {
  it.each([
    ['ink', 'ink'],
    ['ink/patch-console', 'ink'],
    ['ink-gradient', 'ink'],
    ['@inkjs/ui', 'ink'],
    ['react', 'react'],
    ['react/jsx-runtime', 'react'],
    ['react-dom', 'react'],
    ['solid-js', 'solid'],
    ['solid-js/web', 'solid'],
    ['solid-app-router', 'solid'],
    ['@solidjs/router', 'solid'],
    ['@solid-primitives/utils', 'solid'],
    ['@opentui/core', '@opentui'],
    ['@opentui', '@opentui'],
  ])('bans %s as the %s family', (spec, family) => {
    expect(bannedFamily(spec)).toBe(family);
  });

  it.each([
    'inkwell',
    'inkjet',
    'reactivedb',
    'solidity-parser',
    'openai',
    '@open-telemetry/api',
    './local.js',
    '@qwen-code/qwen-code-core',
  ])('allows %s', (spec) => {
    expect(bannedFamily(spec)).toBeNull();
  });
});

describe('findImports', () => {
  const specs = (source, fileName) =>
    findImports(source, fileName).map((imp) => `${imp.kind}:${imp.spec}`);

  it('detects every import shape a module can use', () => {
    expect(
      specs(
        [
          "import { render } from 'ink';",
          "import type { ReactNode } from 'react';",
          "import 'solid-js/web';",
          "export * as inkUtils from 'ink-testing-library';",
          "export type { Props } from '@opentui/core';",
          "export { Box } from 'ink';",
          "const lazy = await import('@solidjs/router');",
          "const legacy = require('react-dom');",
          "vi.mock('ink-spinner');",
        ].join('\n'),
      ),
    ).toEqual([
      'import:ink',
      'import:react',
      'import:solid-js/web',
      'export-from:ink-testing-library',
      'export-from:@opentui/core',
      'export-from:ink',
      'dynamic-import:@solidjs/router',
      'require:react-dom',
      'vi.mock:ink-spinner',
    ]);
  });

  it('ignores import-shaped text inside comments and strings', () => {
    expect(
      specs(
        [
          "// import { render } from 'ink';",
          "/* require('react') */",
          "* header note mentioning import from 'ink'",
          'const fixture = "import { Box } from \'ink\';";',
          'const template = `require("react")`;',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('survives a regex literal full of quote characters', () => {
    // The regex-masked lexer desynced here and masked the real import.
    const source = [
      'const re = /[\'"](ink|react)[\'"]/g;',
      "import { render } from 'ink';",
    ].join('\n');
    expect(specs(source)).toEqual(['import:ink']);
  });

  it('finds a dynamic import inside template-literal interpolation', () => {
    const source = ["const loaded = `${await import('@opentui/core')}`;"].join(
      '\n',
    );
    expect(specs(source)).toEqual(['dynamic-import:@opentui/core']);
  });

  it('reports line numbers matching the source', () => {
    const source = '\n\n' + "import { Box } from 'ink';";
    expect(findImports(source)[0].line).toBe(3);
  });
});

describe('checkRule', () => {
  function writeSource(root, relativePath, source) {
    const filePath = join(root, relativePath);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, source);
    return filePath;
  }

  it('flags banned imports and reports clean trees', () => {
    const root = makeTemporaryDirectory();
    writeSource(root, 'dirty.ts', "import { render } from 'ink';\n");
    writeSource(root, 'nested/clean.ts', "import { z } from 'zod';\n");

    const dirty = checkRule({
      label: 'dirty',
      root,
      rules: { noFramework: true },
    });
    expect(dirty.violations).toHaveLength(1);
    expect(dirty.violations[0]).toContain("import 'ink'");
    expect(dirty.violations[0]).toContain('dirty.ts:1');

    rmSync(join(root, 'dirty.ts'));
    const clean = checkRule({
      label: 'clean',
      root,
      rules: { noFramework: true },
    });
    expect(clean.violations).toEqual([]);
    expect(clean.scanned).toBe(1);
  });

  it('scans .mts and .cts sources the enumeration layer covers', () => {
    const root = makeTemporaryDirectory();
    writeSource(root, 'probe.mts', "import { render } from 'ink';\n");
    writeSource(root, 'helper.cts', "const react = require('react');\n");

    const result = checkRule({
      label: 'mts',
      root,
      rules: { noFramework: true },
    });
    expect(result.violations).toHaveLength(2);
  });

  it('flags relative imports escaping a self-contained root', () => {
    const root = makeTemporaryDirectory();
    writeSource(
      root,
      'model/inner.ts',
      "import { helper } from '../helper.js';\n",
    );
    writeSource(root, 'helper.ts', 'export const helper = 1;\n');

    const result = checkRule({
      label: 'self-contained',
      root: join(root, 'model'),
      rules: { selfContained: true },
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('escapes the framework-neutral');

    const contained = checkRule({
      label: 'self-contained',
      root,
      rules: { selfContained: true },
    });
    expect(contained.violations).toEqual([]);
  });

  it('follows symlinked files and directories instead of skipping them', () => {
    const root = makeTemporaryDirectory();
    const target = join(root, 'real');
    writeSource(root, 'real/leak.ts', "import { Box } from 'ink';\n");
    const scanRoot = join(root, 'scanned');
    mkdirSync(scanRoot);
    writeSource(root, 'scanned/clean.ts', "import { z } from 'zod';\n");
    symlinkSync(target, join(scanRoot, 'linked-dir'), 'dir');
    symlinkSync(
      join(target, 'leak.ts'),
      join(scanRoot, 'linked-file.ts'),
      'file',
    );

    const result = checkRule({
      label: 'symlinks',
      root: scanRoot,
      rules: { noFramework: true },
    });
    expect(result.violations).toHaveLength(2);
  });

  it.skipIf(process.platform === 'win32')(
    'reports unlistable directories instead of silently dropping them',
    () => {
      const root = makeTemporaryDirectory();
      const blocked = join(root, 'blocked');
      writeSource(root, 'blocked/hidden.ts', "import 'ink';\n");
      chmodSync(blocked, 0o000);

      const result = checkRule({
        label: 'unreadable',
        root,
        rules: { noFramework: true },
      });
      chmodSync(blocked, 0o700);
      expect(result.unreadableDirs.length).toBeGreaterThan(0);
      expect(result.unreadableDirs.join(' ')).toContain('blocked');
    },
  );
});

describe('listSourceFiles', () => {
  it('does not revisit a directory reached through two symlinked paths', () => {
    const root = makeTemporaryDirectory();
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'a.ts'), "import { z } from 'zod';\n");
    symlinkSync(join(root, 'real'), join(root, 'alias-one'), 'dir');
    symlinkSync(join(root, 'real'), join(root, 'alias-two'), 'dir');

    const { files, unreadableDirs } = listSourceFiles(root);
    expect(files).toHaveLength(1);
    expect(unreadableDirs).toEqual([]);
  });
});
