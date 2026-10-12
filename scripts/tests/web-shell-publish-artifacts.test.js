/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const verifier = path.join(
  root,
  'packages',
  'web-shell',
  'scripts',
  'verify-publish-artifacts.mjs',
);

// A published version cannot be replaced, so the guard is driven here the way
// `prepublishOnly` drives it: the real script copied into a throwaway package
// root that carries only the shape under test. Nothing imports the workspace,
// and `npm pack` answers for the fixture's own `files` globs.
function runVerifier(build, getEnv = () => ({})) {
  const fixture = mkdtempSync(path.join(tmpdir(), 'web-shell-publish-'));
  try {
    build(fixture);
    mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    cpSync(
      verifier,
      path.join(fixture, 'scripts', 'verify-publish-artifacts.mjs'),
    );
    return spawnSync(
      process.execPath,
      ['scripts/verify-publish-artifacts.mjs'],
      {
        cwd: fixture,
        encoding: 'utf8',
        env: { ...process.env, ...getEnv(fixture) },
        timeout: 120_000,
      },
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function write(fixture, name, contents) {
  const target = path.join(fixture, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    name.endsWith('package.json')
      ? `${JSON.stringify(contents, null, 2)}\n`
      : contents,
  );
}

// The real manifest's `files`: `dist/*.js` does not cross a `/`, so anything
// the build emits below `dist/` is on disk yet absent from the tarball.
const files = ['dist/*.js', 'dist/types'];

function declarePackage(fixture, exports, packageFiles = files) {
  write(fixture, 'package.json', {
    name: 'fixture-web-shell',
    version: '0.0.0',
    type: 'module',
    files: packageFiles,
    exports,
  });
}

describe('web-shell publish artifact verifier', () => {
  it('refuses an export target that exists on disk but is left out of the tarball', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, {
        '.': {
          types: './dist/types/index.d.ts',
          import: './dist/nested/index.js',
        },
      });
      write(fixture, 'dist/nested/index.js', 'export default 1;\n');
      write(
        fixture,
        'dist/types/index.d.ts',
        'export declare const a: number;\n',
      );
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('./dist/nested/index.js');
    expect(result.stderr).toContain('not included in the npm package');
  });

  it('refuses a relative chunk that lands in a subdirectory `files` does not reach', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, { '.': { import: './dist/index.js' } });
      write(
        fixture,
        'dist/index.js',
        'import { chunk } from "./nested/chunk.js";\nexport default chunk;\n',
      );
      write(fixture, 'dist/nested/chunk.js', 'export const chunk = 1;\n');
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('./nested/chunk.js');
    expect(result.stderr).toContain('not included in the npm package');
  });

  it('still fails closed on an export target that was never built', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, {
        '.': {
          types: './dist/types/index.d.ts',
          import: './dist/absent.js',
        },
      });
      write(
        fixture,
        'dist/types/index.d.ts',
        'export declare const a: number;\n',
      );
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing ./dist/absent.js');
  });

  it('accepts a wildcard export pattern whose targets are packed', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, {
        '.': { import: './dist/index.js' },
        './*': './dist/*',
      });
      write(fixture, 'dist/index.js', 'export default 1;\n');
      write(fixture, 'dist/daemon-react-sdk.js', 'export default 2;\n');
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('refuses a wildcard target under a literal exports key', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, {
        '.': { import: './dist/index.js' },
        './foo': './dist/*.js',
      });
      write(fixture, 'dist/index.js', 'export default 1;\n');
      write(fixture, 'dist/bar.js', 'export default 2;\n');
    });

    // Node gives `*` pattern meaning only when the exports KEY carries it: a
    // wildcard target under a literal key resolves to a literal path, so the
    // verifier must keep the literal checks for it instead of pattern-matching
    // it against whatever the package happens to contain.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing ./dist/*.js');
  });

  it('refuses an exports key that carries more than one star', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, {
        '.': { import: './dist/index.js' },
        './*/*': './dist/*',
      });
      write(fixture, 'dist/index.js', 'export default 1;\n');
    });

    // Node honours a pattern key only when it carries exactly one `*`; a
    // two-star key matches nothing at all, so the pair must fall through to
    // the literal checks and be refused like the base verifier refused it.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing ./dist/*');
  });

  it('refuses a star-bearing exports key that is not a subpath key', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, {
        '.': { import: './dist/index.js' },
        'dist/*': './dist/*',
      });
      write(fixture, 'dist/index.js', 'export default 1;\n');
      write(fixture, 'dist/other.js', 'export default 2;\n');
    });

    // `"dist/*"` carries exactly one star and its target is packed, so a
    // star-count gate alone would pattern-match it and certify the publish.
    // Node never gives a key pattern meaning unless it is a `./`-prefixed
    // subpath key: mixed with `"."` it rejects the whole manifest with
    // ERR_INVALID_PACKAGE_CONFIG for every specifier, the root import
    // included. It must fall through to the literal checks and be refused the
    // way the base verifier refused it.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing ./dist/*');
  });

  it('refuses a multi-star target whose capture cannot match every star', () => {
    const result = runVerifier((fixture) => {
      // `files: ['dist']` packs dist/a/b.js, so the refusal cannot be
      // explained by an unpacked file: Node substitutes the one captured
      // substring into BOTH stars (`./a` -> `dist/a/a.js`), and only a
      // back-referencing regex rejects the packed `dist/a/b.js` here.
      declarePackage(fixture, { './*': './dist/*/*.js' }, ['dist']);
      write(fixture, 'dist/a/b.js', 'export default 1;\n');
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('matches no file in the npm package');
  });

  it('accepts a multi-star target when one capture satisfies every star', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, { './*': './dist/*/*.js' }, ['dist']);
      write(fixture, 'dist/a/a.js', 'export default 1;\n');
    });

    // Positive control: the same-capture shape Node actually resolves, so the
    // gate must not be a blanket refusal of multi-star targets.
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('accepts a multi-star target whose star is followed by a digit', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, { './*': './dist/*/*1.js' }, ['dist']);
      write(fixture, 'dist/a/a1.js', 'export default 42;\n');
    });

    // Node substitutes one capture into every star, so `./a` resolves to
    // `dist/a/a1.js` and the import succeeds. A positional `\1` here would
    // compile as `\11` — the Annex B octal escape U+0009, since the pattern
    // has only one group — which no packed path can satisfy, refusing a
    // publishable manifest. The back-reference has to be named.
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('accepts a wildcard pattern whose only packed match is nested', () => {
    const result = runVerifier((fixture) => {
      // `files: ['dist']`: the suite default `dist/*.js` never packs a nested
      // file, so here the family's only packed member lives in a subdirectory
      // and the `*` capture has to cross a `/` to reach it — the property
      // Node's resolver has and this branch depends on.
      declarePackage(fixture, { './*': './dist/*' }, ['dist']);
      write(fixture, 'dist/nested/sdk.js', 'export default 1;\n');
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('refuses an exports target carrying a dot segment', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, { './*': './dist/../dist/*.js' }, ['dist']);
      write(fixture, 'dist/a.js', 'export default 1;\n');
    });

    // `join` normalizes `./dist/../dist/*.js` down to `dist/*.js`, which the
    // packed `dist/a.js` satisfies — but Node throws
    // ERR_INVALID_PACKAGE_TARGET for every subpath through that key, so the
    // DECLARED string is what has to be validated, not the normalized path.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a valid "exports" target');
  });

  it('refuses an exports target that is not ./-relative', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, { './*': 'dist/*' }, ['dist']);
      write(fixture, 'dist/a.js', 'export default 1;\n');
    });

    // `dist/*` normalizes through `packPath` to exactly what the well-formed
    // `./dist/*` does, so the packed-list check alone cannot tell them apart,
    // yet Node rejects a non-relative target for every specifier through it.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a valid "exports" target');
  });

  it('checks a target advertised by both a pattern key and a literal key', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, { './*': './dist/*', './foo': './dist/*' });
      write(fixture, 'dist/index.js', 'export default 1;\n');
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing ./dist/*');
  });

  it('keeps the literal checks for a pattern key with a literal target', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, { './*': './dist/entry.js' });
      write(
        fixture,
        'dist/entry.js',
        'import { chunk } from "./nested/chunk.js";\nexport default chunk;\n',
      );
      write(fixture, 'dist/nested/chunk.js', 'export const chunk = 1;\n');
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not included in the npm package');
  });

  it('still fails closed on a wildcard pattern that matches nothing packed', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, {
        '.': { import: './dist/index.js' },
        './*': './dist/absent/*',
      });
      write(fixture, 'dist/index.js', 'export default 1;\n');
      // On disk but not packed: `dist/*.js` does not cross a `/`, so this
      // keeps the fixture discriminating between the packed-list oracle and a
      // filesystem-existence oracle.
      write(fixture, 'dist/absent/sdk.js', 'export const sdk = 1;\n');
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('./dist/absent/*');
    expect(result.stderr).toContain('matches no file in the npm package');
  });

  it('accepts the shape the published package actually ships', () => {
    const result = runVerifier((fixture) => {
      declarePackage(fixture, {
        '.': {
          types: './dist/types/index.d.ts',
          import: './dist/index.js',
        },
        './daemon-react-sdk': {
          types: './dist/types/daemon-react-sdk.d.ts',
          import: './dist/daemon-react-sdk.js',
        },
        './transcript': {
          types: './dist/types/transcript.d.ts',
          import: './dist/transcript.js',
        },
      });
      write(
        fixture,
        'dist/index.js',
        'import { chunk } from "./chunk.js";\nexport default chunk;\n',
      );
      write(fixture, 'dist/chunk.js', 'export const chunk = 1;\n');
      write(fixture, 'dist/daemon-react-sdk.js', 'export default 2;\n');
      write(fixture, 'dist/transcript.js', 'export default 3;\n');
      write(
        fixture,
        'dist/types/index.d.ts',
        'export declare const a: number;\n',
      );
      write(
        fixture,
        'dist/types/daemon-react-sdk.d.ts',
        'export declare const b: number;\n',
      );
      write(
        fixture,
        'dist/types/transcript.d.ts',
        'export declare const c: number;\n',
      );
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('keeps npm warnings out of the verifier output', () => {
    const result = runVerifier(
      (fixture) => {
        declarePackage(fixture, {
          '.': { import: './dist/index.js' },
        });
        write(fixture, 'dist/index.js', 'export default 1;\n');
        write(
          fixture,
          'unknown.npmrc',
          'ELECTRON_MIRROR=https://mirror.invalid\n',
        );
      },
      (fixture) => ({
        NPM_CONFIG_USERCONFIG: path.join(fixture, 'unknown.npmrc'),
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
