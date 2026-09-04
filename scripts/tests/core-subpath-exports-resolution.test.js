/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Resolution guards for the core subpath scheme.
//
// cli sources import individual core modules through subpath specifiers
// (e.g. `@qwen-code/qwen-code-core/storage`). Typecheck resolves them via
// tsconfig `paths`, unit tests via the vitest alias list, and the bundle via
// esbuild's paths reading — none of which consults `exports`. Two failure
// modes stay invisible to all of those gates:
//
// 1. The built-but-unbundled CLI (`npm start`, `npm run build-and-start`)
//    resolves subpaths through `packages/core/package.json` `exports` alone,
//    so a specifier with no exports entry — or an entry whose import target
//    is typo'd or redirected — crashes or misloads at module load. The
//    plain-Node guard below resolves every specifier in a real child `node`
//    process (no vitest aliases, no tsconfig paths), pins the resolved URL
//    to the expected dist target, and asserts that target exists.
// 2. The bundle chain reads `packages/cli/tsconfig.json` `paths`; a subpath
//    without a named entry falls through the wildcard to a nonexistent file
//    and then back to the `exports` map, bundling a `packages/core/dist/**`
//    copy while every package-root import loads `packages/core/src/**` —
//    two instances of barrel-exported, stateful modules in one process, the
//    module-identity failure #10908's Known risks name. The esbuild guard
//    below bundles every core subpath statically imported from
//    packages/cli/src under the cli tsconfig and asserts every input lands
//    under packages/core/src, never packages/core/dist.
//
// The pinned-target check makes a built core `dist` a prerequisite of the
// plain-Node guard (`import.meta.resolve` alone deliberately does not need
// one); `scripts/vitest-global-setup.js` already fails fast with an
// actionable message when workspace dist output is missing (#9149).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Every core subpath specifier statically imported from packages/cli/src
// (storage, atomicFileWrite, debugLogger, noFollowOpen, envVarResolver,
// toolWriteOrigin, memoryScopes), plus the subpaths `npm start` reaches
// through @qwen-code/acp-bridge (subSessionConstants, goalWire,
// transcriptRecords). Values are the dist targets pinned by the exports map
// in packages/core/package.json. Probes run from packages/cli; acp-bridge is
// a `file:` dependency there, so acp-bridge-routed specifiers resolve
// identically from that cwd.
const expectedDistTargets = {
  '@qwen-code/qwen-code-core/storage':
    'packages/core/dist/src/config/storage.js',
  '@qwen-code/qwen-code-core/atomicFileWrite':
    'packages/core/dist/src/utils/atomicFileWrite.js',
  '@qwen-code/qwen-code-core/debugLogger':
    'packages/core/dist/src/utils/debugLogger.js',
  '@qwen-code/qwen-code-core/noFollowOpen':
    'packages/core/dist/src/utils/no-follow-open.js',
  '@qwen-code/qwen-code-core/envVarResolver':
    'packages/core/dist/src/utils/envVarResolver.js',
  '@qwen-code/qwen-code-core/toolWriteOrigin':
    'packages/core/dist/src/services/tool-write-origin.js',
  '@qwen-code/qwen-code-core/memoryScopes':
    'packages/core/dist/src/memory/scopes.js',
  '@qwen-code/qwen-code-core/subSessionConstants':
    'packages/core/dist/src/tools/sub-session-constants.js',
  '@qwen-code/qwen-code-core/goalWire':
    'packages/core/dist/src/goals/goal-wire.js',
  '@qwen-code/qwen-code-core/transcriptRecords':
    'packages/core/dist/src/utils/transcript-records.js',
};

function probe(specifier) {
  const script = `
    try {
      console.log('OK ' + import.meta.resolve(${JSON.stringify(specifier)}));
    } catch (error) {
      console.log('FAIL ' + (error.code ?? error.name));
    }
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: join(root, 'packages', 'cli'),
    encoding: 'utf8',
  }).trim();
}

describe('core subpath specifiers resolve under plain Node', () => {
  it.each(Object.entries(expectedDistTargets))(
    '%s resolves to its pinned exports target',
    (specifier, expectedTarget) => {
      const output = probe(specifier);
      expect(output).toMatch(/^OK /);
      const url = output.slice('OK '.length);
      expect(url).toBe(pathToFileURL(join(root, expectedTarget)).href);
      expect(existsSync(fileURLToPath(url))).toBe(true);
    },
  );
});

// The core subpath specifiers statically imported from packages/cli/src,
// mapped to the core source file the matching named entry in
// packages/cli/tsconfig.json `paths` must resolve each one to.
const expectedSrcTargets = {
  '@qwen-code/qwen-code-core/storage': 'packages/core/src/config/storage.ts',
  '@qwen-code/qwen-code-core/atomicFileWrite':
    'packages/core/src/utils/atomicFileWrite.ts',
  '@qwen-code/qwen-code-core/debugLogger':
    'packages/core/src/utils/debugLogger.ts',
  '@qwen-code/qwen-code-core/noFollowOpen':
    'packages/core/src/utils/no-follow-open.ts',
  '@qwen-code/qwen-code-core/envVarResolver':
    'packages/core/src/utils/envVarResolver.ts',
  '@qwen-code/qwen-code-core/toolWriteOrigin':
    'packages/core/src/services/tool-write-origin.ts',
  '@qwen-code/qwen-code-core/memoryScopes':
    'packages/core/src/memory/scopes.ts',
};

describe('core subpath specifiers bundle from the core src tree', () => {
  it('resolves every cli/src subpath under packages/core/src', () => {
    const result = buildSync({
      absWorkingDir: root,
      stdin: {
        contents: Object.keys(expectedSrcTargets)
          .map((specifier) => `import ${JSON.stringify(specifier)};`)
          .join('\n'),
        resolveDir: join(root, 'packages', 'cli'),
        sourcefile: 'core-subpath-bundle-probe.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      tsconfig: join(root, 'packages', 'cli', 'tsconfig.json'),
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(
      inputs.filter((input) => input.includes('packages/core/dist/')),
    ).toEqual([]);
    for (const target of Object.values(expectedSrcTargets)) {
      expect(inputs).toContain(target);
    }
  });
});
