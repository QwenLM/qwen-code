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
// Bumped from 140KB to 150KB after merging main: workspace ACP status/preheat
// plus WorkspaceDaemonClient's workspace-qualified core REST helpers (Phase 3
// file/status/settings/agents/session APIs).
// Bumped from 150KB to 151KB for the paged session transcript REST helper.
// Bumped from 151KB to 154KB for extension management v2 catalog, activation,
// mutation, and operation-polling APIs (~2.3KB).
// Bumped from 154KB to 155KB after merging workspace skill-toggle APIs.
// Bumped from 155KB to 160KB to accommodate recent growth and reduce churn,
// from repeated 1KB bumps as new daemon APIs are added.
// Bumped from 160KB to 161KB after merging upstream main.
// Bumped from 161KB to 167KB for the Web Shell git-diff and subagent REST helpers
// (workspaceGitDiff / workspaceGitDiffFile on both client classes) and the
// ChatRecord transcript projection in the default UI API.
// Bumped from 167KB to 168KB for workspace-level streaming generation and
// workspace trust status v2 SDK types, plus the daemon event-bus epoch token
// fields (eventEpoch / onEpoch) and their docs across SDK transports.
// Bumped from 168KB to 169KB for channel delivery alongside workspace-level
// streaming generation.
// Bumped from 169KB to 170KB after merging the event-bus and channel-delivery
// additions.
// Bumped from 170KB to 173KB for workspace-scoped Channel configuration,
// lifecycle, startup, and pairing helpers on both daemon client classes.
// Bumped from 173KB to 174KB for worktree gitCwd query parameters on the
// workspace-qualified diff/log/commit-detail client methods.
// Bumped from 174KB to 175KB for git branch listing/checkout/push/pull/commit
// client methods on both daemon client classes.
// Bumped from 175KB to 176KB for GitHub PR create + default-branch methods.
// Bumped from 176KB to 177KB for concurrent session-cancellation coalescing in
// DaemonSessionClient (#6930).
// Bumped from 177KB to 178KB for workspace file byte-cursor paging after
// merging the workspace pairing approval SDK surface.
// Bumped from 178KB to 184KB for side-task session APIs and source metadata.
// Bumped from 184KB to 185KB for the Live Voice lifecycle helpers on both
// daemon client classes.
// Bumped from 185KB to 186KB for daemon-owned mid-turn message APIs.
// Bumped from 186KB to 188KB for the workspace file-upload surface
// (`uploadWorkspaceFile` + XHR progress) on both daemon client classes.
// Bumped from 188KB to 189KB for the session reasoning-effort config option
// APIs merged in from main.
// Bumped from 189KB to 190KB for historical branch sessions and transcript
// branch-point projection merged with the upload and reasoning APIs.
// Bumped from 190KB to 195KB for session attachment upload, cleanup, and hydration
// merged with the branch-session APIs and the composer text-file attachment
// metadata (#9180).
// Bumped from 195KB to 196KB for transient-vs-gone media hydration errors and
// the reference-only replay placeholder.
// Bumped from 196KB to 197KB for the workspace session live-state daemon
// surface (catalog version + live snapshot accessors), immutable,
// identity-stable transcript block indexes used by browser renderers, and the
// daemon transcript-retention work (replay-snapshot release + capped debug
// payloads, #9303) landing on top of the session media references bundle.
// Bumped from 197KB to 198KB for the unrecognized-diagnostic sidechannel
// (`unrecognizedDiagnostics` routing + selector, #8823).
// Bumped from 198KB to 199KB for persistent session attachment read/remove and
// binary resource hydration.
// Bumped from 199KB to 200KB for the session PR binding (`DaemonSessionPrInfo`
// + validators).
// Bumped from 199KB to 200KB for the retention byte budget (block byte
// estimation + budget-aware trimming) and backing-store-detached string caps
// (#9303 review round 3).
// Bumped from 200KB to 206KB for the pagination/eviction reconciliation and the
// #8823 × #9303 merge (#9303 review rounds 9-12): eviction-direction signal,
// rewind truncation callback, trimmed tool/permission sentinel helpers,
// record-boundary eviction snap, and the floor back-off — each bump budgeted
// its own delta in isolation, and the combined feature sets land here. The
// attachment read/remove + binary hydration feature that separately bumped
// main to 199KB merges within this headroom, so no further bump is needed.
// Bumped from 206KB to 208KB for transcript block change summaries used to
// avoid complete Web Shell projection on every streamed text update.
const MAX_DAEMON_BROWSER_BUNDLE_BYTES = 208 * 1024;
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
