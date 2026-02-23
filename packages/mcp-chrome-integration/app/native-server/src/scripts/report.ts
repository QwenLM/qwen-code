#!/usr/bin/env node

/**
 * report.ts
 *
 * Export a diagnostic report for GitHub Issues.
 * Collects system info, doctor output, logs, manifests, and registry info.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { COMMAND_NAME } from './constant';
import {
  BrowserType,
  detectInstalledBrowsers,
  getBrowserConfig,
  parseBrowserType,
} from './browser-config';
import { getLogDir } from './utils';
import { collectDoctorReport, DoctorReport } from './doctor';

const REPORT_SCHEMA_VERSION = 1;
const DEFAULT_LOG_LINES = 200;
const DEFAULT_TAIL_BYTES = 256 * 1024;
const MAX_LOG_FILES = 6;
const MAX_FULL_LOG_BYTES = 1024 * 1024;

type IncludeLogsMode = 'none' | 'tail' | 'full';

export interface ReportOptions {
  json?: boolean;
  output?: string;
  copy?: boolean;
  redact?: boolean;
  includeLogs?: string;
  logLines?: number;
  browser?: string;
}

interface VersionResult {
  version?: string;
  error?: string;
}

interface ManifestSnapshot {
  browser: string;
  scope: 'user' | 'system';
  path: string;
  exists: boolean;
  json?: unknown;
  raw?: string;
  error?: string;
}

interface LogFileSnapshot {
  name: string;
  path: string;
  mtime?: string;
  size?: number;
  note?: string;
  content?: string;
  truncated?: boolean;
  error?: string;
}

interface WrapperLogsSnapshot {
  dir: string;
  mode: IncludeLogsMode;
  files: LogFileSnapshot[];
  error?: string;
}

interface WindowsRegistryEntrySnapshot {
  browser: string;
  scope: 'user' | 'system';
  key: string;
  expectedManifestPath: string;
  value?: string;
  raw?: string;
  error?: string;
}

interface WindowsRegistrySnapshot {
  entries: WindowsRegistryEntrySnapshot[];
}

export interface DiagnosticReport {
  schemaVersion: number;
  timestamp: string;
  tool: {
    name: string;
    version: string;
  };
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    node: {
      version: string;
      execPath: string;
    };
    os: {
      type: string;
      release: string;
      version?: string;
    };
    cwd: string;
    env: Record<string, string | null>;
  };
  packageManager: {
    npm: VersionResult;
    pnpm: VersionResult;
  };
  doctor?: DoctorReport;
  doctorError?: string;
  manifests: ManifestSnapshot[];
  wrapperLogs: WrapperLogsSnapshot;
  windowsRegistry?: WindowsRegistrySnapshot;
  redaction: {
    enabled: boolean;
  };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function readPackageJson(): Record<string, unknown> {
  try {
    return require('../../package.json') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getToolVersion(): { name: string; version: string } {
  const pkg = readPackageJson();
  const name = typeof pkg.name === 'string' ? pkg.name : COMMAND_NAME;
  const version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  return { name, version };
}

function safeOsVersion(): string | undefined {
  try {
    return os.version();
  } catch {
    return undefined;
  }
}

function safeExecVersion(command: string): VersionResult {
  try {
    const out = execFileSync(command, ['-v'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2500,
      windowsHide: true,
    });
    return { version: out.trim() };
  } catch (e) {
    return { error: stringifyError(e) };
  }
}

function parseIncludeLogsMode(raw: unknown): IncludeLogsMode {
  const v = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (v === 'none' || v === 'tail' || v === 'full') return v;
  return 'tail';
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function resolveBrowsers(browserArg: string | undefined): BrowserType[] {
  if (!browserArg) {
    const detected = detectInstalledBrowsers();
    return detected.length > 0 ? detected : [BrowserType.CHROME, BrowserType.CHROMIUM];
  }

  const normalized = browserArg.toLowerCase();
  if (normalized === 'all') return [BrowserType.CHROME, BrowserType.CHROMIUM];
  if (normalized === 'detect' || normalized === 'auto') {
    const detected = detectInstalledBrowsers();
    return detected.length > 0 ? detected : [BrowserType.CHROME, BrowserType.CHROMIUM];
  }

  const parsed = parseBrowserType(normalized);
  if (!parsed) {
    throw new Error(`Invalid browser: ${browserArg}. Use 'chrome', 'chromium', or 'all'`);
  }
  return [parsed];
}

function readJsonSnapshot(filePath: string): {
  exists: boolean;
  json?: unknown;
  raw?: string;
  error?: string;
} {
  try {
    if (!fs.existsSync(filePath)) return { exists: false };
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
      const json = JSON.parse(raw) as unknown;
      return { exists: true, json };
    } catch (e) {
      return { exists: true, raw, error: `Failed to parse JSON: ${stringifyError(e)}` };
    }
  } catch (e) {
    return { exists: fs.existsSync(filePath), error: stringifyError(e) };
  }
}

function collectManifests(browsers: BrowserType[]): ManifestSnapshot[] {
  const results: ManifestSnapshot[] = [];
  for (const browser of browsers) {
    const config = getBrowserConfig(browser);
    for (const scope of ['user', 'system'] as const) {
      const manifestPath = scope === 'user' ? config.userManifestPath : config.systemManifestPath;
      const snap = readJsonSnapshot(manifestPath);
      results.push({
        browser,
        scope,
        path: manifestPath,
        exists: snap.exists,
        json: snap.json,
        raw: snap.raw,
        error: snap.error,
      });
    }
  }
  return results;
}

function readFileTail(
  filePath: string,
  maxBytes: number,
  maxLines: number,
): { content: string; truncated: boolean } {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const bytesToRead = Math.min(size, maxBytes);
  const start = Math.max(0, size - bytesToRead);

  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, start);
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    const tail = lines.slice(Math.max(0, lines.length - maxLines));
    return { content: tail.join('\n'), truncated: size > maxBytes || lines.length > maxLines };
  } finally {
    fs.closeSync(fd);
  }
}

function readFileLastBytes(
  filePath: string,
  maxBytes: number,
): { content: string; truncated: boolean } {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  if (size <= maxBytes) {
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, truncated: false };
  }

  const bytesToRead = maxBytes;
  const start = Math.max(0, size - bytesToRead);

  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, start);
    const content = buf.toString('utf8');
    return { content, truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

function collectWrapperLogs(
  logDir: string,
  mode: IncludeLogsMode,
  logLines: number,
): WrapperLogsSnapshot {
  if (!fs.existsSync(logDir)) {
    return { dir: logDir, mode, files: [], error: 'Log directory does not exist' };
  }

  const prefixes = ['native_host_wrapper_', 'native_host_stderr_'];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch (e) {
    return { dir: logDir, mode, files: [], error: stringifyError(e) };
  }

  const candidates = entries
    .filter((ent) => ent.isFile())
    .map((ent) => ent.name)
    .filter((name) => name.endsWith('.log') && prefixes.some((p) => name.startsWith(p)));

  const filesWithStat: Array<{ name: string; fullPath: string; mtimeMs: number; size: number }> =
    [];
  for (const name of candidates) {
    const fullPath = path.join(logDir, name);
    try {
      const stat = fs.statSync(fullPath);
      filesWithStat.push({ name, fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // ignore
    }
  }

  filesWithStat.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const selected = filesWithStat.slice(0, MAX_LOG_FILES);
  const snapshots: LogFileSnapshot[] = [];

  for (const file of selected) {
    const snap: LogFileSnapshot = {
      name: file.name,
      path: file.fullPath,
      mtime: new Date(file.mtimeMs).toISOString(),
      size: file.size,
    };

    if (mode !== 'none') {
      try {
        if (mode === 'tail') {
          const read = readFileTail(file.fullPath, DEFAULT_TAIL_BYTES, logLines);
          snap.content = read.content;
          snap.truncated = read.truncated;
          snap.note = `Tail: last ${logLines} lines (from last ${DEFAULT_TAIL_BYTES} bytes)`;
        } else {
          const read = readFileLastBytes(file.fullPath, MAX_FULL_LOG_BYTES);
          snap.content = read.content;
          snap.truncated = read.truncated;
          snap.note = read.truncated
            ? `Truncated: showing last ${MAX_FULL_LOG_BYTES} bytes`
            : 'Full file';
        }
      } catch (e) {
        snap.error = stringifyError(e);
      }
    } else {
      snap.note = 'Content omitted';
    }

    snapshots.push(snap);
  }

  return { dir: logDir, mode, files: snapshots };
}

function queryWindowsRegistryDefaultValue(registryKey: string): {
  value?: string;
  raw?: string;
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
      const match = line.match(/REG_SZ\s+(.*)$/i);
      if (match?.[1]) return { value: match[1].trim(), raw: output };
    }
    return { raw: output, error: 'No REG_SZ default value found' };
  } catch (e) {
    return { error: stringifyError(e) };
  }
}

function collectWindowsRegistry(browsers: BrowserType[]): WindowsRegistrySnapshot {
  const entries: WindowsRegistryEntrySnapshot[] = [];

  for (const browser of browsers) {
    const config = getBrowserConfig(browser);
    const keySpecs = [
      config.registryKey
        ? { key: config.registryKey, scope: 'user' as const, expected: config.userManifestPath }
        : null,
      config.systemRegistryKey
        ? {
            key: config.systemRegistryKey,
            scope: 'system' as const,
            expected: config.systemManifestPath,
          }
        : null,
    ].filter(Boolean) as Array<{ key: string; scope: 'user' | 'system'; expected: string }>;

    for (const spec of keySpecs) {
      const res = queryWindowsRegistryDefaultValue(spec.key);
      entries.push({
        browser,
        scope: spec.scope,
        key: spec.key,
        expectedManifestPath: spec.expected,
        value: res.value,
        raw: res.raw,
        error: res.error,
      });
    }
  }

  return { entries };
}

// ============================================================================
// Redaction
// ============================================================================

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLiteralReplacements(): Array<[RegExp, string]> {
  const replacements: Array<[RegExp, string]> = [];
  const ignoreCase = process.platform === 'win32';

  const addLiteral = (literal: string | undefined, replacement: string): void => {
    if (!literal) return;
    const variants = new Set<string>();
    variants.add(literal);
    variants.add(literal.replace(/\\/g, '/'));
    variants.add(literal.replace(/\//g, '\\'));

    for (const v of variants) {
      if (!v) continue;
      replacements.push([new RegExp(escapeRegExp(v), ignoreCase ? 'gi' : 'g'), replacement]);
    }
  };

  addLiteral(os.homedir(), '<HOME>');
  addLiteral(process.env.USERPROFILE, '<USERPROFILE>');
  addLiteral(process.env.HOME, '<HOME>');

  try {
    const username = os.userInfo().username;
    if (username) {
      replacements.push([
        new RegExp(`\\b${escapeRegExp(username)}\\b`, ignoreCase ? 'gi' : 'g'),
        '<USER>',
      ]);
    }
  } catch {
    // ignore
  }

  return replacements;
}

function createRedactor(enabled: boolean): (input: string) => string {
  if (!enabled) return (s) => s;

  const literalReplacements = buildLiteralReplacements();
  const patternReplacements: Array<[RegExp, string]> = [
    // Sensitive key=value patterns (supports JSON-style "key": "value" and env-style KEY=value)
    [
      /(\b[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY)\b)(\s*["']?\s*[:=]\s*["']?)([^\s"']+)/gi,
      '$1$2<REDACTED>',
    ],
    // HTTP Authorization headers
    [/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1<REDACTED>'],
    [/(Authorization:\s*Basic\s+)[^\s]+/gi, '$1<REDACTED>'],
    // JSON-style Authorization fields ("Authorization": "Bearer ...")
    [
      /(\bAuthorization\b)(\s*["']?\s*[:=]\s*["']?)(Bearer\s+|Basic\s+)?[^\s"']+/gi,
      '$1$2$3<REDACTED>',
    ],
    // Cookies
    [/(Cookie:\s*)[^\r\n]+/gi, '$1<REDACTED>'],
    [/(Set-Cookie:\s*)[^\r\n]+/gi, '$1<REDACTED>'],
    // JSON-style Cookie fields ("Cookie": "...")
    [/(\b(?:Cookie|Set-Cookie)\b)(\s*["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, '$1$2<REDACTED>'],
    // Common API header patterns (supports JSON-style)
    [
      /(\b(?:x-api-key|api-key|x-auth-token|x-access-token)\b)(\s*["']?\s*[:=]\s*["']?)([^\s"']+)/gi,
      '$1$2<REDACTED>',
    ],
    // Email addresses
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<EMAIL>'],
    // User paths (Windows and macOS/Linux)
    [/[A-Z]:\\Users\\[^\\]+/gi, '<USERPROFILE>'],
    [/\/Users\/[^/]+/g, '/Users/<USER>'],
  ];

  return (input: string): string => {
    let out = input;
    for (const [re, replacement] of literalReplacements) {
      out = out.replace(re, replacement);
    }
    for (const [re, replacement] of patternReplacements) {
      out = out.replace(re, replacement);
    }
    return out;
  };
}

function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = redactDeep(v, redact);
    }
    return out;
  }
  return value;
}

// ============================================================================
// Output Rendering
// ============================================================================

function renderMarkdown(report: DiagnosticReport): string {
  const lines: string[] = [];

  lines.push(`# ${report.tool.name} Diagnostic Report`);
  lines.push('');
  lines.push(`**Generated:** ${report.timestamp}`);
  lines.push(`**Redaction:** ${report.redaction.enabled ? 'enabled (default)' : 'disabled'}`);
  lines.push('');

  lines.push('## Environment');
  lines.push('');
  lines.push(`- **Platform:** ${report.environment.platform} (${report.environment.arch})`);
  lines.push(
    `- **OS:** ${report.environment.os.type} ${report.environment.os.release}${
      report.environment.os.version ? ` (${report.environment.os.version})` : ''
    }`,
  );
  lines.push(`- **Node:** ${report.environment.node.version}`);
  lines.push(`- **Node execPath:** \`${report.environment.node.execPath}\``);
  lines.push(`- **CWD:** \`${report.environment.cwd}\``);
  lines.push('');

  lines.push('## Package Managers');
  lines.push('');
  lines.push(
    `- **npm:** ${
      report.packageManager.npm.version ?? `ERROR: ${report.packageManager.npm.error ?? 'unknown'}`
    }`,
  );
  lines.push(
    `- **pnpm:** ${
      report.packageManager.pnpm.version ??
      `ERROR: ${report.packageManager.pnpm.error ?? 'unknown'}`
    }`,
  );
  lines.push('');

  lines.push('## Relevant Environment Variables');
  lines.push('');
  for (const [k, v] of Object.entries(report.environment.env)) {
    lines.push(`- \`${k}\`: ${v ?? '<unset>'}`);
  }
  lines.push('');

  lines.push('## Doctor Output');
  lines.push('');
  if (report.doctor) {
    lines.push('<details>');
    lines.push('<summary>Click to expand doctor JSON</summary>');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(report.doctor, null, 2));
    lines.push('```');
    lines.push('</details>');
  } else {
    lines.push(`**Doctor failed:** ${report.doctorError ?? 'unknown error'}`);
  }
  lines.push('');

  lines.push('## Wrapper Logs');
  lines.push('');
  lines.push(`**Log directory:** \`${report.wrapperLogs.dir}\``);
  lines.push(`**Mode:** ${report.wrapperLogs.mode}`);
  if (report.wrapperLogs.error) {
    lines.push(`**Error:** ${report.wrapperLogs.error}`);
  }
  lines.push('');
  if (report.wrapperLogs.files.length === 0) {
    lines.push('No wrapper logs found.');
  } else {
    for (const f of report.wrapperLogs.files) {
      lines.push(`### ${f.name}`);
      lines.push('');
      lines.push(`- **Path:** \`${f.path}\``);
      if (f.mtime) lines.push(`- **Modified:** ${f.mtime}`);
      if (typeof f.size === 'number') lines.push(`- **Size:** ${f.size} bytes`);
      if (f.note) lines.push(`- **Note:** ${f.note}`);
      if (f.error) {
        lines.push(`- **Error:** ${f.error}`);
        lines.push('');
        continue;
      }
      if (typeof f.content === 'string') {
        if (f.truncated) lines.push('*(Truncated)*');
        lines.push('');
        lines.push('<details>');
        lines.push('<summary>Click to expand log content</summary>');
        lines.push('');
        lines.push('```text');
        lines.push(f.content);
        lines.push('```');
        lines.push('</details>');
      } else {
        lines.push('*(Content omitted)*');
      }
      lines.push('');
    }
  }
  lines.push('');

  lines.push('## Manifests');
  lines.push('');
  for (const m of report.manifests) {
    lines.push(`### ${m.browser} (${m.scope})`);
    lines.push('');
    lines.push(`- **Path:** \`${m.path}\``);
    if (!m.exists) {
      lines.push('- **Status:** not found');
      lines.push('');
      continue;
    }
    if (m.error) {
      lines.push(`- **Status:** error (${m.error})`);
    }
    if (m.json !== undefined) {
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(m.json, null, 2));
      lines.push('```');
    } else if (typeof m.raw === 'string') {
      lines.push('');
      lines.push('```text');
      lines.push(m.raw);
      lines.push('```');
    }
    lines.push('');
  }

  if (report.windowsRegistry) {
    lines.push('## Windows Registry');
    lines.push('');
    for (const entry of report.windowsRegistry.entries) {
      lines.push(`### ${entry.browser} (${entry.scope})`);
      lines.push('');
      lines.push(`- **Key:** \`${entry.key}\``);
      lines.push(`- **Expected manifest:** \`${entry.expectedManifestPath}\``);
      if (entry.error) {
        lines.push(`- **Error:** ${entry.error}`);
        lines.push('');
        continue;
      }
      if (entry.value) lines.push(`- **Default value:** \`${entry.value}\``);
      if (entry.raw) {
        lines.push('');
        lines.push('```text');
        lines.push(entry.raw);
        lines.push('```');
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(
    '> If you are opening a GitHub Issue, paste everything above. ' +
      `You can disable redaction with: \`${report.tool.name} report --no-redact\``,
  );

  return lines.join('\n');
}

function writeOutput(
  outputPath: string | undefined,
  content: string,
): { ok: true; destination: string } | { ok: false; error: string } {
  if (!outputPath || outputPath === '-' || outputPath.toLowerCase() === 'stdout') {
    process.stdout.write(content);
    return { ok: true, destination: 'stdout' };
  }

  try {
    const resolved = path.resolve(outputPath);
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true, destination: resolved };
  } catch (e) {
    return { ok: false, error: stringifyError(e) };
  }
}

function tryCopyToClipboard(text: string): { ok: boolean; method?: string; error?: string } {
  const spawn = (cmd: string, args: string[]): { ok: boolean; error?: string } => {
    const res = spawnSync(cmd, args, {
      input: text,
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (res.error) return { ok: false, error: stringifyError(res.error) };
    if (res.status !== 0) return { ok: false, error: `Exit code ${res.status ?? 'unknown'}` };
    return { ok: true };
  };

  if (process.platform === 'darwin') {
    const r = spawn('pbcopy', []);
    return r.ok ? { ok: true, method: 'pbcopy' } : { ok: false, method: 'pbcopy', error: r.error };
  }
  if (process.platform === 'win32') {
    const r = spawn('clip', []);
    return r.ok ? { ok: true, method: 'clip' } : { ok: false, method: 'clip', error: r.error };
  }

  // Linux: try wl-copy, xclip, xsel
  for (const cmd of [
    { cmd: 'wl-copy', args: [] as string[] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] as string[] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] as string[] },
  ]) {
    const r = spawn(cmd.cmd, cmd.args);
    if (r.ok) return { ok: true, method: cmd.cmd };
  }

  return { ok: false, error: 'No clipboard command available (tried wl-copy, xclip, xsel)' };
}

// ============================================================================
// Main Report Function
// ============================================================================

export async function runReport(options: ReportOptions): Promise<number> {
  try {
    const includeLogs = parseIncludeLogsMode(options.includeLogs);
    const logLines = parsePositiveInt(options.logLines, DEFAULT_LOG_LINES);
    const redactionEnabled = options.redact !== false;

    const tool = getToolVersion();
    const browsers = resolveBrowsers(options.browser);

    // Collect doctor report
    let doctor: DoctorReport | undefined;
    let doctorError: string | undefined;
    try {
      doctor = await collectDoctorReport({
        json: true,
        fix: false,
        browser: options.browser,
      });
    } catch (e) {
      doctorError = stringifyError(e);
    }

    // Build the report
    const report: DiagnosticReport = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      tool,
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: { version: process.version, execPath: process.execPath },
        os: { type: os.type(), release: os.release(), version: safeOsVersion() },
        cwd: process.cwd(),
        env: {
          CHROME_MCP_NODE_PATH: process.env.CHROME_MCP_NODE_PATH ?? null,
          VOLTA_HOME: process.env.VOLTA_HOME ?? null,
          ASDF_DATA_DIR: process.env.ASDF_DATA_DIR ?? null,
          FNM_DIR: process.env.FNM_DIR ?? null,
          NVM_DIR: process.env.NVM_DIR ?? null,
          // nvm-windows uses different environment variables
          NVM_HOME: process.env.NVM_HOME ?? null,
          NVM_SYMLINK: process.env.NVM_SYMLINK ?? null,
          npm_config_user_agent: process.env.npm_config_user_agent ?? null,
        },
      },
      packageManager: {
        npm: safeExecVersion('npm'),
        pnpm: safeExecVersion('pnpm'),
      },
      doctor,
      doctorError,
      manifests: collectManifests(browsers),
      wrapperLogs: collectWrapperLogs(getLogDir(), includeLogs, logLines),
      windowsRegistry: process.platform === 'win32' ? collectWindowsRegistry(browsers) : undefined,
      redaction: { enabled: redactionEnabled },
    };

    // Apply redaction
    const redact = createRedactor(redactionEnabled);
    const finalReport = redactionEnabled
      ? (redactDeep(report, redact) as DiagnosticReport)
      : report;

    // Render output
    const output = options.json
      ? JSON.stringify(finalReport, null, 2) + '\n'
      : renderMarkdown(finalReport) + '\n';

    // Write output
    const write = writeOutput(options.output, output);
    if (!write.ok) {
      process.stderr.write(`Failed to write report: ${write.error}\n`);
      process.stdout.write(output);
    } else if (write.destination !== 'stdout') {
      process.stderr.write(`Report written to: ${write.destination}\n`);
    }

    // Copy to clipboard if requested
    if (options.copy) {
      const copied = tryCopyToClipboard(output);
      if (copied.ok) {
        process.stderr.write(`Copied to clipboard (${copied.method})\n`);
      } else {
        process.stderr.write(`Failed to copy to clipboard: ${copied.error ?? 'unknown error'}\n`);
      }
    }

    return 0;
  } catch (e) {
    process.stderr.write(`Report failed: ${stringifyError(e)}\n`);
    return 1;
  }
}
