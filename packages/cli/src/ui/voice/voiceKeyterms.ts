/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

// Vocabulary-biasing hints sent to the transcription provider (as the OpenAI
// `prompt` field) to improve accuracy on domain-specific terms a generic STT
// model tends to mangle. Mirrors Claude Code's voice keyterms feature.
const MAX_KEYTERMS = 50;
const MIN_TERM_LENGTH = 3;
const MAX_TERM_LENGTH = 40;

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

export interface VoiceKeytermsInput {
  /** Absolute project root; its basename is added as a term. */
  projectRoot?: string;
  /** Current git branch; split into word tokens. */
  gitBranch?: string;
  /** Recently touched file paths; identifiers are extracted from basenames. */
  recentFiles?: string[];
}

/** Split a slug/identifier into word tokens (separators + camelCase). */
function splitIdentifier(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Build a deduplicated, length-filtered keyterm list (≤50) from the global
 * vocabulary plus project-, branch-, and recent-file-derived terms.
 */
export function buildVoiceKeyterms(input: VoiceKeytermsInput = {}): string[] {
  const candidates: string[] = [...GLOBAL_KEYTERMS];

  if (input.projectRoot) {
    const base = path.basename(input.projectRoot).trim();
    if (base) {
      candidates.push(base, ...splitIdentifier(base));
    }
  }
  if (input.gitBranch) {
    candidates.push(...splitIdentifier(input.gitBranch));
  }
  for (const file of input.recentFiles ?? []) {
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    candidates.push(...splitIdentifier(base));
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of candidates) {
    const trimmed = term.trim();
    if (trimmed.length < MIN_TERM_LENGTH || trimmed.length > MAX_TERM_LENGTH) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
    if (result.length >= MAX_KEYTERMS) {
      break;
    }
  }
  return result;
}
