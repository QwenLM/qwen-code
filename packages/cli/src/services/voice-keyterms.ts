/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSubpath } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { resolvePath } from '../utils/resolvePath.js';

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

const DEFAULT_KEYTERMS_FILENAME = 'voice-keyterms.txt';
const MAX_KEYTERMS = 200;
const MAX_KEYTERMS_BYTES = 2000;
const MAX_KEYTERMS_FILE_BYTES = 64 * 1024;

export function buildVoiceKeyterms(settings?: LoadedSettings): string[] {
  const userTerms = settings ? readUserKeyterms(settings) : [];
  return capKeyterms(dedupeKeyterms([...GLOBAL_KEYTERMS, ...userTerms]));
}

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

function readUserKeyterms(settings: LoadedSettings): string[] {
  if (!settings.isTrusted) {
    return [];
  }
  for (const resolved of resolveKeytermsFiles(settings)) {
    try {
      const file = canonicalizeKeytermsFile(resolved);
      if (!file) {
        continue;
      }
      const content = readRegularFileNoFollow(file);
      if (content === undefined) {
        continue;
      }
      const parsed = parseKeyterms(content);
      if (parsed.length > 0) {
        return parsed;
      }
    } catch {
      // Try the next configured scope, if any.
    }
  }
  return [];
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

function resolveKeytermsFiles(
  settings: LoadedSettings,
): ResolvedKeytermsFile[] {
  const workspacePath = settings.workspace?.path;
  if (!workspacePath) {
    return [];
  }
  const qwenDir = path.dirname(workspacePath);
  const workspaceRoot = path.dirname(qwenDir);
  const configured = readKeytermsFileSettings(settings);
  if (configured.length > 0) {
    return configured.map(({ path: configuredPath, scope }) => {
      const expanded = resolvePath(configuredPath);
      const isAbsolute = path.isAbsolute(expanded);
      return {
        filePath: isAbsolute ? expanded : path.resolve(workspaceRoot, expanded),
        workspaceRoot,
        mustBeInWorkspace: scope === 'system' || !isAbsolute,
      };
    });
  }
  return [
    {
      filePath: path.join(qwenDir, DEFAULT_KEYTERMS_FILENAME),
      workspaceRoot,
      mustBeInWorkspace: true,
    },
  ];
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
    let flags = fs.constants.O_RDONLY;
    if (typeof fs.constants.O_NOFOLLOW === 'number') {
      flags |= fs.constants.O_NOFOLLOW;
    }
    if (typeof fs.constants.O_NONBLOCK === 'number') {
      flags |= fs.constants.O_NONBLOCK;
    }
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
    const content = fs.readFileSync(fd, 'utf-8');
    if (Buffer.byteLength(content, 'utf8') > MAX_KEYTERMS_FILE_BYTES) {
      return undefined;
    }
    return content;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function parseKeyterms(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, '').trim())
    .filter((line) => line.length > 0);
}

function readKeytermsFileSettings(
  settings: LoadedSettings,
): KeytermsFileSetting[] {
  const out: KeytermsFileSetting[] = [];
  const system = readKeytermsFileSettingFromScope(settings.system?.settings);
  if (system) {
    out.push({ path: system, scope: 'system' });
  }
  const user = readKeytermsFileSettingFromScope(settings.user?.settings);
  if (user) {
    out.push({ path: user, scope: 'user' });
  }
  return out;
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
