/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Static vocabulary-biasing hints sent to the transcription provider to improve
// accuracy on domain-specific terms a generic STT model tends to mangle. Sent as
// a leading system message (batch) or `corpus_text` (realtime) — not the OpenAI
// `prompt` field. Project/branch/recent-file enrichment is intentionally omitted
// so no project metadata is sent to the ASR provider. Mirrors Claude Code's
// voice keyterms feature.
const GLOBAL_KEYTERMS = [
  'Qwen',
  'MCP',
  'grep',
  'regex',
  'localhost',
  'codebase',
  'TypeScript',
  'JavaScript',
  'JSON',
  'YAML',
  'OAuth',
  'webhook',
  'gRPC',
  'dotfiles',
  'subagent',
  'worktree',
  'stdout',
  'stderr',
  'async',
  'await',
  'API',
  'CLI',
  'npm',
  'pnpm',
  'commit',
  'rebase',
  'refactor',
  'endpoint',
  'middleware',
  'schema',
  'tokenizer',
];

/** The static keyterm vocabulary sent to the ASR provider for biasing. */
export function buildVoiceKeyterms(): string[] {
  return [...GLOBAL_KEYTERMS];
}
