/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  rmSync,
  mkdirSync,
  existsSync,
  cpSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { serveBridgeBinBuildOptions } from './serve-bridge-bin-build-options.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
// Report unexpected growth without blocking normal additions to the public API.
const DAEMON_BROWSER_BUNDLE_WARNING_BYTES = 216 * 1024;
// The opt-in `daemon/transports` browser bundle legitimately ships the concrete
// ACP transports (AcpHttpTransport/AcpWsTransport/AutoReconnect + negotiate), so
// it's larger than the default barrel — but still budgeted so a future PR can't
// silently bloat what browser consumers (agent-web) pull in. Current size ~29KB.
const MAX_TRANSPORTS_BROWSER_BUNDLE_BYTES = 48 * 1024;
// Measured with `npm run build && wc -c dist/daemon/transcript.js`.
// Baseline for the initial projection implementation is ~66 KiB.
const MAX_TRANSCRIPT_BROWSER_BUNDLE_BYTES = 192 * 1024;

rmSync(join(rootDir, 'dist'), { recursive: true, force: true });
mkdirSync(join(rootDir, 'dist'), { recursive: true });

execSync('tsc --project tsconfig.build.json', {
  stdio: 'inherit',
  cwd: rootDir,
});

try {
  execSync(
    'npx dts-bundle-generator --project tsconfig.build.json -o dist/index.d.ts src/index.ts',
    {
      stdio: 'inherit',
      cwd: rootDir,
    },
  );
  execSync(
    'npx dts-bundle-generator --project tsconfig.build.json -o dist/daemon/transcript.d.ts src/daemon/transcript.ts',
    {
      stdio: 'inherit',
      cwd: rootDir,
    },
  );

  const dirsToRemove = ['mcp', 'query', 'transport', 'types', 'utils'];
  for (const dir of dirsToRemove) {
    const dirPath = join(rootDir, 'dist', dir);
    if (existsSync(dirPath)) {
      rmSync(dirPath, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.warn(
    'Could not bundle type definitions, keeping separate .d.ts files',
    error.message,
  );
}

assertTranscriptDeclaration(join(rootDir, 'dist', 'daemon', 'transcript.d.ts'));

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist', 'index.mjs'),
  external: ['@modelcontextprotocol/sdk'],
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist', 'index.cjs'),
  external: ['@modelcontextprotocol/sdk'],
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'daemon', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(rootDir, 'dist', 'daemon', 'index.js'),
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

assertBrowserSafeBundle(join(rootDir, 'dist', 'daemon', 'index.js'));

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'daemon', 'index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist', 'daemon', 'index.cjs'),
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

// Opt-in transports subpath (`@qwen-code/sdk/daemon/transports`): the concrete
// ACP transports + negotiateTransport. Kept out of the default daemon barrel
// (and its byte budget) so REST-only consumers stay tree-shaken; consumers who
// want resumable ACP-over-HTTP import this entry explicitly. Built as its own
// bundle for both browser (esm) and node (cjs) targets.
await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'daemon', 'transports.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(rootDir, 'dist', 'daemon', 'transports.js'),
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'daemon', 'transcript.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: join(rootDir, 'dist', 'daemon', 'transcript.js'),
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

assertTranscriptBundle(join(rootDir, 'dist', 'daemon', 'transcript.js'));

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'daemon', 'transcript.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist', 'daemon', 'transcript.cjs'),
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

assertTransportsBundle(join(rootDir, 'dist', 'daemon', 'transports.js'));

await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'daemon', 'transports.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist', 'daemon', 'transports.cjs'),
  sourcemap: false,
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: 'none',
  keepNames: false,
  treeShaking: true,
});

// Build serve-bridge CLI bin entry. The options — including the absence of a
// hashbang `banner`, see `serveBridgeBinBuildOptions` — are shared with the
// test that pins the emitted bytes.
const serveBridgeBinPath = join(
  rootDir,
  'dist',
  'daemon-mcp',
  'serve-bridge',
  'bin.js',
);
await esbuild.build(serveBridgeBinBuildOptions(rootDir, serveBridgeBinPath));
assertExecutableBin(serveBridgeBinPath);

// Copy LICENSE from root directory to dist
const licenseSource = join(rootDir, '..', '..', 'LICENSE');
const licenseTarget = join(rootDir, 'dist', 'LICENSE');
if (existsSync(licenseSource)) {
  try {
    cpSync(licenseSource, licenseTarget);
  } catch (error) {
    console.warn('Could not copy LICENSE:', error.message);
  }
}

/**
 * A published `bin` must be startable. Assert the built entry begins with a
 * hashbang and that node can actually parse it: a duplicated hashbang (from a
 * `banner` stacked on the entry point's own) leaves line 2 as `#!/usr/bin/env
 * node`, which is a `SyntaxError` through both `node <file>` and the shebang —
 * a break the type checker, the unit tests and the byte budgets all miss.
 */
function assertExecutableBin(filePath) {
  const firstLine = readFileSync(filePath, 'utf8').split('\n', 1)[0];
  if (!firstLine.startsWith('#!')) {
    throw new Error(`Bin ${filePath} must start with a hashbang line`);
  }
  try {
    // argv form, not a command string: `execSync` would run this through
    // `/bin/sh -c`, where a checkout path containing `$(…)`, a backtick or
    // `$VAR` still expands — `JSON.stringify` is JSON quoting, not shell
    // quoting.
    execFileSync('node', ['--check', filePath], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(
      `Bin ${filePath} does not parse: ${String(error.stderr ?? error.message).trim()}`,
    );
  }
}

function assertBrowserSafeBundle(filePath) {
  const size = statSync(filePath).size;
  console.log(`Browser daemon SDK bundle is ${size} bytes`);
  if (size > DAEMON_BROWSER_BUNDLE_WARNING_BYTES) {
    console.warn(
      `Browser daemon SDK bundle exceeds the ${DAEMON_BROWSER_BUNDLE_WARNING_BYTES}-byte warning threshold`,
    );
  }
  assertNoNodeBuiltins(filePath, 'Browser daemon SDK bundle');
}

// Browser-safety + size budget for the opt-in `daemon/transports` bundle.
// Larger budget than the default barrel (it ships the concrete transports), but
// still bounded so a future PR can't silently bloat what browser consumers pull.
function assertTransportsBundle(filePath) {
  const size = statSync(filePath).size;
  if (size > MAX_TRANSPORTS_BROWSER_BUNDLE_BYTES) {
    throw new Error(
      `Browser daemon transports bundle is ${size} bytes; expected <= ${MAX_TRANSPORTS_BROWSER_BUNDLE_BYTES}`,
    );
  }
  assertNoNodeBuiltins(filePath, 'Browser daemon transports bundle');
}

function assertTranscriptBundle(filePath) {
  const size = statSync(filePath).size;
  if (size > MAX_TRANSCRIPT_BROWSER_BUNDLE_BYTES) {
    throw new Error(
      `Browser daemon transcript bundle is ${size} bytes; expected <= ${MAX_TRANSCRIPT_BROWSER_BUNDLE_BYTES}`,
    );
  }
  assertNoNodeBuiltins(filePath, 'Browser daemon transcript bundle');
}

function assertTranscriptDeclaration(filePath) {
  const contents = readFileSync(filePath, 'utf8');
  const forbiddenReferences = [
    '@qwen-code/qwen-code-core',
    '@qwen-code/acp-bridge',
    'reference types="node"',
  ];
  const found = forbiddenReferences.find((token) => contents.includes(token));
  if (found) {
    throw new Error(
      `Daemon transcript declaration leaks an internal dependency: ${found}`,
    );
  }
}

// Node-builtin guard, shared by the budget-checked default daemon barrel and
// the opt-in `daemon/transports` bundle. The transports bundle is allowed to
// be larger (it ships the concrete ACP transports), but must still be
// browser-safe — agent-web consumes it in the browser.
function assertNoNodeBuiltins(filePath, label) {
  const contents = readFileSync(filePath, 'utf8');
  if (contents.includes('node:')) {
    throw new Error(`${label} contains Node-only token node:`);
  }
  const forbiddenBuiltins = [
    'assert',
    'buffer',
    'child_process',
    'cluster',
    'crypto',
    'fs',
    'http',
    'https',
    'module',
    'net',
    'os',
    'path',
    'perf_hooks',
    'process',
    'readline',
    'stream',
    'tls',
    'tty',
    'url',
    'util',
    'worker_threads',
    'zlib',
  ];
  const requirePattern = new RegExp(
    `require\\((["'])(${forbiddenBuiltins.join('|')})(?:/[^"']*)?\\1\\)`,
  );
  const found = contents.match(requirePattern);
  if (found) {
    throw new Error(`${label} contains Node-only token ${found[0]}`);
  }
}
