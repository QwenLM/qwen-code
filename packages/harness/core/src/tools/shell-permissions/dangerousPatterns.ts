/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================================================
// Cross-Platform Code Execution Entry Points
// ============================================================================

/**
 * Cross-platform code-execution entry points present on both Unix and Windows.
 * Shared to prevent the two lists drifting apart on interpreter additions.
 *
 * These are command prefixes that, when granted as broad allow rules,
 * effectively give the model arbitrary code execution capability.
 */
export const CROSS_PLATFORM_CODE_EXEC = [
  // Interpreters
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'tsx',
  'ruby',
  'perl',
  'php',
  'lua',
  // Package runners
  'npx',
  'bunx',
  'npm run',
  'yarn run',
  'pnpm run',
  'bun run',
  // Shells reachable from both (Git Bash / WSL on Windows, native on Unix)
  'bash',
  'sh',
  // Remote arbitrary-command wrapper (native OpenSSH on Win10+)
  'ssh',
] as const;

// ============================================================================
// Bash/Unix-Specific Dangerous Patterns
// ============================================================================

/**
 * Dangerous bash/shell command patterns.
 * Extends the cross-platform list with Unix-shell-specific entries.
 *
 * Commands in this list are considered "dangerous" because broad allow rules
 * for them (e.g., `python:*`, `eval *`) let the model execute arbitrary code,
 * bypassing the safety classifier.
 */
export const DANGEROUS_BASH_PATTERNS: readonly string[] = [
  ...CROSS_PLATFORM_CODE_EXEC,
  // Additional Unix shells
  'zsh',
  'fish',
  // Code execution primitives
  'eval',
  'exec',
  'env',
  'xargs',
  // Privilege escalation
  'sudo',
];
