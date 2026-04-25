/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DesktopServerInfo } from '../../shared/desktopApi.js';
import type {
  DesktopApprovalMode,
  DesktopSessionModeState,
  DesktopSessionModelState,
} from '../../shared/desktopProtocol.js';

export interface DesktopHealth {
  ok: true;
  service: 'qwen-desktop';
  uptimeMs: number;
  timestamp: string;
}

export interface DesktopConnectionStatus {
  serverInfo: DesktopServerInfo;
  serverUrl: string;
  health: DesktopHealth;
  runtime: DesktopRuntime;
}

export interface DesktopGitStatus {
  branch: string | null;
  modified: number;
  staged: number;
  untracked: number;
  ahead: number;
  behind: number;
  clean: boolean;
  isRepository: boolean;
  error?: string;
}

export interface DesktopProject {
  id: string;
  name: string;
  path: string;
  gitBranch: string | null;
  gitStatus: DesktopGitStatus;
  lastOpenedAt: number;
}

export interface DesktopProjectList {
  projects: DesktopProject[];
}

export type DesktopGitChangeStatus =
  | 'added'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'untracked'
  | 'unknown';

export type DesktopGitChangeSource = 'staged' | 'unstaged' | 'untracked';

export interface DesktopGitDiffHunk {
  id: string;
  source: DesktopGitChangeSource;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DesktopGitChangedFile {
  path: string;
  status: DesktopGitChangeStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  diff: string;
  hunks: DesktopGitDiffHunk[];
}

export interface DesktopGitDiff {
  ok: true;
  files: DesktopGitChangedFile[];
  diff: string;
  generatedAt: string;
}

export interface DesktopGitReviewMutation {
  ok: true;
  status: DesktopGitStatus;
  diff: DesktopGitDiff;
}

export interface DesktopGitCommitMutation extends DesktopGitReviewMutation {
  commit: {
    commit: string;
    summary: string;
  };
}

export type DesktopGitReviewTarget =
  | { scope: 'all' }
  | { scope: 'file'; filePath: string }
  | { scope: 'hunk'; filePath: string; hunkId: string };

export type DesktopTerminalStatus = 'running' | 'exited' | 'failed' | 'killed';

export interface DesktopTerminal {
  id: string;
  projectId: string;
  cwd: string;
  command: string;
  status: DesktopTerminalStatus;
  output: string;
  exitCode: number | null;
  signal: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopRuntime {
  ok: true;
  desktop: {
    version: string;
    electronVersion: string | null;
    nodeVersion: string;
  };
  cli: {
    path: string | null;
    channel: 'ACP';
    acpReady: boolean;
  };
  platform: {
    type: string;
    arch: string;
    release: string;
  };
  auth: {
    status: 'unknown' | 'authenticated';
    account: {
      authType: string | null;
      model: string | null;
      baseUrl: string | null;
      apiKeyEnvKey: string | null;
    } | null;
  };
}

export interface DesktopSessionSummary {
  sessionId: string;
  title?: string;
  cwd?: string;
  models?: DesktopSessionModelState;
  modes?: DesktopSessionModeState;
}

export interface DesktopSessionList {
  sessions: DesktopSessionSummary[];
  nextCursor?: string;
}

export interface DesktopUserSettings {
  ok: true;
  settingsPath: string;
  provider: 'api-key' | 'coding-plan' | 'none';
  selectedAuthType: string | null;
  model: {
    name: string | null;
  };
  codingPlan: {
    region: 'china' | 'global';
    hasApiKey: boolean;
    version: string | null;
  };
  openai: {
    hasApiKey: boolean;
    providers: Array<{
      id: string;
      name: string;
      baseUrl: string;
      envKey: string;
    }>;
  };
}

export interface UpdateDesktopSettingsRequest {
  provider: 'api-key' | 'coding-plan';
  apiKey?: string;
  codingPlanRegion?: 'china' | 'global';
  activeModel?: string;
  modelProviders?: Record<string, string>;
}

export async function loadDesktopStatus(): Promise<DesktopConnectionStatus> {
  const serverInfo = await getServerInfo();
  const [health, runtime] = await Promise.all([
    getJson(serverInfo, '/health', isDesktopHealth),
    getJson(serverInfo, '/api/runtime', isDesktopRuntime),
  ]);

  return {
    serverInfo,
    serverUrl: serverInfo.url,
    health,
    runtime,
  };
}

export async function listDesktopSessions(
  serverInfo: DesktopServerInfo,
  cwd?: string,
): Promise<DesktopSessionList> {
  const url = new URL('/api/sessions', serverInfo.url);
  if (cwd) {
    url.searchParams.set('cwd', cwd);
  }

  return getJson(serverInfo, `${url.pathname}${url.search}`, isSessionList);
}

export async function listDesktopProjects(
  serverInfo: DesktopServerInfo,
): Promise<DesktopProjectList> {
  return getJson(serverInfo, '/api/projects', isProjectListResponse);
}

export async function openDesktopProject(
  serverInfo: DesktopServerInfo,
  path: string,
): Promise<DesktopProject> {
  const response = await writeJson(
    serverInfo,
    '/api/projects/open',
    'POST',
    { path },
    isOpenProjectResponse,
  );
  return response.project;
}

export async function getDesktopProjectGitStatus(
  serverInfo: DesktopServerInfo,
  projectId: string,
): Promise<DesktopGitStatus> {
  const response = await getJson(
    serverInfo,
    `/api/projects/${encodeURIComponent(projectId)}/git/status`,
    isGitStatusResponse,
  );
  return response.status;
}

export async function getDesktopProjectGitDiff(
  serverInfo: DesktopServerInfo,
  projectId: string,
): Promise<DesktopGitDiff> {
  return getJson(
    serverInfo,
    `/api/projects/${encodeURIComponent(projectId)}/git/diff`,
    isGitDiff,
  );
}

export async function stageDesktopProjectChanges(
  serverInfo: DesktopServerInfo,
  projectId: string,
  target: DesktopGitReviewTarget = { scope: 'all' },
): Promise<DesktopGitReviewMutation> {
  return writeJson(
    serverInfo,
    `/api/projects/${encodeURIComponent(projectId)}/git/stage`,
    'POST',
    target,
    isGitReviewMutation,
  );
}

export async function revertDesktopProjectChanges(
  serverInfo: DesktopServerInfo,
  projectId: string,
  target: DesktopGitReviewTarget = { scope: 'all' },
): Promise<DesktopGitReviewMutation> {
  return writeJson(
    serverInfo,
    `/api/projects/${encodeURIComponent(projectId)}/git/revert`,
    'POST',
    target,
    isGitReviewMutation,
  );
}

export async function commitDesktopProjectChanges(
  serverInfo: DesktopServerInfo,
  projectId: string,
  message: string,
): Promise<DesktopGitCommitMutation> {
  return writeJson(
    serverInfo,
    `/api/projects/${encodeURIComponent(projectId)}/git/commit`,
    'POST',
    { message },
    isGitCommitMutation,
  );
}

export async function runDesktopTerminalCommand(
  serverInfo: DesktopServerInfo,
  projectId: string,
  command: string,
): Promise<DesktopTerminal> {
  const response = await writeJson(
    serverInfo,
    '/api/terminals',
    'POST',
    { projectId, command },
    isTerminalResponse,
  );
  return response.terminal;
}

export async function getDesktopTerminal(
  serverInfo: DesktopServerInfo,
  terminalId: string,
): Promise<DesktopTerminal> {
  const response = await getJson(
    serverInfo,
    `/api/terminals/${encodeURIComponent(terminalId)}`,
    isTerminalResponse,
  );
  return response.terminal;
}

export async function killDesktopTerminal(
  serverInfo: DesktopServerInfo,
  terminalId: string,
): Promise<DesktopTerminal> {
  const response = await writeJson(
    serverInfo,
    `/api/terminals/${encodeURIComponent(terminalId)}/kill`,
    'POST',
    {},
    isTerminalResponse,
  );
  return response.terminal;
}

export async function writeDesktopTerminalInput(
  serverInfo: DesktopServerInfo,
  terminalId: string,
  input: string,
): Promise<DesktopTerminal> {
  const response = await writeJson(
    serverInfo,
    `/api/terminals/${encodeURIComponent(terminalId)}/write`,
    'POST',
    { input },
    isTerminalResponse,
  );
  return response.terminal;
}

export async function createDesktopSession(
  serverInfo: DesktopServerInfo,
  cwd: string,
): Promise<DesktopSessionSummary> {
  const response = await writeJson(
    serverInfo,
    '/api/sessions',
    'POST',
    { cwd },
    isCreateSessionResponse,
  );
  return response.session;
}

export async function loadDesktopSession(
  serverInfo: DesktopServerInfo,
  sessionId: string,
  cwd: string,
): Promise<DesktopSessionSummary> {
  const response = await writeJson(
    serverInfo,
    `/api/sessions/${encodeURIComponent(sessionId)}/load`,
    'POST',
    { cwd },
    isCreateSessionResponse,
  );
  return response.session;
}

export async function getDesktopUserSettings(
  serverInfo: DesktopServerInfo,
): Promise<DesktopUserSettings> {
  return getJson(serverInfo, '/api/settings/user', isDesktopUserSettings);
}

export async function updateDesktopUserSettings(
  serverInfo: DesktopServerInfo,
  request: UpdateDesktopSettingsRequest,
): Promise<DesktopUserSettings> {
  return writeJson(
    serverInfo,
    '/api/settings/user',
    'PUT',
    request,
    isDesktopUserSettings,
  );
}

export async function authenticateDesktop(
  serverInfo: DesktopServerInfo,
  methodId: string,
): Promise<void> {
  await writeJson(
    serverInfo,
    `/api/auth/${encodeURIComponent(methodId)}`,
    'POST',
    {},
    isOkResponse,
  );
}

export async function getDesktopSessionModelState(
  serverInfo: DesktopServerInfo,
  sessionId: string,
): Promise<DesktopSessionModelState> {
  const response = await getJson(
    serverInfo,
    `/api/sessions/${encodeURIComponent(sessionId)}/model`,
    isModelStateResponse,
  );
  return response.models;
}

export async function setDesktopSessionModel(
  serverInfo: DesktopServerInfo,
  sessionId: string,
  modelId: string,
): Promise<DesktopSessionModelState> {
  const response = await writeJson(
    serverInfo,
    `/api/sessions/${encodeURIComponent(sessionId)}/model`,
    'PUT',
    { modelId },
    isModelStateResponse,
  );
  return response.models;
}

export async function getDesktopSessionModeState(
  serverInfo: DesktopServerInfo,
  sessionId: string,
): Promise<DesktopSessionModeState> {
  const response = await getJson(
    serverInfo,
    `/api/sessions/${encodeURIComponent(sessionId)}/mode`,
    isModeStateResponse,
  );
  return response.modes;
}

export async function setDesktopSessionMode(
  serverInfo: DesktopServerInfo,
  sessionId: string,
  mode: DesktopApprovalMode,
): Promise<DesktopSessionModeState> {
  const response = await writeJson(
    serverInfo,
    `/api/sessions/${encodeURIComponent(sessionId)}/mode`,
    'PUT',
    { mode },
    isModeStateResponse,
  );
  return response.modes;
}

async function getJson<T>(
  serverInfo: DesktopServerInfo,
  path: string,
  isExpectedPayload: (value: unknown) => value is T,
): Promise<T> {
  const response = await fetch(new URL(path, serverInfo.url), {
    headers: {
      Authorization: `Bearer ${serverInfo.token}`,
    },
  });
  const payload = (await response.json()) as unknown;

  if (!response.ok || !isExpectedPayload(payload)) {
    throw new Error(getResponseErrorMessage(payload, path));
  }

  return payload;
}

async function writeJson<T>(
  serverInfo: DesktopServerInfo,
  path: string,
  method: 'POST' | 'PUT' | 'PATCH',
  body: unknown,
  isExpectedPayload: (value: unknown) => value is T,
): Promise<T> {
  const response = await fetch(new URL(path, serverInfo.url), {
    method,
    headers: {
      Authorization: `Bearer ${serverInfo.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as unknown;

  if (!response.ok || !isExpectedPayload(payload)) {
    throw new Error(getResponseErrorMessage(payload, path));
  }

  return payload;
}

async function getServerInfo(): Promise<DesktopServerInfo> {
  if (!window.qwenDesktop) {
    throw new Error('Desktop preload API is unavailable.');
  }

  return window.qwenDesktop.getServerInfo();
}

function getResponseErrorMessage(payload: unknown, path: string): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof payload.message === 'string'
  ) {
    return payload.message;
  }

  return `Desktop service request failed: ${path}`;
}

function isDesktopHealth(value: unknown): value is DesktopHealth {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopHealth>;
  return (
    candidate.ok === true &&
    candidate.service === 'qwen-desktop' &&
    typeof candidate.uptimeMs === 'number' &&
    typeof candidate.timestamp === 'string'
  );
}

function isDesktopRuntime(value: unknown): value is DesktopRuntime {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopRuntime>;
  const auth = candidate.auth;
  return (
    candidate.ok === true &&
    isDesktopRuntimeDesktop(candidate.desktop) &&
    isDesktopRuntimeCli(candidate.cli) &&
    isDesktopRuntimePlatform(candidate.platform) &&
    !!auth &&
    (auth.status === 'unknown' || auth.status === 'authenticated') &&
    (auth.account === null || isRuntimeAccount(auth.account))
  );
}

function isDesktopRuntimeDesktop(
  value: DesktopRuntime['desktop'] | undefined,
): value is DesktopRuntime['desktop'] {
  return (
    !!value &&
    typeof value.version === 'string' &&
    (typeof value.electronVersion === 'string' ||
      value.electronVersion === null) &&
    typeof value.nodeVersion === 'string'
  );
}

function isDesktopRuntimeCli(
  value: DesktopRuntime['cli'] | undefined,
): value is DesktopRuntime['cli'] {
  return (
    !!value &&
    (typeof value.path === 'string' || value.path === null) &&
    value.channel === 'ACP' &&
    typeof value.acpReady === 'boolean'
  );
}

function isRuntimeAccount(
  value: unknown,
): value is DesktopRuntime['auth']['account'] {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as NonNullable<DesktopRuntime['auth']['account']>;
  return (
    isNullableString(candidate.authType) &&
    isNullableString(candidate.model) &&
    isNullableString(candidate.baseUrl) &&
    isNullableString(candidate.apiKeyEnvKey)
  );
}

function isDesktopRuntimePlatform(
  value: DesktopRuntime['platform'] | undefined,
): value is DesktopRuntime['platform'] {
  return (
    !!value &&
    typeof value.type === 'string' &&
    typeof value.arch === 'string' &&
    typeof value.release === 'string'
  );
}

function isSessionList(value: unknown): value is DesktopSessionList {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { sessions?: unknown; nextCursor?: unknown };
  return (
    Array.isArray(candidate.sessions) &&
    candidate.sessions.every(isSessionSummary) &&
    (typeof candidate.nextCursor === 'string' ||
      candidate.nextCursor === undefined)
  );
}

function isProjectListResponse(value: unknown): value is DesktopProjectList {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { projects?: unknown };
  return (
    Array.isArray(candidate.projects) &&
    candidate.projects.every(isDesktopProject)
  );
}

function isOpenProjectResponse(
  value: unknown,
): value is { ok: true; project: DesktopProject } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { ok?: unknown; project?: unknown };
  return candidate.ok === true && isDesktopProject(candidate.project);
}

function isGitStatusResponse(
  value: unknown,
): value is { ok: true; status: DesktopGitStatus } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { ok?: unknown; status?: unknown };
  return candidate.ok === true && isGitStatus(candidate.status);
}

function isGitDiff(value: unknown): value is DesktopGitDiff {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopGitDiff>;
  return (
    candidate.ok === true &&
    Array.isArray(candidate.files) &&
    candidate.files.every(isGitChangedFile) &&
    typeof candidate.diff === 'string' &&
    typeof candidate.generatedAt === 'string'
  );
}

function isGitReviewMutation(
  value: unknown,
): value is DesktopGitReviewMutation {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopGitReviewMutation>;
  return (
    candidate.ok === true &&
    isGitStatus(candidate.status) &&
    isGitDiff(candidate.diff)
  );
}

function isGitCommitMutation(
  value: unknown,
): value is DesktopGitCommitMutation {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopGitCommitMutation>;
  return (
    isGitReviewMutation(value) &&
    !!candidate.commit &&
    typeof candidate.commit.commit === 'string' &&
    typeof candidate.commit.summary === 'string'
  );
}

function isTerminalResponse(
  value: unknown,
): value is { ok: true; terminal: DesktopTerminal } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { ok?: unknown; terminal?: unknown };
  return candidate.ok === true && isDesktopTerminal(candidate.terminal);
}

function isCreateSessionResponse(
  value: unknown,
): value is { ok: true; session: DesktopSessionSummary } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { ok?: unknown; session?: unknown };
  return candidate.ok === true && isSessionSummary(candidate.session);
}

function isDesktopUserSettings(value: unknown): value is DesktopUserSettings {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as DesktopUserSettings;
  return (
    candidate.ok === true &&
    typeof candidate.settingsPath === 'string' &&
    (candidate.provider === 'api-key' ||
      candidate.provider === 'coding-plan' ||
      candidate.provider === 'none') &&
    isNullableString(candidate.selectedAuthType) &&
    !!candidate.model &&
    isNullableString(candidate.model.name) &&
    !!candidate.codingPlan &&
    (candidate.codingPlan.region === 'china' ||
      candidate.codingPlan.region === 'global') &&
    typeof candidate.codingPlan.hasApiKey === 'boolean' &&
    isNullableString(candidate.codingPlan.version) &&
    !!candidate.openai &&
    typeof candidate.openai.hasApiKey === 'boolean' &&
    Array.isArray(candidate.openai.providers)
  );
}

function isModelStateResponse(
  value: unknown,
): value is { ok: true; models: DesktopSessionModelState } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { ok?: unknown; models?: unknown };
  return candidate.ok === true && isModelState(candidate.models);
}

function isModeStateResponse(
  value: unknown,
): value is { ok: true; modes: DesktopSessionModeState } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { ok?: unknown; modes?: unknown };
  return candidate.ok === true && isModeState(candidate.modes);
}

function isOkResponse(value: unknown): value is { ok: true } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { ok?: unknown }).ok === true
  );
}

function isSessionSummary(value: unknown): value is DesktopSessionSummary {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopSessionSummary>;
  return (
    typeof candidate.sessionId === 'string' &&
    (typeof candidate.title === 'string' || candidate.title === undefined) &&
    (typeof candidate.cwd === 'string' || candidate.cwd === undefined) &&
    (candidate.models === undefined || isModelState(candidate.models)) &&
    (candidate.modes === undefined || isModeState(candidate.modes))
  );
}

function isDesktopProject(value: unknown): value is DesktopProject {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopProject>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.path === 'string' &&
    (typeof candidate.gitBranch === 'string' || candidate.gitBranch === null) &&
    typeof candidate.lastOpenedAt === 'number' &&
    isGitStatus(candidate.gitStatus)
  );
}

function isGitStatus(value: unknown): value is DesktopGitStatus {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopGitStatus>;
  return (
    (typeof candidate.branch === 'string' || candidate.branch === null) &&
    typeof candidate.modified === 'number' &&
    typeof candidate.staged === 'number' &&
    typeof candidate.untracked === 'number' &&
    typeof candidate.ahead === 'number' &&
    typeof candidate.behind === 'number' &&
    typeof candidate.clean === 'boolean' &&
    typeof candidate.isRepository === 'boolean' &&
    (typeof candidate.error === 'string' || candidate.error === undefined)
  );
}

function isGitChangedFile(value: unknown): value is DesktopGitChangedFile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopGitChangedFile>;
  return (
    typeof candidate.path === 'string' &&
    isGitChangeStatus(candidate.status) &&
    typeof candidate.staged === 'boolean' &&
    typeof candidate.unstaged === 'boolean' &&
    typeof candidate.untracked === 'boolean' &&
    typeof candidate.diff === 'string' &&
    Array.isArray(candidate.hunks) &&
    candidate.hunks.every(isGitDiffHunk)
  );
}

function isGitDiffHunk(value: unknown): value is DesktopGitDiffHunk {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopGitDiffHunk>;
  return (
    typeof candidate.id === 'string' &&
    isGitChangeSource(candidate.source) &&
    typeof candidate.header === 'string' &&
    typeof candidate.oldStart === 'number' &&
    typeof candidate.oldLines === 'number' &&
    typeof candidate.newStart === 'number' &&
    typeof candidate.newLines === 'number' &&
    Array.isArray(candidate.lines) &&
    candidate.lines.every((line) => typeof line === 'string')
  );
}

function isGitChangeStatus(value: unknown): value is DesktopGitChangeStatus {
  return (
    value === 'added' ||
    value === 'copied' ||
    value === 'deleted' ||
    value === 'modified' ||
    value === 'renamed' ||
    value === 'untracked' ||
    value === 'unknown'
  );
}

function isGitChangeSource(value: unknown): value is DesktopGitChangeSource {
  return value === 'staged' || value === 'unstaged' || value === 'untracked';
}

function isDesktopTerminal(value: unknown): value is DesktopTerminal {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DesktopTerminal>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.cwd === 'string' &&
    typeof candidate.command === 'string' &&
    isTerminalStatus(candidate.status) &&
    typeof candidate.output === 'string' &&
    (typeof candidate.exitCode === 'number' || candidate.exitCode === null) &&
    (typeof candidate.signal === 'string' || candidate.signal === null) &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
  );
}

function isTerminalStatus(value: unknown): value is DesktopTerminalStatus {
  return (
    value === 'running' ||
    value === 'exited' ||
    value === 'failed' ||
    value === 'killed'
  );
}

function isModelState(value: unknown): value is DesktopSessionModelState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as DesktopSessionModelState;
  return (
    typeof candidate.currentModelId === 'string' &&
    Array.isArray(candidate.availableModels) &&
    candidate.availableModels.every(
      (model) =>
        !!model &&
        typeof model === 'object' &&
        typeof model.modelId === 'string' &&
        typeof model.name === 'string',
    )
  );
}

function isModeState(value: unknown): value is DesktopSessionModeState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as DesktopSessionModeState;
  return (
    isApprovalMode(candidate.currentModeId) &&
    Array.isArray(candidate.availableModes) &&
    candidate.availableModes.every(
      (mode) =>
        !!mode &&
        typeof mode === 'object' &&
        isApprovalMode(mode.id) &&
        typeof mode.name === 'string' &&
        typeof mode.description === 'string',
    )
  );
}

function isApprovalMode(value: unknown): value is DesktopApprovalMode {
  return (
    value === 'plan' ||
    value === 'default' ||
    value === 'auto-edit' ||
    value === 'yolo'
  );
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}
