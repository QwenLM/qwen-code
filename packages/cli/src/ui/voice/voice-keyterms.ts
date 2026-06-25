/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSubpath } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { resolvePath } from '../../utils/resolvePath.js';

// Static vocabulary-biasing hints sent to the transcription provider to improve
// accuracy on domain-specific terms a generic STT model tends to mangle. Sent as
// a leading system message (batch) or `corpus_text` (realtime) — not the OpenAI
// `prompt` field. No project/branch/recent-file metadata is auto-collected; the
// only project-local input is a user-curated keyterms file, read only in a
// trusted workspace (see readUserKeyterms). Mirrors Claude Code's voice keyterms
// feature.
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

// Default project-local keyterms file, auto-loaded when present and no explicit
// `general.voice.keytermsFile` is set.
const DEFAULT_KEYTERMS_FILENAME = 'voice-keyterms.txt';

// The merged list is sent on every request (corpus_text / system message), which
// has a finite length budget; cap term count and total bytes so a large user file
// degrades gracefully. The static globals always fit, leaving the rest for user
// terms.
const MAX_KEYTERMS = 200;
const MAX_KEYTERMS_BYTES = 2000;

// Upper bound on the keyterms file itself: anything larger than a plausible term
// list is ignored rather than read into memory and shipped to the provider.
const MAX_KEYTERMS_FILE_BYTES = 64 * 1024;

/**
 * The keyterm vocabulary sent to the ASR provider for biasing: the static
 * globals plus any user terms from `general.voice.keytermsFile` (or the
 * project-local `.qwen/voice-keyterms.txt`), deduped and capped. Reading the
 * file never throws — on any error the static globals are returned alone so
 * dictation is never broken by a bad path. Only the Qwen ASR transports consume
 * this; DashScope (fun-asr/paraformer) uses a separate vocabulary_id mechanism.
 */
export function buildVoiceKeyterms(settings?: LoadedSettings): string[] {
  const userTerms = settings ? readUserKeyterms(settings) : [];
  return capKeyterms(dedupeKeyterms([...GLOBAL_KEYTERMS, ...userTerms]));
}

/** Case-insensitive dedupe, keeping the first occurrence (globals win casing). */
function dedupeKeyterms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(term);
  }
  return out;
}

/** Bound the list by term count and total joined UTF-8 bytes (see caps above). */
function capKeyterms(terms: string[]): string[] {
  const out: string[] = [];
  let bytes = 0;
  for (const term of terms) {
    if (out.length >= MAX_KEYTERMS) {
      break;
    }
    const next =
      bytes + Buffer.byteLength(term, 'utf8') + (out.length > 0 ? 1 : 0);
    if (next > MAX_KEYTERMS_BYTES) {
      continue;
    }
    out.push(term);
    bytes = next;
  }
  return out;
}

/**
 * Read and parse the user's keyterms file, or [] when absent/unreadable. The
 * file's contents are sent to the remote ASR provider, so it is read only in a
 * trusted workspace and must be a regular, non-symlink file under a sane size:
 * this stops a cloned or untrusted repo from planting a file — or a symlink to a
 * secret like ~/.ssh/id_rsa — that would exfiltrate on the next dictation.
 * Auto-discovery bypasses the settings-trust layer, so the guard lives here to
 * cover both the explicit setting and the project-local default.
 */
function readUserKeyterms(settings: LoadedSettings): string[] {
  if (!settings.isTrusted) {
    return [];
  }
  try {
    const resolved = resolveKeytermsFile(settings);
    if (!resolved) {
      return [];
    }
    const file = canonicalizeKeytermsFile(resolved);
    if (!file) {
      return [];
    }
    const content = readRegularFileNoFollow(file);
    if (content === undefined) {
      return [];
    }
    return parseKeyterms(content);
  } catch {
    return [];
  }
}

interface ResolvedKeytermsFile {
  filePath: string;
  workspaceRoot: string;
  mustBeInWorkspace: boolean;
}

interface KeytermsFileSetting {
  path: string;
  scope: 'system' | 'user';
}

interface ValidatedKeytermsFile {
  filePath: string;
  stat: fs.Stats;
}

/**
 * Resolve the keyterms file path: an explicit `general.voice.keytermsFile`
 * (absolute, or relative to the workspace root), else the project-local
 * `.qwen/voice-keyterms.txt`. Returns undefined when the workspace root is
 * unknown (e.g. minimal/stream-json settings with an empty workspace path).
 */
function resolveKeytermsFile(
  settings: LoadedSettings,
): ResolvedKeytermsFile | undefined {
  const workspacePath = settings.workspace?.path;
  if (!workspacePath) {
    return undefined;
  }
  const qwenDir = path.dirname(workspacePath);
  const workspaceRoot = path.dirname(qwenDir);
  const configured = readKeytermsFileSetting(settings);
  if (configured) {
    const expanded = resolvePath(configured.path);
    const isAbsolute = path.isAbsolute(expanded);
    return {
      filePath: isAbsolute ? expanded : path.resolve(workspaceRoot, expanded),
      workspaceRoot,
      mustBeInWorkspace: configured.scope === 'system' || !isAbsolute,
    };
  }
  return {
    filePath: path.join(qwenDir, DEFAULT_KEYTERMS_FILENAME),
    workspaceRoot,
    mustBeInWorkspace: true,
  };
}

function canonicalizeKeytermsFile({
  filePath,
  workspaceRoot,
  mustBeInWorkspace,
}: ResolvedKeytermsFile): ValidatedKeytermsFile | undefined {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    !stat ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink > 1 ||
    stat.size > MAX_KEYTERMS_FILE_BYTES
  ) {
    return undefined;
  }
  const realFilePath = fs.realpathSync(filePath);
  if (mustBeInWorkspace) {
    const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
    if (!isSubpath(realWorkspaceRoot, realFilePath)) {
      return undefined;
    }
  }
  return { filePath: realFilePath, stat };
}

function readRegularFileNoFollow({
  filePath,
  stat: expectedStat,
}: ValidatedKeytermsFile): string | undefined {
  let fd: number | undefined;
  try {
    const flags =
      typeof fs.constants.O_NOFOLLOW === 'number'
        ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        : fs.constants.O_RDONLY;
    fd = fs.openSync(filePath, flags);
    const stat = fs.fstatSync(fd);
    if (
      stat.dev !== expectedStat.dev ||
      stat.ino !== expectedStat.ino ||
      stat.mode !== expectedStat.mode ||
      stat.size !== expectedStat.size ||
      stat.mtimeMs !== expectedStat.mtimeMs ||
      stat.ctimeMs !== expectedStat.ctimeMs ||
      !stat.isFile() ||
      stat.nlink > 1 ||
      stat.size > MAX_KEYTERMS_FILE_BYTES
    ) {
      return undefined;
    }
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** Parse a keyterms file: one term per line, `#` comments and blanks ignored. */
function parseKeyterms(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/(?:^|\s+)#.*$/, '').trim())
    .filter((line) => line.length > 0);
}

function readKeytermsFileSetting(
  settings: LoadedSettings,
): KeytermsFileSetting | undefined {
  // Intentionally skip workspace scope: repos could plant absolute paths that
  // exfiltrate local files through the remote ASR provider.
  const system = readKeytermsFileSettingFromScope(settings.system?.settings);
  if (system) {
    return { path: system, scope: 'system' };
  }
  const user = readKeytermsFileSettingFromScope(settings.user?.settings);
  return user ? { path: user, scope: 'user' } : undefined;
}

function readKeytermsFileSettingFromScope(
  settings: { general?: { voice?: { keytermsFile?: unknown } } } | undefined,
): string | undefined {
  const value = settings?.general?.voice?.keytermsFile;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
