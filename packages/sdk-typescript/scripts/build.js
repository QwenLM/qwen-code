/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
// Budget includes the DaemonTransport interface + DaemonTransportClosedError +
// RestSseTransport (default transport, constructed by DaemonClient).
// Bumped from 116KB to 118KB for the transport abstraction layer (~1.5KB).
// Bumped from 118KB to 119KB for the mid-turn drain surface (enqueue methods +
// `mid_turn_message_injected` event type/guard/registration, ~150 bytes).
// Bumped from 119KB to 122KB for the workspace extension management surface
// (install/update/enable/disable/uninstall/refresh/check update endpoints).
// Bumped from 122KB to 124KB for daemon fork-session APIs/events.
// Bumped from 124KB to 125KB for rewind/branch transcript/session APIs.
// Bumped from 125KB to 126KB for the workspace permissions rules API
// (workspacePermissions + set/add/remove rule methods + types, ~718 bytes).
// Bumped from 126KB to 127KB for prompt clientId self-heal.
// Bumped from 127KB to 130KB for daemon workspace voice, trust, permissions,
// session LSP helper APIs, and the full daemon route table.
// Bumped from 130KB to 131KB for the workspace MCP resources drill-down
// (workspaceMcpResources client method + route + resource status types).
// Bumped from 131KB to 132KB for the pending prompt queue feature.
// Bumped from 132KB to 133KB for session archive/unarchive APIs and sessionless
// workspace remember (managed memory client methods + event validation).
// Bumped from 133KB to 136KB after merging session artifacts plus sessionless
// workspace memory forget/dream APIs and event validation.
// Bumped from 136KB to 138KB for persistent session artifact APIs after
// merging the upstream daemon SDK surface.
// Bumped from 138KB to 139KB for EventBus byte-backlog telemetry validation.
// Bumped from 139KB to 140KB for history_truncated event validation and
// transcript status projection.
// Bumped from 138KB to 139KB for workspace ACP status/preheat APIs.
// Bumped from 139KB to 141KB after merging main (ACP status/preheat) into
// the history_truncated/transcript-status branch.
const MAX_DAEMON_BROWSER_BUNDLE_BYTES = 141 * 1024;
// The opt-in `daemon/transports` browser bundle legitimately ships the concrete
// ACP transports (AcpHttpTransport/AcpWsTransport/AutoReconnect + negotiate), so
// it's larger than the default barrel — but still budgeted so a future PR can't
// silently bloat what browser consumers (agent-web) pull in. Current size ~29KB.
const MAX_TRANSPORTS_BROWSER_BUNDLE_BYTES = 48 * 1024;

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

// Build serve-bridge CLI bin entry
await esbuild.build({
  entryPoints: [join(rootDir, 'src', 'daemon-mcp', 'serve-bridge', 'bin.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist', 'daemon-mcp', 'serve-bridge', 'bin.js'),
  external: ['@modelcontextprotocol/sdk'],
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
});

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

function assertBrowserSafeBundle(filePath) {
  const size = statSync(filePath).size;
  if (size > MAX_DAEMON_BROWSER_BUNDLE_BYTES) {
    throw new Error(
      `Browser daemon SDK bundle is ${size} bytes; expected <= ${MAX_DAEMON_BROWSER_BUNDLE_BYTES}`,
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
