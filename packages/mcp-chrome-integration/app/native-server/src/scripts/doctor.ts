#!/usr/bin/env node

/**
 * doctor.ts
 *
 * Diagnoses common installation and runtime issues for the Chrome Native Messaging host.
 * Provides checks for manifest files, Node.js path, permissions, and connectivity.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { EXTENSION_ID, HOST_NAME, COMMAND_NAME } from './constant';
import {
  BrowserType,
  detectInstalledBrowsers,
  getBrowserConfig,
  parseBrowserType,
} from './browser-config';
import {
  colorText,
  ensureExecutionPermissions,
  tryRegisterUserLevelHost,
  getLogDir,
} from './utils';
import { NATIVE_SERVER_PORT } from '../constant';

const EXPECTED_PORT = 12306;
const SCHEMA_VERSION = 1;
const MIN_NODE_MAJOR_VERSION = 20;

// ============================================================================
// Types
// ============================================================================

export interface DoctorOptions {
  json?: boolean;
  fix?: boolean;
  browser?: string;
}

export type DoctorStatus = 'ok' | 'warn' | 'error';

export interface DoctorFixAttempt {
  id: string;
  description: string;
  success: boolean;
  error?: string;
}

export interface DoctorCheckResult {
  id: string;
  title: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  schemaVersion: number;
  timestamp: string;
  ok: boolean;
  summary: {
    ok: number;
    warn: number;
    error: number;
  };
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    node: {
      version: string;
      execPath: string;
    };
    package: {
      name: string;
      version: string;
      rootDir: string;
      distDir: string;
    };
    command: {
      canonical: string;
      aliases: string[];
    };
    nativeHost: {
      hostName: string;
      expectedPort: number;
    };
  };
  fixes: DoctorFixAttempt[];
  checks: DoctorCheckResult[];
  nextSteps: string[];
}

interface NodeResolutionResult {
  nodePath?: string;
  source?: string;
  version?: string;
  versionError?: string;
  nodePathFile: {
    path: string;
    exists: boolean;
    value?: string;
    valid?: boolean;
    error?: string;
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

function readPackageJson(): Record<string, unknown> {
  try {
    return require('../../package.json') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getCommandInfo(pkg: Record<string, unknown>): { canonical: string; aliases: string[] } {
  const bin = pkg.bin as Record<string, string> | undefined;
  if (!bin || typeof bin !== 'object') {
    return { canonical: COMMAND_NAME, aliases: [] };
  }

  const canonical = COMMAND_NAME;
  const canonicalTarget = bin[canonical];

  const aliases = canonicalTarget
    ? Object.keys(bin).filter((name) => name !== canonical && bin[name] === canonicalTarget)
    : [];

  return { canonical, aliases };
}

function resolveDistDir(): string {
  // __dirname is dist/scripts when running from compiled code
  const candidateFromDistScripts = path.resolve(__dirname, '..');
  const candidateFromSrcScripts = path.resolve(__dirname, '..', '..', 'dist');

  const looksLikeDist = (dir: string): boolean => {
    return (
      fs.existsSync(path.join(dir, 'mcp', 'stdio-config.json')) ||
      fs.existsSync(path.join(dir, 'run_host.sh')) ||
      fs.existsSync(path.join(dir, 'run_host.bat'))
    );
  };

  if (looksLikeDist(candidateFromDistScripts)) return candidateFromDistScripts;
  if (looksLikeDist(candidateFromSrcScripts)) return candidateFromSrcScripts;
  return candidateFromDistScripts;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function canExecute(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeComparablePath(filePath: string): string {
  if (process.platform === 'win32') {
    return path.normalize(filePath).toLowerCase();
  }
  return path.normalize(filePath);
}

function stripOuterQuotes(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function expandTilde(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function expandWindowsEnvVars(input: string): string {
  if (process.platform !== 'win32') return input;
  return input.replace(/%([^%]+)%/g, (_match, name: string) => {
    const key = String(name);
    return (
      process.env[key] ?? process.env[key.toUpperCase()] ?? process.env[key.toLowerCase()] ?? _match
    );
  });
}

function parseVersionFromDirName(dirName: string): number[] | null {
  const cleaned = dirName.trim().replace(/^v/, '');
  if (!/^\d+(\.\d+){0,3}$/.test(cleaned)) return null;
  return cleaned.split('.').map((part) => Number(part));
}

/**
 * Parse Node.js version string from `node -v` output.
 * Handles versions like: v20.10.0, v22.0.0-nightly.2024..., v21.0.0-rc.1
 * Returns major version number or null if parsing fails.
 */
function parseNodeMajorVersion(versionString: string): number | null {
  if (!versionString) return null;
  // Match pattern: v?MAJOR.MINOR.PATCH[-anything]
  const match = versionString.trim().match(/^v?(\d+)(?:\.\d+)*(?:[-+].*)?$/i);
  if (match?.[1]) {
    const major = Number(match[1]);
    return Number.isNaN(major) ? null : major;
  }
  return null;
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function pickLatestVersionDir(parentDir: string): string | null {
  if (!fs.existsSync(parentDir)) return null;
  const dirents = fs.readdirSync(parentDir, { withFileTypes: true });
  let best: { name: string; version: number[] } | null = null;

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const parsed = parseVersionFromDirName(dirent.name);
    if (!parsed) continue;
    if (!best || compareVersions(parsed, best.version) > 0) {
      best = { name: dirent.name, version: parsed };
    }
  }

  return best ? path.join(parentDir, best.name) : null;
}

// ============================================================================
// Node Resolution (mirrors run_host.sh/bat logic)
// ============================================================================

function resolveNodeCandidate(distDir: string): NodeResolutionResult {
  const nodeFileName = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodePathFilePath = path.join(distDir, 'node_path.txt');

  const nodePathFile: NodeResolutionResult['nodePathFile'] = {
    path: nodePathFilePath,
    exists: fs.existsSync(nodePathFilePath),
  };

  const consider = (
    source: string,
    rawCandidate?: string,
  ): { nodePath: string; source: string } | null => {
    if (!rawCandidate) return null;
    let candidate = expandTilde(stripOuterQuotes(rawCandidate));

    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        candidate = path.join(candidate, nodeFileName);
      }
    } catch {
      // ignore
    }

    if (canExecute(candidate)) {
      return { nodePath: candidate, source };
    }
    return null;
  };

  // Priority 0: CHROME_MCP_NODE_PATH
  const fromEnv = consider('CHROME_MCP_NODE_PATH', process.env.CHROME_MCP_NODE_PATH);
  if (fromEnv) {
    return { ...fromEnv, nodePathFile };
  }

  // Priority 1: node_path.txt
  if (nodePathFile.exists) {
    try {
      const content = fs.readFileSync(nodePathFilePath, 'utf8').trim();
      nodePathFile.value = content;
      const fromFile = consider('node_path.txt', content);
      nodePathFile.valid = Boolean(fromFile);
      if (fromFile) {
        return { ...fromFile, nodePathFile };
      }
    } catch (e) {
      nodePathFile.error = stringifyError(e);
      nodePathFile.valid = false;
    }
  }

  // Priority 1.5: Relative path fallback (mirrors run_host.sh/bat)
  // Unix: ../../../bin/node (from dist/)
  // Windows: ..\..\..\node.exe (from dist/, no bin/ subdirectory)
  const relativeNodePath =
    process.platform === 'win32'
      ? path.resolve(distDir, '..', '..', '..', nodeFileName)
      : path.resolve(distDir, '..', '..', '..', 'bin', nodeFileName);
  const fromRelative = consider('relative', relativeNodePath);
  if (fromRelative) return { ...fromRelative, nodePathFile };

  // Priority 2: Volta
  const voltaHome = process.env.VOLTA_HOME || path.join(os.homedir(), '.volta');
  const fromVolta = consider('volta', path.join(voltaHome, 'bin', nodeFileName));
  if (fromVolta) return { ...fromVolta, nodePathFile };

  // Priority 3: asdf (cross-platform)
  const asdfDir = process.env.ASDF_DATA_DIR || path.join(os.homedir(), '.asdf');
  const asdfNodejsDir = path.join(asdfDir, 'installs', 'nodejs');
  const latestAsdf = pickLatestVersionDir(asdfNodejsDir);
  if (latestAsdf) {
    const fromAsdf = consider('asdf', path.join(latestAsdf, 'bin', nodeFileName));
    if (fromAsdf) return { ...fromAsdf, nodePathFile };
  }

  // Priority 4: fnm (cross-platform, Windows uses different layout)
  const fnmDir = process.env.FNM_DIR || path.join(os.homedir(), '.fnm');
  const fnmVersionsDir = path.join(fnmDir, 'node-versions');
  const latestFnm = pickLatestVersionDir(fnmVersionsDir);
  if (latestFnm) {
    const fnmNodePath =
      process.platform === 'win32'
        ? path.join(latestFnm, 'installation', nodeFileName)
        : path.join(latestFnm, 'installation', 'bin', nodeFileName);
    const fromFnm = consider('fnm', fnmNodePath);
    if (fromFnm) return { ...fromFnm, nodePathFile };
  }

  // Priority 5: NVM (Unix only)
  if (process.platform !== 'win32') {
    const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
    const nvmDefaultAlias = path.join(nvmDir, 'alias', 'default');
    try {
      if (fs.existsSync(nvmDefaultAlias)) {
        const stat = fs.lstatSync(nvmDefaultAlias);
        const maybeVersion = stat.isSymbolicLink()
          ? fs.readlinkSync(nvmDefaultAlias).trim()
          : fs.readFileSync(nvmDefaultAlias, 'utf8').trim();
        const fromDefault = consider(
          'nvm-default',
          path.join(nvmDir, 'versions', 'node', maybeVersion, 'bin', 'node'),
        );
        if (fromDefault) return { ...fromDefault, nodePathFile };
      }
    } catch {
      // ignore
    }

    const latestNvm = pickLatestVersionDir(path.join(nvmDir, 'versions', 'node'));
    if (latestNvm) {
      const fromNvm = consider('nvm-latest', path.join(latestNvm, 'bin', 'node'));
      if (fromNvm) return { ...fromNvm, nodePathFile };
    }
  }

  // Priority 6: Common paths
  const commonPaths =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
          path.join(
            process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
            'nodejs',
            'node.exe',
          ),
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
        ].filter((p) => path.isAbsolute(p))
      : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const common of commonPaths) {
    const resolved = consider('common', common);
    if (resolved) return { ...resolved, nodePathFile };
  }

  // Priority 7: PATH
  const pathEnv = process.env.PATH || '';
  for (const rawDir of pathEnv.split(path.delimiter)) {
    const dir = stripOuterQuotes(rawDir);
    if (!dir) continue;
    const candidate = path.join(dir, nodeFileName);
    if (canExecute(candidate)) {
      return { nodePath: candidate, source: 'PATH', nodePathFile };
    }
  }

  return { nodePathFile };
}

// ============================================================================
// Browser Resolution
// ============================================================================

function resolveTargetBrowsers(browserArg: string | undefined): BrowserType[] | undefined {
  if (!browserArg) return undefined;
  const normalized = browserArg.toLowerCase();
  if (normalized === 'all') return [BrowserType.CHROME, BrowserType.CHROMIUM];
  if (normalized === 'detect' || normalized === 'auto') return undefined;
  const parsed = parseBrowserType(normalized);
  if (!parsed) {
    throw new Error(`Invalid browser: ${browserArg}. Use 'chrome', 'chromium', or 'all'`);
  }
  return [parsed];
}

function resolveBrowsersToCheck(requested: BrowserType[] | undefined): BrowserType[] {
  if (requested && requested.length > 0) return requested;
  const detected = detectInstalledBrowsers();
  if (detected.length > 0) return detected;
  return [BrowserType.CHROME, BrowserType.CHROMIUM];
}

// ============================================================================
// Windows Registry Check
// ============================================================================

type RegistryValueType = 'REG_SZ' | 'REG_EXPAND_SZ';

function queryWindowsRegistryDefaultValue(registryKey: string): {
  value?: string;
  valueType?: RegistryValueType;
  error?: string;
} {
  try {
    const output = execFileSync('reg', ['query', registryKey, '/ve'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2500,
      windowsHide: true,
    });
    const lines = output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const match = line.match(/\b(REG_SZ|REG_EXPAND_SZ)\b\s+(.*)$/i);
      if (match?.[2]) {
        const valueType = match[1].toUpperCase() as RegistryValueType;
        return { value: match[2].trim(), valueType };
      }
    }
    return { error: 'No REG_SZ/REG_EXPAND_SZ default value found' };
  } catch (e) {
    return { error: stringifyError(e) };
  }
}

// ============================================================================
// Fix Attempts
// ============================================================================

async function attemptFixes(
  enabled: boolean,
  silent: boolean,
  distDir: string,
  targetBrowsers: BrowserType[] | undefined,
): Promise<DoctorFixAttempt[]> {
  if (!enabled) return [];

  const fixes: DoctorFixAttempt[] = [];
  const logDir = getLogDir();
  const nodePathFile = path.join(distDir, 'node_path.txt');

  const withMutedConsole = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!silent) return await fn();
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      console.error = originalError;
    }
  };

  const attempt = async (id: string, description: string, action: () => Promise<void> | void) => {
    try {
      await withMutedConsole(async () => {
        await action();
      });
      fixes.push({ id, description, success: true });
    } catch (e) {
      fixes.push({ id, description, success: false, error: stringifyError(e) });
    }
  };

  await attempt('logs', 'Ensure logs directory exists', async () => {
    fs.mkdirSync(logDir, { recursive: true });
  });

  await attempt('node_path', 'Write node_path.txt for run_host scripts', async () => {
    fs.writeFileSync(nodePathFile, process.execPath, 'utf8');
  });

  await attempt('permissions', 'Fix execution permissions for native host files', async () => {
    await ensureExecutionPermissions();
  });

  await attempt('register', 'Re-register Native Messaging host (user-level)', async () => {
    const ok = await tryRegisterUserLevelHost(targetBrowsers);
    if (!ok) {
      throw new Error('User-level registration failed');
    }
  });

  return fixes;
}

// ============================================================================
// JSON File Reading
// ============================================================================

function readJsonFile(
  filePath: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: stringifyError(e) };
  }
}

// ============================================================================
// Connectivity Check
// ============================================================================

type FetchFn = typeof globalThis.fetch;

function resolveFetch(): FetchFn | null {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis) as FetchFn;
  }
  try {
    const mod = require('node-fetch');
    return (mod.default ?? mod) as FetchFn;
  } catch {
    return null;
  }
}

async function checkConnectivity(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const fetchFn = resolveFetch();
  if (!fetchFn) {
    return { ok: false, error: 'fetch is not available (requires Node.js >=18 or node-fetch)' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Prevent timeout from keeping the process alive
  if (typeof timeout.unref === 'function') {
    timeout.unref();
  }

  try {
    const res = await fetchFn(url, { method: 'GET', signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (e: unknown) {
    const errMessage = e instanceof Error ? e.message : String(e);
    const errName = e instanceof Error ? e.name : '';
    if (errName === 'AbortError' || errMessage.toLowerCase().includes('abort')) {
      return { ok: false, error: `Timeout after ${timeoutMs}ms` };
    }
    return { ok: false, error: errMessage };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// Summary Computation
// ============================================================================

function computeSummary(checks: DoctorCheckResult[]): { ok: number; warn: number; error: number } {
  let ok = 0;
  let warn = 0;
  let error = 0;
  for (const check of checks) {
    if (check.status === 'ok') ok++;
    else if (check.status === 'warn') warn++;
    else error++;
  }
  return { ok, warn, error };
}

function statusBadge(status: DoctorStatus): string {
  if (status === 'ok') return colorText('[OK]', 'green');
  if (status === 'warn') return colorText('[WARN]', 'yellow');
  return colorText('[ERROR]', 'red');
}

// ============================================================================
// Main Doctor Function
// ============================================================================

/**
 * Collect doctor report without outputting to console.
 * Used by both runDoctor and report command.
 */
export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const pkg = readPackageJson();
  const distDir = resolveDistDir();
  const rootDir = path.resolve(distDir, '..');
  const packageName = typeof pkg.name === 'string' ? pkg.name : 'mcp-chrome-bridge';
  const packageVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  const commandInfo = getCommandInfo(pkg);

  const targetBrowsers = resolveTargetBrowsers(options.browser);
  const browsersToCheck = resolveBrowsersToCheck(targetBrowsers);

  const wrapperScriptName = process.platform === 'win32' ? 'run_host.bat' : 'run_host.sh';
  const wrapperPath = path.resolve(distDir, wrapperScriptName);
  const nodeScriptPath = path.resolve(distDir, 'index.js');
  const logDir = getLogDir();
  const stdioConfigPath = path.resolve(distDir, 'mcp', 'stdio-config.json');

  // Run fixes if requested
  const fixes = await attemptFixes(
    Boolean(options.fix),
    Boolean(options.json),
    distDir,
    targetBrowsers,
  );

  const checks: DoctorCheckResult[] = [];
  const nextSteps: string[] = [];

  // Check 1: Installation info
  checks.push({
    id: 'installation',
    title: 'Installation',
    status: 'ok',
    message: `${packageName}@${packageVersion}, ${process.platform}-${process.arch}, node ${process.version}`,
    details: {
      packageRoot: rootDir,
      distDir,
      execPath: process.execPath,
      aliases: commandInfo.aliases,
    },
  });

  // Check 2: Host files
  const missingHostFiles: string[] = [];
  if (!fs.existsSync(wrapperPath)) missingHostFiles.push(wrapperPath);
  if (!fs.existsSync(nodeScriptPath)) missingHostFiles.push(nodeScriptPath);
  if (!fs.existsSync(stdioConfigPath)) missingHostFiles.push(stdioConfigPath);

  if (missingHostFiles.length > 0) {
    checks.push({
      id: 'host.files',
      title: 'Host files',
      status: 'error',
      message: `Missing required files (${missingHostFiles.length})`,
      details: { missing: missingHostFiles },
    });
    nextSteps.push(`Reinstall: npm install -g ${COMMAND_NAME}`);
  } else {
    checks.push({
      id: 'host.files',
      title: 'Host files',
      status: 'ok',
      message: `Wrapper: ${wrapperPath}`,
      details: { wrapperPath, nodeScriptPath, stdioConfigPath },
    });
  }

  // Check 3: Permissions (Unix only)
  if (process.platform !== 'win32' && fs.existsSync(wrapperPath)) {
    const executable = canExecute(wrapperPath);
    checks.push({
      id: 'host.permissions',
      title: 'Host permissions',
      status: executable ? 'ok' : 'error',
      message: executable ? 'run_host.sh is executable' : 'run_host.sh is not executable',
      details: {
        path: wrapperPath,
        fix: executable
          ? undefined
          : [`${COMMAND_NAME} fix-permissions`, `chmod +x "${wrapperPath}"`],
      },
    });
    if (!executable) nextSteps.push(`${COMMAND_NAME} fix-permissions`);
  } else {
    checks.push({
      id: 'host.permissions',
      title: 'Host permissions',
      status: 'ok',
      message: process.platform === 'win32' ? 'Not applicable on Windows' : 'N/A',
    });
  }

  // Check 4: Node resolution
  const nodeResolution = resolveNodeCandidate(distDir);
  if (nodeResolution.nodePath) {
    try {
      nodeResolution.version = execFileSync(nodeResolution.nodePath, ['-v'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 2500,
        windowsHide: true,
      }).trim();
    } catch (e) {
      nodeResolution.versionError = stringifyError(e);
    }
  }

  // Parse Node version and check if it meets minimum requirement
  const nodeMajorVersion = parseNodeMajorVersion(nodeResolution.version || '');
  const nodeVersionTooOld = nodeMajorVersion !== null && nodeMajorVersion < MIN_NODE_MAJOR_VERSION;

  const nodePathWarn =
    Boolean(nodeResolution.nodePath) &&
    (!nodeResolution.nodePathFile.exists || nodeResolution.nodePathFile.valid === false) &&
    !process.env.CHROME_MCP_NODE_PATH;

  // Determine node check status: error if not found or version too old, warn if path issue
  let nodeStatus: DoctorStatus = 'ok';
  let nodeMessage: string;
  let nodeFix: string[] | undefined;

  if (!nodeResolution.nodePath) {
    nodeStatus = 'error';
    nodeMessage = 'Node.js executable not found by wrapper search order';
    nodeFix = [
      `${COMMAND_NAME} doctor --fix`,
      `Or set CHROME_MCP_NODE_PATH to an absolute node path`,
    ];
    nextSteps.push(`${COMMAND_NAME} doctor --fix`);
  } else if (nodeResolution.versionError) {
    nodeStatus = 'error';
    nodeMessage = `Found ${nodeResolution.source}: ${nodeResolution.nodePath} but failed to run "node -v" (${nodeResolution.versionError})`;
    nodeFix = [
      `Verify the executable: "${nodeResolution.nodePath}" -v`,
      `Reinstall/repair Node.js`,
    ];
    nextSteps.push(`Verify Node.js: "${nodeResolution.nodePath}" -v`);
  } else if (nodeVersionTooOld) {
    nodeStatus = 'error';
    nodeMessage = `Node.js ${nodeResolution.version} is too old (requires >= ${MIN_NODE_MAJOR_VERSION}.0.0)`;
    nodeFix = [`Upgrade Node.js to version ${MIN_NODE_MAJOR_VERSION} or higher`];
    nextSteps.push(`Upgrade Node.js to version ${MIN_NODE_MAJOR_VERSION}+`);
  } else if (nodePathWarn) {
    nodeStatus = 'warn';
    nodeMessage = `Using ${nodeResolution.source}: ${nodeResolution.nodePath}${nodeResolution.version ? ` (${nodeResolution.version})` : ''}`;
    nodeFix = [
      `${COMMAND_NAME} doctor --fix`,
      `Or set CHROME_MCP_NODE_PATH to an absolute node path`,
    ];
  } else {
    nodeStatus = 'ok';
    nodeMessage = `Using ${nodeResolution.source}: ${nodeResolution.nodePath}${nodeResolution.version ? ` (${nodeResolution.version})` : ''}`;
  }

  checks.push({
    id: 'node',
    title: 'Node executable',
    status: nodeStatus,
    message: nodeMessage,
    details: {
      resolved: nodeResolution.nodePath
        ? {
            source: nodeResolution.source,
            path: nodeResolution.nodePath,
            version: nodeResolution.version,
            versionError: nodeResolution.versionError,
            majorVersion: nodeMajorVersion,
          }
        : undefined,
      nodePathFile: nodeResolution.nodePathFile,
      minRequired: `>=${MIN_NODE_MAJOR_VERSION}.0.0`,
      fix: nodeFix,
    },
  });

  // Check 5: Manifest checks per browser
  const expectedOrigin = `chrome-extension://${EXTENSION_ID}/`;
  for (const browser of browsersToCheck) {
    const config = getBrowserConfig(browser);
    const candidates = [config.userManifestPath, config.systemManifestPath];
    const found = candidates.find((p) => fs.existsSync(p));

    if (!found) {
      checks.push({
        id: `manifest.${browser}`,
        title: `${config.displayName} manifest`,
        status: 'error',
        message: 'Manifest not found',
        details: {
          expected: candidates,
          fix: [
            `${COMMAND_NAME} register --browser ${browser}`,
            `${COMMAND_NAME} register --detect`,
          ],
        },
      });
      nextSteps.push(`${COMMAND_NAME} register --detect`);
      continue;
    }

    const parsed = readJsonFile(found);
    if (!parsed.ok) {
      checks.push({
        id: `manifest.${browser}`,
        title: `${config.displayName} manifest`,
        status: 'error',
        message: `Failed to parse manifest: ${parsed.error}`,
        details: { path: found, fix: [`${COMMAND_NAME} register --browser ${browser}`] },
      });
      nextSteps.push(`${COMMAND_NAME} register --browser ${browser}`);
      continue;
    }

    const manifest = parsed.value as Record<string, unknown>;
    const issues: string[] = [];
    if (manifest.name !== HOST_NAME) issues.push(`name != ${HOST_NAME}`);
    if (manifest.type !== 'stdio') issues.push(`type != stdio`);
    if (typeof manifest.path !== 'string') issues.push('path is missing');
    if (typeof manifest.path === 'string') {
      const actual = normalizeComparablePath(manifest.path);
      const expected = normalizeComparablePath(wrapperPath);
      if (actual !== expected) issues.push('path does not match installed wrapper');
      if (!fs.existsSync(manifest.path)) issues.push('path target does not exist');
    }
    const allowedOrigins = manifest.allowed_origins;
    if (!Array.isArray(allowedOrigins) || !allowedOrigins.includes(expectedOrigin)) {
      issues.push(`allowed_origins missing ${expectedOrigin}`);
    }

    checks.push({
      id: `manifest.${browser}`,
      title: `${config.displayName} manifest`,
      status: issues.length === 0 ? 'ok' : 'error',
      message: issues.length === 0 ? found : `Invalid manifest (${issues.join('; ')})`,
      details: {
        path: found,
        expectedWrapperPath: wrapperPath,
        expectedOrigin,
        fix: issues.length === 0 ? undefined : [`${COMMAND_NAME} register --browser ${browser}`],
      },
    });
    if (issues.length > 0) nextSteps.push(`${COMMAND_NAME} register --browser ${browser}`);
  }

  // Check 6: Windows registry (Windows only)
  if (process.platform === 'win32') {
    for (const browser of browsersToCheck) {
      const config = getBrowserConfig(browser);
      const keySpecs = [
        config.registryKey ? { key: config.registryKey, expected: config.userManifestPath } : null,
        config.systemRegistryKey
          ? { key: config.systemRegistryKey, expected: config.systemManifestPath }
          : null,
      ].filter(Boolean) as Array<{ key: string; expected: string }>;
      if (keySpecs.length === 0) continue;

      let anyValue = false;
      let anyExistingTarget = false;
      let anyMissingTarget = false;
      let anyMismatch = false;

      const results: Array<{
        key: string;
        expected: string;
        value?: string;
        valueType?: string;
        expandedValue?: string;
        exists?: boolean;
        matchesExpected?: boolean;
        error?: string;
      }> = [];

      for (const spec of keySpecs) {
        const res = queryWindowsRegistryDefaultValue(spec.key);
        if (!res.value) {
          results.push({ key: spec.key, expected: spec.expected, error: res.error });
          continue;
        }

        anyValue = true;
        // Expand environment variables for REG_EXPAND_SZ values
        const expandedValue = expandWindowsEnvVars(stripOuterQuotes(res.value));
        const exists = fs.existsSync(expandedValue);
        const matchesExpected =
          normalizeComparablePath(expandedValue) === normalizeComparablePath(spec.expected);

        if (exists) {
          anyExistingTarget = true;
          if (!matchesExpected) anyMismatch = true;
        } else {
          anyMissingTarget = true;
        }

        results.push({
          key: spec.key,
          expected: spec.expected,
          value: res.value,
          valueType: res.valueType,
          expandedValue: expandedValue !== res.value ? expandedValue : undefined,
          exists,
          matchesExpected,
        });
      }

      let status: DoctorStatus = 'error';
      let message = 'Registry entry not found';
      if (!anyValue) {
        status = 'error';
        message = 'Registry entry not found';
      } else if (!anyExistingTarget) {
        status = 'error';
        message = 'Registry entry points to missing manifest';
      } else if (anyMissingTarget || anyMismatch) {
        status = 'warn';
        message = 'Registry entry found but inconsistent';
      } else {
        status = 'ok';
        message = 'Registry entry points to manifest';
      }

      checks.push({
        id: `registry.${browser}`,
        title: `${config.displayName} registry`,
        status,
        message,
        details: {
          keys: keySpecs.map((s) => s.key),
          results,
          fix: status === 'ok' ? undefined : [`${COMMAND_NAME} register --browser ${browser}`],
        },
      });
      if (status !== 'ok') nextSteps.push(`${COMMAND_NAME} register --browser ${browser}`);
    }
  }

  // Check 7: Port configuration
  if (fs.existsSync(stdioConfigPath)) {
    const cfg = readJsonFile(stdioConfigPath);
    if (!cfg.ok) {
      checks.push({
        id: 'port.config',
        title: 'Port config',
        status: 'error',
        message: `Failed to parse stdio-config.json: ${cfg.error}`,
      });
    } else {
      try {
        const configValue = cfg.value as Record<string, unknown>;
        const url = new URL(configValue.url as string);
        const port = Number(url.port);
        const portOk = port === EXPECTED_PORT;
        checks.push({
          id: 'port.config',
          title: 'Port config',
          status: portOk ? 'ok' : 'error',
          message: configValue.url as string,
          details: {
            expectedPort: EXPECTED_PORT,
            actualPort: port,
            fix: portOk ? undefined : [`${COMMAND_NAME} update-port ${EXPECTED_PORT}`],
          },
        });
        if (!portOk) nextSteps.push(`${COMMAND_NAME} update-port ${EXPECTED_PORT}`);

        // Check constant consistency
        const nativePortOk = NATIVE_SERVER_PORT === EXPECTED_PORT;
        checks.push({
          id: 'port.constant',
          title: 'Port constant',
          status: nativePortOk ? 'ok' : 'warn',
          message: `NATIVE_SERVER_PORT=${NATIVE_SERVER_PORT}`,
          details: { expectedPort: EXPECTED_PORT },
        });

        // Connectivity check
        const pingUrl = new URL('/ping', url);
        const ping = await checkConnectivity(pingUrl.toString(), 1500);
        checks.push({
          id: 'connectivity',
          title: 'Connectivity',
          status: ping.ok ? 'ok' : 'warn',
          message: ping.ok
            ? `GET ${pingUrl} -> ${ping.status}`
            : `GET ${pingUrl} failed (${ping.error || 'unknown error'})`,
          details: {
            hint: 'If the server is not running, click "Connect" in the extension and retry.',
          },
        });
        if (!ping.ok) nextSteps.push('Click "Connect" in the extension, then re-run doctor');
      } catch (e) {
        checks.push({
          id: 'port.config',
          title: 'Port config',
          status: 'error',
          message: `Invalid URL in stdio-config.json: ${stringifyError(e)}`,
        });
      }
    }
  }

  // Check 8: Logs directory
  checks.push({
    id: 'logs',
    title: 'Logs',
    status: fs.existsSync(logDir) ? 'ok' : 'warn',
    message: logDir,
    details: {
      hint: 'Wrapper logs are created when Chrome launches the native host.',
    },
  });

  // Compute summary
  const summary = computeSummary(checks);
  const ok = summary.error === 0;

  const report: DoctorReport = {
    schemaVersion: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    ok,
    summary,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: { version: process.version, execPath: process.execPath },
      package: { name: packageName, version: packageVersion, rootDir, distDir },
      command: { canonical: commandInfo.canonical, aliases: commandInfo.aliases },
      nativeHost: { hostName: HOST_NAME, expectedPort: EXPECTED_PORT },
    },
    fixes,
    checks,
    nextSteps: Array.from(new Set(nextSteps)).slice(0, 10),
  };

  return report;
}

/**
 * Run doctor command with console output.
 */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  const report = await collectDoctorReport(options);
  const packageVersion = report.environment.package.version;

  // Output
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(`${COMMAND_NAME} doctor v${packageVersion}\n`);
    for (const check of report.checks) {
      console.log(`${statusBadge(check.status)}    ${check.title}: ${check.message}`);
      const fix = (check.details as Record<string, unknown> | undefined)?.fix as
        | string[]
        | undefined;
      if (check.status !== 'ok' && fix && fix.length > 0) {
        console.log(`        Fix: ${fix[0]}`);
      }
    }
    if (report.fixes.length > 0) {
      console.log('\nFix attempts:');
      for (const f of report.fixes) {
        const badge = f.success ? colorText('[OK]', 'green') : colorText('[ERROR]', 'red');
        console.log(`${badge} ${f.description}${f.success ? '' : ` (${f.error})`}`);
      }
    }
    if (report.nextSteps.length > 0) {
      console.log('\nNext steps:');
      report.nextSteps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    }
  }

  return report.ok ? 0 : 1;
}
