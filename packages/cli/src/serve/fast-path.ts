/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RunHandle } from './run-qwen-serve.js';
import { normalizeServeFastPathArgv } from './fast-path-argv.js';
import type { ServeFastPathSettings } from './fast-path-settings.js';
import type { ServeOptions } from './types.js';

type McpBudgetMode = NonNullable<ServeOptions['mcpBudgetMode']>;

interface ParsedServeFastPath {
  kind: 'serve';
  open: boolean;
  httpBridge: boolean;
  options: ServeOptions;
}

interface FallbackFastPath {
  kind: 'fallback';
}

export type ServeFastPathParseResult = ParsedServeFastPath | FallbackFastPath;

const HELP_AND_VERSION_FLAGS = new Set(['--help', '-h', '--version', '-v']);
const MCP_BUDGET_WARN_FRACTION = 0.75;

const NUMBER_OPTIONS = new Map<
  keyof ServeOptions | 'mcp-client-budget',
  string
>([
  ['port', 'port'],
  ['maxSessions', 'max-sessions'],
  ['maxPendingPromptsPerSession', 'max-pending-prompts-per-session'],
  ['maxConnections', 'max-connections'],
  ['eventRingSize', 'event-ring-size'],
  ['mcp-client-budget', 'mcp-client-budget'],
  ['promptDeadlineMs', 'prompt-deadline-ms'],
  ['writerIdleTimeoutMs', 'writer-idle-timeout-ms'],
  ['channelIdleTimeoutMs', 'channel-idle-timeout-ms'],
  ['sessionReapIntervalMs', 'session-reap-interval-ms'],
  ['sessionIdleTimeoutMs', 'session-idle-timeout-ms'],
  ['permissionResponseTimeoutMs', 'permission-response-timeout-ms'],
  ['rateLimitPrompt', 'rate-limit-prompt'],
  ['rateLimitMutation', 'rate-limit-mutation'],
  ['rateLimitRead', 'rate-limit-read'],
  ['rateLimitWindowMs', 'rate-limit-window-ms'],
]);

const NUMBER_OPTION_BY_FLAG = invertOptionMap(NUMBER_OPTIONS);

const STRING_OPTION_BY_FLAG = new Map<string, keyof ServeOptions>([
  ['hostname', 'hostname'],
  ['token', 'token'],
  ['workspace', 'workspace'],
]);

const BOOLEAN_OPTION_BY_FLAG = new Map<
  string,
  keyof ServeOptions | 'open' | 'http-bridge'
>([
  ['require-auth', 'requireAuth'],
  ['enable-session-shell', 'enableSessionShell'],
  ['web', 'serveWebShell'],
  ['open', 'open'],
  ['http-bridge', 'http-bridge'],
  ['allow-private-auth-base-url', 'allowPrivateAuthBaseUrl'],
  ['rate-limit', 'rateLimit'],
]);

function invertOptionMap<T extends string>(
  source: Map<T, string>,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const [target, flag] of source) {
    out.set(flag, target);
  }
  return out;
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  inlineValue: string | undefined,
): { value: string; nextIndex: number } | null {
  if (inlineValue !== undefined) {
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    return null;
  }
  return { value, nextIndex: index + 1 };
}

function parseNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseBooleanValue(value: string): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function parsePositiveIntegerEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return Number.NaN;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function writeStderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

function setServeOption(
  options: ServeOptions,
  key: keyof ServeOptions,
  value: unknown,
): void {
  (options as unknown as Record<string, unknown>)[key] = value;
}

function getRateLimitValidationError(options: ServeOptions): string | null {
  for (const [name, value] of [
    ['--rate-limit-prompt', options.rateLimitPrompt],
    ['--rate-limit-mutation', options.rateLimitMutation],
    ['--rate-limit-read', options.rateLimitRead],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)
    ) {
      return `qwen serve: ${name} must be a positive integer.`;
    }
  }
  if (
    options.rateLimitWindowMs !== undefined &&
    (!Number.isFinite(options.rateLimitWindowMs) ||
      !Number.isInteger(options.rateLimitWindowMs) ||
      options.rateLimitWindowMs < 1000)
  ) {
    return 'qwen serve: --rate-limit-window-ms must be an integer >= 1000.';
  }
  return null;
}

function getServeFastPathValidationError(
  parsed: ParsedServeFastPath,
): string | null {
  const mcpClientBudget = parsed.options.mcpClientBudget;
  if (
    mcpClientBudget !== undefined &&
    (!Number.isFinite(mcpClientBudget) ||
      !Number.isInteger(mcpClientBudget) ||
      mcpClientBudget <= 0)
  ) {
    return 'qwen serve: --mcp-client-budget must be a positive integer.';
  }

  if (
    parsed.options.mcpBudgetMode === 'enforce' &&
    mcpClientBudget === undefined
  ) {
    return 'qwen serve: --mcp-budget-mode=enforce requires --mcp-client-budget=N.';
  }

  const maxPendingPromptsPerSession =
    parsed.options.maxPendingPromptsPerSession;
  if (
    maxPendingPromptsPerSession !== undefined &&
    maxPendingPromptsPerSession !== Number.POSITIVE_INFINITY &&
    (!Number.isFinite(maxPendingPromptsPerSession) ||
      !Number.isInteger(maxPendingPromptsPerSession) ||
      maxPendingPromptsPerSession < 0)
  ) {
    return 'qwen serve: --max-pending-prompts-per-session must be a non-negative integer (0 / Infinity = unlimited).';
  }

  return null;
}

function blockForever(): Promise<never> {
  return new Promise<never>(() => {});
}

export async function waitForServeRuntimeOrExit(
  handle: Pick<RunHandle, 'runtimeReady' | 'close'>,
): Promise<void> {
  try {
    await handle.runtimeReady;
  } catch (err) {
    writeStderrLine(
      `qwen serve: runtime startup failed after listener was ready: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    await handle.close().catch(() => undefined);
    process.exit(1);
  }
}

function applyRateLimitEnvDefaults(
  options: ServeOptions,
  env: NodeJS.ProcessEnv,
): void {
  if (
    options.rateLimit === undefined &&
    isTruthyEnv(env['QWEN_SERVE_RATE_LIMIT'])
  ) {
    options.rateLimit = true;
  }
  if (options.rateLimit) {
    options.rateLimitPrompt ??= parsePositiveIntegerEnv(
      env['QWEN_SERVE_RATE_LIMIT_PROMPT'],
    );
    options.rateLimitMutation ??= parsePositiveIntegerEnv(
      env['QWEN_SERVE_RATE_LIMIT_MUTATION'],
    );
    options.rateLimitRead ??= parsePositiveIntegerEnv(
      env['QWEN_SERVE_RATE_LIMIT_READ'],
    );
    options.rateLimitWindowMs ??= parsePositiveIntegerEnv(
      env['QWEN_SERVE_RATE_LIMIT_WINDOW_MS'],
    );
  }
}

function discardRateLimitTuningWhenDisabled(options: ServeOptions): void {
  if (options.rateLimit === true) return;
  delete options.rateLimitPrompt;
  delete options.rateLimitMutation;
  delete options.rateLimitRead;
  delete options.rateLimitWindowMs;
}

export async function bootstrapServeFastPathEnvironment(
  workspace: string | undefined,
): Promise<ServeFastPathSettings | undefined> {
  const {
    loadServeFastPathEnvironment,
    loadServeFastPathSettings,
    preResolveServeFastPathHomeEnvOverrides,
  } = await import('./fast-path-settings.js');
  preResolveServeFastPathHomeEnvOverrides();
  const workspaceDir = workspace ?? process.cwd();
  const settings = loadServeFastPathSettings(workspaceDir);
  loadServeFastPathEnvironment(settings, workspaceDir);
  return settings;
}

export function parseServeFastPathArgs(
  rawArgv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ServeFastPathParseResult {
  const argv = normalizeServeFastPathArgv(rawArgv);
  if (argv[0] !== 'serve') return { kind: 'fallback' };
  if (argv.some((arg) => HELP_AND_VERSION_FLAGS.has(arg))) {
    return { kind: 'fallback' };
  }

  const options: ServeOptions = {
    hostname: '127.0.0.1',
    mode: 'http-bridge',
    port: 4170,
  };
  let open = false;
  let httpBridge = true;
  let mcpBudgetModeRaw: string | undefined;
  let mcpClientBudget: number | undefined;
  let explicitRateLimit: boolean | undefined;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') return { kind: 'fallback' };
    if (!arg.startsWith('--')) return { kind: 'fallback' };

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    const rawFlag =
      equalsIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : withoutPrefix.slice(equalsIndex + 1);
    const negated = rawFlag.startsWith('no-');
    const flag = negated ? rawFlag.slice(3) : rawFlag;

    const booleanTarget = BOOLEAN_OPTION_BY_FLAG.get(flag);
    if (booleanTarget) {
      let value = !negated;
      if (inlineValue !== undefined) {
        const parsed = parseBooleanValue(inlineValue);
        if (parsed === null || negated) return { kind: 'fallback' };
        value = parsed;
      }
      if (booleanTarget === 'open') {
        open = value;
      } else if (booleanTarget === 'http-bridge') {
        httpBridge = value;
      } else {
        setServeOption(options, booleanTarget, value);
        if (booleanTarget === 'rateLimit') {
          explicitRateLimit = value;
        }
      }
      continue;
    }
    if (negated) return { kind: 'fallback' };

    const numberTarget = NUMBER_OPTION_BY_FLAG.get(flag);
    if (numberTarget) {
      const read = readOptionValue(argv, i, inlineValue);
      if (!read) return { kind: 'fallback' };
      i = read.nextIndex;
      const value = parseNumber(read.value);
      if (value === null) return { kind: 'fallback' };
      if (numberTarget === 'mcp-client-budget') {
        mcpClientBudget = value;
      } else {
        setServeOption(options, numberTarget, value);
      }
      continue;
    }

    const stringTarget = STRING_OPTION_BY_FLAG.get(flag);
    if (stringTarget) {
      const read = readOptionValue(argv, i, inlineValue);
      if (!read) return { kind: 'fallback' };
      i = read.nextIndex;
      setServeOption(options, stringTarget, read.value);
      continue;
    }

    if (flag === 'mcp-budget-mode') {
      const read = readOptionValue(argv, i, inlineValue);
      if (!read) return { kind: 'fallback' };
      i = read.nextIndex;
      mcpBudgetModeRaw = read.value;
      continue;
    }

    if (flag === 'allow-origin') {
      const read = readOptionValue(argv, i, inlineValue);
      if (!read) return { kind: 'fallback' };
      i = read.nextIndex;
      options.allowOrigins = [...(options.allowOrigins ?? []), read.value];
      continue;
    }

    return { kind: 'fallback' };
  }

  if (
    mcpBudgetModeRaw !== undefined &&
    mcpBudgetModeRaw !== 'enforce' &&
    mcpBudgetModeRaw !== 'warn' &&
    mcpBudgetModeRaw !== 'off'
  ) {
    return { kind: 'fallback' };
  }

  const mcpBudgetMode =
    (mcpBudgetModeRaw as McpBudgetMode | undefined) ??
    (mcpClientBudget !== undefined ? 'warn' : 'off');
  if (mcpClientBudget !== undefined) options.mcpClientBudget = mcpClientBudget;
  options.mcpBudgetMode = mcpBudgetMode;

  if (explicitRateLimit !== undefined) {
    options.rateLimit = explicitRateLimit;
  }
  applyRateLimitEnvDefaults(options, env);
  return { kind: 'serve', open, httpBridge, options };
}

async function maybeOpenWebShellBrowser(
  handle: RunHandle,
  open: boolean,
): Promise<void> {
  if (!open) return;
  const { maybeOpenWebShellBrowser: openBrowser } = await import(
    '../commands/serve.js'
  );
  await openBrowser(handle, true);
}

async function emitHeadlessYoloWarning(
  settings: ServeFastPathSettings | undefined,
) {
  if (!settings) return;
  try {
    const { HEADLESS_YOLO_NO_SANDBOX_WARNING } = await import(
      '../utils/headlessSafetyWarnings.js'
    );
    const suppress = process.env['QWEN_CODE_SUPPRESS_YOLO_WARNING'];
    if (
      settings.tools?.approvalMode === 'yolo' &&
      !settings.tools?.sandbox &&
      !process.env['SANDBOX'] &&
      !isTruthyEnv(suppress)
    ) {
      writeStderrLine(HEADLESS_YOLO_NO_SANDBOX_WARNING);
    }
  } catch {
    // Keep the warning best-effort, matching the yargs serve handler.
  }
}

function writeServeWarnings(parsed: ParsedServeFastPath): void {
  if (!parsed.httpBridge) {
    writeStderrLine(
      'qwen serve: --no-http-bridge (native mode) is not yet implemented; ' +
        'falling back to http-bridge.',
    );
  }
  if (parsed.options.token) {
    writeStderrLine(
      'qwen serve: --token is visible in the process command line; ' +
        'prefer the QWEN_SERVER_TOKEN env var for any non-trivial deployment.',
    );
  }

  const mcpClientBudget = parsed.options.mcpClientBudget;
  if (mcpClientBudget !== undefined) {
    const resolvedMcpMode = parsed.options.mcpBudgetMode ?? 'warn';
    writeStderrLine(
      `qwen serve: --mcp-client-budget=${mcpClientBudget} mode=${resolvedMcpMode}` +
        (resolvedMcpMode === 'enforce'
          ? ' (servers past the cap will be refused at discovery)'
          : resolvedMcpMode === 'warn'
            ? ` (warnings at >=${Math.ceil(mcpClientBudget * MCP_BUDGET_WARN_FRACTION)}, no refusal)`
            : ''),
    );
  }
}

export async function tryRunServeFastPath(
  rawArgv: readonly string[] = process.argv.slice(2),
): Promise<boolean> {
  const parsed = parseServeFastPathArgs(rawArgv);
  if (parsed.kind === 'fallback') return false;

  const validationError =
    getServeFastPathValidationError(parsed) ||
    (parsed.options.rateLimit === true
      ? getRateLimitValidationError(parsed.options)
      : null);
  if (validationError) {
    writeStderrLine(validationError);
    process.exit(1);
  }

  let settings: ServeFastPathSettings | undefined;
  try {
    settings = await bootstrapServeFastPathEnvironment(
      parsed.options.workspace,
    );
  } catch {
    return false;
  }
  applyRateLimitEnvDefaults(parsed.options, process.env);
  discardRateLimitTuningWhenDisabled(parsed.options);

  const rateLimitError = getRateLimitValidationError(parsed.options);
  if (rateLimitError) {
    writeStderrLine(rateLimitError);
    process.exit(1);
  }

  writeServeWarnings(parsed);

  const { runQwenServe } = await import('./run-qwen-serve.js');
  let handle: RunHandle;
  try {
    handle = await runQwenServe(parsed.options, {
      ...(settings ? { bootSettings: settings } : {}),
      resolveOnListen: true,
    });
    void emitHeadlessYoloWarning(settings);
    await maybeOpenWebShellBrowser(handle, parsed.open);
  } catch (err) {
    writeStderrLine(
      `qwen serve: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  await waitForServeRuntimeOrExit(handle);
  await blockForever();
  return true;
}
