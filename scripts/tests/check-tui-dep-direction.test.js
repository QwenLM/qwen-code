/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    ['@solid/meta', 'solid'],
    ['@react-aria/button', 'react'],
    ['@react-spring/web', 'react'],
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

  it('detects the vi module-loading family', () => {
    expect(
      specs(
        [
          "vi.mock('ink');",
          "vi.doMock('react');",
          "await vi.importActual('solid-js');",
          "await vi.importMock('@opentui/core');",
        ].join('\n'),
      ),
    ).toEqual([
      'vi.mock:ink',
      'vi.doMock:react',
      'vi.importActual:solid-js',
      'vi.importMock:@opentui/core',
    ]);
  });

  it('detects CommonJS require indirections', () => {
    expect(
      specs(
        [
          "const ink = module.require('ink');",
          "const react = require.main.require('react');",
        ].join('\n'),
      ),
    ).toEqual(['module.require:ink', 'require.main.require:react']);
  });

  it('detects ambient module declarations', () => {
    expect(
      specs("declare module 'react' { export type X = number; }\n"),
    ).toEqual(['ambient-module:react']);
    expect(specs('declare global { const g: number; }\n')).toEqual([]);
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

  it('flags a bare import of the cli package under noRelativeIntoCli', () => {
    const root = makeTemporaryDirectory();
    writeSource(
      root,
      'core/a.ts',
      "import { run } from '@qwen-code/qwen-code';\n",
    );
    writeSource(root, 'core/b.ts', "import { z } from 'zod';\n");

    const flagged = checkRule({
      label: 'bare-cli',
      root,
      rules: { noRelativeIntoCli: true },
    });
    expect(flagged.violations).toHaveLength(1);
    expect(flagged.violations[0]).toContain(
      '(bare import reaches into packages/cli)',
    );

    const otherRule = checkRule({
      label: 'bare-cli-other-rules',
      root,
      rules: { noFramework: true, selfContained: true },
    });
    expect(otherRule.violations).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
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

describe('end-to-end gate run (main wiring)', () => {
  // Regression guard for the root-path check wired into main(): the helper
  // is unit-tested above, but nothing but a full run proves main() actually
  // invokes it before trusting the scan. Build a fixture checkout inside the
  // (git-ignored) .qwen dir so the copied script resolves `typescript` from
  // the real node_modules, run it as a subprocess, and assert exit codes.
  const gatePath = fileURLToPath(
    new URL('../check-tui-dep-direction.mjs', import.meta.url),
  );
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

  function makeFixtureCheckout() {
    mkdirSync(join(repoRoot, '.qwen'), { recursive: true });
    const base = mkdtempSync(join(repoRoot, '.qwen', 'gate-e2e-'));
    temporaryDirectories.push(base);
    mkdirSync(join(base, 'scripts'));
    mkdirSync(join(base, 'packages', 'core', 'src'), { recursive: true });
    mkdirSync(join(base, 'packages', 'cli', 'src', 'ui', 'model'), {
      recursive: true,
    });
    copyFileSync(
      gatePath,
      join(base, 'scripts', 'check-tui-dep-direction.mjs'),
    );
    // The gate reads the cli package's own name from its manifest to block
    // bare imports of it, so the fixture must carry one.
    writeFileSync(
      join(base, 'packages', 'cli', 'package.json'),
      JSON.stringify({ name: '@qwen-code/qwen-code' }),
    );
    writeFileSync(
      join(base, 'packages', 'core', 'src', 'clean.ts'),
      "import { z } from 'zod';\n",
    );
    writeFileSync(
      join(base, 'packages', 'cli', 'src', 'ui', 'model', 'model.ts'),
      "import { z } from 'zod';\n",
    );
    return base;
  }

  function runGate(base) {
    try {
      const out = execFileSync(
        process.execPath,
        [join(base, 'scripts', 'check-tui-dep-direction.mjs')],
        { encoding: 'utf8', timeout: 30000 },
      );
      return { code: 0, out };
    } catch (error) {
      return {
        code: error.status,
        out: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      };
    }
  }

  it('passes a clean fixture checkout', () => {
    const base = makeFixtureCheckout();
    const { code, out } = runGate(base);
    expect(code).toBe(0);
    expect(out).toContain('PASS — dependency direction holds.');
  }, 40000);

  it('does not run main when the module is imported, not executed', () => {
    const base = makeFixtureCheckout();
    // The entry guard must suppress the scan for library importers; if it
    // fired, the gate report would appear before the sentinel.
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import('file://${join(base, 'scripts', 'check-tui-dep-direction.mjs')}'); process.stdout.write('imported-only');`,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    expect(out).toBe('imported-only');
  }, 40000);

  it('fails when a rule root is itself a symlink', () => {
    const base = makeFixtureCheckout();
    const model = join(base, 'packages', 'cli', 'src', 'ui', 'model');
    rmSync(model, { recursive: true, force: true });
    mkdirSync(join(base, 'substitute-model'));
    writeFileSync(
      join(base, 'substitute-model', 'witness.ts'),
      "import { render } from 'ink';\n",
    );
    symlinkSync(join(base, 'substitute-model'), model, 'dir');
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain('error: symlink in rule root path');
    // The redirected target must be rejected before enumeration: its
    // witness file is never parsed, so no violation from it can appear.
    expect(out).not.toContain("import 'ink'");
  }, 40000);

  it('fails a symlinked root even when the target is empty', () => {
    const base = makeFixtureCheckout();
    const model = join(base, 'packages', 'cli', 'src', 'ui', 'model');
    rmSync(model, { recursive: true, force: true });
    mkdirSync(join(base, 'empty-substitute'));
    symlinkSync(join(base, 'empty-substitute'), model, 'dir');
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain('error: symlink in rule root path');
    expect(out).not.toContain('not found or has no source files');
  }, 40000);

  it('fails when a rule-root ancestor is a symlink', () => {
    const base = makeFixtureCheckout();
    const uiDir = join(base, 'packages', 'cli', 'src', 'ui');
    renameSync(uiDir, join(base, 'packages', 'cli', 'src', 'ui-real'));
    symlinkSync(join(base, 'packages', 'cli', 'src', 'ui-real'), uiDir, 'dir');
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain('error: symlink in rule root path');
  }, 40000);

  it('fails on a banned import in the scanned tree', () => {
    const base = makeFixtureCheckout();
    writeFileSync(
      join(base, 'packages', 'core', 'src', 'leak.ts'),
      "import { render } from 'ink';\n",
    );
    // .js is the only enrolled extension with live population under a rule
    // root, so pin its membership with a planted violation too.
    writeFileSync(
      join(base, 'packages', 'core', 'src', 'leak.js'),
      "import { useState } from 'react';\n",
    );
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain("import 'ink'");
    expect(out).toContain("import 'react'");
    expect(out).toContain('FAIL — dependency-direction violations found.');
  }, 40000);

  it('fails on a bare import of the cli package name', () => {
    const base = makeFixtureCheckout();
    writeFileSync(
      join(base, 'packages', 'core', 'src', 'leak.ts'),
      "import { run } from '@qwen-code/qwen-code';\n",
    );
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain('(bare import reaches into packages/cli)');
  }, 40000);

  it('fails on a relative import that reaches into packages/cli', () => {
    const base = makeFixtureCheckout();
    writeFileSync(
      join(base, 'packages', 'core', 'src', 'leak.ts'),
      "import { helper } from '../../cli/src/helper.js';\n",
    );
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain('(relative import reaches into packages/cli)');
  }, 40000);

  it('fails on violations in the ui/model rule arm', () => {
    const base = makeFixtureCheckout();
    writeFileSync(
      join(base, 'packages', 'cli', 'src', 'ui', 'model', 'leak.ts'),
      ["import { render } from 'ink';", "import '../outside.js';"].join('\n'),
    );
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    // Pins the second checkRule wiring (rules object + enumeration): the
    // noFramework and selfContained arms of Rule 2 must both fire.
    expect(out).toContain('(ink import in framework-neutral code)');
    expect(out).toContain(
      '(relative import escapes the framework-neutral directory)',
    );
  }, 40000);

  it('fails when the core rule root is itself a symlink', () => {
    const base = makeFixtureCheckout();
    const coreSrc = join(base, 'packages', 'core', 'src');
    rmSync(coreSrc, { recursive: true, force: true });
    mkdirSync(join(base, 'substitute-core'));
    writeFileSync(
      join(base, 'substitute-core', 'clean.ts'),
      "import { z } from 'zod';\n",
    );
    symlinkSync(join(base, 'substitute-core'), coreSrc, 'dir');
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain('error: symlink in rule root path');
  }, 40000);

  it('fails when the ui/model rule root is empty', () => {
    const base = makeFixtureCheckout();
    rmSync(join(base, 'packages', 'cli', 'src', 'ui', 'model', 'model.ts'));
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain('packages/cli/src/ui/model');
    expect(out).toContain('not found or has no source files');
  }, 40000);

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails on an unlistable directory inside the scanned tree',
    () => {
      const base = makeFixtureCheckout();
      const blocked = join(base, 'packages', 'core', 'src', 'blocked');
      mkdirSync(blocked);
      writeFileSync(join(blocked, 'hidden.ts'), "import 'ink';\n");
      chmodSync(blocked, 0o000);
      const { code, out } = runGate(base);
      chmodSync(blocked, 0o700);
      expect(code).toBe(1);
      expect(out).toContain('error: could not list directory');
    },
    40000,
  );

  it('fails on a skippable directory name inside the scanned tree', () => {
    const base = makeFixtureCheckout();
    mkdirSync(join(base, 'packages', 'core', 'src', 'node_modules'));
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain('error: skippable directory inside scanned tree');
  }, 40000);

  it('fails on a symlink inside the scanned tree', () => {
    const base = makeFixtureCheckout();
    symlinkSync(
      join(base, 'packages', 'core', 'src', 'clean.ts'),
      join(base, 'packages', 'core', 'src', 'alias.ts'),
      'file',
    );
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain('error: symlink in scanned tree (not followed)');
  }, 40000);

  it('fails when a rule root has no source files', () => {
    const base = makeFixtureCheckout();
    rmSync(join(base, 'packages', 'core', 'src'), {
      recursive: true,
      force: true,
    });
    const { code, out } = runGate(base);
    expect(code).toBe(1);
    expect(out).toContain('not found or has no source files');
  }, 40000);
});
