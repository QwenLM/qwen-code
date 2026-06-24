/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import stripJsonComments from 'strip-json-comments';
import { V1_INDICATOR_KEYS } from '../config/migration/versions/v1-to-v2-shared.js';
import {
  DEFAULT_EXCLUDED_ENV_VARS,
  HOME_ENV_BOOTSTRAP_KEYS,
  PROJECT_ENV_HARDCODED_EXCLUSIONS,
} from '../config/shared-env-keys.js';
import {
  getGlobalQwenDirLite,
  getSystemDefaultsPath,
  getSystemSettingsPath,
  SETTINGS_DIRECTORY_NAME,
} from '../config/storage-paths-lite.js';
import {
  getPathComparisonVariants,
  isWithinRoot,
} from '../config/path-comparison.js';
import type { Settings } from '../config/settingsSchema.js';
import { resolveEnvVarsInObject } from '../utils/envVarResolver.js';

type ServeFastPathPolicy = Pick<
  NonNullable<Settings['policy']>,
  'consensusQuorum' | 'permissionStrategy'
>;
type ServeFastPathPolicyInput = {
  [Key in keyof ServeFastPathPolicy]?: unknown;
};
export type ServeFastPathSettings = Pick<
  Settings,
  'advanced' | 'context' | 'env' | 'security' | 'tools'
> & {
  policy?: ServeFastPathPolicyInput;
};
const V2_SETTINGS_VERSION = 2;
const TRUST_FOLDER = 'TRUST_FOLDER';
const TRUST_PARENT = 'TRUST_PARENT';
const DO_NOT_TRUST = 'DO_NOT_TRUST';
let homeEnvBootstrapped = false;
let cachedTrustedFoldersPath: string | undefined;
let cachedTrustedFolders: Record<string, string> | undefined;

function getTrustedFoldersPathFastPath(): string {
  return (
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] ??
    path.join(getGlobalQwenDirLite(), 'trustedFolders.json')
  );
}

function getUserLevelEnvPathsFastPath(): Set<string> {
  const homeDir = os.homedir();
  const globalQwenDir = getGlobalQwenDirLite();
  return new Set([
    path.normalize(path.join(homeDir, '.env')),
    path.normalize(path.join(globalQwenDir, '.env')),
    path.normalize(path.join(homeDir, SETTINGS_DIRECTORY_NAME, '.env')),
  ]);
}

export function preResolveServeFastPathHomeEnvOverrides(): void {
  if (homeEnvBootstrapped) return;
  homeEnvBootstrapped = true;

  if (HOME_ENV_BOOTSTRAP_KEYS.every((key) => process.env[key])) {
    return;
  }

  const initialQwenHome = process.env['QWEN_HOME'];
  const initialQwenDir = getGlobalQwenDirLite();
  readHomeEnvIntoFastPath(path.join(initialQwenDir, '.env'));
  if (!initialQwenHome) {
    readHomeEnvIntoFastPath(path.join(path.dirname(initialQwenDir), '.env'));
  }

  const discoveredQwenHome = process.env['QWEN_HOME'];
  if (discoveredQwenHome && discoveredQwenHome !== initialQwenHome) {
    const discoveredDir = getGlobalQwenDirLite();
    if (discoveredDir !== initialQwenDir) {
      readHomeEnvIntoFastPath(path.join(discoveredDir, '.env'));
    }
  }
}

function readHomeEnvIntoFastPath(file: string): void {
  if (!fs.existsSync(file)) return;
  try {
    const parsed = dotenv.parse(fs.readFileSync(file, 'utf8'));
    for (const key of PROJECT_ENV_HARDCODED_EXCLUSIONS) {
      if (parsed[key] && !Object.hasOwn(process.env, key)) {
        process.env[key] = parsed[key];
      }
    }
  } catch {
    // Match dotenv quiet-mode behavior used by the full environment loader.
  }
}

/** Test-only: reset the home-env bootstrap latch. */
export function resetServeFastPathHomeEnvBootstrapForTesting(): void {
  homeEnvBootstrapped = false;
  cachedTrustedFoldersPath = undefined;
  cachedTrustedFolders = undefined;
}

function getHomeEnvFallbackVarsFastPath(): Record<string, string> {
  const globalQwenDir = getGlobalQwenDirLite();
  const candidates = [path.join(globalQwenDir, '.env')];
  if (!process.env['QWEN_HOME']) {
    candidates.push(path.join(path.dirname(globalQwenDir), '.env'));
  }

  const result: Record<string, string> = {};
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = dotenv.parse(fs.readFileSync(candidate, 'utf8'));
      for (const key in parsed) {
        if (Object.hasOwn(parsed, key) && !Object.hasOwn(process.env, key)) {
          result[key] ??= parsed[key]!;
        }
      }
    } catch {
      // Ignore home .env read failures on the fast path; full loader reports.
    }
  }
  return result;
}

function findEnvFilesFastPath(
  settings: ServeFastPathSettings,
  startDir: string,
  userLevelPaths: Set<string> = getUserLevelEnvPathsFastPath(),
): string[] {
  const homeDir = os.homedir();
  let realStartDir = path.resolve(startDir);
  try {
    realStartDir = fs.realpathSync(realStartDir);
  } catch {
    // Match loadSettings(): use the resolved path when realpath is unavailable.
  }
  const isTrusted = isWorkspaceTrustedFastPath(settings, realStartDir);

  const globalQwenDir = getGlobalQwenDirLite();
  const legacyQwenDir = path.normalize(
    path.join(homeDir, SETTINGS_DIRECTORY_NAME),
  );
  const hasCustomConfigDir = path.normalize(globalQwenDir) !== legacyQwenDir;
  const found: string[] = [];
  const seen = new Set<string>();

  const canUseEnvFile = (filePath: string): boolean =>
    isTrusted !== false || userLevelPaths.has(path.normalize(filePath));

  const pushCandidate = (filePath: string): boolean => {
    const normalized = path.normalize(filePath);
    if (
      !seen.has(normalized) &&
      fs.existsSync(filePath) &&
      canUseEnvFile(filePath)
    ) {
      seen.add(normalized);
      found.push(filePath);
      return true;
    }
    return false;
  };

  const pushHomeCandidates = (): void => {
    const candidates = [path.join(globalQwenDir, '.env')];
    if (hasCustomConfigDir) {
      candidates.push(path.join(legacyQwenDir, '.env'));
    }
    candidates.push(path.join(homeDir, '.env'));
    for (const candidate of candidates) {
      pushCandidate(candidate);
    }
  };

  let currentDir = realStartDir;
  let visitedHomeDir = false;
  while (true) {
    if (currentDir === homeDir) {
      visitedHomeDir = true;
      pushHomeCandidates();
      return found;
    } else {
      const qwenEnvPath = path.join(
        currentDir,
        SETTINGS_DIRECTORY_NAME,
        '.env',
      );
      if (pushCandidate(qwenEnvPath)) {
        pushHomeCandidates();
        return found;
      }
      const envPath = path.join(currentDir, '.env');
      if (pushCandidate(envPath)) {
        pushHomeCandidates();
        return found;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !parentDir) {
      if (!visitedHomeDir) {
        pushHomeCandidates();
      }
      return found;
    }
    currentDir = parentDir;
  }
}

function setUpCloudShellEnvironmentFromFilesFastPath(
  envFilePaths: readonly string[],
): void {
  for (const envFilePath of envFilePaths) {
    if (!fs.existsSync(envFilePath)) continue;
    const parsedEnv = dotenv.parse(fs.readFileSync(envFilePath));
    if (parsedEnv['GOOGLE_CLOUD_PROJECT']) {
      process.env['GOOGLE_CLOUD_PROJECT'] = parsedEnv['GOOGLE_CLOUD_PROJECT'];
      return;
    }
  }
  process.env['GOOGLE_CLOUD_PROJECT'] = 'cloudshell-gca';
}

export function loadServeFastPathEnvironment(
  settings: ServeFastPathSettings,
  startDir: string = process.cwd(),
): void {
  const userLevelPaths = getUserLevelEnvPathsFastPath();
  const envFilePaths = findEnvFilesFastPath(settings, startDir, userLevelPaths);

  if (process.env['CLOUD_SHELL'] === 'true') {
    setUpCloudShellEnvironmentFromFilesFastPath(envFilePaths);
  }

  for (const envFilePath of envFilePaths) {
    try {
      const parsedEnv = dotenv.parse(fs.readFileSync(envFilePath, 'utf8'));
      const excludedVars =
        settings.advanced?.excludedEnvVars ?? DEFAULT_EXCLUDED_ENV_VARS;
      const normalizedEnvFilePath = path.normalize(envFilePath);
      const isHomeScopedEnvFile = userLevelPaths.has(normalizedEnvFilePath);
      const isQwenScopedEnvFile =
        isHomeScopedEnvFile ||
        path.basename(path.dirname(normalizedEnvFilePath)) ===
          SETTINGS_DIRECTORY_NAME;

      for (const key in parsedEnv) {
        if (!Object.hasOwn(parsedEnv, key)) continue;
        if (
          !isHomeScopedEnvFile &&
          PROJECT_ENV_HARDCODED_EXCLUSIONS.includes(key)
        ) {
          continue;
        }
        if (!isQwenScopedEnvFile && excludedVars.includes(key)) {
          continue;
        }
        if (!Object.hasOwn(process.env, key)) {
          process.env[key] = parsedEnv[key];
        }
      }
    } catch {
      // Errors are ignored to match dotenv quiet-mode behavior.
    }
  }

  if (settings.env) {
    for (const [key, value] of Object.entries(settings.env)) {
      if (PROJECT_ENV_HARDCODED_EXCLUSIONS.includes(key)) continue;
      if (!Object.hasOwn(process.env, key) && typeof value === 'string') {
        process.env[key] = value;
      }
    }
  }
}

function readTrustedFoldersFastPath(): Record<string, string> {
  const trustedFoldersPath = getTrustedFoldersPathFastPath();
  if (cachedTrustedFolders && cachedTrustedFoldersPath === trustedFoldersPath) {
    return cachedTrustedFolders;
  }
  if (!fs.existsSync(trustedFoldersPath)) {
    cachedTrustedFoldersPath = trustedFoldersPath;
    cachedTrustedFolders = {};
    return cachedTrustedFolders;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      stripJsonComments(fs.readFileSync(trustedFoldersPath, 'utf8')),
    );
  } catch (err) {
    throw new Error(
      `Failed to read serve fast path trusted folders from ${trustedFoldersPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Serve fast path trusted folders file ${trustedFoldersPath} must be a JSON object.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [rulePath, trustLevel] of Object.entries(parsed)) {
    if (typeof trustLevel === 'string') {
      out[rulePath] = trustLevel;
    }
  }
  cachedTrustedFoldersPath = trustedFoldersPath;
  cachedTrustedFolders = out;
  return cachedTrustedFolders;
}

function isPathTrustedFastPath(location: string): boolean | undefined {
  const trustedPaths: string[] = [];
  const untrustedPaths: string[] = [];
  for (const [rulePath, trustLevel] of Object.entries(
    readTrustedFoldersFastPath(),
  )) {
    if (trustLevel === TRUST_FOLDER) {
      trustedPaths.push(rulePath);
    } else if (trustLevel === TRUST_PARENT) {
      trustedPaths.push(path.dirname(rulePath));
    } else if (trustLevel === DO_NOT_TRUST) {
      untrustedPaths.push(rulePath);
    }
  }

  const locationVariants = getPathComparisonVariants(location);
  for (const trustedPath of trustedPaths) {
    for (const locationVariant of locationVariants) {
      for (const trustedVariant of getPathComparisonVariants(trustedPath)) {
        if (isWithinRoot(locationVariant, trustedVariant)) {
          return true;
        }
      }
    }
  }

  for (const untrustedPath of untrustedPaths) {
    for (const locationVariant of locationVariants) {
      for (const untrustedVariant of getPathComparisonVariants(untrustedPath)) {
        if (locationVariant === untrustedVariant) {
          return false;
        }
      }
    }
  }

  return undefined;
}

function isWorkspaceTrustedFastPath(
  settings: ServeFastPathSettings,
  realWorkspaceDir: string,
): boolean | undefined {
  if (settings.security?.folderTrust?.enabled !== true) {
    return true;
  }
  return isPathTrustedFastPath(realWorkspaceDir);
}

function readSettingsSummary(filePath: string): ServeFastPathSettings {
  if (!fs.existsSync(filePath)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(fs.readFileSync(filePath, 'utf8')));
  } catch (err) {
    throw new Error(
      `Failed to read serve fast path settings from ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `Serve fast path settings file ${filePath} must be a JSON object.`,
    );
  }
  return pickFastPathSettings(parsed);
}

function shouldUseLegacyFastPathKeys(value: Record<string, unknown>): boolean {
  const version = value['$version'];
  if (typeof version === 'number' && version >= V2_SETTINGS_VERSION) {
    return false;
  }
  return V1_INDICATOR_KEYS.some((key) => {
    if (!(key in value)) return false;
    const item = value[key];
    return !(typeof item === 'object' && item !== null && !Array.isArray(item));
  });
}

function pickFastPathSettings(
  value: Record<string, unknown>,
): ServeFastPathSettings {
  const out: ServeFastPathSettings = {};
  const useLegacyKeys = shouldUseLegacyFastPathKeys(value);
  const env = value['env'];
  if (isPlainObject(env)) {
    out.env = pickStringRecord(env);
  }

  const advanced = value['advanced'];
  if (isPlainObject(advanced)) {
    const pickedAdvanced: NonNullable<ServeFastPathSettings['advanced']> = {};
    const excludedEnvVars = advanced['excludedEnvVars'];
    if (excludedEnvVars !== undefined && !isStringArray(excludedEnvVars)) {
      throw new Error(
        'Serve fast path settings advanced.excludedEnvVars must be a string array.',
      );
    }
    if (excludedEnvVars !== undefined) {
      pickedAdvanced.excludedEnvVars = excludedEnvVars;
    }
    const runtimeOutputDir = advanced['runtimeOutputDir'];
    if (
      runtimeOutputDir !== undefined &&
      typeof runtimeOutputDir !== 'string'
    ) {
      throw new Error(
        'Serve fast path settings advanced.runtimeOutputDir must be a string.',
      );
    }
    if (runtimeOutputDir !== undefined) {
      pickedAdvanced.runtimeOutputDir = runtimeOutputDir;
    }
    if (Object.keys(pickedAdvanced).length > 0) {
      out.advanced = pickedAdvanced;
    }
  }
  if (useLegacyKeys && out.advanced?.excludedEnvVars === undefined) {
    const legacyExcludedEnvVars = value['excludedProjectEnvVars'];
    if (isStringArray(legacyExcludedEnvVars)) {
      out.advanced = {
        ...(out.advanced ?? {}),
        excludedEnvVars: legacyExcludedEnvVars,
      };
    }
  }

  const security = value['security'];
  if (isPlainObject(security)) {
    const folderTrust = security['folderTrust'];
    if (isPlainObject(folderTrust)) {
      const enabled = folderTrust['enabled'];
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        throw new Error(
          'Serve fast path settings security.folderTrust.enabled must be a boolean.',
        );
      }
      if (enabled !== undefined) {
        out.security = { folderTrust: { enabled } };
      }
    }
  }
  if (
    useLegacyKeys &&
    out.security === undefined &&
    Object.hasOwn(value, 'folderTrust')
  ) {
    const legacyFolderTrust = value['folderTrust'];
    if (
      legacyFolderTrust !== undefined &&
      typeof legacyFolderTrust !== 'boolean'
    ) {
      throw new Error(
        'Serve fast path settings folderTrust must be a boolean.',
      );
    }
    if (legacyFolderTrust !== undefined) {
      out.security = { folderTrust: { enabled: legacyFolderTrust } };
    }
  }

  const tools = value['tools'];
  if (isPlainObject(tools)) {
    const pickedTools: NonNullable<ServeFastPathSettings['tools']> = {};
    const approvalMode = tools['approvalMode'];
    if (typeof approvalMode === 'string') {
      pickedTools.approvalMode = approvalMode as NonNullable<
        ServeFastPathSettings['tools']
      >['approvalMode'];
    }
    const sandbox = tools['sandbox'];
    if (typeof sandbox === 'boolean' || typeof sandbox === 'string') {
      pickedTools.sandbox = sandbox;
    }
    if (Object.keys(pickedTools).length > 0) {
      out.tools = pickedTools;
    }
  }
  const legacyApprovalMode = value['approvalMode'];
  if (
    useLegacyKeys &&
    out.tools?.approvalMode === undefined &&
    typeof legacyApprovalMode === 'string'
  ) {
    out.tools = {
      ...(out.tools ?? {}),
      approvalMode: legacyApprovalMode as NonNullable<
        ServeFastPathSettings['tools']
      >['approvalMode'],
    };
  }
  const legacySandbox = value['sandbox'];
  if (
    useLegacyKeys &&
    out.tools?.sandbox === undefined &&
    (typeof legacySandbox === 'boolean' || typeof legacySandbox === 'string')
  ) {
    out.tools = {
      ...(out.tools ?? {}),
      sandbox: legacySandbox,
    };
  }

  const context = value['context'];
  if (isPlainObject(context)) {
    const pickedContext: NonNullable<ServeFastPathSettings['context']> = {};
    const fileName = context['fileName'];
    if (typeof fileName === 'string' || isStringArray(fileName)) {
      pickedContext.fileName = fileName;
    }
    const fileFiltering = context['fileFiltering'];
    if (isPlainObject(fileFiltering)) {
      const customIgnoreFiles = fileFiltering['customIgnoreFiles'];
      if (isStringArray(customIgnoreFiles)) {
        pickedContext.fileFiltering = { customIgnoreFiles };
      }
    }
    if (Object.keys(pickedContext).length > 0) {
      out.context = pickedContext;
    }
  }
  const legacyContextFileName = value['contextFileName'];
  if (
    useLegacyKeys &&
    out.context?.fileName === undefined &&
    (typeof legacyContextFileName === 'string' ||
      isStringArray(legacyContextFileName))
  ) {
    out.context = {
      ...(out.context ?? {}),
      fileName: legacyContextFileName,
    };
  }
  const legacyFileFiltering = value['fileFiltering'];
  if (
    useLegacyKeys &&
    out.context?.fileFiltering === undefined &&
    isPlainObject(legacyFileFiltering)
  ) {
    const customIgnoreFiles = legacyFileFiltering['customIgnoreFiles'];
    if (isStringArray(customIgnoreFiles)) {
      out.context = {
        ...(out.context ?? {}),
        fileFiltering: { customIgnoreFiles },
      };
    }
  }

  const policy = value['policy'];
  if (isPlainObject(policy)) {
    const pickedPolicy: NonNullable<ServeFastPathSettings['policy']> = {};
    if (Object.hasOwn(policy, 'permissionStrategy')) {
      pickedPolicy.permissionStrategy = policy['permissionStrategy'];
    }
    if (Object.hasOwn(policy, 'consensusQuorum')) {
      pickedPolicy.consensusQuorum = policy['consensusQuorum'];
    }
    out.policy = pickedPolicy;
  }

  return out;
}

function mergeFastPathSettings(
  ...sources: readonly ServeFastPathSettings[]
): ServeFastPathSettings {
  const merged: ServeFastPathSettings = {};
  for (const source of sources) {
    if (source.env) {
      merged.env = { ...(merged.env ?? {}), ...source.env };
    }
    if (source.advanced?.excludedEnvVars) {
      merged.advanced = {
        ...(merged.advanced ?? {}),
        excludedEnvVars: unique([
          ...(merged.advanced?.excludedEnvVars ?? []),
          ...source.advanced.excludedEnvVars,
        ]),
      };
    }
    if (source.advanced?.runtimeOutputDir !== undefined) {
      merged.advanced = {
        ...(merged.advanced ?? {}),
        runtimeOutputDir: source.advanced.runtimeOutputDir,
      };
    }
    if (source.security?.folderTrust) {
      merged.security = {
        ...(merged.security ?? {}),
        folderTrust: {
          ...(merged.security?.folderTrust ?? {}),
          ...source.security.folderTrust,
        },
      };
    }
    if (source.tools) {
      merged.tools = { ...(merged.tools ?? {}), ...source.tools };
    }
    if (source.context) {
      merged.context = {
        ...(merged.context ?? {}),
        ...source.context,
        ...(source.context.fileFiltering
          ? {
              fileFiltering: {
                ...(merged.context?.fileFiltering ?? {}),
                ...source.context.fileFiltering,
              },
            }
          : {}),
      };
    }
    if (source.policy) {
      merged.policy = { ...(merged.policy ?? {}), ...source.policy };
    }
  }
  return merged;
}

export function loadServeFastPathSettings(
  workspaceDir: string,
): ServeFastPathSettings {
  preResolveServeFastPathHomeEnvOverrides();
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedHomeDir = path.resolve(os.homedir());
  let realWorkspaceDir = resolvedWorkspaceDir;
  try {
    realWorkspaceDir = fs.realpathSync(resolvedWorkspaceDir);
  } catch {
    // Match loadSettings(): use the resolved path when realpath is unavailable.
  }

  const system = readSettingsSummary(getSystemSettingsPath());
  const systemDefaults = readSettingsSummary(getSystemDefaultsPath());
  const user = readSettingsSummary(
    path.join(getGlobalQwenDirLite(), 'settings.json'),
  );
  const initialTrustCheckSettings = mergeFastPathSettings(system, user);
  const isTrusted =
    isWorkspaceTrustedFastPath(initialTrustCheckSettings, realWorkspaceDir) ??
    true;
  let realHomeDir = resolvedHomeDir;
  try {
    realHomeDir = fs.realpathSync(resolvedHomeDir);
  } catch {
    // Match loadSettings(): fall back to the resolved path if unavailable.
  }

  const workspaceSettingsPath = path.join(
    realWorkspaceDir,
    SETTINGS_DIRECTORY_NAME,
    'settings.json',
  );
  const workspaceSettingsActive = realWorkspaceDir !== realHomeDir;
  const workspaceFromDisk = workspaceSettingsActive
    ? readSettingsSummary(workspaceSettingsPath)
    : {};
  const workspace = isTrusted ? workspaceFromDisk : {};

  const merged = mergeFastPathSettings(systemDefaults, user, workspace, system);
  return resolveEnvVarsInObject(
    merged as Settings,
    getHomeEnvFallbackVarsFastPath(),
  ) as ServeFastPathSettings;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function pickStringRecord(
  value: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      out[key] = item;
    }
  }
  return out;
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}
