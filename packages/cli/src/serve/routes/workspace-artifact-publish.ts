/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { platform as hostPlatform } from 'node:os';
import { promisify } from 'node:util';
import type { Application, Request, RequestHandler, Response } from 'express';
import {
  HostPublisher,
  Storage,
  artifactIdFromPath,
  tokenizeCommand,
  type ArtifactHostConfig,
} from '@qwen-code/qwen-code-core';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { getNpmCliPath } from '../../utils/installationInfo.js';
import { getNestedProperty } from '../../config/settingsUtils.js';
import type { SendBridgeError } from '../server/error-response.js';
import {
  MAX_READ_BYTES,
  isFsError,
  type ResolvedPath,
  type WorkspaceFileSystem,
} from '../fs/index.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';
import { applyReadHeaders, sendFsError } from './workspace-file-read.js';

const execFileAsync = promisify(execFile);
const MAX_PUBLISH_BYTES = 16 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 60_000;
const ACCESS_TIMEOUT_MS = 30_000;
const PUBLIC_URL_ATTEMPT_TIMEOUT_MS = 2_000;
const PUBLIC_URL_RETRY_DELAYS_MS = [0, 1_000, 3_000, 6_000, 10_000];
const PROJECT_CONFIRM_RETRY_DELAYS_MS = [0, 500, 1_500, 3_000];
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PUBLISH_TIMEOUT_MS = 5 * 60_000;
const LOGIN_TICKET_TTL_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_LOGIN_TICKETS = 32;
const MAX_PUBLICATION_RECORDS = 50;

const PROVIDERS = ['cloudflare', 'vercel', 'netlify'] as const;
type ProviderKind = (typeof PROVIDERS)[number];

interface ProviderStatus {
  kind: ProviderKind;
  configured: boolean;
  unavailableReason?: string;
}

interface PublicationRecord {
  provider: ProviderKind;
  targetId: string;
  artifactId: string;
  contentHash: string;
  publishedId: string;
  url: string;
  publishedAt: string;
}

interface PublicationStatus {
  provider: ProviderKind;
  id: string;
  url: string;
  publishedAt: string;
  upToDate: boolean;
}

interface ShareSettings {
  enabled: boolean;
  publications: PublicationRecord[];
  host: ArtifactHostConfig;
  cloudflare: {
    accountId: string;
    projectName: string;
  };
  vercel: {
    projectId: string;
    projectName: string;
    scope: string;
  };
  netlify: {
    siteId: string;
  };
}

interface NetlifySite {
  id: string;
  name: string;
  url?: string;
  accountName?: string;
}

interface NetlifySetupStatus {
  stage: 'install' | 'authenticate' | 'connect' | 'ready';
  cliInstalled: boolean;
  authenticated: boolean;
  linked: boolean;
  configured: boolean;
  authorizationPending?: boolean;
  linkedSite?: NetlifySite;
  sites?: NetlifySite[];
}

interface LoginTicket {
  id: string;
  url: string;
  expiresAt: number;
}

interface NetlifyCommand {
  file: string;
  prefixArgs: string[];
}

type ProviderCommand = NetlifyCommand;

interface ProviderProject {
  id: string;
  name: string;
  url?: string;
  accountName?: string;
}

interface ProviderSetupStatus {
  provider: ProviderKind;
  stage: 'install' | 'authenticate' | 'connect' | 'ready';
  cliInstalled: boolean;
  authenticated: boolean;
  linked: boolean;
  configured: boolean;
  authorizationPending?: boolean;
  project?: ProviderProject;
  accounts?: ProviderProject[];
}

interface CommandOptions {
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type ArtifactRouteCommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<string>;

type MutationGate = (opts?: { strict?: boolean }) => RequestHandler;

type PersistSettings = (
  workspace: string,
  writes: Array<{
    scope: SettingScope;
    key: string;
    value: unknown;
  }>,
  assertGenerationOpen?: () => void,
) => Promise<void>;

interface ArtifactPublishRouteDeps {
  sendBridgeError: SendBridgeError;
  mutate: MutationGate;
  persistSettings?: PersistSettings;
  runCommand?: ArtifactRouteCommandRunner;
  platform?: NodeJS.Platform;
  checkPublicUrl?: (url: string) => Promise<boolean>;
  waitForPublicUrlRetry?: (delayMs: number) => Promise<void>;
  operationSignal?: AbortSignal;
}

class SetupError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const loginTickets = new Map<string, LoginTicket>();
const publishQueues = new Map<string, Promise<unknown>>();
let setupQueue: Promise<unknown> = Promise.resolve();

export function resetArtifactNetlifySetupStateForTesting(): void {
  loginTickets.clear();
  publishQueues.clear();
  setupQueue = Promise.resolve();
}

function withSetupLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = setupQueue.then(operation, operation);
  setupQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withPublishLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = publishQueues.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  publishQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (publishQueues.get(key) === tail) publishQueues.delete(key);
  }
}

function activeLoginTicket(workspaceCwd: string): LoginTicket | undefined {
  const now = Date.now();
  for (const [workspace, ticket] of loginTickets) {
    if (ticket.expiresAt <= now) loginTickets.delete(workspace);
  }
  return loginTickets.get(workspaceCwd);
}

function rememberLoginTicket(workspaceCwd: string, ticket: LoginTicket): void {
  activeLoginTicket(workspaceCwd);
  while (loginTickets.size >= MAX_LOGIN_TICKETS) {
    const oldest = loginTickets.keys().next().value as string | undefined;
    if (!oldest) break;
    loginTickets.delete(oldest);
  }
  loginTickets.set(workspaceCwd, ticket);
}

async function defaultRunCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: { ...options.env },
    signal: options.signal,
    timeout: options.timeoutMs,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function commandRunner(
  deps: ArtifactPublishRouteDeps,
): ArtifactRouteCommandRunner {
  return deps.runCommand ?? defaultRunCommand;
}

function requestAbortScope(
  req: Request,
  res: Response,
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  const abortClosedResponse = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once('aborted', abortRequest);
  res.once('close', abortClosedResponse);
  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', abortRequest);
      res.off('close', abortClosedResponse);
    },
  };
}

function withCommandSignal(
  deps: ArtifactPublishRouteDeps,
  signal: AbortSignal,
): ArtifactPublishRouteDeps {
  const run = commandRunner(deps);
  return {
    ...deps,
    operationSignal: signal,
    runCommand: (command, args, options) =>
      run(command, args, {
        ...options,
        signal: options.signal ?? signal,
      }),
  };
}

function artifactCliNpmCache(): string {
  return path.join(Storage.getGlobalQwenDir(), 'artifact-hosting', 'npm-cache');
}

function artifactCliToolPrefix(): string {
  return path.join(Storage.getGlobalQwenDir(), 'artifact-hosting', 'tools');
}

function publicationRecords(value: unknown): PublicationRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      const provider = record['provider'];
      const targetId = record['targetId'];
      const artifactId = record['artifactId'];
      const contentHash = record['contentHash'];
      const publishedId = record['publishedId'];
      const url = record['url'];
      const publishedAt = record['publishedAt'];
      if (
        !PROVIDERS.includes(provider as ProviderKind) ||
        typeof targetId !== 'string' ||
        !targetId ||
        targetId.length > 256 ||
        typeof artifactId !== 'string' ||
        !artifactId ||
        artifactId.length > 128 ||
        typeof contentHash !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(contentHash) ||
        typeof publishedId !== 'string' ||
        !publishedId ||
        publishedId.length > 256 ||
        typeof url !== 'string' ||
        url.length > 2_048 ||
        typeof publishedAt !== 'string' ||
        publishedAt.length > 64 ||
        !Number.isFinite(Date.parse(publishedAt))
      ) {
        return [];
      }
      try {
        const parsedUrl = new URL(url);
        if (
          parsedUrl.protocol !== 'https:' ||
          parsedUrl.username ||
          parsedUrl.password
        ) {
          return [];
        }
      } catch {
        return [];
      }
      return [
        {
          provider: provider as ProviderKind,
          targetId,
          artifactId,
          contentHash: contentHash.toLowerCase(),
          publishedId,
          url,
          publishedAt,
        },
      ];
    })
    .slice(0, MAX_PUBLICATION_RECORDS);
}

function readShareSettings(workspaceCwd: string): ShareSettings {
  const loaded = loadSettings(workspaceCwd, {
    skipLoadEnvironment: true,
    workspaceTrusted: true,
  });
  const merged = loaded.merged as Record<string, unknown>;
  const str = (key: string): string => {
    const value = getNestedProperty(merged, key);
    return typeof value === 'string' ? value.trim() : '';
  };
  const bool = (key: string): boolean =>
    getNestedProperty(merged, key) === true;

  return {
    enabled: getNestedProperty(merged, 'artifact.share.enabled') !== false,
    publications: publicationRecords(
      getNestedProperty(merged, 'artifact.share.publications'),
    ),
    host: {
      uploadCommand: str('artifact.host.uploadCommand'),
      urlTemplate: str('artifact.host.urlTemplate'),
      urlFromCommandOutput: bool('artifact.host.urlFromCommandOutput'),
      keyPrefix: str('artifact.host.keyPrefix') || 'artifacts',
    },
    cloudflare: {
      accountId: str('artifact.share.cloudflare.accountId'),
      projectName: str('artifact.share.cloudflare.projectName'),
    },
    vercel: {
      projectId: str('artifact.share.vercel.projectId'),
      projectName: str('artifact.share.vercel.projectName'),
      scope: str('artifact.share.vercel.scope'),
    },
    netlify: {
      siteId: str('artifact.share.netlify.siteId'),
    },
  };
}

function requireArtifactSharingEnabled(
  runtime: WorkspaceRuntime,
  res: Response,
): boolean {
  if (readShareSettings(runtime.workspaceCwd).enabled) return true;
  res.status(403).json({
    error: 'Artifact sharing is disabled in Settings.',
    code: 'artifact_sharing_disabled',
  });
  return false;
}

function effectiveEnv(runtime: WorkspaceRuntime): Readonly<NodeJS.ProcessEnv> {
  return runtime.env.effectiveEnv ?? {};
}

function providerEnv(runtime: WorkspaceRuntime): NodeJS.ProcessEnv {
  const env = { ...process.env, ...effectiveEnv(runtime) };
  env['PATH'] = process.env['PATH'];
  delete env['NODE_OPTIONS'];
  delete env['NODE_PATH'];
  delete env['LD_PRELOAD'];
  delete env['DYLD_INSERT_LIBRARIES'];
  delete env['DYLD_LIBRARY_PATH'];
  delete env['CLOUDFLARE_ACCOUNT_ID'];
  delete env['VERCEL_ORG_ID'];
  delete env['VERCEL_PROJECT_ID'];
  delete env['CLOUDFLARE_API_TOKEN'];
  delete env['CLOUDFLARE_API_BASE_URL'];
  delete env['CF_API_BASE_URL'];
  delete env['VERCEL_TOKEN'];
  delete env['NETLIFY_AUTH_TOKEN'];
  delete env['NETLIFY_API_URL'];
  delete env['NETLIFY_SITE_ID'];
  // Restore the daemon's credential-store locations instead of deleting
  // them: logins performed by this daemon live under those paths.
  for (const key of [
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'APPDATA',
    'LOCALAPPDATA',
  ]) {
    const daemonValue = process.env[key];
    if (daemonValue === undefined) delete env[key];
    else env[key] = daemonValue;
  }
  return env;
}

function netlifyEnv(runtime: WorkspaceRuntime): Readonly<NodeJS.ProcessEnv> {
  return providerEnv(runtime);
}

function assertRuntimeOpen(runtime: WorkspaceRuntime): void {
  runtime.generationGuard?.assertOpen();
}

async function runForRuntime(
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<string> {
  assertRuntimeOpen(runtime);
  const output = await run(command, args, options);
  assertRuntimeOpen(runtime);
  return output;
}

function netlifyCommandTokens(config: ArtifactHostConfig): string[] {
  try {
    return tokenizeCommand(config.uploadCommand.trim());
  } catch {
    return [];
  }
}

function isNetlifyExecutable(command: string | undefined): boolean {
  const executable = command
    ?.replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.toLowerCase();
  return executable === 'netlify' || executable === 'netlify.cmd';
}

function isNodeExecutable(command: string | undefined): boolean {
  const executable = command
    ?.replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.toLowerCase();
  return executable === 'node' || executable === 'node.exe';
}

function isNetlifyEntry(command: string | undefined): boolean {
  return (
    command
      ?.replaceAll('\\', '/')
      .toLowerCase()
      .endsWith('/node_modules/netlify-cli/bin/run.js') === true
  );
}

function netlifyDeployArgs(config: ArtifactHostConfig): string[] | undefined {
  const [command, ...args] = netlifyCommandTokens(config);
  if (isNetlifyExecutable(command)) return args;
  if (isNodeExecutable(command) && isNetlifyEntry(args[0])) {
    return args.slice(1);
  }
  return undefined;
}

function optionValues(args: string[], name: string): string[] {
  return args.flatMap((arg, index) => {
    if (arg === name) return [args[index + 1] ?? ''];
    return arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : [];
  });
}

function netlifyConfiguredSiteId(
  config: ArtifactHostConfig,
): string | undefined {
  const args = netlifyDeployArgs(config);
  if (!args) return undefined;
  const siteDirectories = optionValues(args, '--dir');
  const siteIds = optionValues(args, '--site');
  return config.urlFromCommandOutput &&
    args[0] === 'deploy' &&
    siteDirectories.length === 1 &&
    siteDirectories[0] === '{dir}' &&
    siteIds.length === 1 &&
    siteIds[0] &&
    args.includes('--json') &&
    args.includes('--prod')
    ? siteIds[0]
    : undefined;
}

function isNetlifyConfigured(config: ArtifactHostConfig): boolean {
  return netlifyConfiguredSiteId(config) !== undefined;
}

function parseJsonRecord(output: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(output.trim());
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function siteFromRecord(value: unknown): NetlifySite | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = record['id'] ?? record['site-id'];
  const name = record['name'] ?? record['site-name'];
  if (typeof id !== 'string' || typeof name !== 'string') return undefined;
  const url = record['ssl_url'] ?? record['site-url'];
  const accountName = record['account_name'];
  return {
    id,
    name,
    ...(typeof url === 'string' ? { url } : {}),
    ...(typeof accountName === 'string' ? { accountName } : {}),
  };
}

function parseLinkedSite(output: string): NetlifySite | undefined {
  const status = parseJsonRecord(output);
  return siteFromRecord(status?.['siteData']);
}

async function commandWorks(
  command: NetlifyCommand,
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
): Promise<boolean> {
  try {
    await runForRuntime(
      runtime,
      run,
      command.file,
      [...command.prefixArgs, '--version'],
      {
        cwd: runtime.workspaceCwd,
        env: netlifyEnv(runtime),
        timeoutMs: VERSION_TIMEOUT_MS,
      },
    );
    return true;
  } catch {
    assertRuntimeOpen(runtime);
    return false;
  }
}

function netlifyCommandForPrefix(
  prefix: string,
  platform: NodeJS.Platform,
): NetlifyCommand | undefined {
  const isAbsolute =
    platform === 'win32'
      ? path.win32.isAbsolute(prefix)
      : path.posix.isAbsolute(prefix);
  if (!prefix.trim() || !isAbsolute) return undefined;
  const entry =
    platform === 'win32'
      ? path.win32.join(prefix, 'node_modules', 'netlify-cli', 'bin', 'run.js')
      : path.posix.join(
          prefix,
          'lib',
          'node_modules',
          'netlify-cli',
          'bin',
          'run.js',
        );
  return { file: process.execPath, prefixArgs: [entry] };
}

async function resolveNetlifyCommand(
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
  platform: NodeJS.Platform,
): Promise<NetlifyCommand | undefined> {
  const command = netlifyCommandForPrefix(artifactCliToolPrefix(), platform);
  return command && (await commandWorks(command, runtime, run))
    ? command
    : undefined;
}

function providerCommandForPrefix(
  provider: Exclude<ProviderKind, 'netlify'>,
  prefix: string,
  platform: NodeJS.Platform,
): ProviderCommand | undefined {
  const isAbsolute =
    platform === 'win32'
      ? path.win32.isAbsolute(prefix)
      : path.posix.isAbsolute(prefix);
  if (!prefix.trim() || !isAbsolute) return undefined;
  const packageRoot =
    platform === 'win32'
      ? path.win32.join(prefix, 'node_modules')
      : path.posix.join(prefix, 'lib', 'node_modules');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const entry =
    provider === 'cloudflare'
      ? pathApi.join(packageRoot, 'wrangler', 'bin', 'wrangler.js')
      : pathApi.join(packageRoot, 'vercel', 'dist', 'vc.js');
  return { file: process.execPath, prefixArgs: [entry] };
}

async function resolveProviderCommand(
  provider: ProviderKind,
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
  platform: NodeJS.Platform,
): Promise<ProviderCommand | undefined> {
  if (provider === 'netlify') {
    return resolveNetlifyCommand(runtime, run, platform);
  }
  const command = providerCommandForPrefix(
    provider,
    artifactCliToolPrefix(),
    platform,
  );
  return command && (await commandWorks(command, runtime, run))
    ? command
    : undefined;
}

function runProvider(
  command: ProviderCommand,
  args: string[],
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
  timeoutMs: number,
  options?: {
    signal?: AbortSignal;
    cwd?: string;
    env?: Readonly<NodeJS.ProcessEnv>;
  },
): Promise<string> {
  return runForRuntime(
    runtime,
    run,
    command.file,
    [...command.prefixArgs, ...args],
    {
      cwd: options?.cwd ?? path.dirname(process.execPath),
      env: options?.env ?? providerEnv(runtime),
      timeoutMs,
      signal: options?.signal,
    },
  );
}

function runNetlify(
  command: NetlifyCommand,
  args: string[],
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
  timeoutMs: number,
  signal?: AbortSignal,
  cwd: string = runtime.workspaceCwd,
): Promise<string> {
  return runForRuntime(
    runtime,
    run,
    command.file,
    [...command.prefixArgs, ...args],
    {
      cwd,
      env: netlifyEnv(runtime),
      timeoutMs,
      signal,
    },
  );
}

async function readAuthenticated(
  command: NetlifyCommand,
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
): Promise<boolean> {
  try {
    const output = await runNetlify(
      command,
      ['api', 'getCurrentUser'],
      runtime,
      run,
      AUTH_TIMEOUT_MS,
    );
    return typeof parseJsonRecord(output)?.['id'] === 'string';
  } catch {
    assertRuntimeOpen(runtime);
    return false;
  }
}

async function readLinkedSite(
  command: NetlifyCommand,
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
): Promise<NetlifySite | undefined> {
  try {
    const output = await runNetlify(
      command,
      ['status', '--json'],
      runtime,
      run,
      AUTH_TIMEOUT_MS,
    );
    return parseLinkedSite(output);
  } catch {
    assertRuntimeOpen(runtime);
    return undefined;
  }
}

async function readSiteRecord(
  command: NetlifyCommand,
  siteId: string,
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
): Promise<Record<string, unknown> | undefined> {
  try {
    const output = await runNetlify(
      command,
      ['api', 'getSite', '--data', JSON.stringify({ site_id: siteId })],
      runtime,
      run,
      ACCESS_TIMEOUT_MS,
    );
    return parseJsonRecord(output);
  } catch {
    assertRuntimeOpen(runtime);
    return undefined;
  }
}

async function loadSetupStatus(
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<{ status: NetlifySetupStatus; command?: NetlifyCommand }> {
  assertRuntimeOpen(runtime);
  const settings = readShareSettings(runtime.workspaceCwd);
  const run = commandRunner(deps);
  const platform = deps.platform ?? hostPlatform();
  const command = await resolveNetlifyCommand(runtime, run, platform);
  if (!command) {
    return {
      status: {
        stage: 'install',
        cliInstalled: false,
        authenticated: false,
        linked: false,
        configured: Boolean(
          settings.netlify.siteId || isNetlifyConfigured(settings.host),
        ),
      },
    };
  }

  const authenticated = await readAuthenticated(command, runtime, run);
  if (!authenticated) {
    return {
      command,
      status: {
        stage: 'authenticate',
        cliInstalled: true,
        authenticated: false,
        linked: false,
        configured: Boolean(
          settings.netlify.siteId || isNetlifyConfigured(settings.host),
        ),
        ...(activeLoginTicket(runtime.workspaceCwd)
          ? { authorizationPending: true }
          : {}),
      },
    };
  }

  const configuredSiteId =
    settings.netlify.siteId || netlifyConfiguredSiteId(settings.host);
  if (configuredSiteId) {
    const configuredSite = siteFromRecord(
      await readSiteRecord(command, configuredSiteId, runtime, run),
    );
    if (configuredSite?.id === configuredSiteId) {
      return {
        command,
        status: {
          stage: 'ready',
          cliInstalled: true,
          authenticated: true,
          linked: true,
          configured: true,
          linkedSite: configuredSite,
        },
      };
    }
  }

  const linkedSite = await readLinkedSite(command, runtime, run);
  if (linkedSite) {
    return {
      command,
      status: {
        stage: 'connect',
        cliInstalled: true,
        authenticated: true,
        linked: true,
        configured: false,
        linkedSite,
      },
    };
  }

  return {
    command,
    status: {
      stage: 'connect',
      cliInstalled: true,
      authenticated: true,
      linked: Boolean(linkedSite),
      configured: false,
      ...(linkedSite ? { linkedSite } : {}),
      sites: [],
    },
  };
}

function netlifyProviderSetup(status: NetlifySetupStatus): ProviderSetupStatus {
  return {
    provider: 'netlify',
    stage: status.stage,
    cliInstalled: status.cliInstalled,
    authenticated: status.authenticated,
    linked: status.linked,
    configured: status.configured,
    ...(status.authorizationPending ? { authorizationPending: true } : {}),
    ...(status.linkedSite ? { project: status.linkedSite } : {}),
  };
}

function providerUnavailableReason(status: ProviderSetupStatus): string {
  if (!status.cliInstalled) return `${status.provider}_cli_missing`;
  if (!status.authenticated) return `${status.provider}_auth_required`;
  if (!status.linked) return `${status.provider}_project_unlinked`;
  return `${status.provider}_not_configured`;
}

function allProviderStatuses(
  setups: Record<ProviderKind, ProviderSetupStatus>,
): ProviderStatus[] {
  return PROVIDERS.map((kind) => {
    const status = setups[kind];
    return status.stage === 'ready'
      ? { kind, configured: true }
      : {
          kind,
          configured: false,
          unavailableReason: providerUnavailableReason(status),
        };
  });
}

function cloudflareAccounts(output: string): ProviderProject[] {
  const value = parseJsonRecord(output)?.['accounts'];
  if (!Array.isArray(value)) return [];
  return value.flatMap((account) => {
    if (
      typeof account !== 'object' ||
      account === null ||
      Array.isArray(account)
    ) {
      return [];
    }
    const record = account as Record<string, unknown>;
    return typeof record['id'] === 'string' &&
      typeof record['name'] === 'string'
      ? [{ id: record['id'], name: record['name'] }]
      : [];
  });
}

function cloudflareProjects(output: string): ProviderProject[] {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((project) => {
    if (
      typeof project !== 'object' ||
      project === null ||
      Array.isArray(project)
    ) {
      return [];
    }
    const record = project as Record<string, unknown>;
    const name = record['Project Name'];
    if (typeof name !== 'string') return [];
    const domains = record['Project Domains'];
    const firstDomain =
      typeof domains === 'string' ? domains.split(',')[0]?.trim() : undefined;
    return [
      {
        id: name,
        name,
        ...(firstDomain ? { url: `https://${firstDomain}` } : {}),
      },
    ];
  });
}

function vercelProjects(output: string): {
  projects: ProviderProject[];
  scope?: string;
} {
  const record = parseJsonRecord(output);
  const value = record?.['projects'];
  const projects = Array.isArray(value)
    ? value.flatMap((project) => {
        if (
          typeof project !== 'object' ||
          project === null ||
          Array.isArray(project)
        ) {
          return [];
        }
        const item = project as Record<string, unknown>;
        return typeof item['id'] === 'string' &&
          typeof item['name'] === 'string'
          ? [
              {
                id: item['id'],
                name: item['name'],
                ...(typeof item['latestProductionUrl'] === 'string'
                  ? { url: `https://${item['latestProductionUrl']}` }
                  : {}),
              },
            ]
          : [];
      })
    : [];
  return {
    projects,
    ...(typeof record?.['contextName'] === 'string'
      ? { scope: record['contextName'] }
      : {}),
  };
}

function accountEnv(
  runtime: WorkspaceRuntime,
  accountId: string,
): NodeJS.ProcessEnv {
  return {
    ...providerEnv(runtime),
    CLOUDFLARE_ACCOUNT_ID: accountId,
  };
}

async function confirmCloudflareProject(
  command: ProviderCommand,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
  accountId: string,
  name: string,
): Promise<ProviderProject | undefined> {
  for (const delayMs of PROJECT_CONFIRM_RETRY_DELAYS_MS) {
    if (delayMs > 0) await waitForOperation(delayMs, deps);
    deps.operationSignal?.throwIfAborted();
    try {
      const project = cloudflareProjects(
        await runProvider(
          command,
          ['pages', 'project', 'list', '--json'],
          runtime,
          commandRunner(deps),
          AUTH_TIMEOUT_MS,
          { env: accountEnv(runtime, accountId) },
        ),
      ).find((item) => item.name === name);
      if (project) return project;
    } catch {
      deps.operationSignal?.throwIfAborted();
      assertRuntimeOpen(runtime);
    }
  }
  return undefined;
}

async function loadCloudflareStatus(
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<{ status: ProviderSetupStatus; command?: ProviderCommand }> {
  const settings = readShareSettings(runtime.workspaceCwd);
  const run = commandRunner(deps);
  const command = await resolveProviderCommand(
    'cloudflare',
    runtime,
    run,
    deps.platform ?? hostPlatform(),
  );
  if (!command) {
    return {
      status: {
        provider: 'cloudflare',
        stage: 'install',
        cliInstalled: false,
        authenticated: false,
        linked: false,
        configured: false,
      },
    };
  }
  let accounts: ProviderProject[] = [];
  try {
    accounts = cloudflareAccounts(
      await runProvider(
        command,
        ['whoami', '--json'],
        runtime,
        run,
        AUTH_TIMEOUT_MS,
      ),
    );
  } catch {
    assertRuntimeOpen(runtime);
  }
  if (accounts.length === 0) {
    return {
      command,
      status: {
        provider: 'cloudflare',
        stage: 'authenticate',
        cliInstalled: true,
        authenticated: false,
        linked: false,
        configured: false,
      },
    };
  }

  const account =
    accounts.find((item) => item.id === settings.cloudflare.accountId) ??
    (accounts.length === 1 ? accounts[0] : undefined);
  if (!account) {
    return {
      command,
      status: {
        provider: 'cloudflare',
        stage: 'connect',
        cliInstalled: true,
        authenticated: true,
        linked: false,
        configured: false,
        accounts,
      },
    };
  }

  if (settings.cloudflare.projectName) {
    try {
      const projects = cloudflareProjects(
        await runProvider(
          command,
          ['pages', 'project', 'list', '--json'],
          runtime,
          run,
          AUTH_TIMEOUT_MS,
          { env: accountEnv(runtime, account.id) },
        ),
      );
      const project = projects.find(
        (item) => item.name === settings.cloudflare.projectName,
      );
      if (project) {
        return {
          command,
          status: {
            provider: 'cloudflare',
            stage: 'ready',
            cliInstalled: true,
            authenticated: true,
            linked: true,
            configured: true,
            project: { ...project, accountName: account.name },
          },
        };
      }
    } catch {
      assertRuntimeOpen(runtime);
    }
  }

  return {
    command,
    status: {
      provider: 'cloudflare',
      stage: 'connect',
      cliInstalled: true,
      authenticated: true,
      linked: false,
      configured: false,
      accounts,
    },
  };
}

async function vercelAuthenticated(
  command: ProviderCommand,
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
): Promise<boolean> {
  try {
    return Boolean(
      (
        await runProvider(command, ['whoami'], runtime, run, AUTH_TIMEOUT_MS)
      ).trim(),
    );
  } catch {
    assertRuntimeOpen(runtime);
    return false;
  }
}

async function readVercelProjects(
  command: ProviderCommand,
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
  name: string,
  scope?: string,
): Promise<{ projects: ProviderProject[]; scope?: string }> {
  const args = ['project', 'ls', '--filter', name, '--json'];
  if (scope) args.push('--scope', scope);
  return vercelProjects(
    await runProvider(command, args, runtime, run, AUTH_TIMEOUT_MS),
  );
}

async function confirmVercelProject(
  command: ProviderCommand,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
  name: string,
): Promise<{ project: ProviderProject; scope: string } | undefined> {
  for (const delayMs of PROJECT_CONFIRM_RETRY_DELAYS_MS) {
    if (delayMs > 0) await waitForOperation(delayMs, deps);
    deps.operationSignal?.throwIfAborted();
    try {
      const listed = await readVercelProjects(
        command,
        runtime,
        commandRunner(deps),
        name,
      );
      const project = listed.projects.find((item) => item.name === name);
      if (project && listed.scope) return { project, scope: listed.scope };
    } catch {
      deps.operationSignal?.throwIfAborted();
      assertRuntimeOpen(runtime);
    }
  }
  return undefined;
}

async function loadVercelStatus(
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<{ status: ProviderSetupStatus; command?: ProviderCommand }> {
  const settings = readShareSettings(runtime.workspaceCwd);
  const run = commandRunner(deps);
  const command = await resolveProviderCommand(
    'vercel',
    runtime,
    run,
    deps.platform ?? hostPlatform(),
  );
  if (!command) {
    return {
      status: {
        provider: 'vercel',
        stage: 'install',
        cliInstalled: false,
        authenticated: false,
        linked: false,
        configured: false,
      },
    };
  }
  if (!(await vercelAuthenticated(command, runtime, run))) {
    return {
      command,
      status: {
        provider: 'vercel',
        stage: 'authenticate',
        cliInstalled: true,
        authenticated: false,
        linked: false,
        configured: false,
      },
    };
  }

  if (settings.vercel.projectId && settings.vercel.projectName) {
    try {
      const listed = await readVercelProjects(
        command,
        runtime,
        run,
        settings.vercel.projectName,
        settings.vercel.scope || undefined,
      );
      const project = listed.projects.find(
        (item) => item.id === settings.vercel.projectId,
      );
      if (project) {
        return {
          command,
          status: {
            provider: 'vercel',
            stage: 'ready',
            cliInstalled: true,
            authenticated: true,
            linked: true,
            configured: true,
            project: {
              ...project,
              accountName: settings.vercel.scope || listed.scope,
            },
          },
        };
      }
    } catch {
      assertRuntimeOpen(runtime);
    }
  }

  return {
    command,
    status: {
      provider: 'vercel',
      stage: 'connect',
      cliInstalled: true,
      authenticated: true,
      linked: false,
      configured: false,
    },
  };
}

async function loadProviderSetups(
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<{
  setups: Record<ProviderKind, ProviderSetupStatus>;
  netlify: NetlifySetupStatus;
}> {
  const [cloudflare, vercel, netlify] = await Promise.all([
    loadCloudflareStatus(runtime, deps),
    loadVercelStatus(runtime, deps),
    loadSetupStatus(runtime, deps),
  ]);
  return {
    setups: {
      cloudflare: cloudflare.status,
      vercel: vercel.status,
      netlify: netlifyProviderSetup(netlify.status),
    },
    netlify: netlify.status,
  };
}

function configPayload(
  runtime: WorkspaceRuntime,
  setups: Record<ProviderKind, ProviderSetupStatus>,
  legacyNetlify: NetlifySetupStatus,
  publications?: Partial<Record<ProviderKind, PublicationStatus>>,
): Record<string, unknown> {
  return {
    v: 1,
    workspaceCwd: runtime.workspaceCwd,
    providers: allProviderStatuses(setups),
    setups,
    setup: {
      ...netlifyProviderSetup(legacyNetlify),
      ...(legacyNetlify.linkedSite
        ? { linkedSite: legacyNetlify.linkedSite }
        : {}),
      ...(legacyNetlify.sites ? { sites: legacyNetlify.sites } : {}),
    },
    ...(publications ? { publications } : {}),
  };
}

async function handleConfig(
  req: Request,
  res: Response,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
  route: string,
): Promise<void> {
  if (!requireArtifactSharingEnabled(runtime, res)) return;
  try {
    const { setups, netlify } = await loadProviderSetups(runtime, deps);
    const filePath =
      typeof req.query['path'] === 'string' ? req.query['path'].trim() : '';
    let publications:
      | Partial<Record<ProviderKind, PublicationStatus>>
      | undefined;
    if (filePath) {
      const fs = runtime.routeFileSystemFactory.forRequest({ route });
      const resolved = await fs.resolve(filePath, 'read');
      assertRuntimeOpen(runtime);
      const html = await readWholeFile(fs, resolved);
      assertRuntimeOpen(runtime);
      if (html === null) {
        res.status(400).json({
          error: `Artifact is larger than the ${MAX_PUBLISH_BYTES} byte publish limit.`,
          code: 'artifact_too_large',
        });
        return;
      }
      const settings = readShareSettings(runtime.workspaceCwd);
      const artifactId = artifactIdFromPath(resolved);
      const contentHash = artifactContentHash(html);
      publications = Object.fromEntries(
        PROVIDERS.flatMap((provider) => {
          const record = publicationFor(settings, provider, artifactId);
          return record
            ? [[provider, publicationStatus(record, contentHash)]]
            : [];
        }),
      );
    }
    assertRuntimeOpen(runtime);
    applyReadHeaders(res);
    res.status(200).json(configPayload(runtime, setups, netlify, publications));
  } catch (err) {
    if (isFsError(err)) {
      sendFsError(res, err, route);
      return;
    }
    deps.sendBridgeError(res, err, { route });
  }
}

async function installNetlify(
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<NetlifyCommand> {
  const run = commandRunner(deps);
  const platform = deps.platform ?? hostPlatform();
  try {
    await runForRuntime(
      runtime,
      run,
      process.execPath,
      [
        getNpmCliPath(process.execPath, platform),
        'install',
        '--global',
        '--prefix',
        artifactCliToolPrefix(),
        '--cache',
        artifactCliNpmCache(),
        'netlify-cli',
      ],
      {
        cwd: path.dirname(process.execPath),
        env: process.env,
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
  } catch {
    assertRuntimeOpen(runtime);
    throw new SetupError(
      500,
      'netlify_install_failed',
      'Netlify setup could not be installed. Try again.',
    );
  }

  const resolved = await resolveNetlifyCommand(runtime, run, platform);
  if (resolved) return resolved;
  throw new SetupError(
    500,
    'netlify_install_failed',
    'Netlify setup finished but the CLI could not be started.',
  );
}

function validateAuthorizationUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new SetupError(
      502,
      'netlify_login_failed',
      'Netlify did not return an authorization page.',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SetupError(
      502,
      'netlify_login_failed',
      'Netlify returned an invalid authorization page.',
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'app.netlify.com' ||
    url.pathname !== '/authorize'
  ) {
    throw new SetupError(
      502,
      'netlify_login_failed',
      'Netlify returned an unexpected authorization page.',
    );
  }
  return url.href;
}

async function beginLogin(
  command: NetlifyCommand,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<LoginTicket> {
  const existing = activeLoginTicket(runtime.workspaceCwd);
  if (existing) return existing;
  let output: string;
  try {
    output = await runNetlify(
      command,
      ['login', '--request', 'Qwen Code artifact sharing', '--json'],
      runtime,
      commandRunner(deps),
      AUTH_TIMEOUT_MS,
    );
  } catch {
    assertRuntimeOpen(runtime);
    throw new SetupError(
      502,
      'netlify_login_failed',
      'Could not start Netlify authorization. Try again.',
    );
  }
  const body = parseJsonRecord(output);
  const id = body?.['ticket_id'];
  if (typeof id !== 'string' || !id.trim()) {
    throw new SetupError(
      502,
      'netlify_login_failed',
      'Netlify did not return an authorization ticket.',
    );
  }
  const ticket = {
    id,
    url: validateAuthorizationUrl(body?.['url']),
    expiresAt: Date.now() + LOGIN_TICKET_TTL_MS,
  };
  rememberLoginTicket(runtime.workspaceCwd, ticket);
  return ticket;
}

async function pollLogin(
  command: NetlifyCommand,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<'pending' | 'denied' | 'authorized' | 'expired'> {
  const ticket = activeLoginTicket(runtime.workspaceCwd);
  if (!ticket) return 'expired';
  let output: string;
  try {
    output = await runNetlify(
      command,
      ['login', '--check', ticket.id, '--json'],
      runtime,
      commandRunner(deps),
      AUTH_TIMEOUT_MS,
    );
  } catch {
    assertRuntimeOpen(runtime);
    throw new SetupError(
      502,
      'netlify_login_check_failed',
      'Could not check Netlify authorization. Try again.',
    );
  }
  const state = parseJsonRecord(output)?.['status'];
  if (state !== 'pending' && state !== 'denied' && state !== 'authorized') {
    throw new SetupError(
      502,
      'netlify_login_check_failed',
      'Netlify returned an unexpected authorization status.',
    );
  }
  if (state !== 'pending') loginTickets.delete(runtime.workspaceCwd);
  return state;
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await fsp.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function assertLinkBoundary(runtime: WorkspaceRuntime): Promise<void> {
  assertRuntimeOpen(runtime);
  const workspaceRoot = await canonicalPath(runtime.workspaceCwd);
  let repositoryRoot: string | undefined;
  for (let current = workspaceRoot; ; current = path.dirname(current)) {
    try {
      await fsp.stat(path.join(current, '.git'));
      repositoryRoot = current;
      break;
    } catch {
      // Only a discovered .git proves nesting; an unreadable entry proves
      // nothing, and rethrowing turns transient fs errors into setup 500s.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
  }
  if (repositoryRoot && !pathIsInside(workspaceRoot, repositoryRoot)) {
    throw new SetupError(
      409,
      'netlify_link_outside_workspace',
      'This workspace is nested inside a larger repository. Open the repository root as the workspace before connecting Netlify.',
    );
  }
  assertRuntimeOpen(runtime);
}

function quoteCommand(command: string): string {
  if (!/[\s'"]/.test(command)) return command;
  if (command.includes('"')) {
    throw new SetupError(
      500,
      'netlify_config_failed',
      'The Netlify CLI path cannot be saved safely.',
    );
  }
  return `"${command}"`;
}

function netlifyUploadCommand(command: NetlifyCommand, siteId: string): string {
  return [
    command.file,
    ...command.prefixArgs,
    'deploy',
    '--dir',
    '{dir}',
    '--json',
    '--no-build',
    '--prod',
    '--site',
    siteId,
  ]
    .map(quoteCommand)
    .join(' ');
}

async function connectSite(
  requestedSiteId: string | undefined,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
  knownSite?: NetlifySite,
): Promise<NetlifySetupStatus> {
  const initial = await loadSetupStatus(runtime, deps);
  if (!initial.command || !initial.status.authenticated) {
    throw new SetupError(
      409,
      'netlify_auth_required',
      'Authorize Netlify before connecting a project.',
    );
  }

  if (initial.status.stage === 'ready' && initial.status.linkedSite) {
    return initial.status;
  }

  const linkedSite = initial.status.linkedSite;
  if (linkedSite && requestedSiteId && linkedSite.id !== requestedSiteId) {
    throw new SetupError(
      409,
      'netlify_site_already_linked',
      `This workspace is already connected to ${linkedSite.name}.`,
    );
  }

  let selected = knownSite;
  if (!selected && linkedSite) {
    const site = await readSiteRecord(
      initial.command,
      linkedSite.id,
      runtime,
      commandRunner(deps),
    );
    if (!site) {
      throw new SetupError(
        502,
        'netlify_site_check_failed',
        'Could not verify the connected Netlify project. Try again.',
      );
    }
    selected =
      site['published_deploy'] == null
        ? linkedSite
        : await createSite(initial.command, runtime, deps);
  }
  if (!selected) {
    if (requestedSiteId) {
      throw new SetupError(
        400,
        'netlify_site_invalid',
        'Qwen Code can only connect a dedicated artifact project.',
      );
    }
    selected = await createSite(initial.command, runtime, deps);
  }

  assertRuntimeOpen(runtime);
  if (!deps.persistSettings) {
    throw new SetupError(
      503,
      'netlify_config_unavailable',
      'Qwen Code could not save the sharing setup. Try again.',
    );
  }
  try {
    await deps.persistSettings(
      runtime.workspaceCwd,
      [
        {
          scope: SettingScope.Workspace,
          key: 'artifact.host.uploadCommand',
          value: netlifyUploadCommand(initial.command, selected.id),
        },
        {
          scope: SettingScope.Workspace,
          key: 'artifact.host.urlFromCommandOutput',
          value: true,
        },
        {
          scope: SettingScope.Workspace,
          key: 'artifact.share.netlify.siteId',
          value: selected.id,
        },
      ],
      () => assertRuntimeOpen(runtime),
    );
    assertRuntimeOpen(runtime);
  } catch {
    assertRuntimeOpen(runtime);
    throw new SetupError(
      500,
      'netlify_config_failed',
      'The project was connected, but Qwen Code could not save the sharing configuration. Try again.',
    );
  }

  const refreshed = await loadSetupStatus(runtime, deps);
  if (refreshed.status.stage !== 'ready') {
    throw new SetupError(
      500,
      'netlify_config_failed',
      'Netlify was connected, but sharing is not ready yet. Try again.',
    );
  }
  return refreshed.status;
}

async function createSite(
  command: NetlifyCommand,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<NetlifySite> {
  await assertLinkBoundary(runtime);
  let output: string;
  try {
    output = await runNetlify(
      command,
      ['sites:create', '--disable-linking', '--json'],
      runtime,
      commandRunner(deps),
      CREATE_TIMEOUT_MS,
    );
  } catch {
    assertRuntimeOpen(runtime);
    throw new SetupError(
      502,
      'netlify_site_create_failed',
      'Could not create a Netlify project. Try again.',
    );
  }
  const site = siteFromRecord(parseJsonRecord(output));
  if (!site) {
    throw new SetupError(
      502,
      'netlify_site_create_failed',
      'Netlify did not confirm the new project.',
    );
  }
  return site;
}

async function finishAuthenticatedSetup(
  current: Awaited<ReturnType<typeof loadSetupStatus>>,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<NetlifySetupStatus> {
  if (!current.command || !current.status.authenticated) {
    throw new SetupError(
      409,
      'netlify_auth_required',
      'Authorize Netlify before connecting a project.',
    );
  }
  if (current.status.linkedSite) {
    return connectSite(undefined, runtime, deps);
  }
  const site = await createSite(current.command, runtime, deps);
  return connectSite(site.id, runtime, deps, site);
}

async function handleSetup(
  req: Request,
  res: Response,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
  route: string,
): Promise<void> {
  if (!requireArtifactSharingEnabled(runtime, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = body['action'];
  const requestedSiteId =
    typeof body['siteId'] === 'string'
      ? body['siteId'].trim()
      : typeof body['targetId'] === 'string'
        ? body['targetId'].trim()
        : undefined;
  if (action !== 'prepare' && action !== 'poll' && action !== 'connect') {
    res.status(400).json({
      error: '`action` must be "prepare", "poll", or "connect"',
      code: 'invalid_request',
    });
    return;
  }

  const abortScope = requestAbortScope(req, res);
  const operationDeps = withCommandSignal(deps, abortScope.signal);
  try {
    const result = await withSetupLock(async () => {
      abortScope.signal.throwIfAborted();
      assertRuntimeOpen(runtime);
      if (action === 'connect') {
        return {
          status: await connectSite(requestedSiteId, runtime, operationDeps),
        };
      }

      let current = await loadSetupStatus(runtime, operationDeps);
      if (action === 'prepare' && !current.command) {
        await installNetlify(runtime, operationDeps);
        current = await loadSetupStatus(runtime, operationDeps);
      }
      if (!current.command) {
        throw new SetupError(
          500,
          'netlify_install_failed',
          'Netlify setup is not available.',
        );
      }
      if (current.status.authenticated) {
        return {
          status: await finishAuthenticatedSetup(
            current,
            runtime,
            operationDeps,
          ),
        };
      }

      if (action === 'prepare') {
        const ticket = await beginLogin(
          current.command,
          runtime,
          operationDeps,
        );
        return {
          status: {
            ...current.status,
            authorizationPending: true,
          },
          authorizationUrl: ticket.url,
        };
      }

      const loginState = await pollLogin(
        current.command,
        runtime,
        operationDeps,
      );
      if (loginState === 'authorized') {
        const authenticated = await loadSetupStatus(runtime, operationDeps);
        return {
          status: await finishAuthenticatedSetup(
            authenticated,
            runtime,
            operationDeps,
          ),
        };
      }
      if (loginState === 'denied') {
        throw new SetupError(
          401,
          'netlify_login_denied',
          'Netlify authorization was declined. Try again when ready.',
        );
      }
      return {
        status: {
          ...current.status,
          authorizationPending: loginState === 'pending',
        },
      };
    });

    assertRuntimeOpen(runtime);
    abortScope.signal.throwIfAborted();
    const loaded = await loadProviderSetups(runtime, operationDeps);
    loaded.setups.netlify = netlifyProviderSetup(result.status);
    applyReadHeaders(res);
    res.status(200).json({
      ...configPayload(runtime, loaded.setups, result.status),
      provider: 'netlify',
      setup: {
        ...netlifyProviderSetup(result.status),
        ...(result.status.linkedSite
          ? { linkedSite: result.status.linkedSite }
          : {}),
        ...(result.status.sites ? { sites: result.status.sites } : {}),
      },
      ...('authorizationUrl' in result
        ? { authorizationUrl: result.authorizationUrl }
        : {}),
    });
  } catch (err) {
    if (abortScope.signal.aborted || res.destroyed) return;
    if (err instanceof SetupError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    deps.sendBridgeError(res, err, { route });
  } finally {
    abortScope.dispose();
  }
}

async function installProvider(
  provider: Exclude<ProviderKind, 'netlify'>,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<ProviderCommand> {
  const run = commandRunner(deps);
  const platform = deps.platform ?? hostPlatform();
  const packageName = provider === 'cloudflare' ? 'wrangler' : 'vercel';
  try {
    await runForRuntime(
      runtime,
      run,
      process.execPath,
      [
        getNpmCliPath(process.execPath, platform),
        'install',
        '--global',
        '--prefix',
        artifactCliToolPrefix(),
        '--cache',
        artifactCliNpmCache(),
        packageName,
      ],
      {
        cwd: path.dirname(process.execPath),
        env: process.env,
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
  } catch {
    assertRuntimeOpen(runtime);
    throw new SetupError(
      500,
      `${provider}_install_failed`,
      `${provider === 'cloudflare' ? 'Cloudflare' : 'Vercel'} setup could not be installed. Try again.`,
    );
  }
  const command = await resolveProviderCommand(
    provider,
    runtime,
    run,
    platform,
  );
  if (command) return command;
  throw new SetupError(
    500,
    `${provider}_install_failed`,
    `${provider === 'cloudflare' ? 'Cloudflare' : 'Vercel'} setup finished but the CLI could not be started.`,
  );
}

async function loginProvider(
  provider: Exclude<ProviderKind, 'netlify'>,
  command: ProviderCommand,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<void> {
  try {
    await runProvider(
      command,
      ['login'],
      runtime,
      commandRunner(deps),
      LOGIN_TIMEOUT_MS,
    );
  } catch {
    assertRuntimeOpen(runtime);
    const authenticated =
      provider === 'cloudflare'
        ? (await loadCloudflareStatus(runtime, deps)).status.authenticated
        : await vercelAuthenticated(command, runtime, commandRunner(deps));
    if (authenticated) return;
    throw new SetupError(
      401,
      `${provider}_login_failed`,
      `${provider === 'cloudflare' ? 'Cloudflare' : 'Vercel'} authorization was not completed. Try again.`,
    );
  }
}

function dedicatedProjectName(): string {
  return `qwen-artifacts-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

async function persistProviderTarget(
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
  writes: Array<{ key: string; value: string }>,
  provider: Exclude<ProviderKind, 'netlify'>,
): Promise<void> {
  if (!deps.persistSettings) {
    throw new SetupError(
      503,
      `${provider}_config_unavailable`,
      'Qwen Code could not save the sharing setup. Try again.',
    );
  }
  try {
    await deps.persistSettings(
      runtime.workspaceCwd,
      writes.map(({ key, value }) => ({
        scope: SettingScope.Workspace,
        key,
        value,
      })),
      () => assertRuntimeOpen(runtime),
    );
    assertRuntimeOpen(runtime);
  } catch {
    assertRuntimeOpen(runtime);
    throw new SetupError(
      500,
      `${provider}_config_failed`,
      'The project was created, but Qwen Code could not save the sharing setup. Try again.',
    );
  }
}

async function connectCloudflare(
  current: Awaited<ReturnType<typeof loadCloudflareStatus>>,
  requestedAccountId: string | undefined,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<ProviderSetupStatus> {
  if (!current.command || !current.status.authenticated) {
    throw new SetupError(
      409,
      'cloudflare_auth_required',
      'Authorize Cloudflare before connecting a project.',
    );
  }
  if (current.status.stage === 'ready') return current.status;
  const settings = readShareSettings(runtime.workspaceCwd);
  const accounts = current.status.accounts ?? [];
  const account = requestedAccountId
    ? accounts.find((item) => item.id === requestedAccountId)
    : (accounts.find((item) => item.id === settings.cloudflare.accountId) ??
      (accounts.length === 1 ? accounts[0] : undefined));
  if (!account) return current.status;

  const pendingName = settings.cloudflare.projectName;
  const name = pendingName || dedicatedProjectName();
  try {
    if (!pendingName || settings.cloudflare.accountId !== account.id) {
      await persistProviderTarget(
        runtime,
        deps,
        [
          {
            key: 'artifact.share.cloudflare.accountId',
            value: account.id,
          },
          {
            key: 'artifact.share.cloudflare.projectName',
            value: name,
          },
        ],
        'cloudflare',
      );
    }
    let project =
      pendingName && settings.cloudflare.accountId === account.id
        ? await confirmCloudflareProject(
            current.command,
            runtime,
            deps,
            account.id,
            name,
          )
        : undefined;
    if (!project) {
      let createError: unknown;
      try {
        await runProvider(
          current.command,
          [
            'pages',
            'project',
            'create',
            name,
            '--production-branch',
            'main',
            '--force',
          ],
          runtime,
          commandRunner(deps),
          CREATE_TIMEOUT_MS,
          { env: accountEnv(runtime, account.id) },
        );
      } catch (error) {
        createError = error;
        deps.operationSignal?.throwIfAborted();
        assertRuntimeOpen(runtime);
      }
      project = await confirmCloudflareProject(
        current.command,
        runtime,
        deps,
        account.id,
        name,
      );
      if (!project) throw createError ?? new Error('Project not returned');
    }
    await persistProviderTarget(
      runtime,
      deps,
      [
        {
          key: 'artifact.share.cloudflare.accountId',
          value: account.id,
        },
        {
          key: 'artifact.share.cloudflare.projectName',
          value: name,
        },
      ],
      'cloudflare',
    );
    return {
      provider: 'cloudflare',
      stage: 'ready',
      cliInstalled: true,
      authenticated: true,
      linked: true,
      configured: true,
      project: { ...project, accountName: account.name },
    };
  } catch (error) {
    if (error instanceof SetupError) throw error;
    assertRuntimeOpen(runtime);
    throw new SetupError(
      502,
      'cloudflare_project_create_failed',
      'Could not create a Cloudflare Pages project. Try again.',
    );
  }
}

async function connectVercel(
  current: Awaited<ReturnType<typeof loadVercelStatus>>,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<ProviderSetupStatus> {
  if (!current.command || !current.status.authenticated) {
    throw new SetupError(
      409,
      'vercel_auth_required',
      'Authorize Vercel before connecting a project.',
    );
  }
  if (current.status.stage === 'ready') return current.status;
  const settings = readShareSettings(runtime.workspaceCwd);
  const pendingName = settings.vercel.projectName;
  const name = pendingName || dedicatedProjectName();
  try {
    if (!pendingName) {
      await persistProviderTarget(
        runtime,
        deps,
        [{ key: 'artifact.share.vercel.projectName', value: name }],
        'vercel',
      );
    }
    let confirmed = pendingName
      ? await confirmVercelProject(current.command, runtime, deps, name)
      : undefined;
    if (!confirmed) {
      let createError: unknown;
      try {
        await runProvider(
          current.command,
          ['project', 'add', name],
          runtime,
          commandRunner(deps),
          CREATE_TIMEOUT_MS,
        );
      } catch (error) {
        createError = error;
        deps.operationSignal?.throwIfAborted();
        assertRuntimeOpen(runtime);
      }
      confirmed = await confirmVercelProject(
        current.command,
        runtime,
        deps,
        name,
      );
      if (!confirmed) throw createError ?? new Error('Project not returned');
    }
    const { project, scope } = confirmed;
    await persistProviderTarget(
      runtime,
      deps,
      [
        { key: 'artifact.share.vercel.projectId', value: project.id },
        { key: 'artifact.share.vercel.projectName', value: project.name },
        { key: 'artifact.share.vercel.scope', value: scope },
      ],
      'vercel',
    );
    return {
      provider: 'vercel',
      stage: 'ready',
      cliInstalled: true,
      authenticated: true,
      linked: true,
      configured: true,
      project: { ...project, accountName: scope },
    };
  } catch (error) {
    if (error instanceof SetupError) throw error;
    assertRuntimeOpen(runtime);
    throw new SetupError(
      502,
      'vercel_project_create_failed',
      'Could not create a Vercel project. Try again.',
    );
  }
}

async function prepareProvider(
  provider: Exclude<ProviderKind, 'netlify'>,
  action: 'prepare' | 'poll' | 'connect',
  accountId: string | undefined,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<ProviderSetupStatus> {
  let current =
    provider === 'cloudflare'
      ? await loadCloudflareStatus(runtime, deps)
      : await loadVercelStatus(runtime, deps);
  if (!current.command && action !== 'poll') {
    await installProvider(provider, runtime, deps);
    current =
      provider === 'cloudflare'
        ? await loadCloudflareStatus(runtime, deps)
        : await loadVercelStatus(runtime, deps);
  }
  if (!current.command) return current.status;
  if (!current.status.authenticated) {
    if (action === 'poll') return current.status;
    await loginProvider(provider, current.command, runtime, deps);
    current =
      provider === 'cloudflare'
        ? await loadCloudflareStatus(runtime, deps)
        : await loadVercelStatus(runtime, deps);
  }
  if (!current.status.authenticated) {
    throw new SetupError(
      401,
      `${provider}_auth_required`,
      `${provider === 'cloudflare' ? 'Cloudflare' : 'Vercel'} authorization is still required.`,
    );
  }
  return provider === 'cloudflare'
    ? connectCloudflare(current, accountId, runtime, deps)
    : connectVercel(current, runtime, deps);
}

async function handleProviderSetup(
  provider: Exclude<ProviderKind, 'netlify'>,
  req: Request,
  res: Response,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
  route: string,
): Promise<void> {
  if (!requireArtifactSharingEnabled(runtime, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = body['action'];
  if (action !== 'prepare' && action !== 'poll' && action !== 'connect') {
    res.status(400).json({
      error: '`action` must be "prepare", "poll", or "connect"',
      code: 'invalid_request',
    });
    return;
  }
  const accountId =
    typeof body['accountId'] === 'string'
      ? body['accountId'].trim()
      : undefined;
  const abortScope = requestAbortScope(req, res);
  const operationDeps = withCommandSignal(deps, abortScope.signal);
  try {
    const status = await withSetupLock(() => {
      abortScope.signal.throwIfAborted();
      return prepareProvider(
        provider,
        action,
        accountId,
        runtime,
        operationDeps,
      );
    });
    abortScope.signal.throwIfAborted();
    const loaded = await loadProviderSetups(runtime, operationDeps);
    loaded.setups[provider] = status;
    assertRuntimeOpen(runtime);
    applyReadHeaders(res);
    res.status(200).json({
      ...configPayload(runtime, loaded.setups, loaded.netlify),
      provider,
      setup: status,
    });
  } catch (err) {
    if (abortScope.signal.aborted || res.destroyed) return;
    if (err instanceof SetupError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    deps.sendBridgeError(res, err, { route });
  } finally {
    abortScope.dispose();
  }
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

async function readWholeFile(
  fs: Pick<WorkspaceFileSystem, 'readBytesWindow'>,
  resolved: ResolvedPath,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const out = await fs.readBytesWindow(resolved, {
      offset,
      maxBytes: MAX_READ_BYTES,
    });
    if (out.sizeBytes > MAX_PUBLISH_BYTES) return null;
    chunks.push(out.buffer);
    offset = out.offset + out.returnedBytes;
    if (offset >= out.sizeBytes || out.returnedBytes <= 0) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function artifactContentHash(html: string): string {
  return createHash('sha256').update(html).digest('hex');
}

function configuredTargetId(
  settings: ShareSettings,
  provider: ProviderKind,
): string {
  const identity =
    provider === 'cloudflare'
      ? [settings.cloudflare.accountId, settings.cloudflare.projectName]
      : provider === 'vercel'
        ? [settings.vercel.scope, settings.vercel.projectId]
        : [
            settings.netlify.siteId ||
              netlifyConfiguredSiteId(settings.host) ||
              '',
          ];
  if (identity.some((part) => !part)) return '';
  return createHash('sha256')
    .update(JSON.stringify([provider, ...identity]))
    .digest('hex');
}

function publicationFor(
  settings: ShareSettings,
  provider: ProviderKind,
  artifactId: string,
): PublicationRecord | undefined {
  const targetId = configuredTargetId(settings, provider);
  if (!targetId) return undefined;
  return settings.publications.find(
    (record) =>
      record.provider === provider &&
      record.targetId === targetId &&
      record.artifactId === artifactId,
  );
}

function publicationStatus(
  record: PublicationRecord,
  contentHash: string,
): PublicationStatus {
  return {
    provider: record.provider,
    id: record.publishedId,
    url: record.url,
    publishedAt: record.publishedAt,
    upToDate: record.contentHash === contentHash,
  };
}

async function savePublication(
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
  settings: ShareSettings,
  record: PublicationRecord,
): Promise<boolean> {
  if (!deps.persistSettings) return false;
  const publications = [
    record,
    ...settings.publications.filter(
      (existing) =>
        existing.provider !== record.provider ||
        existing.artifactId !== record.artifactId,
    ),
  ].slice(0, MAX_PUBLICATION_RECORDS);
  try {
    await deps.persistSettings(
      runtime.workspaceCwd,
      [
        {
          scope: SettingScope.Workspace,
          key: 'artifact.share.publications',
          value: publications,
        },
      ],
      () => assertRuntimeOpen(runtime),
    );
    assertRuntimeOpen(runtime);
    return true;
  } catch {
    assertRuntimeOpen(runtime);
    return false;
  }
}

function makeNetlifyPublisher(
  command: NetlifyCommand,
  siteId: string,
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
): HostPublisher {
  const config: ArtifactHostConfig = {
    uploadCommand: netlifyUploadCommand(command, siteId),
    urlTemplate: '',
    urlFromCommandOutput: true,
    keyPrefix: 'artifacts',
  };
  return new HostPublisher(config, async (_file, args, signal) => {
    const deployDirectories = optionValues(args, '--dir');
    const deployDirectory = deployDirectories[0];
    if (
      deployDirectories.length !== 1 ||
      !deployDirectory ||
      !path.isAbsolute(deployDirectory)
    ) {
      throw new Error('Netlify artifact deploy directory is invalid.');
    }
    return runNetlify(
      command,
      args.slice(command.prefixArgs.length),
      runtime,
      run,
      PUBLISH_TIMEOUT_MS,
      signal,
      deployDirectory,
    );
  });
}

interface ResolvedPublisher {
  provider: ProviderKind;
  publisher: HostPublisher;
  command: ProviderCommand;
  targetId: string;
  accountId?: string;
  scope?: string;
}

function cloudflareUploadCommand(
  command: ProviderCommand,
  projectName: string,
): string {
  return [
    command.file,
    ...command.prefixArgs,
    'pages',
    'deploy',
    '{dir}',
    '--project-name',
    projectName,
    '--branch',
    'main',
    '--commit-dirty=true',
    '--force',
  ]
    .map(quoteCommand)
    .join(' ');
}

function vercelUploadCommand(
  command: ProviderCommand,
  projectId: string,
  scope: string,
): string {
  return [
    command.file,
    ...command.prefixArgs,
    'deploy',
    '{dir}',
    '--yes',
    '--prod',
    '--project',
    projectId,
    '--scope',
    scope,
  ]
    .map(quoteCommand)
    .join(' ');
}

function deployDirectory(args: string[], provider: ProviderKind): string {
  const candidates =
    provider === 'netlify'
      ? optionValues(args, '--dir')
      : args.filter((arg) => path.isAbsolute(arg));
  const directory = candidates[0];
  if (candidates.length !== 1 || !directory) {
    throw new Error(`${provider} artifact deploy directory is invalid.`);
  }
  return directory;
}

function cloudflareDeployUrl(output: string): string {
  const deployment = output.match(
    /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pages\.dev/i,
  )?.[0];
  if (!deployment) {
    throw new Error('Cloudflare did not return a Pages deployment URL.');
  }
  return deployment;
}

function vercelDeployUrl(output: string): string {
  const raw = output.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Vercel did not return a deployment URL.');
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.vercel.app')) {
    throw new Error('Vercel returned an unexpected deployment URL.');
  }
  return raw;
}

function makeProviderPublisher(
  provider: Exclude<ProviderKind, 'netlify'>,
  command: ProviderCommand,
  target: { id: string; scope?: string; accountId?: string },
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
): HostPublisher {
  const config: ArtifactHostConfig = {
    uploadCommand:
      provider === 'cloudflare'
        ? cloudflareUploadCommand(command, target.id)
        : vercelUploadCommand(command, target.id, target.scope ?? ''),
    urlTemplate: '',
    urlFromCommandOutput: true,
    keyPrefix: 'artifacts',
  };
  return new HostPublisher(config, async (_file, args, signal) => {
    const providerArgs = args.slice(command.prefixArgs.length);
    const directory = deployDirectory(providerArgs, provider);
    const output = await runProvider(
      command,
      providerArgs,
      runtime,
      run,
      PUBLISH_TIMEOUT_MS,
      {
        cwd: directory,
        signal,
        ...(provider === 'cloudflare' && target.accountId
          ? { env: accountEnv(runtime, target.accountId) }
          : {}),
      },
    );
    return provider === 'cloudflare'
      ? cloudflareDeployUrl(output)
      : vercelDeployUrl(output);
  });
}

async function resolvePublisher(
  provider: ProviderKind,
  settings: ShareSettings,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<ResolvedPublisher | undefined> {
  const run = commandRunner(deps);
  const command = await resolveProviderCommand(
    provider,
    runtime,
    run,
    deps.platform ?? hostPlatform(),
  );
  if (!command) return undefined;
  if (provider === 'netlify') {
    const siteId =
      settings.netlify.siteId || netlifyConfiguredSiteId(settings.host);
    return siteId
      ? {
          provider,
          publisher: makeNetlifyPublisher(command, siteId, runtime, run),
          command,
          targetId: siteId,
        }
      : undefined;
  }
  if (provider === 'cloudflare') {
    const { accountId, projectName } = settings.cloudflare;
    return accountId && projectName
      ? {
          provider,
          publisher: makeProviderPublisher(
            provider,
            command,
            { id: projectName, accountId },
            runtime,
            run,
          ),
          command,
          targetId: projectName,
          accountId,
        }
      : undefined;
  }
  const { projectId, scope } = settings.vercel;
  return projectId && scope
    ? {
        provider,
        publisher: makeProviderPublisher(
          provider,
          command,
          { id: projectId, scope },
          runtime,
          run,
        ),
        command,
        targetId: projectId,
        scope,
      }
    : undefined;
}

function publicSiteRequest(siteId: string): string {
  return JSON.stringify({
    site_id: siteId,
    body: {
      password: '',
      password_context: 'all',
      sso_login: false,
      sso_login_context: 'all',
    },
  });
}

function isPublicSite(output: string): boolean {
  const site = parseJsonRecord(output);
  return site?.['sso_login'] === false && site['has_password'] === false;
}

async function makeSitePublic(
  command: NetlifyCommand,
  siteId: string,
  runtime: WorkspaceRuntime,
  run: ArtifactRouteCommandRunner,
): Promise<void> {
  try {
    await runNetlify(
      command,
      ['api', 'updateSite', '--data', publicSiteRequest(siteId)],
      runtime,
      run,
      ACCESS_TIMEOUT_MS,
    );
    const output = await runNetlify(
      command,
      ['api', 'getSite', '--data', JSON.stringify({ site_id: siteId })],
      runtime,
      run,
      ACCESS_TIMEOUT_MS,
    );
    if (isPublicSite(output)) return;
  } catch {
    assertRuntimeOpen(runtime);
  }
  throw new SetupError(
    502,
    'netlify_public_access_failed',
    'The artifact was published, but Netlify did not make the share link public. Try again.',
  );
}

async function defaultCheckPublicUrl(
  url: string,
  operationSignal?: AbortSignal,
): Promise<boolean> {
  try {
    const timeoutSignal = AbortSignal.timeout(PUBLIC_URL_ATTEMPT_TIMEOUT_MS);
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: operationSignal
        ? AbortSignal.any([operationSignal, timeoutSignal])
        : timeoutSignal,
      headers: { 'cache-control': 'no-cache' },
    });
    const reachable = response.ok;
    await response.body?.cancel();
    return reachable;
  } catch {
    operationSignal?.throwIfAborted();
    return false;
  }
}

function waitForPublicUrlRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForOperation(
  delayMs: number,
  deps: ArtifactPublishRouteDeps,
): Promise<void> {
  const signal = deps.operationSignal;
  signal?.throwIfAborted();
  const wait = deps.waitForPublicUrlRetry ?? waitForPublicUrlRetry;
  if (!signal) {
    await wait(delayMs);
    return;
  }
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([wait(delayMs), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  signal.throwIfAborted();
}

async function checkPublicUrlWithRetry(
  url: string,
  check: (url: string) => Promise<boolean>,
  wait: (delayMs: number) => Promise<void>,
  assertOpen: () => void,
): Promise<boolean> {
  for (const delayMs of PUBLIC_URL_RETRY_DELAYS_MS) {
    assertOpen();
    if (delayMs > 0) await wait(delayMs);
    assertOpen();
    const reachable = await check(url);
    assertOpen();
    if (reachable) return true;
  }
  return false;
}

async function verifyProviderTarget(
  resolved: ResolvedPublisher,
  settings: ShareSettings,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
): Promise<void> {
  const run = commandRunner(deps);
  if (resolved.provider === 'netlify') {
    const approvedSite = siteFromRecord(
      await readSiteRecord(resolved.command, resolved.targetId, runtime, run),
    );
    if (approvedSite?.id === resolved.targetId) return;
  } else if (resolved.provider === 'cloudflare' && resolved.accountId) {
    try {
      const projects = cloudflareProjects(
        await runProvider(
          resolved.command,
          ['pages', 'project', 'list', '--json'],
          runtime,
          run,
          AUTH_TIMEOUT_MS,
          { env: accountEnv(runtime, resolved.accountId) },
        ),
      );
      if (projects.some((project) => project.name === resolved.targetId))
        return;
    } catch {
      assertRuntimeOpen(runtime);
    }
  } else if (
    resolved.provider === 'vercel' &&
    resolved.scope &&
    settings.vercel.projectName
  ) {
    try {
      const listed = await readVercelProjects(
        resolved.command,
        runtime,
        run,
        settings.vercel.projectName,
        resolved.scope,
      );
      if (listed.projects.some((project) => project.id === resolved.targetId)) {
        return;
      }
    } catch {
      assertRuntimeOpen(runtime);
    }
  }
  throw new SetupError(
    409,
    `${resolved.provider}_project_unavailable`,
    `The dedicated ${resolved.provider} project is no longer available. Set up sharing again.`,
  );
}

async function handlePublish(
  req: Request,
  res: Response,
  runtime: WorkspaceRuntime,
  deps: ArtifactPublishRouteDeps,
  route: string,
): Promise<void> {
  if (!requireArtifactSharingEnabled(runtime, res)) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filePath = readString(body, 'path');
  const provider = readString(body, 'provider');
  if (!filePath) {
    res
      .status(400)
      .json({ error: '`path` is required', code: 'invalid_request' });
    return;
  }
  if (!PROVIDERS.includes(provider as ProviderKind)) {
    res.status(400).json({
      error: '`provider` must be "cloudflare", "vercel", or "netlify"',
      code: 'invalid_request',
    });
    return;
  }
  if (body['force'] !== undefined && typeof body['force'] !== 'boolean') {
    res.status(400).json({
      error: '`force` must be a boolean',
      code: 'invalid_request',
    });
    return;
  }

  const abortScope = requestAbortScope(req, res);
  const operationDeps = withCommandSignal(deps, abortScope.signal);
  try {
    assertRuntimeOpen(runtime);
    const selectedProvider = provider as ProviderKind;
    const fs = runtime.routeFileSystemFactory.forRequest({ route });
    const resolved = await fs.resolve(filePath, 'read');
    assertRuntimeOpen(runtime);
    const html = await readWholeFile(fs, resolved);
    assertRuntimeOpen(runtime);
    if (html === null) {
      res.status(400).json({
        error: `Artifact is larger than the ${MAX_PUBLISH_BYTES} byte publish limit.`,
        code: 'artifact_too_large',
      });
      return;
    }
    const title =
      readString(body, 'title') || resolved.split(/[\\/]/).pop() || 'artifact';
    const artifactId = artifactIdFromPath(resolved);
    const contentHash = artifactContentHash(html);
    const outcome = await withPublishLock(runtime.workspaceCwd, async () => {
      const settings = readShareSettings(runtime.workspaceCwd);
      const existing = publicationFor(settings, selectedProvider, artifactId);
      if (body['force'] !== true && existing?.contentHash === contentHash) {
        return {
          id: existing.publishedId,
          url: existing.url,
          publishedAt: existing.publishedAt,
          reused: true,
          recorded: true,
        };
      }

      const resolvedPublisher = await resolvePublisher(
        selectedProvider,
        settings,
        runtime,
        operationDeps,
      );
      if (!resolvedPublisher) {
        throw new SetupError(
          400,
          `${selectedProvider}_not_configured`,
          `${selectedProvider} sharing is not ready yet.`,
        );
      }
      const run = commandRunner(operationDeps);
      await verifyProviderTarget(
        resolvedPublisher,
        settings,
        runtime,
        operationDeps,
      );
      const published = await resolvedPublisher.publisher
        .publish(
          {
            id: artifactId,
            title,
            html,
          },
          abortScope.signal,
        )
        .catch(() => {
          abortScope.signal.throwIfAborted();
          assertRuntimeOpen(runtime);
          throw new SetupError(
            502,
            `${selectedProvider}_publish_failed`,
            `Could not publish the artifact through ${selectedProvider}. Try again.`,
          );
        });
      if (selectedProvider === 'netlify' && settings.netlify.siteId) {
        // Only the dedicated site this flow created may have protection
        // stripped; a host-configured site keeps its password/SSO settings.
        await makeSitePublic(
          resolvedPublisher.command,
          resolvedPublisher.targetId,
          runtime,
          run,
        );
      }
      const publicUrl =
        operationDeps.checkPublicUrl ??
        ((url: string) => defaultCheckPublicUrl(url, abortScope.signal));
      const publicUrlReady = await checkPublicUrlWithRetry(
        published.url,
        publicUrl,
        (delayMs) => waitForOperation(delayMs, operationDeps),
        () => {
          abortScope.signal.throwIfAborted();
          assertRuntimeOpen(runtime);
        },
      );
      if (!publicUrlReady) {
        throw new SetupError(
          502,
          `${selectedProvider}_public_access_failed`,
          `The artifact was published, but the ${selectedProvider} link is not publicly accessible. Try again.`,
        );
      }

      const publishedAt = new Date().toISOString();
      const targetId = configuredTargetId(settings, selectedProvider);
      const recorded = await savePublication(runtime, operationDeps, settings, {
        provider: selectedProvider,
        targetId,
        artifactId,
        contentHash,
        publishedId: published.id,
        url: published.url,
        publishedAt,
      });
      return {
        id: published.id,
        url: published.url,
        publishedAt,
        reused: false,
        recorded,
      };
    });

    assertRuntimeOpen(runtime);
    applyReadHeaders(res);
    res.status(200).json({
      v: 1,
      workspaceCwd: runtime.workspaceCwd,
      id: outcome.id,
      url: outcome.url,
      provider: selectedProvider,
      publishedAt: outcome.publishedAt,
      reused: outcome.reused,
      recorded: outcome.recorded,
    });
  } catch (err) {
    if (abortScope.signal.aborted || res.destroyed) return;
    if (err instanceof SetupError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    if (isFsError(err)) {
      sendFsError(res, err, route);
      return;
    }
    deps.sendBridgeError(res, err, { route });
  } finally {
    abortScope.dispose();
  }
}

function resolveTrustedRuntime(
  registry: WorkspaceRegistry,
  req: Request,
  res: Response,
): WorkspaceRuntime | null {
  const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
  if (!runtime) return null;
  return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
}

function resolvePrimaryRuntime(
  getPrimaryRuntime: () => WorkspaceRuntime,
  res: Response,
  sendBridgeError: SendBridgeError,
  route: string,
): WorkspaceRuntime | null {
  try {
    const runtime = getPrimaryRuntime();
    return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
  } catch (err) {
    sendBridgeError(res, err, { route });
    return null;
  }
}

export function registerWorkspaceArtifactPublishRoutes(
  app: Application,
  deps: ArtifactPublishRouteDeps & {
    getPrimaryRuntime: () => WorkspaceRuntime;
  },
): void {
  app.get('/workspace/artifact/publish-config', (req, res) => {
    const route = 'GET /workspace/artifact/publish-config';
    const runtime = resolvePrimaryRuntime(
      deps.getPrimaryRuntime,
      res,
      deps.sendBridgeError,
      route,
    );
    if (!runtime) return;
    void handleConfig(req, res, runtime, deps, route);
  });
  app.post(
    '/workspace/artifact/:provider/setup',
    deps.mutate({ strict: true }),
    (req, res) => {
      const provider = req.params['provider'];
      if (!PROVIDERS.includes(provider as ProviderKind)) {
        res.status(404).json({
          error: 'Unknown artifact sharing provider.',
          code: 'provider_not_found',
        });
        return;
      }
      const selectedProvider = provider as ProviderKind;
      const route = 'POST /workspace/artifact/:provider/setup';
      const runtime = resolvePrimaryRuntime(
        deps.getPrimaryRuntime,
        res,
        deps.sendBridgeError,
        route,
      );
      if (!runtime) return;
      if (selectedProvider === 'netlify') {
        void handleSetup(req, res, runtime, deps, route);
      } else {
        void handleProviderSetup(
          selectedProvider,
          req,
          res,
          runtime,
          deps,
          route,
        );
      }
    },
  );
  app.post(
    '/workspace/artifact/publish',
    deps.mutate({ strict: true }),
    (req, res) => {
      const route = 'POST /workspace/artifact/publish';
      const runtime = resolvePrimaryRuntime(
        deps.getPrimaryRuntime,
        res,
        deps.sendBridgeError,
        route,
      );
      if (!runtime) return;
      void handlePublish(req, res, runtime, deps, route);
    },
  );
}

export function registerWorkspaceQualifiedArtifactPublishRoutes(
  app: Application,
  deps: ArtifactPublishRouteDeps & {
    workspaceRegistry: WorkspaceRegistry;
  },
): void {
  app.get('/workspaces/:workspace/artifact/publish-config', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    void handleConfig(
      req,
      res,
      runtime,
      deps,
      'GET /workspaces/:workspace/artifact/publish-config',
    );
  });
  app.post(
    '/workspaces/:workspace/artifact/:provider/setup',
    deps.mutate({ strict: true }),
    (req, res) => {
      const provider = req.params['provider'];
      if (!PROVIDERS.includes(provider as ProviderKind)) {
        res.status(404).json({
          error: 'Unknown artifact sharing provider.',
          code: 'provider_not_found',
        });
        return;
      }
      const selectedProvider = provider as ProviderKind;
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      const route = 'POST /workspaces/:workspace/artifact/:provider/setup';
      if (selectedProvider === 'netlify') {
        void handleSetup(req, res, runtime, deps, route);
      } else {
        void handleProviderSetup(
          selectedProvider,
          req,
          res,
          runtime,
          deps,
          route,
        );
      }
    },
  );
  app.post(
    '/workspaces/:workspace/artifact/publish',
    deps.mutate({ strict: true }),
    (req, res) => {
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      void handlePublish(
        req,
        res,
        runtime,
        deps,
        'POST /workspaces/:workspace/artifact/publish',
      );
    },
  );
}
