/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Config } from '../config/config.js';
import type { PermissionDecision } from '../permissions/types.js';
import type {
  ToolCallConfirmationDetails,
  ToolInvocation,
  ToolResult,
  ToolResultDisplay,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { getMemoryBaseDir } from '../memory/paths.js';
import { isSubpath, resolvePath } from '../utils/paths.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { recordGrepResultFileReads } from './grepReadTracking.js';

const DEFAULT_EMBEDDING_MODEL = 'qwen/text-embedding-v4';
const ZVEC_GREP_NPM_PACKAGE = '@zvec/zvec-grep@0.1.4';
const REMOTE_EMBEDDING_API_KEY_ENV_NAMES = [
  'ZVEC_GREP_API_KEY',
  'DASHSCOPE_API_KEY',
  'QWEN_API_KEY',
] as const;
const BACKGROUND_JOB_DIR = path.join(os.tmpdir(), 'qwen-zvec-grep-index');
const ZG_OUTPUT_LIMIT = 20_000_000;
const ZG_RUN_TIMEOUT_MS = 10_000;
const ZG_WSL_TIMEOUT_MS = 60_000;
const ZG_INSTALL_OUTPUT_LIMIT = 200_000;
const ZG_INSTALL_TIMEOUT_MS = 120_000;
const DEFAULT_SEMANTIC_LIMIT = 20;
const SEMANTIC_FALLBACK_TOKEN_LIMIT = 12;
const ZG_RESULT_LINE_RE = /^((?:[A-Za-z]:)?[^:\s][^:]*):\d+(?:-\d+)?(?::|\s|$)/;
const debugLogger = createDebugLogger('ZVEC_GREP');

const SEMANTIC_FALLBACK_STOP_WORDS = new Set([
  'able',
  'about',
  'after',
  'all',
  'also',
  'and',
  'any',
  'are',
  'around',
  'as',
  'be',
  'been',
  'being',
  'between',
  'by',
  'called',
  'can',
  'check',
  'checking',
  'class',
  'classes',
  'code',
  'component',
  'components',
  'current',
  'describe',
  'did',
  'do',
  'does',
  'during',
  'explain',
  'file',
  'files',
  'find',
  'full',
  'function',
  'functions',
  'get',
  'give',
  'for',
  'from',
  'handle',
  'handled',
  'handles',
  'handling',
  'has',
  'have',
  'how',
  'in',
  'implementation',
  'implementations',
  'implemented',
  'implements',
  'inside',
  'into',
  'is',
  'it',
  'its',
  'list',
  'look',
  'looking',
  'method',
  'methods',
  'module',
  'modules',
  'need',
  'needs',
  'now',
  'of',
  'on',
  'or',
  'part',
  'parts',
  'please',
  'project',
  'related',
  'relevant',
  'repo',
  'repository',
  'search',
  'show',
  'should',
  'support',
  'supported',
  'supports',
  'that',
  'their',
  'there',
  'these',
  'they',
  'text',
  'the',
  'this',
  'to',
  'use',
  'used',
  'uses',
  'using',
  'was',
  'way',
  'we',
  'what',
  'when',
  'where',
  'with',
  'why',
  'work',
  'working',
  'works',
  'workspace',
  'would',
]);

type ZvecGrepOperation = 'semantic' | 'rg';

interface ZvecGrepParams {
  operation: ZvecGrepOperation;
  query?: string;
  pattern?: string;
  path?: string;
  paths?: string[];
  glob?: string;
  exclude?: string[];
  limit?: number;
}

interface ZgCommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  unavailable?: boolean;
  error?: string;
}

interface ParsedStatus {
  ready: boolean;
  disabled: boolean;
  indexing: boolean;
  unindexed: boolean;
  raw: string;
}

interface BackgroundIndexJob {
  pid: number;
  cwd: string;
  args: string[];
  logPath: string;
  startedAt: string;
}

let zvecGrepInstallPromise: Promise<ZgCommandResult> | undefined;
let zvecGrepInstalledInProcess = false;

export function _resetZvecGrepInstallForTest(): void {
  zvecGrepInstallPromise = undefined;
  zvecGrepInstalledInProcess = false;
}

function shellQuoteForDisplay(arg: string): string {
  if (/^[A-Za-z0-9_./:=,@%+-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function formatZgCommand(args: readonly string[]): string {
  return ['zg', ...args].map(shellQuoteForDisplay).join(' ');
}

function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeStringArray(value: string[] | undefined): string[] {
  return (value ?? []).map((item) => item.trim()).filter(Boolean);
}

function getSearchQuery(params: ZvecGrepParams): string | undefined {
  const query = params.query?.trim() || params.pattern?.trim();
  return query || undefined;
}

function normalizeSearchPaths(params: ZvecGrepParams): string[] {
  const paths = normalizeStringArray(params.paths);
  const singlePath = normalizeOptionalString(params.path);
  return singlePath ? [singlePath, ...paths] : paths;
}

function pathLooksLikeGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function pathToScopeGlob(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed || pathLooksLikeGlob(trimmed)) return trimmed;
  const base = path.basename(trimmed);
  if (base.includes('.') && !trimmed.endsWith('/')) {
    return trimmed;
  }
  return `${trimmed}/**`;
}

function expandBraceAlternates(value: string): string[] {
  const match = value.match(/^(.*)\{([^{}]+)\}(.*)$/);
  if (!match) return [value];

  const [, before, inner, after] = match;
  const parts = inner
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length === 0) return [value];
  return parts.map((item) => `${before}${item}${after}`);
}

function expandGlobs(values: string[]): string[] {
  return values.flatMap(expandBraceAlternates);
}

function addScopeArgs(args: string[], params: ZvecGrepParams): void {
  const paths = normalizeSearchPaths(params).map(pathToScopeGlob);
  const glob = normalizeOptionalString(params.glob);
  const include = expandGlobs(glob ? [...paths, glob] : paths);
  const exclude = expandGlobs(normalizeStringArray(params.exclude));

  if (include.length > 0) {
    args.push('--include', include.join(','));
  }
  if (exclude.length > 0) {
    args.push('--exclude', exclude.join(','));
  }
}

function buildSearchArgs(params: ZvecGrepParams): string[] {
  const searchQuery = getSearchQuery(params);
  const args = searchQuery ? [searchQuery] : [];
  args.push('--limit', String(params.limit ?? DEFAULT_SEMANTIC_LIMIT));
  addScopeArgs(args, params);
  return args;
}

function buildGrepArgs(params: ZvecGrepParams): string[] {
  const searchQuery = getSearchQuery(params);
  const args = ['--rg'];
  if (searchQuery) {
    args.push(searchQuery);
  }
  if (params.limit !== undefined) {
    args.push('--limit', String(params.limit));
  }

  const glob = normalizeOptionalString(params.glob);
  if (glob) {
    for (const expandedGlob of expandBraceAlternates(glob)) {
      args.push('--glob', expandedGlob);
    }
  }
  for (const item of expandGlobs(normalizeStringArray(params.exclude))) {
    args.push('--glob', item.startsWith('!') ? item : `!${item}`);
  }
  args.push(...normalizeSearchPaths(params));
  return args;
}

function escapeRgRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function looksCodeLike(token: string): boolean {
  return (
    token.includes('_') ||
    /[a-z][A-Z]/.test(token) ||
    /[A-Z]{2,}/.test(token) ||
    /\d/.test(token)
  );
}

function buildSemanticFallbackQuery(query: string): string {
  const allTokens: string[] = [];
  const codeLikeTokens: string[] = [];
  for (const match of query.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    const normalized = token.toLowerCase();
    if (normalized.length < 3) continue;
    if (SEMANTIC_FALLBACK_STOP_WORDS.has(normalized)) continue;
    allTokens.push(token);
    if (looksCodeLike(token)) {
      codeLikeTokens.push(token);
    }
    if (allTokens.length >= SEMANTIC_FALLBACK_TOKEN_LIMIT) break;
  }

  const selected = codeLikeTokens.length > 0 ? codeLikeTokens : allTokens;
  const tokens = [...new Set(selected)].map(escapeRgRegex);
  if (tokens.length === 0) return query;
  if (tokens.length === 1) return `(?i)${tokens[0]}`;
  return `(?i)(${tokens.join('|')})`;
}

function buildSemanticFallbackGrepArgs(params: ZvecGrepParams): string[] {
  const query = getSearchQuery(params);
  const fallbackParams = {
    ...params,
    limit: params.limit ?? DEFAULT_SEMANTIC_LIMIT,
  };
  if (!query) return buildGrepArgs(fallbackParams);
  return buildGrepArgs({
    ...fallbackParams,
    query: buildSemanticFallbackQuery(query),
  });
}

function zvecRunTimeoutMs(): number {
  return process.platform === 'linux' && process.env['WSL_INTEROP']
    ? ZG_WSL_TIMEOUT_MS
    : ZG_RUN_TIMEOUT_MS;
}

function getConfiguredEmbeddingModel(): string | undefined {
  return normalizeOptionalString(process.env['ZVEC_GREP_EMBEDDING']);
}

function isLocalEmbeddingModel(embedding: string | undefined): boolean {
  return embedding?.startsWith('local/') === true;
}

function hasRemoteEmbeddingApiKey(): boolean {
  return REMOTE_EMBEDDING_API_KEY_ENV_NAMES.some((name) =>
    Boolean(normalizeOptionalString(process.env[name])),
  );
}

function statusLooksLocalEmbedding(output: string): boolean {
  return /\bembedding\s+local\//i.test(output);
}

function canUseSemanticEmbedding(parsed?: ParsedStatus): boolean {
  const configuredEmbedding = getConfiguredEmbeddingModel();
  return (
    isLocalEmbeddingModel(configuredEmbedding) ||
    hasRemoteEmbeddingApiKey() ||
    (parsed ? statusLooksLocalEmbedding(parsed.raw) : false)
  );
}

function getIndexEmbeddingModel(): string {
  return getConfiguredEmbeddingModel() ?? DEFAULT_EMBEDDING_MODEL;
}

function buildIndexArgs(params: ZvecGrepParams): string[] {
  const args = ['--index', '--embedding', getIndexEmbeddingModel()];
  addScopeArgs(args, params);
  return args;
}

function parseStatus(output: string): ParsedStatus {
  const text = output.trim();
  const lowered = text.toLowerCase();
  return {
    ready:
      /\bindexed\s+yes\b/.test(lowered) ||
      /\bstatus\s+ready\b/.test(lowered) ||
      /\bstatus:\s*ready\b/.test(lowered),
    disabled:
      /\bpolicy\s+disabled\b/.test(lowered) ||
      /\bpolicy:\s*disabled\b/.test(lowered),
    indexing:
      /\bstatus\s+(indexing|building|running|in[_ -]?progress)\b/.test(
        lowered,
      ) ||
      /\bstatus:\s*(indexing|building|running|in[_ -]?progress)\b/.test(
        lowered,
      ) ||
      /\bindexing\s+yes\b/.test(lowered) ||
      /\bindexing:\s*yes\b/.test(lowered),
    unindexed:
      /\bindexed\s+no\b/.test(lowered) ||
      /\bsource\s+unindexed\b/.test(lowered) ||
      /\bpolicy\s+undecided\b/.test(lowered) ||
      /\bpolicy:\s*undecided\b/.test(lowered),
    raw: text,
  };
}

function validateRawStringArrayField(
  params: ZvecGrepParams,
  field: 'paths' | 'exclude',
): string | null {
  const value = (params as unknown as Record<string, unknown>)[field];
  if (value === undefined || !Array.isArray(value)) return null;
  if (value.some((item) => typeof item !== 'string' || !item.trim())) {
    return `${field} must contain only non-empty strings`;
  }
  return null;
}

function getWorkspaceJobKey(cwd: string): string {
  return crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 16);
}

function getBackgroundJobPath(cwd: string): string {
  return path.join(BACKGROUND_JOB_DIR, `${getWorkspaceJobKey(cwd)}.index.json`);
}

function removeBackgroundJobFiles(jobPath: string, logPath?: string): void {
  try {
    fs.rmSync(jobPath, { force: true });
  } catch {
    // Best effort cleanup only.
  }
  if (
    logPath &&
    path.dirname(path.resolve(logPath)) === path.resolve(BACKGROUND_JOB_DIR)
  ) {
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readBackgroundIndexJob(cwd: string): BackgroundIndexJob | undefined {
  const jobPath = getBackgroundJobPath(cwd);
  if (!fs.existsSync(jobPath)) return undefined;

  try {
    const parsed = JSON.parse(
      fs.readFileSync(jobPath, 'utf8'),
    ) as Partial<BackgroundIndexJob>;
    if (
      parsed.cwd !== cwd ||
      typeof parsed.pid !== 'number' ||
      !Array.isArray(parsed.args) ||
      typeof parsed.logPath !== 'string' ||
      typeof parsed.startedAt !== 'string'
    ) {
      removeBackgroundJobFiles(
        jobPath,
        typeof parsed.logPath === 'string' ? parsed.logPath : undefined,
      );
      return undefined;
    }
    if (!isProcessRunning(parsed.pid)) {
      removeBackgroundJobFiles(jobPath, parsed.logPath);
      return undefined;
    }
    return {
      pid: parsed.pid,
      cwd: parsed.cwd,
      args: parsed.args.filter((arg): arg is string => typeof arg === 'string'),
      logPath: parsed.logPath,
      startedAt: parsed.startedAt,
    };
  } catch {
    removeBackgroundJobFiles(jobPath);
    return undefined;
  }
}

function startBackgroundIndexJob(
  cwd: string,
  args: readonly string[],
): BackgroundIndexJob {
  fs.mkdirSync(BACKGROUND_JOB_DIR, { recursive: true });

  const jobKey = getWorkspaceJobKey(cwd);
  const logPath = path.join(BACKGROUND_JOB_DIR, `${jobKey}-${Date.now()}.log`);
  const logFd = fs.openSync(logPath, 'a');
  let child;
  try {
    child = spawn('zg', args, {
      cwd,
      detached: true,
      env: zvecGrepChildEnv(),
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }

  if (!child.pid) {
    throw new Error('failed to start zvec-grep index process');
  }

  const job: BackgroundIndexJob = {
    pid: child.pid,
    cwd,
    args: [...args],
    logPath,
    startedAt: new Date().toISOString(),
  };
  const jobPath = getBackgroundJobPath(cwd);
  const cleanupJob = () => {
    removeBackgroundJobFiles(jobPath, job.logPath);
  };
  child.once('error', cleanupJob);
  child.once('exit', cleanupJob);
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
  child.unref();
  return job;
}

function startAutoBackgroundIndex(
  cwd: string,
  params: ZvecGrepParams,
  parsed: ParsedStatus,
): void {
  if (!parsed.unindexed || parsed.ready || parsed.disabled || parsed.indexing) {
    return;
  }
  if (readBackgroundIndexJob(cwd)) return;
  if (!canUseSemanticEmbedding(parsed)) return;
  try {
    startBackgroundIndexJob(cwd, buildIndexArgs(params));
  } catch (error) {
    debugLogger.debug('Failed to start zvec-grep background index', error);
    // Searching must stay transparent even when background indexing cannot start.
  }
}

function pathListSeparator(): string {
  return process.platform === 'win32' ? ';' : ':';
}

function zvecGrepPathDirs(): string[] {
  const dirs = [
    process.env['npm_config_prefix']
      ? path.join(process.env['npm_config_prefix'], 'bin')
      : undefined,
    path.dirname(process.execPath),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ];
  return [...new Set(dirs.filter((dir): dir is string => Boolean(dir)))];
}

function zvecGrepChildEnv(): NodeJS.ProcessEnv {
  const separator = pathListSeparator();
  return {
    ...process.env,
    PATH: [
      ...zvecGrepPathDirs(),
      ...(normalizeOptionalString(process.env['PATH'])?.split(separator) ?? []),
    ]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(separator),
  };
}

function runInstallZvecGrep(signal: AbortSignal): Promise<ZgCommandResult> {
  if (signal.aborted) {
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      error: 'aborted',
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const child = spawn('npm', ['install', '-g', ZVEC_GREP_NPM_PACKAGE], {
      env: zvecGrepChildEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result: ZgCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const killForLimit = () => {
      if (truncated) return;
      truncated = true;
      child.kill('SIGTERM');
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killForLimit();
    }, ZG_INSTALL_TIMEOUT_MS);

    const onAbort = () => {
      child.kill('SIGTERM');
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        truncated,
        error: 'aborted',
      });
    };

    signal.addEventListener('abort', onAbort, { once: true });

    const appendChunk = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const currentSize = stdout.length + stderr.length;
      const remaining = ZG_INSTALL_OUTPUT_LIMIT - currentSize;
      if (remaining <= 0) {
        killForLimit();
        return;
      }

      const nextText = text.slice(0, remaining);
      if (target === 'stdout') {
        stdout += nextText;
      } else {
        stderr += nextText;
      }
      if (nextText.length < text.length) {
        killForLimit();
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      appendChunk('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      appendChunk('stderr', chunk);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        truncated,
        unavailable: error.code === 'ENOENT',
        error: error.message,
      });
    });

    child.on('close', (code) => {
      finish({
        ok: code === 0,
        code,
        stdout,
        stderr,
        truncated,
        error: timedOut
          ? `timed out after ${ZG_INSTALL_TIMEOUT_MS}ms`
          : truncated
            ? `output exceeded ${ZG_INSTALL_OUTPUT_LIMIT} bytes`
            : undefined,
      });
    });
  });
}

function installZvecGrep(signal: AbortSignal): Promise<ZgCommandResult> {
  if (!zvecGrepInstallPromise) {
    zvecGrepInstallPromise = runInstallZvecGrep(signal).then((result) => {
      if (result.ok) {
        zvecGrepInstalledInProcess = true;
      }
      if (result.error === 'aborted') {
        zvecGrepInstallPromise = undefined;
      }
      return result;
    });
  }
  return zvecGrepInstallPromise;
}

function withInstallFailure(
  result: ZgCommandResult,
  installResult: ZgCommandResult,
): ZgCommandResult {
  const details = [
    result.error,
    `auto-install command failed: npm install -g ${ZVEC_GREP_NPM_PACKAGE}`,
    `exit_code: ${installResult.code ?? 'unknown'}`,
    installResult.stdout.trim()
      ? `install_stdout:\n${installResult.stdout.trim()}`
      : '',
    installResult.stderr.trim()
      ? `install_stderr:\n${installResult.stderr.trim()}`
      : '',
    installResult.error ? `install_error: ${installResult.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { ...result, error: details };
}

async function runZg(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  options: { allowPartialOutput?: boolean } = {},
): Promise<ZgCommandResult> {
  const result = await runZgOnce(args, cwd, signal, options);
  if (!result.unavailable) return result;

  if (zvecGrepInstalledInProcess) return result;

  const installResult = await installZvecGrep(signal);
  if (!installResult.ok) {
    return withInstallFailure(result, installResult);
  }

  return runZgOnce(args, cwd, signal, options);
}

function runZgOnce(
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  options: { allowPartialOutput?: boolean } = {},
): Promise<ZgCommandResult> {
  if (signal.aborted) {
    return Promise.resolve({
      ok: false,
      code: null,
      stdout: '',
      stderr: '',
      error: 'aborted',
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const finish = (result: ZgCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const child = spawn('zg', args, {
      cwd,
      env: zvecGrepChildEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killForLimit = () => {
      if (truncated) return;
      truncated = true;
      child.kill('SIGTERM');
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killForLimit();
    }, zvecRunTimeoutMs());

    const onAbort = () => {
      child.kill('SIGTERM');
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        truncated,
        error: 'aborted',
      });
    };

    signal.addEventListener('abort', onAbort, { once: true });

    const appendChunk = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const currentSize = stdout.length + stderr.length;
      const remaining = ZG_OUTPUT_LIMIT - currentSize;
      if (remaining <= 0) {
        killForLimit();
        return;
      }

      const nextText = text.slice(0, remaining);
      if (target === 'stdout') {
        stdout += nextText;
      } else {
        stderr += nextText;
      }
      if (nextText.length < text.length) {
        killForLimit();
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      appendChunk('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      appendChunk('stderr', chunk);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        truncated,
        unavailable: error.code === 'ENOENT',
        error: error.message,
      });
    });

    child.on('close', (code) => {
      const partialOutputOk =
        options.allowPartialOutput === true &&
        truncated &&
        stdout.trim().length > 0;
      finish({
        ok: code === 0 || partialOutputOk,
        code,
        stdout,
        stderr,
        truncated,
        error: timedOut
          ? `timed out after ${zvecRunTimeoutMs()}ms`
          : truncated
            ? `output exceeded ${ZG_OUTPUT_LIMIT} bytes`
            : undefined,
      });
    });
  });
}

function extractResultFilePaths(cwd: string, output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(ZG_RESULT_LINE_RE);
    if (!match) continue;
    const candidate = path.isAbsolute(match[1]!)
      ? match[1]!
      : path.resolve(cwd, match[1]!);
    if (fs.existsSync(candidate)) {
      paths.add(candidate);
    }
  }
  return [...paths];
}

function countResultMatches(output: string): number {
  return output.split(/\r?\n/).filter((line) => ZG_RESULT_LINE_RE.test(line))
    .length;
}

function formatSearchReturnDisplay(
  output: string,
  result: ZgCommandResult,
): string {
  const matchCount = countResultMatches(output);
  if (matchCount === 0) {
    return output.trim() ? 'Search completed' : 'No matches found';
  }
  const matchTerm = matchCount === 1 ? 'match' : 'matches';
  return `Found ${matchCount} ${matchTerm}${result.truncated ? ' (truncated)' : ''}`;
}

function appendTruncationNotice(
  output: string,
  result: ZgCommandResult,
): string {
  if (!result.truncated) return output;
  return [
    output,
    '---',
    'Output was truncated to keep the tool result bounded. Retry with a narrower query, paths, glob, or limit if more detail is needed.',
  ].join('\n');
}

async function makeSearchSuccessResult(
  config: Config,
  cwd: string,
  result: ZgCommandResult,
): Promise<ToolResult> {
  const rawOutput = result.stdout.trim() || result.stderr.trim();
  const content = appendTruncationNotice(
    rawOutput || 'No matches found',
    result,
  );
  const resultFilePaths = extractResultFilePaths(cwd, content);
  await recordGrepResultFileReads(config, resultFilePaths);
  return {
    llmContent: content,
    returnDisplay: formatSearchReturnDisplay(rawOutput, result),
    resultFilePaths,
  };
}

function makeErrorResult(
  label: string,
  commandArgs: readonly string[],
  result: ZgCommandResult,
): ToolResult {
  const content = [
    label,
    '',
    `command: ${formatZgCommand(commandArgs)}`,
    `exit_code: ${result.code ?? 'unknown'}`,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
    result.error ? `error: ${result.error}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { llmContent: content, returnDisplay: content };
}

async function runGrepSearch(
  config: Config,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<ToolResult> {
  const result = await runZg(args, cwd, signal, {
    allowPartialOutput: true,
  });
  if (result.unavailable) {
    return makeErrorResult('zvec-grep is not installed.', args, result);
  }
  if (!result.ok) {
    return makeErrorResult('zvec-grep search failed.', args, result);
  }
  return makeSearchSuccessResult(config, cwd, result);
}

class ZvecGrepInvocation extends BaseToolInvocation<
  ZvecGrepParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ZvecGrepParams,
  ) {
    super(params);
  }

  private getExternalPathScopes(): string[] {
    const workspaceContext = this.config.getWorkspaceContext();
    const targetDir = this.config.getTargetDir();
    return normalizeSearchPaths(this.params).filter((scopePath) => {
      const resolvedPath = resolvePath(targetDir, scopePath);
      return (
        !workspaceContext.isPathWithinWorkspace(resolvedPath) &&
        !isSubpath(getMemoryBaseDir(), resolvedPath)
      );
    });
  }

  getDescription(): string {
    const query = getSearchQuery(this.params);
    if (this.params.operation === 'rg') {
      return query ? `zvec-grep rg: ${query}` : 'zvec-grep rg';
    }
    return query
      ? `Semantic zvec-grep search: ${query}`
      : 'Semantic zvec-grep search';
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return this.getExternalPathScopes().length > 0 ? 'ask' : 'allow';
  }

  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const externalScopes = this.getExternalPathScopes();
    return {
      type: 'info',
      title: 'Confirm zvec-grep external path search',
      prompt: [
        'zvec-grep was asked to search outside the current workspace.',
        '',
        'External paths:',
        ...externalScopes.map((scopePath) => `  - ${scopePath}`),
      ].join('\n'),
      onConfirm: async () => {},
    };
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    const cwd = this.config.getTargetDir();

    if (this.params.operation === 'rg') {
      const grepArgs = buildGrepArgs(this.params);
      updateOutput?.(
        `Searching with zvec-grep rg: ${formatZgCommand(grepArgs)}`,
      );
      return runGrepSearch(this.config, cwd, grepArgs, signal);
    }

    const status = await runZg(['--status'], cwd, signal);
    if (status.unavailable) {
      return makeErrorResult(
        'zvec-grep is not installed.',
        ['--status'],
        status,
      );
    }

    const parsed = parseStatus(`${status.stdout}\n${status.stderr}`);
    const canRunSemantic =
      status.ok && parsed.ready && canUseSemanticEmbedding(parsed);

    if (canRunSemantic) {
      const searchArgs = buildSearchArgs(this.params);
      updateOutput?.('Searching with zvec-grep');
      const searchResult = await runZg(searchArgs, cwd, signal, {
        allowPartialOutput: true,
      });
      if (searchResult.ok) {
        return makeSearchSuccessResult(this.config, cwd, searchResult);
      }
      debugLogger.debug(
        'zvec-grep semantic search failed; falling back to rg',
        searchResult.error ||
          searchResult.stderr.trim() ||
          searchResult.stdout.trim(),
      );
    } else {
      startAutoBackgroundIndex(cwd, this.params, parsed);
    }

    const grepArgs = buildSemanticFallbackGrepArgs(this.params);
    updateOutput?.('Searching with zvec-grep');
    return runGrepSearch(this.config, cwd, grepArgs, signal);
  }
}

export class ZvecGrepTool extends BaseDeclarativeTool<
  ZvecGrepParams,
  ToolResult
> {
  static readonly Name = ToolNames.ZVEC_GREP;

  override get maxOutputChars(): number {
    return 20_000;
  }

  constructor(private readonly config: Config) {
    super(
      ZvecGrepTool.Name,
      ToolDisplayNames.ZVEC_GREP,
      [
        'zvec_grep is the primary, higher-quality workspace search tool. Use zvec_grep for workspace search by default; do not use grep_search when zvec_grep is available.',
        '',
        'Use operation="semantic" with query for semantic or fuzzy discovery: concepts, behavior, architecture, relationships, topics, relevant files, or cases where exact keywords are unknown.',
        '',
        'Use operation="rg" with pattern for exact text or regular-expression searches: names, paths, messages, literals, config keys, documentation phrases, and other known text patterns.',
        '',
        'Trust zvec_grep result quality: treat returned files, symbols, and line ranges as high-signal candidates for the primary investigation path instead of repeating broad searches. Read only the relevant returned ranges when possible. If results look too narrow, increase limit and search again.',
      ].join('\n'),
      Kind.Search,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: {
            type: 'string',
            enum: ['semantic', 'rg'],
            description:
              'Search mode. Use semantic for fuzzy or meaning-based workspace search. Use rg for exact text or regular-expression search.',
          },
          query: {
            type: 'string',
            description:
              'Natural-language search query for operation="semantic".',
          },
          pattern: {
            type: 'string',
            description:
              'Exact text or regular expression pattern for operation="rg".',
          },
          path: {
            type: 'string',
            description:
              'Optional file or directory to search in. Defaults to the current workspace.',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional file or directory paths selected by the agent to narrow the current search.',
          },
          glob: {
            type: 'string',
            description:
              'Optional glob filter for files, e.g. "**/*.{ts,tsx}" or "src/**".',
          },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional exclude globs or paths, e.g. ["build/**", "thirdparty/**", "node_modules/**"].',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            description:
              'Maximum returned results. Semantic search defaults to 20 when omitted. For operation="rg", omit this unless the user explicitly asks for a capped sample.',
          },
        },
        required: ['operation'],
      },
      true,
      true,
    );
  }

  override validateToolParams(params: ZvecGrepParams): string | null {
    return (
      validateRawStringArrayField(params, 'paths') ??
      validateRawStringArrayField(params, 'exclude') ??
      super.validateToolParams(params)
    );
  }

  protected override validateToolParamValues(
    params: ZvecGrepParams,
  ): string | null {
    if (!['semantic', 'rg'].includes(params.operation)) {
      return 'operation must be one of: semantic, rg';
    }
    if (!getSearchQuery(params)) {
      return `query or pattern must be a non-empty string for operation="${params.operation}"`;
    }
    if (params.query !== undefined && !params.query.trim()) {
      return 'query must be a non-empty string when provided';
    }
    if (params.pattern !== undefined && !params.pattern.trim()) {
      return 'pattern must be a non-empty string when provided';
    }
    if (params.path !== undefined && !params.path.trim()) {
      return 'path must be a non-empty string when provided';
    }
    if (
      params.limit !== undefined &&
      (!Number.isInteger(params.limit) || params.limit <= 0)
    ) {
      return 'limit must be a positive integer';
    }
    if (params.glob !== undefined && !params.glob.trim()) {
      return 'glob must be a non-empty string when provided';
    }
    for (const field of ['paths', 'exclude'] as const) {
      const value = params[field];
      if (
        value !== undefined &&
        value.some((item) => typeof item !== 'string' || !item.trim())
      ) {
        return `${field} must contain only non-empty strings`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: ZvecGrepParams,
  ): ToolInvocation<ZvecGrepParams, ToolResult> {
    return new ZvecGrepInvocation(this.config, params);
  }
}
