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

function declarePackage(fixture, exports) {
  write(fixture, 'package.json', {
    name: 'fixture-web-shell',
    version: '0.0.0',
    type: 'module',
    files,
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
