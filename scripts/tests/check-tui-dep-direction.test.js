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
  symlinkedPathComponents,
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

  it('detects import-type queries (type X = import("...").Y)', () => {
    expect(
      specs(
        [
          'type Node = import("react").ReactNode;',
          "type Box = import('ink').Box['props'];",
          'type Core = import(`@opentui/core`).TuiApp;',
        ].join('\n'),
      ),
    ).toEqual([
      'import-type:react',
      'import-type:ink',
      'import-type:@opentui/core',
    ]);
  });

  it('accepts interpolation-free template literals as call specifiers', () => {
    expect(
      specs(
        [
          'const lazy = await import(`@solidjs/router`);',
          'const legacy = require(`react-dom`);',
          'vi.mock(`ink-spinner`);',
        ].join('\n'),
      ),
    ).toEqual([
      'dynamic-import:@solidjs/router',
      'require:react-dom',
      'vi.mock:ink-spinner',
    ]);
  });

  it('still ignores interpolated specifiers (not statically knowable)', () => {
    const source = [
      'const mod = await import(`react${suffix}`);',
      'const legacy = require(`${name}/ink`);',
      'vi.mock(`ink-${variant}`);',
    ].join('\n');
    expect(specs(source)).toEqual([]);
  });

  it('detects import-equals forms (import x = require("..."))', () => {
    expect(
      specs(
        [
          "import ink = require('ink');",
          "export import reactDom = require('react-dom');",
          'import wrapped = require(`solid-js`);',
        ].join('\n'),
      ),
    ).toEqual([
      'import-equals:ink',
      'import-equals:react-dom',
      'import-equals:solid-js',
    ]);
  });

  it('ignores namespace import-equals (no module specifier)', () => {
    expect(specs('import ns = Some.Namespace;\n')).toEqual([]);
  });

  it('detects module-resolution probes that name a framework', () => {
    expect(
      specs(
        [
          "const p = require.resolve('ink');",
          "const m = import.meta.resolve('react');",
        ].join('\n'),
      ),
    ).toEqual(['require.resolve:ink', 'import.meta.resolve:react']);
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

  it('fails closed on symlinks inside the rule root instead of following them', () => {
    const root = makeTemporaryDirectory();
    const scanRoot = join(root, 'scanned');
    mkdirSync(scanRoot);
    const target = join(scanRoot, 'real');
    writeSource(root, 'scanned/real/leak.ts', "import { Box } from 'ink';\n");
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
    // leak.ts is scanned once as a real file; both symlinks fail the gate
    // and are never followed, so no link can mask or fake an import.
    expect(result.violations).toHaveLength(1);
    expect(result.symlinks).toHaveLength(2);
  });

  it('fails closed when a symlink target escapes the rule root', () => {
    const root = makeTemporaryDirectory();
    writeSource(root, 'outside/config/settings.ts', 'export const x = 1;\n');
    writeSource(root, 'outside/sneaky.ts', "import { render } from 'ink';\n");
    const scanRoot = join(root, 'ui-model');
    mkdirSync(scanRoot);
    writeSource(root, 'ui-model/clean.ts', "import { z } from 'zod';\n");
    // A file served from outside the rule root whose lexical relative
    // imports would resolve inside it; the link must fail the gate, not be
    // scanned.
    symlinkSync(
      join(root, 'outside', 'sneaky.ts'),
      join(scanRoot, 'dialog-scope.ts'),
      'file',
    );
    symlinkSync(
      join(root, 'outside', 'config'),
      join(scanRoot, 'config-dir'),
      'dir',
    );

    const result = checkRule({
      label: 'escaped',
      root: scanRoot,
      rules: { noFramework: true, selfContained: true },
    });
    expect(result.symlinks).toHaveLength(2);
    expect(result.symlinks.join(' ')).toContain('dialog-scope.ts');
    expect(result.symlinks.join(' ')).toContain('config-dir');
    // Symlinked entries are not scanned, so they cannot fake a clean result.
    expect(result.scanned).toBe(1);
    expect(result.violations).toEqual([]);
  });

  it('fails closed on a link whose lexical path masks a physical escape', () => {
    // Reviewer's end-to-end witness: deep/deeper/link.ts -> dist/target.ts,
    // where the physical target imports ../../../cli/secret.js. Lexical
    // resolution from the link stays inside the root (and dist/ is skipped),
    // so only the fail-closed link diagnostic prevents a false PASS.
    const root = makeTemporaryDirectory();
    writeSource(root, 'dist/target.ts', "import '../../../cli/secret.js';\n");
    writeSource(root, 'deep/deeper/keep.ts', "import { z } from 'zod';\n");
    symlinkSync(
      join(root, 'dist', 'target.ts'),
      join(root, 'deep', 'deeper', 'link.ts'),
      'file',
    );

    const result = checkRule({
      label: 'masked-escape',
      root,
      rules: { noFramework: true, selfContained: true },
    });
    expect(result.violations).toEqual([]);
    expect(result.symlinks).toHaveLength(1);
    expect(result.symlinks[0]).toContain('link.ts');
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
  it('reports symlinked aliases instead of following them', () => {
    const root = makeTemporaryDirectory();
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'a.ts'), "import { z } from 'zod';\n");
    symlinkSync(join(root, 'real'), join(root, 'alias-one'), 'dir');
    symlinkSync(join(root, 'real'), join(root, 'alias-two'), 'dir');

    const { files, symlinks, unreadableDirs } = listSourceFiles(root);
    expect(files).toHaveLength(1);
    expect(symlinks).toHaveLength(2);
    expect(unreadableDirs).toEqual([]);
  });
});

describe('symlinkedPathComponents', () => {
  it('returns [] for an ordinary path', () => {
    const anchor = makeTemporaryDirectory();
    const root = join(anchor, 'packages', 'cli', 'src', 'ui', 'model');
    mkdirSync(root, { recursive: true });
    expect(symlinkedPathComponents(root, anchor)).toEqual([]);
  });

  it('rejects a symlinked rule root (substituted scan)', () => {
    const anchor = makeTemporaryDirectory();
    mkdirSync(join(anchor, 'clean-elsewhere'));
    symlinkSync(
      join(anchor, 'clean-elsewhere'),
      join(anchor, 'ui-model'),
      'dir',
    );
    expect(symlinkedPathComponents(join(anchor, 'ui-model'), anchor)).toEqual([
      join(anchor, 'ui-model'),
    ]);
  });

  it('rejects a symlinked ancestor component (reviewer bypass)', () => {
    const anchor = makeTemporaryDirectory();
    mkdirSync(join(anchor, 'real-src', 'ui', 'model'), { recursive: true });
    symlinkSync(join(anchor, 'real-src'), join(anchor, 'src'), 'dir');
    expect(
      symlinkedPathComponents(join(anchor, 'src', 'ui', 'model'), anchor),
    ).toEqual([join(anchor, 'src')]);
  });

  it('stops at a missing component without throwing', () => {
    const anchor = makeTemporaryDirectory();
    expect(
      symlinkedPathComponents(join(anchor, 'nope', 'model'), anchor),
    ).toEqual([]);
  });
});
