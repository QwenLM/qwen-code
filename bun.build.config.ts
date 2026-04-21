/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bun Build Configuration
 * Compiles Qwen Code into a standalone executable
 */

// Feature flags for compile-time conditional compilation
const FEATURES = {
  // Core features - enabled by default
  CORE: true,
  SKILLS: true,
  MCP: true,

  // Optional features - controlled via environment variables
  VOICE_MODE: process.env.ENABLE_VOICE === 'true',
  TEAMMEM: process.env.ENABLE_TEAMMEM === 'true',
  KAIROS: process.env.ENABLE_KAIROS === 'true',
  COORDINATOR_MODE: process.env.ENABLE_COORDINATOR === 'true',
  FAST_MODE: process.env.ENABLE_FAST_MODE === 'true',

  // Experimental features
  AGENT_TRIGGERS: process.env.ENABLE_AGENT_TRIGGERS === 'true',
  TRANSCRIPT_CLASSIFIER: process.env.ENABLE_TRANSCRIPT_CLASSIFIER === 'true',
  BASH_CLASSIFIER: process.env.ENABLE_BASH_CLASSIFIER === 'true',
  PROACTIVE: process.env.ENABLE_PROACTIVE === 'true',
};

// Generate define object for bun build
const define: Record<string, string> = {};
for (const [key, value] of Object.entries(FEATURES)) {
  define[`process.env.FEATURE_${key}`] = JSON.stringify(value);
}

// Native modules that should be external
const external = [
  '@lydell/node-pty',
  'node-pty',
  '@lydell/node-pty-darwin-arm64',
  '@lydell/node-pty-darwin-x64',
  '@lydell/node-pty-linux-x64',
  '@lydell/node-pty-win32-arm64',
  '@lydell/node-pty-win32-x64',
  '@teddyzhu/clipboard',
  '@teddyzhu/clipboard-darwin-arm64',
  '@teddyzhu/clipboard-darwin-x64',
  '@teddyzhu/clipboard-linux-x64-gnu',
  '@teddyzhu/clipboard-linux-arm64-gnu',
  '@teddyzhu/clipboard-win32-x64-msvc',
  '@teddyzhu/clipboard-win32-arm64-msvc',
  // WASM files with ?binary suffix (esbuild specific, not supported by Bun)
  'web-tree-sitter/tree-sitter.wasm?binary',
  'tree-sitter-wasms/out/tree-sitter-bash.wasm?binary',
  // Packages with top-level await issues in Bun
  'ink',
  'yoga-layout',
];

// Get version from environment or package.json
const version =
  process.env.npm_package_version || process.env.CLI_VERSION || 'dev';

// Build configuration
const config = {
  entrypoints: ['packages/cli/index.ts'],
  outdir: 'dist/native',
  naming: 'qwen',
  target: 'bun',

  // Compile to standalone executable
  compile: true,

  // Enable bytecode compilation (faster startup)
  bytecode: true,

  // Define compile-time constants
  define: {
    ...define,
    'process.env.CLI_VERSION': JSON.stringify(version),
    'process.env.BUILD_TARGET': '"native"',
    global: 'globalThis',
  },

  // External modules (not bundled)
  external,

  // Minify production build
  minify: {
    whitespace: true,
    identifiers: false, // Keep for debuggability
    syntax: true,
  },

  // Source map for debugging
  sourcemap: 'external',

  // Add banner
  banner: `// Qwen Code ${version} - Native Build`,
};

// Execute build
console.log('Starting Bun build...');
console.log('Version:', version);
console.log(
  'Features:',
  Object.entries(FEATURES)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ') || 'CORE, SKILLS, MCP',
);

const result = await Bun.build(config);

if (result.success) {
  console.log('✓ Build successful!');
  for (const output of result.outputs) {
    console.log(`  - ${output.path}`);
  }
} else {
  console.error('✗ Build failed:');
  for (const log of result.logs) {
    console.error(`  ${log}`);
  }
  process.exit(1);
}
