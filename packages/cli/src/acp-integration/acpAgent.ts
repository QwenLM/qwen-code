/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  AuthType,
  ALL_PROVIDERS,
  applyProviderInstallPlan,
  buildInstallPlan,
  clearCachedCredentialFile,
  createDebugLogger,
  findProviderById,
  getAllGeminiMdFilenames,
  getAutoMemoryRoot,
  getDefaultBaseUrlForProtocol,
  getDefaultModelIds,
  getScopedEnvContents,
  QwenOAuth2Event,
  qwenOAuth2Events,
  resolveBaseUrl,
  MCP_BUDGET_WARN_FRACTION,
  MCPServerConfig,
  SessionService,
  SESSION_TITLE_MAX_LENGTH,
  Storage,
  tokenLimit,
  getMCPDiscoveryState,
  getMCPServerStatus,
  MCPDiscoveryState,
  MCPServerStatus,
  resolveOwnsModel,
  ExtensionManager,
  ExtensionSettingScope,
  updateSetting,
  SessionEndReason,
  restoreWorktreeContext,
} from '@qwen-code/qwen-code-core';
import type {
  ApprovalMode,
  Config,
  ConversationRecord,
  DeviceAuthorizationData,
  ProviderConfig,
  ProviderModelConfig,
  ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import {
  AgentSideConnection,
  RequestError,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type { Content } from '@google/genai';
import type {
  Agent,
  AuthenticateRequest,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  McpServerHttp,
  McpServerSse,
  McpServerStdio,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionUpdate,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import {
  buildAuthMethods,
  pickAuthMethodsForAuthRequired,
} from './authMethods.js';
import { AcpFileSystemService } from './service/filesystem.js';
import { Readable, Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { LoadedSettings } from '../config/settings.js';
import { loadSettings, SettingScope } from '../config/settings.js';
import { createLoadedSettingsAdapter } from '../config/loadedSettingsAdapter.js';
import type { ApprovalModeValue, SessionContext } from './session/types.js';
import { z } from 'zod';
import type { CliArgs } from '../config/config.js';
import { loadCliConfig } from '../config/config.js';
import { Session, buildAvailableCommandsSnapshot } from './session/Session.js';
import { HistoryReplayer } from './session/HistoryReplayer.js';
import {
  formatAcpModelId,
  parseAcpBaseModelId,
} from '../utils/acpModelUtils.js';
import { updateOutputLanguageFile } from '../utils/languageUtils.js';
import { runWithAcpRuntimeOutputDir } from './runtimeOutputDirContext.js';
import { runExitCleanup } from '../utils/cleanup.js';
import { isWorkspaceTrusted } from '../config/trustedFolders.js';
import {
  ACP_PREFLIGHT_KINDS,
  STATUS_SCHEMA_VERSION,
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
  mapDomainErrorToErrorKind,
  type AcpPreflightKind,
  type ServeErrorKind,
  type ServeMcpBudgetMode,
  type ServeMcpBudgetStatusCell,
  type ServeMcpDiscoveryState,
  type ServeMcpServerRuntimeStatus,
  type ServeMcpTransport,
  type ServePreflightCell,
  type ServePreflightKind,
  type ServeSessionContextStatus,
  type ServeSessionSupportedCommandsStatus,
  type ServeStatus,
  type ServeStatusCell,
  type ServeWorkspaceMcpServerStatus,
  type ServeWorkspaceMcpStatus,
  type ServeWorkspaceProviderModel,
  type ServeWorkspaceProviderStatus,
  type ServeWorkspaceProvidersStatus,
  type ServeWorkspaceSkillStatus,
  type ServeWorkspaceSkillsStatus,
} from '../serve/status.js';

const debugLogger = createDebugLogger('ACP_AGENT');

/**
 * Env-var candidates per auth method, used by `buildAuthPreflightCell` for
 * a side-effect-free presence check. Mirrors `AUTH_ENV_MAPPINGS` from
 * `core/src/models/constants.ts` (which isn't on the public package
 * surface). Keep in sync if a new provider is added there. Any auth method
 * not listed here surfaces as `status: 'unknown'` on the cell rather than
 * a false `auth_env_error` — full validation happens at session start.
 *
 * Drift detection: `AUTH_PREFLIGHT_AUDITED_AUTH_TYPES` below lists every
 * `AuthType` enum value that has been triaged for this map (either keyed
 * here, or explicitly waived for non-env-based auth like qwen-oauth). The
 * paired test `AUTH_PREFLIGHT_AUDITED_AUTH_TYPES covers every AuthType`
 * walks the public enum and fails CI when core adds a new auth method
 * without a deliberate decision here.
 */
export const AUTH_PREFLIGHT_ENV_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  'vertex-ai': ['GOOGLE_API_KEY'],
};

/**
 * Auth methods deliberately not env-keyed (e.g. OAuth-based, credential
 * file). Listed here so the drift test recognizes them as triaged-but-
 * waived rather than a missing entry.
 */
export const AUTH_PREFLIGHT_WAIVED_AUTH_TYPES: ReadonlySet<string> = new Set([
  'qwen-oauth',
]);

type PermissionRuleType = 'allow' | 'ask' | 'deny';

interface PermissionRuleSet {
  allow: string[];
  ask: string[];
  deny: string[];
}

interface PermissionSettingsScopeState {
  path: string;
  rules: PermissionRuleSet;
}

interface QwenPermissionSettings {
  user: PermissionSettingsScopeState;
  workspace: PermissionSettingsScopeState;
  merged: PermissionRuleSet;
  isTrusted: boolean;
}

const PERMISSION_RULE_TYPES: PermissionRuleType[] = ['allow', 'ask', 'deny'];

function readPermissionRuleSet(settings: unknown): PermissionRuleSet {
  const permissions =
    settings && typeof settings === 'object'
      ? (
          settings as {
            permissions?: Partial<Record<PermissionRuleType, unknown>>;
          }
        ).permissions
      : undefined;

  const readRules = (type: PermissionRuleType): string[] => {
    const value = permissions?.[type];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  };

  return {
    allow: readRules('allow'),
    ask: readRules('ask'),
    deny: readRules('deny'),
  };
}

function normalizePermissionRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

type QwenMemorySettings = {
  enableManagedAutoMemory: boolean;
  enableManagedAutoDream: boolean;
  enableAutoSkill: boolean;
};

type QwenMemoryPaths = {
  userMemoryFile: string;
  projectMemoryFile: string;
  autoMemoryDir: string;
};

type QwenSkillInstallRequest = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  sourceUrl: string;
  scope: 'global';
};

type QwenSkillDeleteRequest = {
  slug: string;
  scope: 'global';
};

type QwenSkillSetEnabledRequest = {
  slug: string;
  enabled: boolean;
  scope: 'global' | 'project';
};

type QwenManagedSkillFile = {
  skillDir: string;
  skillFile: string;
  content: string;
};

const PROJECT_SKILL_DIRS = ['.qwen', '.agents'] as const;
const SKILLS_DIR = 'skills';

type DownloadedSkillFile = {
  relativePath: string;
  content: Uint8Array;
};

type DownloadedSkill = {
  skillContent: string;
  files: DownloadedSkillFile[];
};

type GitHubBlobSkillUrl = {
  owner: string;
  repo: string;
  ref: string;
  filePath: string;
};

type QwenSettingsScope = 'user' | 'workspace';
type QwenSettingValue = string | number | boolean | string[] | undefined;
type QwenMcpTransport = 'stdio' | 'http' | 'sse';
type QwenHookEvent =
  | 'UserPromptSubmit'
  | 'Stop'
  | 'Notification'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PermissionRequest';

type QwenCoreSettingKey =
  | 'model.name'
  | 'fastModel'
  | 'general.outputLanguage'
  | 'general.language'
  | 'tools.approvalMode'
  | 'general.vimMode'
  | 'general.enableAutoUpdate'
  | 'general.showSessionRecap'
  | 'general.sessionRecapAwayThresholdMinutes'
  | 'general.terminalBell'
  | 'general.gitCoAuthor.commit'
  | 'general.gitCoAuthor.pr'
  | 'general.defaultFileEncoding'
  | 'context.fileFiltering.respectGitIgnore'
  | 'context.fileFiltering.respectQwenIgnore'
  | 'context.fileFiltering.enableFuzzySearch'
  | 'memory.enableManagedAutoMemory'
  | 'memory.enableManagedAutoDream'
  | 'memory.enableAutoSkill'
  | 'disableAllHooks';

type QwenMcpServerConfig = {
  transport: QwenMcpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  httpUrl?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  trust?: boolean;
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
  extensionName?: string;
};

type QwenHookConfig = {
  type: 'command' | 'http';
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  name?: string;
  description?: string;
  timeout?: number;
  env?: Record<string, string>;
  async?: boolean;
  once?: boolean;
  statusMessage?: string;
  shell?: 'bash' | 'powershell';
};

type QwenHookDefinition = {
  matcher?: string;
  sequential?: boolean;
  hooks: QwenHookConfig[];
};

const QWEN_CORE_SETTING_DEFINITIONS = {
  'model.name': { type: 'string' },
  fastModel: { type: 'string' },
  'general.outputLanguage': { type: 'string' },
  'general.language': { type: 'string' },
  'tools.approvalMode': {
    type: 'enum',
    values: ['plan', 'default', 'auto-edit', 'auto', 'yolo'],
  },
  'general.vimMode': { type: 'boolean' },
  'general.enableAutoUpdate': { type: 'boolean' },
  'general.showSessionRecap': { type: 'boolean' },
  'general.sessionRecapAwayThresholdMinutes': { type: 'number', min: 1 },
  'general.terminalBell': { type: 'boolean' },
  'general.gitCoAuthor.commit': { type: 'boolean' },
  'general.gitCoAuthor.pr': { type: 'boolean' },
  'general.defaultFileEncoding': {
    type: 'enum',
    values: ['utf-8', 'utf-8-bom'],
  },
  'context.fileFiltering.respectGitIgnore': { type: 'boolean' },
  'context.fileFiltering.respectQwenIgnore': { type: 'boolean' },
  'context.fileFiltering.enableFuzzySearch': { type: 'boolean' },
  'memory.enableManagedAutoMemory': { type: 'boolean' },
  'memory.enableManagedAutoDream': { type: 'boolean' },
  'memory.enableAutoSkill': { type: 'boolean' },
  disableAllHooks: { type: 'boolean' },
} as const satisfies Record<
  QwenCoreSettingKey,
  {
    type: 'string' | 'number' | 'boolean' | 'enum';
    min?: number;
    values?: readonly string[];
  }
>;

const QWEN_CORE_SETTING_KEYS = Object.keys(
  QWEN_CORE_SETTING_DEFINITIONS,
) as QwenCoreSettingKey[];

const QWEN_HOOK_EVENTS: QwenHookEvent[] = [
  'UserPromptSubmit',
  'Stop',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
  'PermissionRequest',
];

const DEFAULT_QWEN_MEMORY_SETTINGS: QwenMemorySettings = {
  enableManagedAutoMemory: true,
  enableManagedAutoDream: false,
  enableAutoSkill: false,
};

const QWEN_MEMORY_SETTING_KEYS = [
  'enableManagedAutoMemory',
  'enableManagedAutoDream',
  'enableAutoSkill',
] as const satisfies ReadonlyArray<keyof QwenMemorySettings>;

function normalizeQwenMemorySettings(value: unknown): QwenMemorySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_QWEN_MEMORY_SETTINGS };
  }

  const record = value as Record<string, unknown>;
  return {
    enableManagedAutoMemory:
      typeof record['enableManagedAutoMemory'] === 'boolean'
        ? record['enableManagedAutoMemory']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableManagedAutoMemory,
    enableManagedAutoDream:
      typeof record['enableManagedAutoDream'] === 'boolean'
        ? record['enableManagedAutoDream']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableManagedAutoDream,
    enableAutoSkill:
      typeof record['enableAutoSkill'] === 'boolean'
        ? record['enableAutoSkill']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableAutoSkill,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected string`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(value: unknown, fieldName: string): string {
  const stringValue = readOptionalString(value, fieldName);
  if (!stringValue) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid or missing ${fieldName}`,
    );
  }
  return stringValue;
}

// Skill slugs are used to build filesystem paths under `<globalQwenDir>/skills`.
// The character allowlist below already excludes `/` and `\`, but `.` and `..`
// would still slip through and let `path.join` traverse out of the skills dir
// (e.g. slug `..` resolves to the global config dir). Reject them explicitly.
function validateSkillSlug(slug: string): void {
  if (
    !slug ||
    slug === '.' ||
    slug === '..' ||
    slug.includes('/') ||
    slug.includes(path.sep) ||
    !/^[a-zA-Z0-9._-]+$/.test(slug)
  ) {
    throw RequestError.invalidParams(undefined, 'Invalid skill.slug');
  }
}

function readSkillInstallRequest(
  params: Record<string, unknown>,
): QwenSkillInstallRequest {
  const skillParams = toRecord(params['skill']);
  const input = Object.keys(skillParams).length > 0 ? skillParams : params;
  const slug = readRequiredString(input['slug'], 'skill.slug');
  validateSkillSlug(slug);

  const scope = readOptionalString(input['scope'], 'skill.scope') ?? 'global';
  if (scope !== 'global') {
    throw RequestError.invalidParams(
      undefined,
      'Only global skill installation is supported',
    );
  }

  const description = readOptionalString(
    input['description'],
    'skill.description',
  );
  return {
    id: readOptionalString(input['id'], 'skill.id') ?? slug,
    slug,
    name: readOptionalString(input['name'], 'skill.name') ?? slug,
    ...(description ? { description } : {}),
    sourceUrl: readRequiredString(input['sourceUrl'], 'skill.sourceUrl'),
    scope,
  };
}

function readSkillSlugRequest(
  params: Record<string, unknown>,
): QwenSkillDeleteRequest {
  const skillParams = toRecord(params['skill']);
  const input = Object.keys(skillParams).length > 0 ? skillParams : params;
  const slug = readRequiredString(input['slug'], 'skill.slug');
  validateSkillSlug(slug);

  const scope = readOptionalString(input['scope'], 'skill.scope') ?? 'global';
  if (scope !== 'global') {
    throw RequestError.invalidParams(
      undefined,
      'Only global skill management is supported',
    );
  }

  return { slug, scope };
}

function readSkillSetEnabledRequest(
  params: Record<string, unknown>,
): QwenSkillSetEnabledRequest {
  const skillParams = toRecord(params['skill']);
  const input = Object.keys(skillParams).length > 0 ? skillParams : params;
  const slug = readRequiredString(input['slug'], 'skill.slug');
  validateSkillSlug(slug);

  const scope = readOptionalString(input['scope'], 'skill.scope') ?? 'global';
  if (scope !== 'global' && scope !== 'project') {
    throw RequestError.invalidParams(
      undefined,
      'Only global or project skill management is supported',
    );
  }

  if (typeof input['enabled'] !== 'boolean') {
    throw RequestError.invalidParams(
      undefined,
      'Invalid skill.enabled: expected boolean',
    );
  }
  return {
    slug,
    scope,
    enabled: input['enabled'],
  };
}

function splitSkillMarkdown(content: string): {
  frontmatter: string;
  body: string;
} {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) {
    throw RequestError.invalidParams(
      undefined,
      'Invalid skill file: missing YAML frontmatter',
    );
  }
  return {
    frontmatter: match[1],
    body: match[2],
  };
}

function setSkillFrontmatterEnabled(content: string, enabled: boolean): string {
  const { frontmatter, body } = splitSkillMarkdown(content);

  // Surgically add/remove only the top-level `disable-model-invocation:` line
  // instead of round-tripping the whole frontmatter through a YAML
  // parse/stringify. The minimal core YAML serializer drops comments and
  // flattens nested structures (e.g. `hooks:`), so reserializing here would
  // corrupt hooks-bearing skills and strip user comments. Working on the raw
  // text leaves every other byte untouched.
  const lines = frontmatter.split('\n');
  const disabledLineIndex = lines.findIndex((line) =>
    /^disable-model-invocation\s*:/.test(line),
  );

  if (enabled) {
    if (disabledLineIndex !== -1) {
      lines.splice(disabledLineIndex, 1);
    }
  } else if (disabledLineIndex !== -1) {
    lines[disabledLineIndex] = 'disable-model-invocation: true';
  } else {
    let insertIndex = lines.length;
    while (insertIndex > 0 && lines[insertIndex - 1].trim() === '') {
      insertIndex -= 1;
    }
    lines.splice(insertIndex, 0, 'disable-model-invocation: true');
  }

  const nextFrontmatter = lines.join('\n');
  return `---\n${nextFrontmatter}\n---\n${body}`;
}

// Skill downloads must come from the GitHub host set. Restricting the host
// here prevents the client-supplied `sourceUrl` from driving server-side
// fetches at internal/loopback/link-local endpoints (SSRF), e.g.
// `http://169.254.169.254/` cloud-metadata or `http://localhost:<port>/`.
const ALLOWED_SKILL_SOURCE_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'api.github.com',
]);

function assertAllowedSkillSourceUrl(sourceUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl must be a valid URL',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl must be an HTTP(S) URL',
    );
  }
  if (!ALLOWED_SKILL_SOURCE_HOSTS.has(parsed.hostname)) {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl host is not allowed (only github.com sources are supported)',
    );
  }
}

function parseGitHubBlobSkillUrl(sourceUrl: string): GitHubBlobSkillUrl | null {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw RequestError.invalidParams(
      undefined,
      'Skill sourceUrl must be an HTTP(S) URL',
    );
  }

  if (parsed.hostname !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 5 || parts[2] !== 'blob') return null;

  const owner = parts[0];
  const repo = parts[1];
  const ref = parts[3];
  const filePathParts = parts.slice(4);
  if (!owner || !repo || !ref || filePathParts.length === 0) return null;

  return {
    owner,
    repo,
    ref,
    filePath: filePathParts.join('/'),
  };
}

function toRawGitHubUrl(githubUrl: GitHubBlobSkillUrl): string {
  return `https://raw.githubusercontent.com/${githubUrl.owner}/${githubUrl.repo}/${githubUrl.ref}/${githubUrl.filePath}`;
}

function encodeGitHubPath(filePath: string): string {
  if (!filePath || filePath === '.') return '';
  return filePath.split('/').map(encodeURIComponent).join('/');
}

function readTarString(
  archive: Uint8Array,
  offset: number,
  length: number,
): string {
  const bytes = archive.subarray(offset, offset + length);
  const nul = bytes.indexOf(0);
  const end = nul >= 0 ? nul : bytes.length;
  return Buffer.from(bytes.subarray(0, end)).toString('utf8').trim();
}

function readTarSize(archive: Uint8Array, offset: number): number {
  const raw = readTarString(archive, offset + 124, 12);
  return raw ? Number.parseInt(raw, 8) : 0;
}

function isZeroTarBlock(archive: Uint8Array, offset: number): boolean {
  for (let i = 0; i < 512; i += 1) {
    if (archive[offset + i] !== 0) return false;
  }
  return true;
}

function readTarPath(archive: Uint8Array, offset: number): string {
  const name = readTarString(archive, offset, 100);
  const prefix = readTarString(archive, offset + 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function stripArchiveRoot(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('/') : '';
}

// Bound the work done on untrusted skill archives so a malicious or oversized
// download cannot exhaust memory. `gunzip` (async) keeps decompression off the
// synchronous path so it never blocks the event loop.
const MAX_SKILL_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB compressed
const MAX_SKILL_DECOMPRESSED_BYTES = 500 * 1024 * 1024; // 500 MB decompressed
const gunzipAsync = promisify(gunzip);

async function extractFilesFromTarGz(
  archiveBytes: Uint8Array,
  directoryPath: string,
): Promise<DownloadedSkillFile[]> {
  if (archiveBytes.length > MAX_SKILL_DOWNLOAD_BYTES) {
    throw RequestError.invalidParams(
      undefined,
      'Skill archive exceeds the maximum allowed size',
    );
  }

  let archive: Buffer;
  try {
    archive = await gunzipAsync(archiveBytes);
  } catch (error) {
    throw RequestError.invalidParams(
      undefined,
      `Failed to decompress skill archive: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (archive.length > MAX_SKILL_DECOMPRESSED_BYTES) {
    throw RequestError.invalidParams(
      undefined,
      'Decompressed skill archive exceeds the maximum allowed size',
    );
  }

  const normalizedDirectory = directoryPath.replace(/^\/+|\/+$/g, '');
  const directoryPrefix = normalizedDirectory ? `${normalizedDirectory}/` : '';
  const files: DownloadedSkillFile[] = [];

  for (let offset = 0; offset + 512 <= archive.length; ) {
    if (isZeroTarBlock(archive, offset)) break;

    const fullPath = readTarPath(archive, offset);
    const typeFlag = String.fromCharCode(archive[offset + 156] || 0);
    const size = readTarSize(archive, offset);
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512;

    if (typeFlag === '0' || typeFlag === '\0') {
      const repoPath = stripArchiveRoot(fullPath);
      if (repoPath.startsWith(directoryPrefix)) {
        const relativePath = repoPath.slice(directoryPrefix.length);
        if (relativePath) {
          files.push({
            relativePath,
            content: archive.subarray(dataOffset, dataOffset + size),
          });
        }
      }
    }

    offset = nextOffset;
  }

  return files;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  // `redirect: 'manual'` stops a redirect hop from an allowed host bouncing the
  // fetch to an internal endpoint; GitHub's raw/codeload endpoints respond 200
  // directly so this does not affect legitimate skill downloads.
  const response = await fetch(url, { redirect: 'manual' });
  if (!response.ok) {
    throw RequestError.invalidParams(
      undefined,
      `Failed to download skill (${response.status})`,
    );
  }

  const contentLength = response.headers?.get('content-length');
  if (contentLength) {
    const declaredSize = Number.parseInt(contentLength, 10);
    if (
      Number.isFinite(declaredSize) &&
      declaredSize > MAX_SKILL_DOWNLOAD_BYTES
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Skill download exceeds the maximum allowed size',
      );
    }
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function downloadSingleSkillFile(
  sourceUrl: string,
): Promise<DownloadedSkill> {
  const githubUrl = parseGitHubBlobSkillUrl(sourceUrl);
  const fetchUrl = githubUrl ? toRawGitHubUrl(githubUrl) : sourceUrl;
  const content = await fetchBytes(fetchUrl);
  return {
    skillContent: Buffer.from(content).toString('utf8'),
    files: [{ relativePath: 'SKILL.md', content }],
  };
}

async function downloadGitHubSkillDirectoryFromArchive(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
): Promise<DownloadedSkillFile[]> {
  const archiveUrl = `https://codeload.github.com/${githubUrl.owner}/${githubUrl.repo}/tar.gz/${githubUrl.ref}`;
  const response = await fetch(archiveUrl, {
    headers: {
      'User-Agent': 'qwen-code',
    },
  });
  if (!response.ok) {
    throw RequestError.invalidParams(
      undefined,
      `Failed to download GitHub skill archive (${response.status})`,
    );
  }

  return extractFilesFromTarGz(
    new Uint8Array(await response.arrayBuffer()),
    directoryPath,
  );
}

async function fetchGitHubDirectoryItems(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
): Promise<unknown[]> {
  const encodedPath = encodeGitHubPath(directoryPath);
  const apiUrl = `https://api.github.com/repos/${githubUrl.owner}/${githubUrl.repo}/contents/${encodedPath}?ref=${encodeURIComponent(githubUrl.ref)}`;
  const response = await fetch(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'qwen-code',
    },
  });
  if (!response.ok) {
    throw RequestError.invalidParams(
      undefined,
      `Failed to list GitHub skill files (${response.status})`,
    );
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw RequestError.invalidParams(
      undefined,
      'GitHub skill URL must point to a directory-backed SKILL.md file',
    );
  }
  return data;
}

async function downloadGitHubSkillDirectoryFromApi(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
  relativeRoot = '',
): Promise<DownloadedSkillFile[]> {
  const items = await fetchGitHubDirectoryItems(githubUrl, directoryPath);
  const files: DownloadedSkillFile[] = [];

  for (const item of items) {
    const record = toRecord(item);
    const name = readRequiredString(record['name'], 'github.name');
    const itemPath = readRequiredString(record['path'], 'github.path');
    const type = readRequiredString(record['type'], 'github.type');
    const relativePath = relativeRoot
      ? path.posix.join(relativeRoot, name)
      : name;

    if (type === 'dir') {
      files.push(
        ...(await downloadGitHubSkillDirectoryFromApi(
          githubUrl,
          itemPath,
          relativePath,
        )),
      );
      continue;
    }

    if (type !== 'file') continue;
    const downloadUrl = readRequiredString(
      record['download_url'],
      'github.download_url',
    );
    files.push({
      relativePath,
      content: await fetchBytes(downloadUrl),
    });
  }

  return files;
}

async function downloadGitHubSkillDirectory(
  githubUrl: GitHubBlobSkillUrl,
  directoryPath: string,
): Promise<DownloadedSkillFile[]> {
  const apiFiles = await downloadGitHubSkillDirectoryFromApi(
    githubUrl,
    directoryPath,
  ).catch(() => null);
  if (apiFiles) return apiFiles;

  return downloadGitHubSkillDirectoryFromArchive(githubUrl, directoryPath);
}

async function downloadSkill(sourceUrl: string): Promise<DownloadedSkill> {
  assertAllowedSkillSourceUrl(sourceUrl);
  const githubUrl = parseGitHubBlobSkillUrl(sourceUrl);
  if (!githubUrl || path.posix.basename(githubUrl.filePath) !== 'SKILL.md') {
    return downloadSingleSkillFile(sourceUrl);
  }

  const skillDirectory = path.posix.dirname(githubUrl.filePath);
  const files = await downloadGitHubSkillDirectory(githubUrl, skillDirectory);
  const skillFile = files.find((file) => file.relativePath === 'SKILL.md');
  if (!skillFile) {
    throw RequestError.invalidParams(
      undefined,
      'GitHub skill directory does not contain SKILL.md',
    );
  }

  return {
    skillContent: Buffer.from(skillFile.content).toString('utf8'),
    files,
  };
}

function resolveSkillInstallPath(
  skillDir: string,
  relativePath: string,
): string {
  const root = path.resolve(skillDir);
  const target = path.resolve(skillDir, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid skill file path: ${relativePath}`,
    );
  }
  return target;
}

// Builds the per-skill directory and asserts (defense-in-depth, on top of
// validateSkillSlug) that it stays strictly under the managed skills root, so a
// crafted slug can never make install/delete operate on `<globalQwenDir>` itself.
function resolveManagedSkillDir(skillsBaseDir: string, slug: string): string {
  const root = path.resolve(skillsBaseDir);
  const skillDir = path.resolve(skillsBaseDir, slug);
  if (!skillDir.startsWith(root + path.sep)) {
    throw RequestError.invalidParams(undefined, 'Invalid skill.slug');
  }
  return skillDir;
}

function readStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected string[]`,
    );
  }
  return Array.from(
    new Set(
      value
        .map((item) => {
          if (typeof item !== 'string') {
            throw RequestError.invalidParams(
              undefined,
              `Invalid ${fieldName}: expected string[]`,
            );
          }
          return item.trim();
        })
        .filter(Boolean),
    ),
  );
}

function readPositiveNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected positive number`,
    );
  }
  return value;
}

function readProviderAdvancedConfig(
  value: unknown,
): ProviderSetupInputs['advancedConfig'] | undefined {
  if (value === undefined || value === null) return undefined;
  const record = toRecord(value);
  if (
    record['enableThinking'] !== undefined &&
    typeof record['enableThinking'] !== 'boolean'
  ) {
    throw RequestError.invalidParams(
      undefined,
      'Invalid advancedConfig.enableThinking: expected boolean',
    );
  }
  const multimodalRecord = toRecord(record['multimodal']);
  const multimodal: NonNullable<
    ProviderSetupInputs['advancedConfig']
  >['multimodal'] = {};
  for (const key of ['image', 'video', 'audio', 'pdf'] as const) {
    const flag = multimodalRecord[key];
    if (flag !== undefined) {
      if (typeof flag !== 'boolean') {
        throw RequestError.invalidParams(
          undefined,
          `Invalid advancedConfig.multimodal.${key}: expected boolean`,
        );
      }
      multimodal[key] = flag;
    }
  }
  const contextWindowSize = readPositiveNumber(
    record['contextWindowSize'],
    'advancedConfig.contextWindowSize',
  );
  const maxTokens = readPositiveNumber(
    record['maxTokens'],
    'advancedConfig.maxTokens',
  );

  const advancedConfig: NonNullable<ProviderSetupInputs['advancedConfig']> = {
    ...(typeof record['enableThinking'] === 'boolean'
      ? { enableThinking: record['enableThinking'] }
      : {}),
    ...(Object.keys(multimodal).length > 0 ? { multimodal } : {}),
    ...(contextWindowSize ? { contextWindowSize } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };

  return Object.keys(advancedConfig).length > 0 ? advancedConfig : undefined;
}

function resolveProviderDocumentationUrl(
  config: ProviderConfig,
  baseUrl: string,
): string | undefined {
  if (typeof config.documentationUrl === 'string') {
    return config.documentationUrl;
  }
  if (typeof config.documentationUrl === 'function') {
    try {
      return config.documentationUrl(baseUrl);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isProviderModelConfig(value: unknown): value is ProviderModelConfig {
  const record = toRecord(value);
  return typeof record['id'] === 'string';
}

function readSettingsEnv(
  settings: LoadedSettings,
  envKey: string | undefined,
): string | undefined {
  if (!envKey) return undefined;
  const env = toRecord((settings.merged as Record<string, unknown>)['env']);
  const value = env[envKey];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readProviderModels(
  settings: LoadedSettings,
  protocol: string,
): ProviderModelConfig[] {
  const modelProviders = toRecord(
    (settings.merged as Record<string, unknown>)['modelProviders'],
  );
  const models = modelProviders[protocol];
  return Array.isArray(models) ? models.filter(isProviderModelConfig) : [];
}

function findExistingProviderModels(
  config: ProviderConfig,
  settings: LoadedSettings,
):
  | { protocol: ProviderConfig['protocol']; models: ProviderModelConfig[] }
  | undefined {
  const ownsModel = resolveOwnsModel(config);
  if (!ownsModel) return undefined;
  const protocols = config.protocolOptions?.length
    ? config.protocolOptions
    : [config.protocol];
  for (const protocol of protocols) {
    const models = readProviderModels(settings, protocol).filter(ownsModel);
    if (models.length > 0) return { protocol, models };
  }
  return undefined;
}

function resolveProviderEnvKey(
  config: ProviderConfig,
  protocol: ProviderConfig['protocol'],
  baseUrl: string,
): string | undefined {
  try {
    return typeof config.envKey === 'function'
      ? config.envKey(protocol, baseUrl)
      : config.envKey;
  } catch {
    return undefined;
  }
}

function readExistingAdvancedConfig(
  model: ProviderModelConfig | undefined,
): Record<string, unknown> | undefined {
  const generationConfig = toRecord(model?.generationConfig);
  const extraBody = toRecord(generationConfig['extra_body']);
  const advancedConfig: Record<string, unknown> = {};
  if (typeof extraBody['enable_thinking'] === 'boolean') {
    advancedConfig['enableThinking'] = extraBody['enable_thinking'];
  }
  if (typeof generationConfig['contextWindowSize'] === 'number') {
    advancedConfig['contextWindowSize'] = generationConfig['contextWindowSize'];
  }
  return Object.keys(advancedConfig).length > 0 ? advancedConfig : undefined;
}

function readExistingProviderConfig(
  config: ProviderConfig,
  settings: LoadedSettings,
): Record<string, unknown> | undefined {
  const existing = findExistingProviderModels(config, settings);
  const firstModel = existing?.models[0];
  const protocol = existing?.protocol ?? config.protocol;
  const baseUrl =
    typeof firstModel?.baseUrl === 'string'
      ? firstModel.baseUrl
      : resolveBaseUrl(config);
  const envKey =
    typeof firstModel?.envKey === 'string'
      ? firstModel.envKey
      : resolveProviderEnvKey(config, protocol, baseUrl);
  const apiKey = readSettingsEnv(settings, envKey);
  const hasExistingConfig = !!apiKey || !!existing;

  if (!hasExistingConfig) return undefined;

  const advancedConfig = readExistingAdvancedConfig(firstModel);

  return {
    protocol,
    baseUrl,
    // Never serialize the raw secret over the ACP wire. Expose only whether a
    // key is stored; the client can omit `apiKey` on connect to keep it.
    ...(apiKey ? { hasApiKey: true } : {}),
    ...(existing ? { modelIds: existing.models.map((model) => model.id) } : {}),
    ...(advancedConfig ? { advancedConfig } : {}),
  };
}

// Resolves the raw, stored API key for a provider for server-side use only
// (never serialized to the client). Used so `qwen/providers/connect` can keep
// the existing key when the client updates other fields without resubmitting it.
function resolveExistingProviderApiKey(
  config: ProviderConfig,
  settings: LoadedSettings,
): string | undefined {
  const existing = findExistingProviderModels(config, settings);
  const firstModel = existing?.models[0];
  const protocol = existing?.protocol ?? config.protocol;
  const baseUrl =
    typeof firstModel?.baseUrl === 'string'
      ? firstModel.baseUrl
      : resolveBaseUrl(config);
  const envKey =
    typeof firstModel?.envKey === 'string'
      ? firstModel.envKey
      : resolveProviderEnvKey(config, protocol, baseUrl);
  return readSettingsEnv(settings, envKey);
}

function serializeProviderConfig(
  config: ProviderConfig,
  settings: LoadedSettings,
): Record<string, unknown> {
  const defaultProtocol = config.protocolOptions?.[0] ?? config.protocol;
  const defaultBaseUrl =
    config.baseUrl === undefined
      ? getDefaultBaseUrlForProtocol(defaultProtocol)
      : resolveBaseUrl(config);
  const existingConfig = readExistingProviderConfig(config, settings);

  return {
    id: config.id,
    label: config.label,
    description: config.description,
    protocol: config.protocol,
    protocolOptions: config.protocolOptions ?? [],
    baseUrl: config.baseUrl,
    baseUrlPlaceholder:
      config.baseUrl === undefined ? defaultBaseUrl : undefined,
    defaultModelIds: getDefaultModelIds(config),
    models: config.models ?? [],
    modelsEditable: config.modelsEditable === true || !config.models,
    showAdvancedConfig: config.showAdvancedConfig === true,
    apiKeyPlaceholder: config.apiKeyPlaceholder,
    documentationUrl: resolveProviderDocumentationUrl(config, defaultBaseUrl),
    uiGroup: config.uiGroup ?? 'third-party',
    uiLabels: config.uiLabels,
    ...(existingConfig ? { existingConfig } : {}),
  };
}

function readProviderSetupInputs(
  config: ProviderConfig,
  params: Record<string, unknown>,
  existingApiKey?: string,
): ProviderSetupInputs {
  const protocol = readOptionalString(params['protocol'], 'protocol') as
    | AuthType
    | undefined;
  if (
    protocol &&
    protocol !== config.protocol &&
    !config.protocolOptions?.includes(protocol)
  ) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid protocol for provider "${config.id}"`,
    );
  }

  let baseUrl = resolveBaseUrl(
    config,
    readOptionalString(params['baseUrl'], 'baseUrl'),
  ).trim();
  if (!baseUrl && config.baseUrl === undefined) {
    baseUrl = getDefaultBaseUrlForProtocol(protocol ?? config.protocol);
  }
  if (!baseUrl) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid or missing baseUrl for provider "${config.id}"`,
    );
  }

  // `apiKey` is optional on update: when the client omits it (e.g. it only
  // received `hasApiKey` from the list response), fall back to the stored key.
  const apiKey =
    readOptionalString(params['apiKey'], 'apiKey') ?? existingApiKey;
  if (!apiKey) {
    throw RequestError.invalidParams(undefined, 'Invalid or missing apiKey');
  }
  const apiKeyError = config.validateApiKey?.(apiKey, baseUrl);
  if (apiKeyError) {
    throw RequestError.invalidParams(undefined, apiKeyError);
  }

  const defaultModelIds = getDefaultModelIds(config);
  const modelIds = readStringArray(params['modelIds'], 'modelIds');
  const resolvedModelIds = modelIds.length > 0 ? modelIds : defaultModelIds;
  if (resolvedModelIds.length === 0) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid or missing modelIds for provider "${config.id}"`,
    );
  }

  const advancedConfig = readProviderAdvancedConfig(params['advancedConfig']);

  return {
    ...(protocol ? { protocol } : {}),
    baseUrl,
    apiKey,
    modelIds: resolvedModelIds,
    ...(advancedConfig ? { advancedConfig } : {}),
  };
}

function readProviderConnectScope(value: unknown): SettingScope | undefined {
  if (value === undefined) return undefined;
  if (value === 'user') return SettingScope.User;
  if (value === 'workspace') return SettingScope.Workspace;
  throw RequestError.invalidParams(
    undefined,
    'Invalid scope for provider connect',
  );
}

function getNestedSettingValue(
  source: Record<string, unknown>,
  key: QwenCoreSettingKey,
): QwenSettingValue {
  let current: unknown = source;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (
    typeof current === 'string' ||
    typeof current === 'number' ||
    typeof current === 'boolean' ||
    Array.isArray(current)
  ) {
    return current as QwenSettingValue;
  }
  return undefined;
}

function readCoreSettingValues(
  source: Record<string, unknown>,
): Partial<Record<QwenCoreSettingKey, QwenSettingValue>> {
  const values: Partial<Record<QwenCoreSettingKey, QwenSettingValue>> = {};
  for (const key of QWEN_CORE_SETTING_KEYS) {
    const value = getNestedSettingValue(source, key);
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return values;
}

function normalizeCoreSettingValue(
  key: QwenCoreSettingKey,
  value: unknown,
): QwenSettingValue {
  const definition = QWEN_CORE_SETTING_DEFINITIONS[key];
  switch (definition.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw RequestError.invalidParams(undefined, `${key} must be a boolean`);
      }
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw RequestError.invalidParams(undefined, `${key} must be a number`);
      }
      if (definition.min !== undefined && value < definition.min) {
        throw RequestError.invalidParams(
          undefined,
          `${key} must be at least ${definition.min}`,
        );
      }
      return value;
    case 'enum': {
      const values = definition.values as readonly string[] | undefined;
      if (typeof value !== 'string' || !values?.includes(value)) {
        throw RequestError.invalidParams(
          undefined,
          `${key} must be one of ${values?.join(', ')}`,
        );
      }
      return value;
    }
    case 'string':
      if (value === undefined) return undefined;
      if (typeof value !== 'string') {
        throw RequestError.invalidParams(undefined, `${key} must be a string`);
      }
      return value.trim();
    default:
      throw RequestError.invalidParams(
        undefined,
        `${key} has an unsupported setting type`,
      );
  }
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw RequestError.invalidParams(undefined, 'Expected an array of strings');
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = toRecord(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' && key.trim()) {
      result[key.trim()] = item;
    }
  }
  return result;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numberValue =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw RequestError.invalidParams(undefined, 'Expected a positive number');
  }
  return numberValue;
}

function normalizeMcpServerConfig(value: unknown): QwenMcpServerConfig {
  const input = toRecord(value);
  const transport = input['transport'];
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    throw RequestError.invalidParams(
      undefined,
      'MCP transport must be stdio, http, or sse',
    );
  }

  const server: QwenMcpServerConfig = { transport };
  const description = input['description'];
  if (typeof description === 'string' && description.trim()) {
    server.description = description.trim();
  }
  const cwd = input['cwd'];
  if (typeof cwd === 'string' && cwd.trim()) server.cwd = cwd.trim();
  const timeout = normalizeOptionalNumber(input['timeout']);
  if (timeout !== undefined) server.timeout = timeout;
  if (typeof input['trust'] === 'boolean') server.trust = input['trust'];
  server.includeTools = normalizeStringArray(input['includeTools']);
  server.excludeTools = normalizeStringArray(input['excludeTools']);

  if (transport === 'stdio') {
    const command = input['command'];
    if (typeof command !== 'string' || !command.trim()) {
      throw RequestError.invalidParams(
        undefined,
        'Stdio MCP servers require a command',
      );
    }
    server.command = command.trim();
    server.args = normalizeStringArray(input['args']);
    server.env = normalizeStringRecord(input['env']);
    return server;
  }

  const urlKey = transport === 'http' ? 'httpUrl' : 'url';
  const url = input[urlKey];
  if (typeof url !== 'string' || !url.trim()) {
    throw RequestError.invalidParams(
      undefined,
      `${transport.toUpperCase()} MCP servers require a URL`,
    );
  }
  if (transport === 'http') server.httpUrl = url.trim();
  else server.url = url.trim();
  server.headers = normalizeStringRecord(input['headers']);
  return server;
}

function toStoredMcpServerConfig(
  server: QwenMcpServerConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    'timeout',
    'trust',
    'description',
    'includeTools',
    'excludeTools',
  ] as const) {
    if (server[key] !== undefined) result[key] = server[key];
  }
  if (server.transport === 'stdio') {
    result['command'] = server.command;
    if (server.args !== undefined) result['args'] = server.args;
    if (server.cwd !== undefined) result['cwd'] = server.cwd;
    if (server.env !== undefined) result['env'] = server.env;
  } else if (server.transport === 'http') {
    result['httpUrl'] = server.httpUrl;
    if (server.headers !== undefined) result['headers'] = server.headers;
  } else {
    result['url'] = server.url;
    if (server.headers !== undefined) result['headers'] = server.headers;
  }
  return result;
}

function toMcpServerConfig(value: unknown): QwenMcpServerConfig | undefined {
  const server = toRecord(value);
  if (typeof server['httpUrl'] === 'string') {
    return {
      transport: 'http',
      httpUrl: server['httpUrl'],
      headers: normalizeStringRecord(server['headers']),
      timeout: normalizeOptionalNumber(server['timeout']),
      trust: typeof server['trust'] === 'boolean' ? server['trust'] : undefined,
      description:
        typeof server['description'] === 'string'
          ? server['description']
          : undefined,
      includeTools: normalizeStringArray(server['includeTools']),
      excludeTools: normalizeStringArray(server['excludeTools']),
      extensionName:
        typeof server['extensionName'] === 'string'
          ? server['extensionName']
          : undefined,
    };
  }
  if (typeof server['url'] === 'string') {
    return {
      transport: 'sse',
      url: server['url'],
      headers: normalizeStringRecord(server['headers']),
      timeout: normalizeOptionalNumber(server['timeout']),
      trust: typeof server['trust'] === 'boolean' ? server['trust'] : undefined,
      description:
        typeof server['description'] === 'string'
          ? server['description']
          : undefined,
      includeTools: normalizeStringArray(server['includeTools']),
      excludeTools: normalizeStringArray(server['excludeTools']),
      extensionName:
        typeof server['extensionName'] === 'string'
          ? server['extensionName']
          : undefined,
    };
  }
  if (typeof server['command'] === 'string') {
    return {
      transport: 'stdio',
      command: server['command'],
      args: normalizeStringArray(server['args']),
      cwd: typeof server['cwd'] === 'string' ? server['cwd'] : undefined,
      env: normalizeStringRecord(server['env']),
      timeout: normalizeOptionalNumber(server['timeout']),
      trust: typeof server['trust'] === 'boolean' ? server['trust'] : undefined,
      description:
        typeof server['description'] === 'string'
          ? server['description']
          : undefined,
      includeTools: normalizeStringArray(server['includeTools']),
      excludeTools: normalizeStringArray(server['excludeTools']),
      extensionName:
        typeof server['extensionName'] === 'string'
          ? server['extensionName']
          : undefined,
    };
  }
  return undefined;
}

function readMcpServers(
  source: Record<string, unknown>,
  scope: QwenSettingsScope | 'extension',
): Array<{
  name: string;
  scope: QwenSettingsScope | 'extension';
  server: QwenMcpServerConfig;
}> {
  const servers = toRecord(source['mcpServers']);
  return Object.entries(servers)
    .map(([name, value]) => {
      try {
        const server = toMcpServerConfig(value);
        return server ? { name, scope, server } : undefined;
      } catch (error) {
        debugLogger.warn(
          `Skipping malformed MCP server config [${scope}:${name}]:`,
          error,
        );
        return undefined;
      }
    })
    .filter(
      (
        entry,
      ): entry is {
        name: string;
        scope: QwenSettingsScope | 'extension';
        server: QwenMcpServerConfig;
      } => !!entry,
    );
}

function isHookEvent(value: unknown): value is QwenHookEvent {
  return (
    typeof value === 'string' &&
    QWEN_HOOK_EVENTS.includes(value as QwenHookEvent)
  );
}

function normalizeHookConfig(value: unknown): QwenHookConfig {
  const input = toRecord(value);
  const type = input['type'];
  if (type !== 'command' && type !== 'http') {
    throw RequestError.invalidParams(
      undefined,
      'Hook type must be command or http',
    );
  }
  const config: QwenHookConfig = { type };
  if (type === 'command') {
    const command = input['command'];
    if (typeof command !== 'string' || !command.trim()) {
      throw RequestError.invalidParams(
        undefined,
        'Command hooks require a command',
      );
    }
    config.command = command.trim();
    config.env = normalizeStringRecord(input['env']);
    if (typeof input['async'] === 'boolean') config.async = input['async'];
    const shell = input['shell'];
    if (shell === 'bash' || shell === 'powershell') config.shell = shell;
  } else {
    const url = input['url'];
    if (typeof url !== 'string' || !url.trim()) {
      throw RequestError.invalidParams(undefined, 'HTTP hooks require a URL');
    }
    config.url = url.trim();
    config.headers = normalizeStringRecord(input['headers']);
    config.allowedEnvVars = normalizeStringArray(input['allowedEnvVars']);
    if (typeof input['once'] === 'boolean') config.once = input['once'];
  }
  const timeout = normalizeOptionalNumber(input['timeout']);
  if (timeout !== undefined) config.timeout = timeout;
  for (const key of ['name', 'description', 'statusMessage'] as const) {
    const item = input[key];
    if (typeof item === 'string' && item.trim()) {
      config[key] = item.trim();
    }
  }
  return config;
}

function normalizeHookDefinition(value: unknown): QwenHookDefinition {
  const input = toRecord(value);
  const hooks = input['hooks'];
  if (!Array.isArray(hooks) || hooks.length === 0) {
    throw RequestError.invalidParams(
      undefined,
      'Hook definition requires at least one hook',
    );
  }
  const definition: QwenHookDefinition = {
    hooks: hooks.map(normalizeHookConfig),
  };
  if (typeof input['matcher'] === 'string') {
    definition.matcher = input['matcher'];
  }
  if (typeof input['sequential'] === 'boolean') {
    definition.sequential = input['sequential'];
  }
  return definition;
}

function readHooks(
  source: Record<string, unknown>,
  scope: QwenSettingsScope | 'extension',
  extensionName?: string,
): Array<{
  event: QwenHookEvent;
  scope: QwenSettingsScope | 'extension';
  index: number;
  hook: QwenHookDefinition;
  extensionName?: string;
}> {
  const hooksRoot = toRecord(source['hooks']);
  const entries: Array<{
    event: QwenHookEvent;
    scope: QwenSettingsScope | 'extension';
    index: number;
    hook: QwenHookDefinition;
    extensionName?: string;
  }> = [];
  for (const event of QWEN_HOOK_EVENTS) {
    const eventHooks = hooksRoot[event];
    if (!Array.isArray(eventHooks)) continue;
    eventHooks.forEach((hookValue, index) => {
      try {
        entries.push({
          event,
          scope,
          index,
          hook: normalizeHookDefinition(hookValue),
          extensionName,
        });
      } catch (error) {
        debugLogger.warn(
          `Skipping malformed hook entry [${scope}:${event}:${index}]:`,
          error,
        );
      }
    });
  }
  return entries;
}

function toSettingsScope(scope: unknown): SettingScope {
  if (scope === 'workspace') return SettingScope.Workspace;
  if (scope === 'user') return SettingScope.User;
  throw RequestError.invalidParams(
    undefined,
    'scope must be user or workspace',
  );
}

function readScopeSettings(
  settings: LoadedSettings,
  scope: QwenSettingsScope,
): Record<string, unknown> {
  return settings.forScope(toSettingsScope(scope)).settings as Record<
    string,
    unknown
  >;
}

async function resolvePreferredMemoryFile(
  dir: string,
  fallbackFilename: string,
): Promise<string> {
  for (const filename of getAllGeminiMdFilenames()) {
    const filePath = path.join(dir, filename);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Try the next configured file name.
    }
  }

  return path.join(dir, fallbackFilename);
}

async function ensureMemoryFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, '', 'utf-8');
  }
}

async function resolveQwenMemoryPaths(params: {
  cwd: string;
  projectRoot: string;
}): Promise<QwenMemoryPaths> {
  const fallbackFilename = getAllGeminiMdFilenames()[0] ?? 'QWEN.md';
  const userMemoryFile = await resolvePreferredMemoryFile(
    Storage.getGlobalQwenDir(),
    fallbackFilename,
  );
  const projectMemoryFile = await resolvePreferredMemoryFile(
    params.cwd,
    fallbackFilename,
  );
  const autoMemoryDir = getAutoMemoryRoot(params.projectRoot);

  await Promise.all([
    ensureMemoryFile(userMemoryFile),
    ensureMemoryFile(projectMemoryFile),
    fs.mkdir(autoMemoryDir, { recursive: true }),
  ]);

  return {
    userMemoryFile,
    projectMemoryFile,
    autoMemoryDir,
  };
}

export async function runAcpAgent(
  config: Config,
  settings: LoadedSettings,
  argv: CliArgs,
) {
  // Initialize config to set up ACP bootstrap services (hooks, tools, MCP)
  // without creating a chat session. The real per-session Config will own
  // GeminiClient.initialize() and any SessionStart hook execution.
  await config.initialize({ skipGeminiInitialization: true });
  // ACP forwards session messages straight to the model; under progressive
  // MCP availability `initialize()` returns before MCP servers settle, so
  // we wait here to keep the first session's tool surface consistent with
  // the legacy synchronous behavior.
  await config.waitForMcpReady();
  // Surface MCP failures to stderr. ACP's stdout is the protocol channel
  // so info/log writes are already redirected to stderr below, but we
  // emit this BEFORE that redirection takes effect to keep the message
  // visible regardless of how the host process is wired.
  // Defensive against tests that pass a stubbed Config without
  // `getFailedMcpServerNames`.
  const failedMcpServers =
    typeof config.getFailedMcpServerNames === 'function'
      ? config.getFailedMcpServerNames()
      : [];
  if (failedMcpServers.length > 0) {
    process.stderr.write(
      `Warning: MCP server(s) failed to start: ${failedMcpServers.join(', ')}. ` +
        `Continuing with built-in tools and any servers that did connect.\n`,
    );
  }

  const stdout = Writable.toWeb(process.stdout) as WritableStream;
  const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  // Stdout is used to send messages to the client, so console.log/console.info
  // messages to stderr so that they don't interfere with ACP.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const stream = ndJsonStream(stdout, stdin);
  let agentInstance: QwenAgent | undefined;
  const connection = new AgentSideConnection((conn) => {
    agentInstance = new QwenAgent(config, settings, argv, conn);
    return agentInstance;
  }, stream);

  // Handle SIGTERM/SIGINT for graceful shutdown.
  // Without this, signal handlers registered elsewhere in the CLI
  // (e.g., stdin raw mode restoration) override the default exit behavior,
  // causing the ACP process to ignore termination signals.
  let shuttingDown = false;
  let sessionEndFired = false;

  // Helper to fire SessionEnd hook once, preventing double-fire from both
  // shutdown handler path and connection.closed path.
  const fireSessionEndOnce = async (reason: SessionEndReason) => {
    if (sessionEndFired) return;
    sessionEndFired = true;

    const configs = new Set<Config>([config]);
    const sessions = agentInstance?.getActiveSessions();
    if (sessions) {
      for (const session of sessions) {
        const sessionConfig = session.getConfig?.();
        if (sessionConfig) {
          configs.add(sessionConfig);
        }
      }
    }

    for (const cfg of configs) {
      const hookSystem = cfg.getHookSystem?.();
      const hooksEnabled = !cfg.getDisableAllHooks?.();
      if (
        !hooksEnabled ||
        !hookSystem ||
        !cfg.hasHooksForEvent?.('SessionEnd')
      ) {
        continue;
      }
      try {
        await hookSystem.fireSessionEndEvent(reason);
      } catch (err) {
        debugLogger.warn(
          `SessionEnd hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  const shutdownHandler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    debugLogger.debug('[ACP] Shutdown signal received, closing streams');

    // Fire SessionEnd hook for all active sessions (aligned with core path)
    await fireSessionEndOnce(SessionEndReason.Other);

    try {
      process.stdin.destroy();
    } catch {
      // stdin may already be closed
    }
    try {
      process.stdout.destroy();
    } catch {
      // stdout may already be closed
    }
    // Clean up child processes (MCP servers, etc.) and force exit.
    // Without this, orphan subprocesses keep the Node.js event loop alive
    // and the CLI process never terminates after the IDE disconnects.
    runExitCleanup()
      .catch((err) => {
        debugLogger.error('[ACP] Cleanup error:', err);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);

  await connection.closed;
  // Connection closed by IDE - fire SessionEnd hook (aligned with core path)
  await fireSessionEndOnce(SessionEndReason.PromptInputExit);

  process.off('SIGTERM', shutdownHandler);
  process.off('SIGINT', shutdownHandler);
}

export function toStdioServer(server: McpServer): McpServerStdio | undefined {
  if ('command' in server && 'args' in server && 'env' in server) {
    return server as McpServerStdio;
  }
  return undefined;
}

export function toSseServer(
  server: McpServer,
): (McpServerSse & { type: 'sse' }) | undefined {
  if ('type' in server && server.type === 'sse') {
    return server as McpServerSse & { type: 'sse' };
  }
  return undefined;
}

export function toHttpServer(
  server: McpServer,
): (McpServerHttp & { type: 'http' }) | undefined {
  if ('type' in server && server.type === 'http') {
    return server as McpServerHttp & { type: 'http' };
  }
  return undefined;
}

class QwenAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private clientCapabilities: ClientCapabilities | undefined;

  getActiveSessions(): Session[] {
    return [...this.sessions.values()];
  }

  constructor(
    private config: Config,
    private settings: LoadedSettings,
    private argv: CliArgs,
    private connection: AgentSideConnection,
  ) {}

  async initialize(args: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = args.clientCapabilities;
    const authMethods = buildAuthMethods();
    const version = process.env['CLI_VERSION'] || process.version;

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: 'qwen-code',
        title: 'Qwen Code',
        version,
      },
      authMethods,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
        },
        mcpCapabilities: {
          sse: true,
          http: true,
        },
      },
    };
  }

  async authenticate({ methodId }: AuthenticateRequest): Promise<void> {
    const method = z.nativeEnum(AuthType).parse(methodId);

    let authUri: string | undefined;
    const authUriHandler = (deviceAuth: DeviceAuthorizationData) => {
      authUri = deviceAuth.verification_uri_complete;
      void this.connection.extNotification('authenticate/update', {
        _meta: { authUri },
      });
    };

    if (method === AuthType.QWEN_OAUTH) {
      qwenOAuth2Events.once(QwenOAuth2Event.AuthUri, authUriHandler);
    }

    await clearCachedCredentialFile();
    try {
      await this.config.refreshAuth(method);
      this.settings.setValue(
        SettingScope.User,
        'security.auth.selectedType',
        method,
      );
    } finally {
      if (method === AuthType.QWEN_OAUTH) {
        qwenOAuth2Events.off(QwenOAuth2Event.AuthUri, authUriHandler);
      }
    }
  }

  async newSession({
    cwd,
    mcpServers,
  }: NewSessionRequest): Promise<NewSessionResponse> {
    const config = await this.newSessionConfig(cwd, mcpServers);
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const session = await this.createAndStoreSession(config);
    const availableModels = this.buildAvailableModels(config);
    const modesData = this.buildModesData(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      sessionId: session.getId(),
      models: availableModels,
      modes: modesData,
      configOptions,
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const exists = await runWithAcpRuntimeOutputDir(
      this.settings,
      params.cwd,
      async () => {
        const sessionService = new SessionService(params.cwd);
        return sessionService.sessionExists(params.sessionId);
      },
    );
    if (!exists) {
      throw RequestError.resourceNotFound(`session:${params.sessionId}`);
    }

    const config = await this.newSessionConfig(
      params.cwd,
      // `LoadSessionRequest.mcpServers` is required in today's ACP
      // schema, but mirror `unstable_resumeSession` and tolerate a
      // future loosening — `newSessionConfig` iterates the list, so
      // a `null`/`undefined` would otherwise throw `TypeError`.
      params.mcpServers ?? [],
      params.sessionId,
      true,
    );
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const sessionData = config.getResumedSessionData();
    const session = await this.createAndStoreSession(
      config,
      sessionData?.conversation,
    );

    await this.#restoreWorktreeOnResume(config, session);

    const modesData = this.buildModesData(config);
    const availableModels = this.buildAvailableModels(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      modes: modesData,
      models: availableModels,
      configOptions,
    };
  }

  async unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const exists = await runWithAcpRuntimeOutputDir(
      this.settings,
      params.cwd,
      async () => {
        const sessionService = new SessionService(params.cwd);
        return sessionService.sessionExists(params.sessionId);
      },
    );
    if (!exists) {
      throw RequestError.resourceNotFound(`session:${params.sessionId}`);
    }

    const config = await this.newSessionConfig(
      params.cwd,
      params.mcpServers ?? [],
      params.sessionId,
      true,
    );
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const session = await this.createAndStoreSession(config);

    await this.#restoreWorktreeOnResume(config, session);

    const modesData = this.buildModesData(config);
    const availableModels = this.buildAvailableModels(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      modes: modesData,
      models: availableModels,
      configOptions,
    };
  }

  /**
   * Shared worktree restore for both ACP entry points (`loadSession` and
   * `unstable_resumeSession`). Reads the WorktreeSession sidecar, cleans
   * up stale ones, and queues the context reminder on the Session so the
   * next `#executePrompt` prepends it to the user's first prompt.
   *
   * Best-effort: failures don't block session load — worktree context
   * is a hint to the model, not a load-time correctness requirement.
   * (PR #4174 review #3259975... — parity between the two ACP entry
   * points.)
   */
  async #restoreWorktreeOnResume(
    config: Config,
    session: Session,
  ): Promise<void> {
    try {
      const sessionPath = config
        .getSessionService()
        .getWorktreeSessionPath(config.getSessionId());
      const restored = await restoreWorktreeContext(sessionPath);
      if (restored.contextMessage) {
        session.pendingWorktreeNotice = restored.contextMessage;
      }
    } catch (error) {
      debugLogger.warn(`ACP worktree restore failed: ${error}`);
    }
  }

  async unstable_listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const cwd = params.cwd || process.cwd();
    const numericCursor = params.cursor ? Number(params.cursor) : undefined;

    // The ACP spec's ListSessionsRequest doesn't include a page-size field,
    // so the SDK's zod validator strips any top-level `size` the client sends
    // before it reaches this handler. Carry page size through `_meta.size`
    // (same pattern filesystem.ts uses for `_meta.bom` / `_meta.encoding`).
    const metaSize = params._meta?.['size'];
    const size =
      typeof metaSize === 'number' && metaSize > 0
        ? Math.floor(metaSize)
        : undefined;

    const result = await runWithAcpRuntimeOutputDir(this.settings, cwd, () => {
      const sessionService = new SessionService(cwd);
      return sessionService.listSessions({
        cursor: Number.isNaN(numericCursor) ? undefined : numericCursor,
        size,
      });
    });

    const sessions: SessionInfo[] = result.items.map((item) => ({
      _meta: {
        createdAt: item.startTime,
        startTime: item.startTime,
        preview: item.prompt,
        ...(item.gitBranch ? { gitBranch: item.gitBranch } : {}),
        ...(item.titleSource ? { titleSource: item.titleSource } : {}),
      },
      cwd: item.cwd,
      sessionId: item.sessionId,
      title: item.customTitle || item.prompt || '(session)',
      updatedAt: new Date(item.mtime).toISOString(),
    }));

    return {
      sessions,
      nextCursor:
        result.nextCursor != null ? String(result.nextCursor) : undefined,
    };
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${params.sessionId}`,
      );
    }
    return session.setMode(params);
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${params.sessionId}`,
      );
    }
    return await session.setModel(params);
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const { sessionId, configId, value } = params;

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }

    switch (configId) {
      case 'mode': {
        await this.setSessionMode({
          sessionId,
          modeId: value as string,
        });
        break;
      }
      case 'model': {
        await session.setModel(
          {
            sessionId,
            modelId: value as string,
          },
          { persistDefault: false },
        );
        break;
      }
      default:
        throw RequestError.invalidParams(
          undefined,
          `Unsupported configId: ${configId}`,
        );
    }

    return {
      configOptions: this.buildConfigOptions(session.getConfig()),
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    return session.prompt(params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    await session.cancelPendingPrompt();
  }

  private loadPermissionSettings(cwd: string): LoadedSettings {
    this.settings = loadSettings(cwd);
    return this.settings;
  }

  private buildPermissionSettings(
    settings: LoadedSettings,
  ): QwenPermissionSettings {
    return {
      user: {
        path: settings.user.path,
        rules: readPermissionRuleSet(settings.user.settings),
      },
      workspace: {
        path: settings.workspace.path,
        rules: readPermissionRuleSet(settings.workspace.settings),
      },
      merged: readPermissionRuleSet(settings.merged),
      isTrusted: settings.isTrusted,
    };
  }

  private async buildCoreSettings(
    settings: LoadedSettings,
    cwd: string,
  ): Promise<Record<string, unknown>> {
    const userSettings = settings.user.settings as Record<string, unknown>;
    const workspaceSettings = settings.workspace.settings as Record<
      string,
      unknown
    >;
    const mergedSettings = settings.merged as Record<string, unknown>;

    let extensions: ReturnType<ExtensionManager['getLoadedExtensions']> = [];
    try {
      const extensionManager = new ExtensionManager({
        workspaceDir: cwd,
        isWorkspaceTrusted: !!isWorkspaceTrusted(settings.merged),
      });
      await extensionManager.refreshCache();
      extensions = extensionManager.getLoadedExtensions();
    } catch (error) {
      debugLogger.warn(
        'Extension loading failed, continuing without extensions:',
        error,
      );
    }

    const extensionEntries = await Promise.all(
      extensions.map(async (extension) => {
        const userEnv = await getScopedEnvContents(
          extension.config,
          extension.id,
          ExtensionSettingScope.USER,
        );
        const workspaceEnv = await getScopedEnvContents(
          extension.config,
          extension.id,
          ExtensionSettingScope.WORKSPACE,
        );
        const settingDefs = extension.settings ?? [];
        return {
          id: extension.id,
          name: extension.name,
          version: extension.version,
          isActive: extension.isActive,
          path: extension.path,
          commands: extension.commands ?? [],
          skills: (extension.skills ?? []).map((skill) => skill.name),
          mcpServers: Object.keys(extension.config.mcpServers ?? {}),
          settings: settingDefs.map((setting) => {
            const userValue = userEnv[setting.envVar];
            const workspaceValue = workspaceEnv[setting.envVar];
            const hasWorkspaceValue = workspaceValue !== undefined;
            const hasUserValue = userValue !== undefined;
            const effectiveValue = hasWorkspaceValue
              ? workspaceValue
              : userValue;
            const effectiveScope = hasWorkspaceValue
              ? 'workspace'
              : hasUserValue
                ? 'user'
                : undefined;
            return {
              name: setting.name,
              description: setting.description,
              envVar: setting.envVar,
              sensitive: !!setting.sensitive,
              userValue: setting.sensitive ? undefined : userValue,
              workspaceValue: setting.sensitive ? undefined : workspaceValue,
              effectiveValue: setting.sensitive ? undefined : effectiveValue,
              effectiveScope,
              hasUserValue,
              hasWorkspaceValue,
            };
          }),
        };
      }),
    );

    const extensionMcpServers = extensions.flatMap((extension) =>
      readMcpServers(
        { mcpServers: extension.config.mcpServers ?? {} },
        'extension',
      ).map((entry) => ({
        ...entry,
        server: { ...entry.server, extensionName: extension.name },
      })),
    );
    const extensionHooks = extensions.flatMap((extension) =>
      readHooks({ hooks: extension.hooks ?? {} }, 'extension', extension.name),
    );

    return {
      user: {
        path: settings.user.path,
        values: readCoreSettingValues(userSettings),
        mcpServers: readMcpServers(userSettings, 'user'),
        hooks: readHooks(userSettings, 'user'),
      },
      workspace: {
        path: settings.workspace.path,
        values: readCoreSettingValues(workspaceSettings),
        mcpServers: readMcpServers(workspaceSettings, 'workspace'),
        hooks: readHooks(workspaceSettings, 'workspace'),
      },
      merged: {
        values: readCoreSettingValues(mergedSettings),
        mcpServers: [
          ...readMcpServers(mergedSettings, 'workspace'),
          ...extensionMcpServers,
        ],
        hooks: [...readHooks(mergedSettings, 'workspace'), ...extensionHooks],
      },
      extensions: extensionEntries,
      isTrusted: settings.isTrusted,
    };
  }

  private syncLivePermissionManagers(
    before: PermissionRuleSet,
    after: PermissionRuleSet,
  ): void {
    for (const ruleType of PERMISSION_RULE_TYPES) {
      const oldRules = new Set(before[ruleType]);
      const newRules = new Set(after[ruleType]);
      const removed = before[ruleType].filter((rule) => !newRules.has(rule));
      const added = after[ruleType].filter((rule) => !oldRules.has(rule));

      if (removed.length === 0 && added.length === 0) continue;

      for (const session of this.sessions.values()) {
        const pm = session.getConfig().getPermissionManager?.();
        if (!pm) continue;
        for (const rule of removed) {
          pm.removePersistentRule(rule, ruleType);
        }
        for (const rule of added) {
          pm.addPersistentRule(rule, ruleType);
        }
      }
    }
  }

  private workspaceCwd(config: Config): string {
    return config.getTargetDir();
  }

  private safeWorkspaceCwd(config: Config): string {
    try {
      return this.workspaceCwd(config);
    } catch {
      return '';
    }
  }

  private mcpTransport(server: unknown): ServeMcpTransport {
    if (
      server &&
      typeof server === 'object' &&
      'type' in server &&
      (server as { type?: unknown }).type === 'sdk'
    ) {
      return 'sdk';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { httpUrl?: unknown }).httpUrl === 'string'
    ) {
      return 'http';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { url?: unknown }).url === 'string'
    ) {
      return 'sse';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { tcp?: unknown }).tcp === 'string'
    ) {
      return 'websocket';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { command?: unknown }).command === 'string'
    ) {
      return 'stdio';
    }
    return 'unknown';
  }

  private mcpStatus(status: MCPServerStatus): ServeMcpServerRuntimeStatus {
    switch (status) {
      case MCPServerStatus.CONNECTED:
        return 'connected';
      case MCPServerStatus.CONNECTING:
        return 'connecting';
      case MCPServerStatus.DISCONNECTED:
      default:
        return 'disconnected';
    }
  }

  private mcpCellStatus(
    status: MCPServerStatus,
    disabled: boolean,
  ): ServeStatus {
    if (disabled) return 'disabled';
    switch (status) {
      case MCPServerStatus.CONNECTED:
        return 'ok';
      case MCPServerStatus.CONNECTING:
        return 'warning';
      case MCPServerStatus.DISCONNECTED:
      default:
        return 'error';
    }
  }

  private discoveryState(): ServeMcpDiscoveryState {
    const state = getMCPDiscoveryState();
    switch (state) {
      case MCPDiscoveryState.IN_PROGRESS:
        return 'in_progress';
      case MCPDiscoveryState.COMPLETED:
        return 'completed';
      case MCPDiscoveryState.NOT_STARTED:
      default:
        return 'not_started';
    }
  }

  private buildWorkspaceMcpStatus(config: Config): ServeWorkspaceMcpStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const servers = config.getMcpServers() ?? {};

      // PR 14: pull live accounting + budget config from the child's
      // McpClientManager so the daemon's read-only route reflects the
      // single source of truth (not a daemon-side polled cache).
      // `getToolRegistry()` and `getMcpClientManager()` are best-effort
      // — older test stubs or partially-initialized configs may not
      // expose them; in that case we fall back to "no budget surface".
      let clientCount: number | undefined;
      let clientBudget: number | undefined;
      let budgetMode: ServeMcpBudgetMode | undefined;
      let refusedSet: ReadonlySet<string> = new Set<string>();
      try {
        const manager = config.getToolRegistry()?.getMcpClientManager();
        if (manager) {
          const accounting = manager.getMcpClientAccounting();
          clientCount = accounting.total;
          clientBudget = manager.getMcpClientBudget();
          budgetMode = manager.getMcpBudgetMode();
          refusedSet = new Set(accounting.refusedServerNames);
        }
      } catch (err) {
        // Accounting failure must not crash the snapshot — the per-
        // server data is still useful even without budget overlay.
        // PR 14 fix (review #4247 wenshao S7a): bumped from
        // `debugLogger.debug` to stderr `process.stderr.write` so a
        // production daemon emits a visible warning when accounting
        // breaks. `debugLogger.debug` is gated on the operator
        // having set debug=true, which makes silent slot-leak / type-
        // mismatch failures invisible in real deployments.
        process.stderr.write(
          `qwen serve: getMcpClientAccounting failed: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        discoveryState: this.discoveryState(),
        servers: Object.entries(servers).map(([name, server]) => {
          const disabled = config.isMcpServerDisabled(name);
          const rawStatus = getMCPServerStatus(name);
          const refusedByBudget = refusedSet.has(name);
          // PR 14 fix (review #4247): config-disable takes precedence
          // over budget-refusal. `lastRefusedServerNames` is a
          // per-discovery-pass snapshot; if an operator runs
          // `/mcp disable <name>` against a server that was refused
          // last pass, the entry stays in the refused list until the
          // next discovery pass clears it (`McpClientManager.removeServer`
          // now drops the entry too — see sibling fix). Either way,
          // a `disabled` cell should NEVER show `budget_exhausted` —
          // the operator's deliberate disable wins.
          const effectivelyRefused = refusedByBudget && !disabled;
          const out: ServeWorkspaceMcpServerStatus = {
            kind: 'mcp_server',
            // Refused-by-budget shadows the raw status: the rawStatus
            // is `DISCONNECTED` (we never tried to connect), but the
            // operator-facing severity is `error` with an explanatory
            // errorKind rather than the generic disconnected `error`.
            status: effectivelyRefused
              ? 'error'
              : this.mcpCellStatus(rawStatus, disabled),
            name,
            mcpStatus: this.mcpStatus(rawStatus),
            transport: this.mcpTransport(server),
            disabled,
          };
          if (effectivelyRefused) {
            out.errorKind = 'budget_exhausted';
            out.disabledReason = 'budget';
            out.hint =
              'Raise --mcp-client-budget or remove servers from mcpServers config.';
          } else if (disabled) {
            out.disabledReason = 'config';
          }
          const description =
            server && typeof server === 'object'
              ? (server as { description?: unknown }).description
              : undefined;
          const extensionName =
            server && typeof server === 'object'
              ? (server as { extensionName?: unknown }).extensionName
              : undefined;
          if (typeof description === 'string') {
            out.description = description;
          }
          if (typeof extensionName === 'string') {
            out.extensionName = extensionName;
          }
          return out;
        }),
        ...(clientCount !== undefined ? { clientCount } : {}),
        ...(clientBudget !== undefined ? { clientBudget } : {}),
        ...(budgetMode !== undefined ? { budgetMode } : {}),
        ...(budgetMode !== undefined
          ? {
              // PR 14 fix (review #4247 wenshao R2-#6): filter out
              // servers that are now config-disabled so the
              // workspace cell matches the per-server cell
              // precedence (`effectivelyRefused = refusedByBudget
              // && !disabled` above). Pre-fix a server disabled
              // after being refused would render `disabled` on its
              // per-server row but `error: budget_exhausted` on the
              // workspace row — confusing for dashboards. Use
              // `Array.from(refusedSet).filter(...)` to apply the
              // same disabled gate the per-server loop applies.
              budgets: this.buildBudgetCells(
                clientCount ?? 0,
                clientBudget,
                budgetMode,
                Array.from(refusedSet).filter(
                  (n) => !config.isMcpServerDisabled(n),
                ).length,
              ),
            }
          : {}),
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: true,
        servers: [],
        errors: [this.errorCell('mcp', error)],
      };
    }
  }

  /**
   * Build the MCP budget status cells exposed on `GET /workspace/mcp`
   * (PR 14). v1 emits one cell with `scope: 'session'` — each ACP
   * session has its own `McpClientManager`, so the budget enforces
   * per-session (snapshot reflects the bootstrap session's view).
   * Wave 5 PR 23 (shared MCP pool) will add `scope: 'workspace'`
   * for true per-workspace aggregation. Consumers MUST tolerate
   * additional entries with unrecognized scope values (drop, don't
   * fail).
   *
   * Cell `status` semantics:
   *   - `error`   — refusals happened this pass (only possible in enforce mode)
   *   - `warning` — live count crossed 75% of budget (warn or enforce mode)
   *   - `ok`      — under threshold (or `off` mode)
   *
   * **`liveCount` vs `reservedSlots.size` (PR 14 review #4247 R9 #5)**:
   * `liveCount` here is `accounting.total` — only `MCPServerStatus.CONNECTED`
   * clients. Enforcement (`tryReserveSlot`) on the other hand uses
   * `reservedSlots.size` — all reserved names, including in-flight
   * connects and never-connected stale entries. The two diverge when
   * servers hold a slot during the connect handshake or after a
   * connect failure that didn't release (e.g. `'already_held'`
   * reconnect timeouts). The snapshot intentionally uses the live
   * count for **operator observability** — "how many MCP clients
   * are actually serving requests right now" — while enforcement
   * uses the reservation count to prevent capacity races across
   * `Promise.all` microtask boundaries. PR 14b's typed events
   * should consider exposing both for real-time pressure signals.
   */
  private buildBudgetCells(
    liveCount: number,
    budget: number | undefined,
    mode: ServeMcpBudgetMode,
    refusedCount: number,
  ): ServeMcpBudgetStatusCell[] {
    // PR 14 fix (review #4247): when no `--mcp-client-budget` is
    // configured the manager resolves to `mode: 'off'`. The protocol
    // docs and SDK type comments promise `budgets: []` for that case;
    // a synthetic `mcp_budget` cell carrying nothing actionable was
    // (a) protocol-noncompliant, (b) clutter — clients iterating
    // `budgets[]` to render rows would draw an "ok" budget row for
    // uncapped workspaces. Always return empty so the top-level
    // `budgetMode: 'off'` field is the sole signal that guardrails
    // are inactive.
    if (mode === 'off') return [];
    let status: ServeStatus = 'ok';
    let errorKind: ServeErrorKind | undefined;
    let hint: string | undefined;
    if (refusedCount > 0) {
      status = 'error';
      errorKind = 'budget_exhausted';
      hint =
        'Raise --mcp-client-budget or remove servers from mcpServers config.';
    } else if (
      budget !== undefined &&
      budget > 0 &&
      liveCount >= MCP_BUDGET_WARN_FRACTION * budget
    ) {
      status = 'warning';
      hint = `Live MCP clients are above ${Math.round(
        MCP_BUDGET_WARN_FRACTION * 100,
      )}% of the configured budget.`;
    }
    const cell: ServeMcpBudgetStatusCell = {
      kind: 'mcp_budget',
      // PR 14 v1: per-session, not per-workspace. Each ACP session has
      // its own `Config`/`McpClientManager` (via `newSessionConfig`)
      // and reads `QWEN_SERVE_MCP_CLIENT_BUDGET` independently.
      // Snapshot shows the bootstrap session's view. Wave 5 PR 23
      // shared MCP pool will graduate this to `'workspace'`.
      scope: 'session',
      status,
      liveCount,
      mode,
      refusedCount,
    };
    if (budget !== undefined) cell.budget = budget;
    if (errorKind) cell.errorKind = errorKind;
    if (hint) cell.hint = hint;
    return [cell];
  }

  private errorCell(
    kind: string,
    error: unknown,
    errorKind?: ServeErrorKind,
  ): ServeStatusCell {
    const inferred = errorKind ?? mapDomainErrorToErrorKind(error);
    return {
      kind,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      ...(inferred ? { errorKind: inferred } : {}),
    };
  }

  private async buildWorkspaceSkillsStatus(
    config: Config,
  ): Promise<ServeWorkspaceSkillsStatus> {
    const skillManager = config.getSkillManager();
    if (!skillManager) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: [],
      };
    }

    try {
      const skills = await skillManager.listSkills();
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: skills.map((skill): ServeWorkspaceSkillStatus => {
          const modelInvocable = skill.disableModelInvocation !== true;
          return {
            kind: 'skill',
            status: modelInvocable ? 'ok' : 'disabled',
            name: skill.name,
            description: skill.description,
            level: skill.level,
            modelInvocable,
            ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
            ...(skill.model ? { model: skill.model } : {}),
            ...(skill.extensionName
              ? { extensionName: skill.extensionName }
              : {}),
          };
        }),
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: [],
        errors: [this.errorCell('skills', error)],
      };
    }
  }

  private buildWorkspaceProvidersStatus(
    config: Config,
  ): ServeWorkspaceProvidersStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const currentAuthType = config.getAuthType?.();
      const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
      const currentModelId = activeRuntimeSnapshot
        ? activeRuntimeSnapshot.id
        : (config.getModel() || '').trim();
      const hasCurrentModel = currentModelId.length > 0;
      const currentAuth = activeRuntimeSnapshot?.authType ?? currentAuthType;
      const currentAcpModelId =
        hasCurrentModel && currentAuth
          ? formatAcpModelId(currentModelId, currentAuth)
          : currentModelId || undefined;
      const providers = new Map<string, ServeWorkspaceProviderStatus>();

      for (const model of config.getAllConfiguredModels()) {
        const authType = String(model.authType);
        let provider = providers.get(authType);
        if (!provider) {
          provider = {
            kind: 'model_provider',
            status: 'ok',
            authType,
            current: false,
            models: [],
          };
          providers.set(authType, provider);
        }

        const effectiveModelId =
          model.isRuntimeModel && model.runtimeSnapshotId
            ? model.runtimeSnapshotId
            : model.id;
        const modelId = formatAcpModelId(effectiveModelId, model.authType);
        const isCurrent =
          currentAuth === model.authType &&
          hasCurrentModel &&
          (currentModelId === effectiveModelId ||
            currentModelId === model.id ||
            currentAcpModelId === modelId);
        const providerModel: ServeWorkspaceProviderModel = {
          modelId,
          baseModelId: parseAcpBaseModelId(effectiveModelId),
          name: model.label,
          ...(model.description !== undefined
            ? { description: model.description }
            : {}),
          contextLimit: model.contextWindowSize ?? tokenLimit(effectiveModelId),
          isCurrent,
          isRuntime: model.isRuntimeModel === true,
        };
        provider.models.push(providerModel);
        if (isCurrent) provider.current = true;
      }

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        ...(currentAuth || currentAcpModelId
          ? {
              current: {
                ...(currentAuth ? { authType: String(currentAuth) } : {}),
                ...(currentAcpModelId ? { modelId: currentAcpModelId } : {}),
              },
            }
          : {}),
        providers: [...providers.values()],
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: true,
        providers: [],
        errors: [this.errorCell('providers', error)],
      };
    }
  }

  private async buildAcpPreflightCells(
    config: Config,
  ): Promise<{ cells: ServePreflightCell[]; errors?: ServeStatusCell[] }> {
    // Drive emission order from the shared `ACP_PREFLIGHT_KINDS` constant
    // (also consumed by `createIdleAcpPreflightCells` in `serve/status.ts`)
    // so the idle-placeholder list and the live builder cannot drift —
    // adding a new ACP kind in the constant flags any builder dispatch
    // gap as a TS exhaustiveness error in the switch below, instead of
    // silently dropping the cell from one path or the other.
    const builders: Record<
      AcpPreflightKind,
      () => ServePreflightCell | Promise<ServePreflightCell>
    > = {
      auth: () => this.buildAuthPreflightCell(config),
      mcp_discovery: () => this.buildMcpDiscoveryPreflightCell(config),
      skills: () => this.buildSkillsPreflightCell(config),
      providers: () => this.buildProvidersPreflightCell(config),
      tool_registry: () => this.buildToolRegistryPreflightCell(config),
      egress: () => ({
        kind: 'egress',
        status: 'not_started',
        locality: 'acp',
        hint: 'egress probing lands in PR 14 (#4175)',
      }),
    };
    const cells: ServePreflightCell[] = [];
    for (const kind of ACP_PREFLIGHT_KINDS) {
      cells.push(await builders[kind]());
    }
    return { cells };
  }

  private acpCell(
    kind: ServePreflightKind,
    spec: Omit<ServePreflightCell, 'kind' | 'locality'>,
  ): ServePreflightCell {
    return { kind, locality: 'acp', ...spec };
  }

  /**
   * Pure auth preflight check. Looks up the well-known env var keys for the
   * configured auth method (via `AUTH_ENV_MAPPINGS`) and reports whether at
   * least one is present.
   *
   * Deliberately does NOT call `validateAuthMethod` from `cli/config/auth.ts`:
   * that helper has side effects (reloads `.env` from disk via
   * `loadEnvironment`, writes `process.env['GOOGLE_GENAI_USE_VERTEXAI']` for
   * Vertex auth) which would let a read-only `GET /workspace/preflight`
   * mutate daemon state and produce torn snapshots when racing
   * `GET /workspace/env`. Full validation still happens at session start.
   */
  private buildAuthPreflightCell(config: Config): ServePreflightCell {
    try {
      const authType = config.getAuthType?.();
      if (!authType) {
        return this.acpCell('auth', {
          status: 'warning',
          errorKind: 'auth_env_error',
          error: 'No auth method configured.',
          hint: 'Run `qwen` and complete the auth flow, or set a provider env var.',
          detail: { source: 'none', hasToken: false },
        });
      }
      const apiKeyVars = AUTH_PREFLIGHT_ENV_KEYS[String(authType)] ?? [];
      const presentVar = apiKeyVars.find((name: string) =>
        Boolean(process.env[name]),
      );
      const hasToken = Boolean(presentVar);
      // No env-var registration → either OAuth-style auth (qwen-oauth) or
      // a custom provider whose key is sourced from settings rather than
      // env. Surface as `unknown` (the SDK consumer can defer to the
      // `/session` boot for definitive validation) rather than a false
      // negative.
      if (apiKeyVars.length === 0) {
        return this.acpCell('auth', {
          status: 'unknown',
          hint: 'Auth credentials for this provider are not env-keyed; full validation runs at session start.',
          detail: {
            source: String(authType),
            hasToken: 'unknown',
            envVarCandidates: [],
          },
        });
      }
      return this.acpCell('auth', {
        status: hasToken ? 'ok' : 'warning',
        ...(hasToken
          ? {}
          : {
              errorKind: 'auth_env_error' as const,
              error: `None of the env vars [${apiKeyVars.join(', ')}] is set for authType '${String(authType)}'.`,
              hint: `Set one of: ${apiKeyVars.join(' / ')}.`,
            }),
        detail: {
          source: String(authType),
          hasToken,
          envVarCandidates: apiKeyVars,
          ...(presentVar ? { presentVar } : {}),
        },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'auth_env_error';
      return this.acpCell('auth', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildMcpDiscoveryPreflightCell(config: Config): ServePreflightCell {
    try {
      const discovery = this.discoveryState();
      const servers = config.getMcpServers() ?? {};
      const total = Object.keys(servers).length;
      // Today `MCPServerStatus` is `{CONNECTED, CONNECTING, DISCONNECTED}`,
      // but a future state (e.g. `ERROR`, `NEEDS_AUTH`) could be added.
      // Bucketing it as `disconnected` would silently lose the distinction
      // between "credential failed" and "idle, will spawn on demand".
      // Track an explicit `unknown` count so unrecognized states surface in
      // the cell `detail` rather than disappearing.
      const counts = {
        connected: 0,
        connecting: 0,
        disconnected: 0,
        unknown: 0,
      };
      for (const name of Object.keys(servers)) {
        const raw = getMCPServerStatus(name);
        switch (raw) {
          case MCPServerStatus.CONNECTED:
            counts.connected += 1;
            break;
          case MCPServerStatus.CONNECTING:
            counts.connecting += 1;
            break;
          case MCPServerStatus.DISCONNECTED:
            counts.disconnected += 1;
            break;
          default:
            counts.unknown += 1;
            break;
        }
      }
      const detail = { discoveryState: discovery, total, ...counts };

      if (total === 0) {
        return this.acpCell('mcp_discovery', {
          status: 'ok',
          detail,
          hint: 'No MCP servers configured.',
        });
      }
      if (counts.unknown > 0) {
        return this.acpCell('mcp_discovery', {
          status: 'warning',
          errorKind: 'protocol_error',
          error: `${counts.unknown}/${total} MCP server(s) in an unrecognized state.`,
          detail,
        });
      }
      if (counts.disconnected > 0 && discovery === 'completed') {
        return this.acpCell('mcp_discovery', {
          status: 'error',
          errorKind: 'protocol_error',
          error: `${counts.disconnected}/${total} MCP server(s) disconnected after discovery.`,
          detail,
        });
      }
      if (counts.connecting > 0 || discovery === 'in_progress') {
        // No `errorKind`: this is a normal transitional state (just-spawned
        // MCP servers haven't completed their handshake yet), not an
        // `init_timeout`. The latter would push SDK consumers to render
        // timeout-specific remediation ("increase init timeout") when the
        // correct user action is simply "wait or retry shortly". A real
        // timeout surfaces via `BridgeTimeoutError` from the bridge's
        // `withTimeout`, mapped through `mapDomainErrorToErrorKind`.
        return this.acpCell('mcp_discovery', {
          status: 'warning',
          error: `${counts.connecting}/${total} MCP server(s) still connecting.`,
          detail,
        });
      }
      return this.acpCell('mcp_discovery', { status: 'ok', detail });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err);
      return this.acpCell('mcp_discovery', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(errorKind ? { errorKind } : {}),
      });
    }
  }

  private async buildSkillsPreflightCell(
    config: Config,
  ): Promise<ServePreflightCell> {
    // Whole body wrapped in try so a Config getter that throws
    // synchronously (mock-style or future Config refactor) doesn't escape
    // out of `buildAcpPreflightCells` and 500 the whole envelope.
    try {
      const skillManager = config.getSkillManager();
      if (!skillManager) {
        return this.acpCell('skills', {
          status: 'disabled',
          // `disabled` here is the structural state — Config has no
          // SkillManager attached. That can mean the user opted out OR a
          // mis-config silently dropped the manager; preflight cannot
          // distinguish the two without settings introspection. Hint
          // surfaces the ambiguity so operators investigate when
          // unexpected.
          hint: 'No SkillManager attached to Config; verify settings if you expected skills to load.',
          detail: { configured: false },
        });
      }
      const skills = await skillManager.listSkills();
      return this.acpCell('skills', {
        status: 'ok',
        detail: { count: skills.length },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err);
      return this.acpCell('skills', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(errorKind ? { errorKind } : {}),
      });
    }
  }

  private buildProvidersPreflightCell(config: Config): ServePreflightCell {
    try {
      const models = config.getAllConfiguredModels();
      const authType = config.getAuthType?.();
      if (models.length === 0) {
        // `authType` set but zero models = the next `POST /session` will
        // fail. Report `error`, not `warning`: the daemon literally cannot
        // serve a prompt in this state.
        return this.acpCell('providers', {
          status: authType ? 'error' : 'disabled',
          ...(authType ? { errorKind: 'auth_env_error' } : {}),
          ...(authType
            ? {
                error: `No model configured for authType ${String(authType)}.`,
              }
            : {}),
          detail: { count: 0, authType: authType ? String(authType) : null },
        });
      }
      const authTypes = new Set(models.map((m) => String(m.authType)));
      return this.acpCell('providers', {
        status: 'ok',
        detail: {
          count: models.length,
          providers: [...authTypes],
        },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'auth_env_error';
      return this.acpCell('providers', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildToolRegistryPreflightCell(config: Config): ServePreflightCell {
    try {
      const registry = config.getToolRegistry();
      if (!registry) {
        return this.acpCell('tool_registry', {
          status: 'error',
          errorKind: 'protocol_error',
          error: 'Tool registry is not initialized.',
        });
      }
      const tools = registry.getAllTools();
      return this.acpCell('tool_registry', {
        status: 'ok',
        detail: { count: tools.length },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'protocol_error';
      return this.acpCell('tool_registry', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private sessionOrThrow(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }
    return session;
  }

  private buildSessionContextStatus(
    sessionId: string,
  ): ServeSessionContextStatus {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      workspaceCwd: this.workspaceCwd(config),
      state: {
        models: this.buildAvailableModels(config),
        modes: this.buildModesData(config),
        configOptions: this.buildConfigOptions(config),
      },
    };
  }

  private async buildSessionSupportedCommandsStatus(
    sessionId: string,
  ): Promise<ServeSessionSupportedCommandsStatus> {
    const session = this.sessionOrThrow(sessionId);
    const { availableCommands, availableSkills } =
      await buildAvailableCommandsSnapshot(session.getConfig());
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      availableCommands,
      availableSkills: availableSkills ?? [],
    };
  }

  private async installSkillFromUrl(
    request: QwenSkillInstallRequest,
  ): Promise<Record<string, unknown>> {
    const skillManager = this.config.getSkillManager();
    if (!skillManager) {
      throw RequestError.invalidParams(
        undefined,
        'SkillManager is not available',
      );
    }

    const download = await downloadSkill(request.sourceUrl);
    const skillsBaseDir = path.join(Storage.getGlobalQwenDir(), 'skills');
    const skillDir = resolveManagedSkillDir(skillsBaseDir, request.slug);
    const skillFile = path.join(skillDir, 'SKILL.md');
    const parsed = skillManager.parseSkillContent(
      download.skillContent,
      skillFile,
      'user',
    );
    if (parsed.name !== request.slug) {
      throw RequestError.invalidParams(
        undefined,
        `Skill name "${parsed.name}" does not match requested slug "${request.slug}"`,
      );
    }

    for (const file of download.files) {
      const targetPath = resolveSkillInstallPath(skillDir, file.relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, file.content);
    }
    await skillManager.refreshCache();

    return {
      id: request.id,
      slug: parsed.name,
      installed: true,
      installedPath: skillFile,
      sourceUrl: request.sourceUrl,
    };
  }

  private async deleteGlobalSkill(
    request: QwenSkillDeleteRequest,
  ): Promise<Record<string, unknown>> {
    const skillManager = this.config.getSkillManager();
    if (!skillManager) {
      throw RequestError.invalidParams(
        undefined,
        'SkillManager is not available',
      );
    }

    const { skillDir, skillFile, content } = await this.readManagedSkillFile(
      request.slug,
      'global',
      skillManager,
    );
    const parsed = skillManager.parseSkillContent(content, skillFile, 'user');
    if (parsed.name !== request.slug) {
      throw RequestError.invalidParams(
        undefined,
        `Skill name "${parsed.name}" does not match requested slug "${request.slug}"`,
      );
    }

    await fs.rm(skillDir, { recursive: true, force: true });
    await skillManager.refreshCache();
    return {
      slug: request.slug,
      deleted: true,
    };
  }

  private async readManagedSkillFile(
    slug: string,
    scope: QwenSkillSetEnabledRequest['scope'],
    skillManager: NonNullable<ReturnType<Config['getSkillManager']>>,
    cwd?: string,
  ): Promise<QwenManagedSkillFile> {
    if (scope === 'global') {
      const qwenSkillDir = resolveManagedSkillDir(
        path.join(Storage.getGlobalQwenDir(), 'skills'),
        slug,
      );
      const qwenSkillFile = path.join(qwenSkillDir, 'SKILL.md');
      const qwenContent = await fs
        .readFile(qwenSkillFile, 'utf8')
        .catch(() => undefined);
      if (qwenContent !== undefined) {
        return {
          skillDir: qwenSkillDir,
          skillFile: qwenSkillFile,
          content: qwenContent,
        };
      }
    }

    if (scope === 'project' && cwd?.trim()) {
      const projectSkill = await this.findProjectSkillFileFromCwd(
        slug,
        cwd,
        skillManager,
      );
      if (projectSkill) return projectSkill;
    }

    const level = scope === 'project' ? 'project' : 'user';
    const skill = (await skillManager.listSkills({ level })).find(
      (candidate) => candidate.name === slug,
    );
    const skillFile = skill?.filePath;
    if (!skillFile) {
      throw RequestError.invalidParams(
        undefined,
        `${scope === 'project' ? 'Project' : 'Global'} skill not found: ${slug}`,
      );
    }

    const content = await fs.readFile(skillFile, 'utf8').catch(() => {
      throw RequestError.invalidParams(
        undefined,
        `${scope === 'project' ? 'Project' : 'Global'} skill not found: ${slug}`,
      );
    });
    return {
      skillDir: path.dirname(skillFile),
      skillFile,
      content,
    };
  }

  private async findProjectSkillFileFromCwd(
    slug: string,
    cwd: string,
    skillManager: NonNullable<ReturnType<Config['getSkillManager']>>,
  ): Promise<QwenManagedSkillFile | undefined> {
    const projectRoot = path.resolve(cwd);
    for (const configDir of PROJECT_SKILL_DIRS) {
      const baseDir = path.join(projectRoot, configDir, SKILLS_DIR);
      const skills = await skillManager.loadSkillsFromDir(baseDir, 'project');
      const skill = skills.find((candidate) => candidate.name === slug);
      const skillFile = skill?.filePath;
      if (!skillFile) continue;

      const content = await fs.readFile(skillFile, 'utf8').catch(() => {
        throw RequestError.invalidParams(
          undefined,
          `Project skill not found: ${slug}`,
        );
      });
      return {
        skillDir: path.dirname(skillFile),
        skillFile,
        content,
      };
    }
    return undefined;
  }

  private async setGlobalSkillEnabled(
    request: QwenSkillSetEnabledRequest,
    cwd?: string,
  ): Promise<Record<string, unknown>> {
    const skillManager = this.config.getSkillManager();
    if (!skillManager) {
      throw RequestError.invalidParams(
        undefined,
        'SkillManager is not available',
      );
    }

    const { skillFile, content } = await this.readManagedSkillFile(
      request.slug,
      request.scope,
      skillManager,
      cwd,
    );
    const level = request.scope === 'project' ? 'project' : 'user';
    const parsed = skillManager.parseSkillContent(content, skillFile, level);
    if (parsed.name !== request.slug) {
      throw RequestError.invalidParams(
        undefined,
        `Skill name "${parsed.name}" does not match requested slug "${request.slug}"`,
      );
    }

    const nextContent = setSkillFrontmatterEnabled(content, request.enabled);
    skillManager.parseSkillContent(nextContent, skillFile, level);
    await fs.writeFile(skillFile, nextContent, 'utf8');
    await skillManager.refreshCache();
    return {
      slug: request.slug,
      enabled: request.enabled,
      installedPath: skillFile,
    };
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requestedCwd =
      typeof params['cwd'] === 'string' ? params['cwd'] : undefined;
    const cwd = requestedCwd || process.cwd();
    const SESSION_ID_RE = /^[0-9a-fA-F-]{32,36}$/;

    switch (method) {
      case 'qwen/providers/list': {
        return {
          providers: ALL_PROVIDERS.map((provider) =>
            serializeProviderConfig(provider, this.settings),
          ),
        };
      }
      case 'qwen/providers/connect': {
        const providerId = readRequiredString(
          params['providerId'],
          'providerId',
        );
        const providerConfig = findProviderById(providerId);
        if (!providerConfig) {
          throw RequestError.invalidParams(
            undefined,
            `Unknown provider: ${providerId}`,
          );
        }

        const inputs = readProviderSetupInputs(
          providerConfig,
          params,
          resolveExistingProviderApiKey(providerConfig, this.settings),
        );
        const persistScope = readProviderConnectScope(params['scope']);
        const plan = buildInstallPlan(providerConfig, inputs);
        await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(this.settings, persistScope),
          reloadModelProviders: (modelProviders) =>
            this.config.reloadModelProvidersConfig(modelProviders),
          syncAuthState: (authType, modelId) =>
            this.config
              .getModelsConfig()
              .syncAfterAuthRefresh(authType, modelId),
          refreshAuth: (authType) => this.config.refreshAuth(authType),
        });

        return {
          success: true,
          providerId: providerConfig.id,
          providerLabel: providerConfig.label,
          authType: plan.authType,
          modelId: plan.modelSelection?.modelId,
        };
      }
      case 'qwen/skills/install': {
        return this.installSkillFromUrl(readSkillInstallRequest(params));
      }
      case 'qwen/skills/delete': {
        return this.deleteGlobalSkill(readSkillSlugRequest(params));
      }
      case 'qwen/skills/setEnabled': {
        return this.setGlobalSkillEnabled(
          readSkillSetEnabledRequest(params),
          requestedCwd,
        );
      }
      case 'qwen/settings/getMemory': {
        return {
          settings: normalizeQwenMemorySettings(
            this.settings.user.settings.memory,
          ),
        };
      }
      case 'qwen/settings/setMemory': {
        const updates = toRecord(params['updates']);
        // Mutate a freshly loaded settings object and adopt it, mirroring the
        // other settings mutation handlers, instead of writing through the
        // possibly-stale cached `this.settings` and reading it back.
        const settings = loadSettings(cwd);
        for (const key of QWEN_MEMORY_SETTING_KEYS) {
          if (updates[key] === undefined) continue;
          if (typeof updates[key] !== 'boolean') {
            throw RequestError.invalidParams(
              undefined,
              `Invalid memory setting '${key}': expected boolean`,
            );
          }
          settings.setValue(SettingScope.User, `memory.${key}`, updates[key]);
        }
        this.settings = settings;
        return {
          settings: normalizeQwenMemorySettings(settings.user.settings.memory),
        };
      }
      case 'qwen/settings/getPath': {
        return { path: this.settings.user.path };
      }
      case 'qwen/settings/getMemoryPaths': {
        const projectRoot =
          typeof params['projectRoot'] === 'string'
            ? params['projectRoot']
            : cwd;
        return {
          paths: await resolveQwenMemoryPaths({ cwd, projectRoot }),
        };
      }
      case SERVE_STATUS_EXT_METHODS.workspaceMcp:
        return this.buildWorkspaceMcpStatus(this.config) as unknown as Record<
          string,
          unknown
        >;
      case SERVE_STATUS_EXT_METHODS.workspaceSkills:
        return (await this.buildWorkspaceSkillsStatus(
          this.config,
        )) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspaceProviders:
        return this.buildWorkspaceProvidersStatus(
          this.config,
        ) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspacePreflight:
        return (await this.buildAcpPreflightCells(
          this.config,
        )) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.sessionContext: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionContextStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.sessionSupportedCommands: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return (await this.buildSessionSupportedCommandsStatus(
          sessionId,
        )) as unknown as Record<string, unknown>;
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart: {
        // #4175 Wave 4 PR 17. Single-server MCP restart with budget
        // pre-check from PR 14 v1's accounting snapshot. Soft skips
        // (in_flight, disabled, budget_would_exceed) come back as
        // structured 200 responses; hard errors (server not in
        // config, manager unavailable, post-discover not connected)
        // propagate as JSON-RPC errors with structured `data` that
        // the bridge translates to typed HTTP responses.
        const serverName = params['serverName'];
        if (typeof serverName !== 'string' || serverName.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing serverName',
          );
        }
        const servers = this.config.getMcpServers() ?? {};
        if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
          // #4282 gpt-5.5 C5 fold-in: the bridge looks for
          // `data.errorKind: 'mcp_server_not_found'` to map this back
          // to a typed `McpServerNotFoundError` and a stable HTTP 404
          // — without the structured payload the bridge can't
          // distinguish this from a generic JSON-RPC error and the
          // route falls through to 500.
          throw new RequestError(
            -32004,
            `MCP server not configured: ${JSON.stringify(serverName)}`,
            { errorKind: 'mcp_server_not_found', serverName },
          );
        }
        if (this.config.isMcpServerDisabled(serverName)) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'disabled' as const,
          };
        }
        const manager = this.config.getToolRegistry()?.getMcpClientManager();
        if (!manager) {
          throw RequestError.internalError(
            undefined,
            'McpClientManager unavailable on this Config',
          );
        }
        if (manager.isServerDiscovering(serverName)) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'in_flight' as const,
          };
        }
        const accounting = manager.getMcpClientAccounting();
        const budget = manager.getMcpClientBudget();
        const mode = manager.getMcpBudgetMode();
        // #4282 gpt-5.5 C3 fold-in: enforce-mode capacity is reserved
        // by `tryReserveSlot` via `reservedSlots` (which counts
        // configured + in-flight + disconnected slot holders), not by
        // `total` (which only counts CONNECTED clients). Comparing
        // `total` to budget under-counted reservations and let a
        // restart proceed past capacity; the manager would then
        // refuse internally and return void, while this handler
        // reported `restarted: true`. Mirror the manager's policy
        // by checking `reservedSlots.length` for servers that don't
        // already hold a reservation.
        if (
          mode === 'enforce' &&
          budget !== undefined &&
          !accounting.reservedSlots.includes(serverName) &&
          accounting.reservedSlots.length >= budget
        ) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'budget_would_exceed' as const,
          };
        }
        const start = Date.now();
        await manager.discoverMcpToolsForServer(serverName, this.config);
        // #4282 gpt-5.5 C4 fold-in: `discoverMcpToolsForServer`
        // catches reconnect/discovery errors internally (logs and
        // resolves void) so a broken MCP server would otherwise
        // surface as `restarted: true`. Verify the live status from
        // the per-server status map; anything other than CONNECTED
        // means the restart didn't take effect.
        const postStatus = getMCPServerStatus(serverName);
        if (postStatus !== MCPServerStatus.CONNECTED) {
          throw new RequestError(
            -32099,
            `MCP server ${JSON.stringify(serverName)} did not reach a ` +
              `connected state after restart (status: ${postStatus}).`,
            {
              errorKind: 'mcp_restart_failed',
              serverName,
              mcpStatus: postStatus,
            },
          );
        }
        return {
          serverName,
          restarted: true,
          durationMs: Date.now() - start,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionApprovalMode: {
        // #4175 Wave 4 PR 17: remote callers change a live session's
        // approval mode via this ACP extMethod. `Config.setApprovalMode`
        // throws `TrustGateError` for privileged modes in an untrusted
        // folder; we let it propagate — the bridge's mapping helper
        // converts the name to `errorKind: 'auth_env_error'` on the
        // wire so the SDK consumer gets a structured failure.
        const sessionId = params['sessionId'];
        const mode = params['mode'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          typeof mode !== 'string' ||
          !APPROVAL_MODES.includes(mode as ApprovalMode)
        ) {
          throw RequestError.invalidParams(
            undefined,
            `Invalid approval mode; allowed: ${APPROVAL_MODES.join(', ')}`,
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const previous = config.getApprovalMode();
        try {
          config.setApprovalMode(mode as ApprovalMode);
        } catch (err) {
          // `TrustGateError` is the core's structured rejection for
          // untrusted-folder + privileged-mode. We re-raise it as a
          // JSON-RPC error whose `data.errorKind` is the literal the
          // bridge looks for to reconstruct a typed `TrustGateError` on
          // the daemon side (JSON-RPC strips the class name across the
          // wire). Other errors propagate unchanged.
          if (err instanceof Error && err.name === 'TrustGateError') {
            throw new RequestError(-32003, err.message, {
              errorKind: 'trust_gate',
            });
          }
          throw err;
        }
        const current = config.getApprovalMode();
        return { previous, current };
      }
      case 'deleteSession': {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const success = await runWithAcpRuntimeOutputDir(
          this.settings,
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.removeSession(sessionId);
          },
        );
        return { success };
      }
      case 'renameSession': {
        const sessionId = params['sessionId'] as string;
        const title = params['title'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (!title || typeof title !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing title',
          );
        }
        if (title.length > SESSION_TITLE_MAX_LENGTH) {
          throw RequestError.invalidParams(
            undefined,
            `Title too long (max ${SESSION_TITLE_MAX_LENGTH} chars)`,
          );
        }
        // When the target session is currently live in this process, route
        // through its ChatRecordingService so the in-memory `currentCustomTitle`
        // stays in sync. Writing directly to disk via SessionService here
        // would leave the live recording's cache stale; the next title
        // re-anchor (every 32KB of writes) or finalize() would re-emit the
        // old title and silently revert the rename. The disk-only path
        // remains for the dead-session case (e.g., another client renaming
        // a session that isn't active in this process).
        const liveRecording = this.sessions
          .get(sessionId)
          ?.getConfig()
          .getChatRecordingService();
        if (liveRecording) {
          const ok = liveRecording.recordCustomTitle(title, 'manual');
          await liveRecording.flush();
          return { success: ok };
        }
        const success = await runWithAcpRuntimeOutputDir(
          this.settings,
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.renameSession(sessionId, title);
          },
        );
        return { success };
      }
      case 'rewindSession': {
        const sessionId = params['sessionId'] as string;
        const targetTurnIndex = params['targetTurnIndex'];
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          !Number.isInteger(targetTurnIndex) ||
          (targetTurnIndex as number) < 0
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing targetTurnIndex',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        const historyBeforeRewind = session.captureHistorySnapshot();
        return {
          success: true,
          historyBeforeRewind,
          ...session.rewindToTurn(targetTurnIndex as number),
        };
      }
      case 'qwen/session/loadUpdates': {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }

        const sessionData = await runWithAcpRuntimeOutputDir(
          this.settings,
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.loadSession(sessionId);
          },
        );
        if (!sessionData?.conversation) {
          return { updates: [] };
        }

        const updates: SessionUpdate[] = [];
        const replayContext: SessionContext = {
          sessionId,
          config: this.config,
          sendUpdate: async (update) => {
            updates.push(update);
          },
        };
        try {
          await new HistoryReplayer(replayContext).replay(
            sessionData.conversation.messages,
          );
        } catch (error) {
          debugLogger.warn(
            '[loadUpdates] History replay failed for session %s (partial updates: %d):',
            sessionId,
            updates.length,
            error,
          );
        }
        const updatesWithTopLevelTimestamps = updates.map((update) => {
          const record = update as Record<string, unknown>;
          const meta = record['_meta'];
          const timestamp =
            meta && typeof meta === 'object' && !Array.isArray(meta)
              ? (meta as Record<string, unknown>)['timestamp']
              : undefined;
          return typeof timestamp === 'number' || typeof timestamp === 'string'
            ? { ...record, timestamp }
            : record;
        });

        return {
          updates: updatesWithTopLevelTimestamps,
          startTime: sessionData.conversation.startTime,
          lastUpdated: sessionData.conversation.lastUpdated,
        };
      }
      case 'restoreSessionHistory': {
        const sessionId = params['sessionId'] as string;
        const history = params['history'];
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (!Array.isArray(history)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing history',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        session.restoreHistory(history as Content[]);
        return { success: true };
      }
      case 'getAccountInfo': {
        const sessionId = params['sessionId'] as string | undefined;
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        const config = session ? session.getConfig() : this.config;
        const cfg = config.getContentGeneratorConfig();
        return {
          authType: cfg?.authType ?? config.getAuthType() ?? null,
          model: cfg?.model ?? config.getModel() ?? null,
          baseUrl: cfg?.baseUrl ?? null,
          apiKeyEnvKey: cfg?.apiKeyEnvKey ?? null,
        };
      }
      case 'qwen/settings/getCore': {
        const settings = loadSettings(cwd);
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/setCoreValue': {
        const key = params['key'];
        if (
          typeof key !== 'string' ||
          !QWEN_CORE_SETTING_KEYS.includes(key as QwenCoreSettingKey)
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Unsupported Qwen setting key',
          );
        }
        const settings = loadSettings(cwd);
        const settingKey = key as QwenCoreSettingKey;
        const normalizedValue = normalizeCoreSettingValue(
          settingKey,
          params['value'],
        );
        settings.setValue(
          toSettingsScope(params['scope']),
          key,
          normalizedValue,
        );
        if (
          settingKey === 'general.outputLanguage' &&
          typeof normalizedValue === 'string'
        ) {
          updateOutputLanguageFile(normalizedValue);
        }
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/setMcpServer': {
        const name = params['name'];
        if (typeof name !== 'string' || !name.trim()) {
          throw RequestError.invalidParams(
            undefined,
            'MCP server name is required',
          );
        }
        const settings = loadSettings(cwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const mcpServers = {
          ...toRecord(existing['mcpServers']),
          [name.trim()]: toStoredMcpServerConfig(
            normalizeMcpServerConfig(params['server']),
          ),
        };
        settings.setValue(settingScope, 'mcpServers', mcpServers);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/removeMcpServer': {
        const name = params['name'];
        if (typeof name !== 'string' || !name.trim()) {
          throw RequestError.invalidParams(
            undefined,
            'MCP server name is required',
          );
        }
        const settings = loadSettings(cwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const mcpServers = { ...toRecord(existing['mcpServers']) };
        delete mcpServers[name.trim()];
        settings.setValue(settingScope, 'mcpServers', mcpServers);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/setHook': {
        const event = params['event'];
        if (!isHookEvent(event)) {
          throw RequestError.invalidParams(undefined, 'Invalid hook event');
        }
        const settings = loadSettings(cwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const hooksRoot = { ...toRecord(existing['hooks']) };
        const eventHooks = Array.isArray(hooksRoot[event])
          ? [...(hooksRoot[event] as unknown[])]
          : [];
        const hook = normalizeHookDefinition(params['hook']);
        const index = params['index'];
        // Only replace when the index points at an existing entry. An
        // out-of-range index would create sparse-array holes that serialize to
        // `null` in settings.json and corrupt hook loading, so treat it (and a
        // missing/negative index) as an append.
        if (
          typeof index === 'number' &&
          index >= 0 &&
          index < eventHooks.length
        ) {
          eventHooks[index] = hook;
        } else {
          eventHooks.push(hook);
        }
        hooksRoot[event] = eventHooks;
        settings.setValue(settingScope, 'hooks', hooksRoot);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/removeHook': {
        const event = params['event'];
        if (!isHookEvent(event)) {
          throw RequestError.invalidParams(undefined, 'Invalid hook event');
        }
        const index = params['index'];
        if (typeof index !== 'number' || index < 0) {
          throw RequestError.invalidParams(undefined, 'Invalid hook index');
        }
        const settings = loadSettings(cwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const hooksRoot = { ...toRecord(existing['hooks']) };
        const eventHooks = Array.isArray(hooksRoot[event])
          ? [...(hooksRoot[event] as unknown[])]
          : [];
        eventHooks.splice(index, 1);
        hooksRoot[event] = eventHooks;
        settings.setValue(settingScope, 'hooks', hooksRoot);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/settings/setExtensionSetting': {
        const extensionId = params['extensionId'];
        const settingKey = params['settingKey'];
        const value = params['value'];
        if (typeof extensionId !== 'string' || !extensionId) {
          throw RequestError.invalidParams(
            undefined,
            'extensionId is required',
          );
        }
        if (typeof settingKey !== 'string' || !settingKey) {
          throw RequestError.invalidParams(undefined, 'settingKey is required');
        }
        if (typeof value !== 'string') {
          throw RequestError.invalidParams(undefined, 'value must be a string');
        }
        const settings = loadSettings(cwd);
        const extensionManager = new ExtensionManager({
          workspaceDir: cwd,
          isWorkspaceTrusted: !!isWorkspaceTrusted(settings.merged),
        });
        await extensionManager.refreshCache();
        const extension = extensionManager
          .getLoadedExtensions()
          .find((item) => item.id === extensionId || item.name === extensionId);
        if (!extension) {
          throw RequestError.invalidParams(undefined, 'Extension not found');
        }
        const extScope =
          toSettingsScope(params['scope']) === SettingScope.Workspace
            ? ExtensionSettingScope.WORKSPACE
            : ExtensionSettingScope.USER;
        await updateSetting(
          extension.config,
          extension.id,
          settingKey,
          async () => value,
          extScope,
        );
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.settings = settings;
        return this.buildCoreSettings(settings, cwd);
      }
      case 'qwen/permissions/getSettings': {
        const settings = this.loadPermissionSettings(cwd);
        return this.buildPermissionSettings(settings) as unknown as Record<
          string,
          unknown
        >;
      }
      case 'qwen/permissions/setRules': {
        const scope = params['scope'];
        const ruleType = params['ruleType'];
        if (scope !== 'user' && scope !== 'workspace') {
          throw RequestError.invalidParams(
            undefined,
            'scope must be "user" or "workspace"',
          );
        }
        if (ruleType !== 'allow' && ruleType !== 'ask' && ruleType !== 'deny') {
          throw RequestError.invalidParams(
            undefined,
            'ruleType must be "allow", "ask", or "deny"',
          );
        }

        const beforeSettings = this.loadPermissionSettings(cwd);
        const before = readPermissionRuleSet(beforeSettings.merged);
        const rules = normalizePermissionRules(params['rules']);
        const settingScope =
          scope === 'workspace' ? SettingScope.Workspace : SettingScope.User;

        beforeSettings.setValue(settingScope, `permissions.${ruleType}`, rules);
        const afterSettings = this.loadPermissionSettings(cwd);
        const after = readPermissionRuleSet(afterSettings.merged);
        this.syncLivePermissionManagers(before, after);
        return this.buildPermissionSettings(afterSettings) as unknown as Record<
          string,
          unknown
        >;
      }
      default:
        throw RequestError.methodNotFound(method);
    }
  }

  // --- private helpers ---

  private async newSessionConfig(
    cwd: string,
    mcpServers: McpServer[],
    sessionId?: string,
    resume?: boolean,
  ): Promise<Config> {
    this.settings = loadSettings(cwd);
    const mergedMcpServers = { ...this.settings.merged.mcpServers };

    for (const server of mcpServers) {
      const stdioServer = toStdioServer(server);
      if (stdioServer) {
        const env: Record<string, string> = {};
        for (const { name: envName, value } of stdioServer.env) {
          env[envName] = value;
        }
        mergedMcpServers[stdioServer.name] = new MCPServerConfig(
          stdioServer.command,
          stdioServer.args,
          env,
          cwd,
        );
        continue;
      }

      const sseServer = toSseServer(server);
      if (sseServer) {
        const headers: Record<string, string> = {};
        for (const { name: headerName, value } of sseServer.headers) {
          headers[headerName] = value;
        }
        mergedMcpServers[sseServer.name] = new MCPServerConfig(
          undefined,
          undefined,
          undefined,
          undefined,
          sseServer.url,
          undefined,
          Object.keys(headers).length > 0 ? headers : undefined,
        );
        continue;
      }

      const httpServer = toHttpServer(server);
      if (httpServer) {
        const headers: Record<string, string> = {};
        for (const { name: headerName, value } of httpServer.headers) {
          headers[headerName] = value;
        }
        mergedMcpServers[httpServer.name] = new MCPServerConfig(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          httpServer.url,
          Object.keys(headers).length > 0 ? headers : undefined,
        );
        continue;
      }
    }

    const settings = { ...this.settings.merged, mcpServers: mergedMcpServers };
    const argvForSession = {
      ...this.argv,
      ...(resume ? { resume: sessionId } : { sessionId }),
      continue: false,
    };

    const config = await loadCliConfig(
      settings,
      argvForSession,
      cwd,
      [],
      // Pass separated hooks for proper source attribution
      {
        userHooks: this.settings.getUserHooks(),
        projectHooks: this.settings.getProjectHooks(),
      },
    );
    // PR 14b fix #2 (codex review round 1): register the MCP guardrail
    // budget-event callback BEFORE `config.initialize()`. Pre-fix the
    // registration ran AFTER initialize, which (a) missed end-of-pass
    // events under `QWEN_CODE_LEGACY_MCP_BLOCKING=1` (synchronous
    // discovery completes inside initialize, before our setter runs)
    // and (b) raced against background-discovery completion under the
    // default progressive mode. `Config.setMcpBudgetEventCallback`
    // stashes the callback and `createToolRegistry` applies it to the
    // manager BEFORE `discoverAllTools` / `startMcpDiscoveryInBackground`
    // fires, closing both windows.
    //
    // sessionId source: `config.getSessionId()` reads the Config's own
    // session id (auto-assigned via `randomUUID()` in the Config
    // constructor when no override is passed — see `config.ts:849`),
    // so the value is available immediately after `loadCliConfig`
    // returns. The closure pins it for the manager's whole lifetime.
    //
    // Defensive `typeof` checks tolerate stub Configs / ToolRegistries
    // in older tests (older fixtures may omit `setMcpBudgetEventCallback`
    // or `getSessionId`).
    const wiredSessionId =
      typeof config.getSessionId === 'function'
        ? config.getSessionId()
        : undefined;
    if (
      typeof config.setMcpBudgetEventCallback === 'function' &&
      wiredSessionId !== undefined
    ) {
      const sid = wiredSessionId;
      config.setMcpBudgetEventCallback((event) => {
        // Fire-and-forget: `extNotification` returns Promise<void> but
        // the manager's call site doesn't await. `.catch` suppresses
        // unhandled rejections — a mid-flight ACP disconnect would
        // otherwise crash the child. Snapshot still carries the state
        // for clients that reconnect.
        //
        // PR 14b fix (codex round 3 — DeepSeek): pre-fix the catch
        // handler was `() => {}`, silently dropping every error
        // including "real" ones (serialization bugs, protocol
        // violations) — operators had no debug trail. Now logs at
        // `debug` level: ACP channel closure during shutdown is the
        // expected case and would spam at higher levels, but `debug`
        // is opt-in so when an oncall engineer DOES turn it on for
        // an MCP guardrail incident, they see exactly which event
        // dropped and why.
        void this.connection
          .extNotification('qwen/notify/session/mcp-budget-event', {
            v: 1,
            sessionId: sid,
            ...event,
          })
          .catch((err: unknown) => {
            debugLogger.debug(
              `MCP budget extNotification dropped ` +
                `(session=${sid}, kind=${event.kind}): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          });
      });
    }
    await config.initialize();
    // Same reasoning as the top-level runAcpAgent path: ACP feeds session
    // messages to the model immediately, so we cannot return a Config whose
    // MCP discovery is still in flight.
    await config.waitForMcpReady();
    // Surface MCP failures to stderr — mirrors `runAcpAgent` (lines 95-107)
    // and the other non-interactive entry points (`gemini.tsx`,
    // `session.ts`). Without this, per-session ACP configs that lose MCP
    // servers fall back to built-in-tools-only with no user-visible
    // indication. Defensive against tests that pass a stubbed Config
    // without `getFailedMcpServerNames`.
    const failedMcpServers =
      typeof config.getFailedMcpServerNames === 'function'
        ? config.getFailedMcpServerNames()
        : [];
    if (failedMcpServers.length > 0) {
      process.stderr.write(
        `Warning: MCP server(s) failed to start: ${failedMcpServers.join(', ')}. ` +
          `Continuing with built-in tools and any servers that did connect.\n`,
      );
    }
    return config;
  }

  private async ensureAuthenticated(config: Config): Promise<void> {
    const selectedType = config.getModelsConfig().getCurrentAuthType();
    if (!selectedType) {
      throw RequestError.authRequired(
        { authMethods: pickAuthMethodsForAuthRequired() },
        'Use Qwen Code CLI to authenticate first.',
      );
    }

    try {
      await config.refreshAuth(selectedType, true);
    } catch (e) {
      debugLogger.error(`Authentication failed: ${e}`);
      throw RequestError.authRequired(
        {
          authMethods: pickAuthMethodsForAuthRequired(selectedType),
        },
        'Authentication failed: ' + (e as Error).message,
      );
    }
  }

  private setupFileSystem(config: Config): void {
    if (!this.clientCapabilities?.fs) return;

    const acpFileSystemService = new AcpFileSystemService(
      this.connection,
      config.getSessionId(),
      this.clientCapabilities.fs,
      config.getFileSystemService(),
    );
    config.setFileSystemService(acpFileSystemService);
  }

  private async createAndStoreSession(
    config: Config,
    conversation?: ConversationRecord,
  ): Promise<Session> {
    const sessionId = config.getSessionId();
    const geminiClient = config.getGeminiClient();
    const needsInitialize = !geminiClient.isInitialized();

    if (needsInitialize) {
      await geminiClient.initialize();
    }

    const session = new Session(
      sessionId,
      config,
      this.connection,
      this.settings,
    );
    this.sessions.set(sessionId, session);

    setTimeout(async () => {
      await session.sendAvailableCommandsUpdate();
    }, 0);

    if (conversation && conversation.messages) {
      await session.replayHistory(conversation.messages);
    }

    // Install rewriter AFTER history replay to avoid rewriting historical messages
    session.installRewriter();

    return session;
  }

  private buildAvailableModels(config: Config): NewSessionResponse['models'] {
    const rawCurrentModelId = (
      config.getModel() ||
      this.config.getModel() ||
      ''
    ).trim();
    const currentAuthType = config.getAuthType();
    const allConfiguredModels = config.getAllConfiguredModels();

    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = activeRuntimeSnapshot
      ? formatAcpModelId(
          activeRuntimeSnapshot.id,
          activeRuntimeSnapshot.authType,
        )
      : this.formatCurrentModelId(rawCurrentModelId, currentAuthType);

    const mappedAvailableModels = allConfiguredModels.map((model) => {
      const effectiveModelId =
        model.isRuntimeModel && model.runtimeSnapshotId
          ? model.runtimeSnapshotId
          : model.id;

      return {
        modelId: formatAcpModelId(effectiveModelId, model.authType),
        name: model.label,
        description: model.description ?? null,
        _meta: {
          contextLimit: model.contextWindowSize ?? tokenLimit(model.id),
        },
      };
    });

    return {
      currentModelId,
      availableModels: mappedAvailableModels,
    };
  }

  private buildModesData(config: Config): SessionModeState {
    const currentApprovalMode = config.getApprovalMode();

    const availableModes = APPROVAL_MODES.map((mode) => ({
      id: mode as ApprovalModeValue,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    return {
      currentModeId: currentApprovalMode as ApprovalModeValue,
      availableModes,
    };
  }

  private buildConfigOptions(config: Config): SessionConfigOption[] {
    const currentApprovalMode = config.getApprovalMode();
    const allConfiguredModels = config.getAllConfiguredModels();
    const rawCurrentModelId = (config.getModel() || '').trim();
    const currentAuthType = config.getAuthType?.();

    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = activeRuntimeSnapshot
      ? formatAcpModelId(
          activeRuntimeSnapshot.id,
          activeRuntimeSnapshot.authType,
        )
      : this.formatCurrentModelId(rawCurrentModelId, currentAuthType);

    const modeOptions = APPROVAL_MODES.map((mode) => ({
      value: mode,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    const modeConfigOption: SessionConfigOption = {
      id: 'mode',
      name: 'Mode',
      description: 'Session permission mode',
      category: 'mode',
      type: 'select' as const,
      currentValue: currentApprovalMode,
      options: modeOptions,
    };

    const modelOptions = allConfiguredModels.map((model) => {
      const effectiveModelId =
        model.isRuntimeModel && model.runtimeSnapshotId
          ? model.runtimeSnapshotId
          : model.id;
      return {
        value: formatAcpModelId(effectiveModelId, model.authType),
        name: model.label,
        description: model.description ?? '',
      };
    });

    const modelConfigOption: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select' as const,
      currentValue: currentModelId,
      options: modelOptions,
    };

    return [modeConfigOption, modelConfigOption];
  }

  private formatCurrentModelId(
    baseModelId: string,
    authType?: AuthType,
  ): string {
    if (!baseModelId) return baseModelId;
    return authType ? formatAcpModelId(baseModelId, authType) : baseModelId;
  }
}
