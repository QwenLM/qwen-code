/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  APPROVAL_MODES,
  type AuthType,
  Config,
  DEFAULT_QWEN_EMBEDDING_MODEL,
  FileDiscoveryService,
  getAllMemoryFilenames,
  loadServerHierarchicalMemory,
  type LoadServerHierarchicalMemoryOptions,
  type LoadServerHierarchicalMemoryResponse,
  setMemoryFilename as setServerMemoryFilename,
  resolveTelemetrySettings,
  FatalConfigError,
  Storage,
  InputFormat,
  OutputFormat,
  SessionService,
  ideContextStore,
  type ResumedSessionData,
  type SessionRestoreProjection,
  type LspClient,
  type ToolName,
  type ToolInvocationGuard,
  ToolNames,
  NativeLspClient,
  createDebugLogger,
  NativeLspService,
  isBareMode,
  isTruthy,
  isSafeModeEnv,
  isToolEnabled,
  isTlsVerificationDisabled,
  parseBooleanEnvFlag,
  SchemaValidator,
  type ConfigParameters,
  type MCPServerConfig,
  type SkillLevel,
  type WebSearchSettings,
  MAX_SUBAGENT_DEPTH_LIMIT,
  addDaemonRequestAttribute,
} from '@qwen-code/qwen-code-core';
import { extensionsCommand } from '../commands/extensions.js';
import { hooksCommand } from '../commands/hooks.js';
import { resolveAcpChannelFallback } from './acp-channel-fallback.js';
import { normalizeDisabledToolList } from './normalizeDisabledTools.js';
import type { LoadedSettings, Settings } from './settings.js';
import { loadSettings, SettingScope } from './settings.js';
import {
  resolveCliGenerationConfig,
  getAuthTypeFromEnv,
} from '../utils/modelConfigUtils.js';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import stripJsonComments from 'strip-json-comments';

import { resolvePath } from '../utils/resolvePath.js';
import {
  TOP_LEVEL_GLOBAL_OPTIONS,
  DEFAULT_COMMAND,
  DEFAULT_COMMAND_DESC,
  DEFAULT_COMMAND_OPTIONS,
  QUERY_POSITIONAL,
  TOP_LEVEL_DEPRECATED_OPTIONS,
  TOP_LEVEL_USAGE,
} from './top-level-options.js';
import { getCliVersion } from '../utils/version.js';
import { loadSandboxConfig } from './sandboxConfig.js';
import { appEvents } from '../utils/events.js';
import { mcpCommand } from '../commands/mcp.js';
import { channelCommand } from '../commands/channel.js';
import { authCommand } from '../commands/auth.js';
import { reviewCommand } from '../commands/review.js';
import { serveCommand } from '../commands/serve.js';
import { sessionsCommand } from '../commands/sessions.js';
import { boardCommand } from '../commands/board.js';
import { updateCommand } from '../commands/update.js';
import { isValidSessionId, normalizeSessionIdForLookup } from './session-id.js';

export { isValidSessionId } from './session-id.js';

import { isWorkspaceTrusted } from './trustedFolders.js';
import { assembleMcpServers } from './mcpServers.js';
import { getPendingGatedMcpServers } from './mcpApprovals.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import {
  parseDurationSeconds,
  validateGoalTokenBudget,
  validateMaxToolCalls,
  validateMaxWallTimeSetting,
} from '../utils/runBudget.js';
import { detectSystemLanguage } from '../i18n/index.js';
import { resolveSkillSettings } from './skill-settings.js';

const debugLogger = createDebugLogger('CONFIG');

function resolveLocaleForExtensions(settings: Settings): string {
  const envLang = process.env['QWEN_CODE_LANG'];
  if (envLang) return envLang;
  const settingsLang = settings.general?.language as string | undefined;
  if (settingsLang && settingsLang !== 'auto') return settingsLang;
  return detectSystemLanguage();
}

const SKILL_LEVELS: readonly SkillLevel[] = [
  'project',
  'user',
  'extension',
  'bundled',
];

function isSkillLevel(value: unknown): value is SkillLevel {
  return SKILL_LEVELS.includes(value as SkillLevel);
}

function formatApprovalModeError(value: string): Error {
  return new Error(
    `Invalid approval mode: ${value}. Valid values are: ${APPROVAL_MODES.join(
      ', ',
    )}`,
  );
}

function parseApprovalModeValue(value: string): ApprovalMode {
  const normalized = value.trim().toLowerCase();
  const canonical =
    normalized === 'auto_edit' || normalized === 'autoedit'
      ? ApprovalMode.AUTO_EDIT
      : normalized;
  const approvalMode = APPROVAL_MODES.find((mode) => mode === canonical);
  if (approvalMode === undefined) {
    throw formatApprovalModeError(value);
  }
  return approvalMode;
}

export interface CliArgs {
  query: string | undefined;
  model: string | undefined;
  fallbackModel: string[] | undefined;
  sandbox: boolean | string | undefined;
  sandboxImage: string | undefined;
  debug: boolean | undefined;
  prompt: string | undefined;
  promptInteractive: string | undefined;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  yolo: boolean | undefined;
  bare: boolean | undefined;
  safeMode?: boolean | undefined;
  approvalMode: string | undefined;
  telemetry: boolean | undefined;
  telemetryTarget: string | undefined;
  telemetryOtlpEndpoint: string | undefined;
  telemetryOtlpProtocol: string | undefined;
  telemetryLogPrompts: boolean | undefined;
  telemetryOutfile: string | undefined;
  allowedMcpServerNames: string[] | undefined;
  mcpConfig: string | undefined;
  allowedTools: string[] | undefined;
  acp: boolean | undefined;
  experimentalAcp: boolean | undefined;
  experimentalLsp: boolean | undefined;
  restoreAskUserQuestion: boolean | undefined;
  extensions: string[] | undefined;
  listExtensions: boolean | undefined;
  openaiLogging: boolean | undefined;
  openaiApiKey: string | undefined;
  openaiBaseUrl: string | undefined;
  openaiLoggingDir: string | undefined;
  proxy: string | undefined;
  insecure?: boolean | undefined;
  includeDirectories: string[] | undefined;
  screenReader: boolean | undefined;
  inputFormat?: string | undefined;
  outputFormat: string | undefined;
  includePartialMessages?: boolean;
  /**
   * If chat recording is disabled, the chat history would not be recorded,
   * so --continue and --resume would not take effect.
   */
  chatRecording: boolean | undefined;
  /** Resume the most recent session for the current project */
  continue: boolean | undefined;
  /** Resume a specific session by its ID */
  resume: string | undefined;
  /** Specify a session ID without session resumption */
  sessionId: string | undefined;
  /**
   * Internal: `sessionId` was generated by the daemon just now (not
   * caller-supplied), so the caller-id occupancy check is skipped — a fresh
   * UUID has no case-twin to protect, and the check's readdir cost and
   * fail-closed policy must not apply to the id-less creation hot path.
   */
  sessionIdGenerated?: boolean | undefined;
  /**
   * Create a new forked session from the resumed session. Must be used with
   * --resume or --continue.
   */
  forkSession?: boolean | undefined;
  /** Internal: preserve the outer session ID when relaunching in a sandbox */
  sandboxSessionId?: string | undefined;
  /**
   * Start the session inside a git worktree. Accepted forms:
   * - bare `--worktree` (empty string from yargs) → auto-generated slug
   * - `--worktree foo` / `--worktree=foo` → explicit slug
   * - `--worktree=#123` / `--worktree https://github.com/o/r/pull/123` → PR ref
   *
   * Consumed by `setupStartupWorktree()` before `loadCliConfig()`. When set,
   * the CLI chdirs into `<repoRoot>/.qwen/worktrees/<slug>/` and the entire
   * session runs inside that worktree.
   */
  worktree?: string | undefined;
  maxSessionTurns: number | undefined;
  maxWallTime: string | undefined;
  maxToolCalls: number | undefined;
  maxSubagentDepth: number | undefined;
  coreTools: string[] | undefined;
  excludeTools: string[] | undefined;
  disabledSlashCommands: string[] | undefined;
  authType: string | undefined;
  channel: string | undefined;
  jsonFd?: number | undefined;
  jsonFile?: string | undefined;
  jsonSchema?: string | undefined;
  inputFile?: string | undefined;
}

/**
 * Returns true if the root of the given schema can accept a JSON object.
 *
 * JSON Schema applies sibling keywords conjunctively, so `type`, `anyOf`,
 * `oneOf`, and `allOf` at the same level must EACH allow an object — they
 * can't rescue one another. For example, `{type:"object", anyOf:[{type:"string"}]}`
 * is unsatisfiable for any value because `type` requires object while
 * `anyOf` requires string. Walk all four rather than returning on the
 * first hit.
 *
 * For `anyOf` / `oneOf`, at least one branch must admit object (a value
 * only has to match one branch). For `allOf`, every branch must admit
 * object (a value has to match all of them). Root `$ref` is rejected
 * unconditionally — Ajv applies `$ref` conjunctively with sibling
 * keywords, so even `{type:"object", $ref:"#/$defs/Foo"}` is
 * unsatisfiable when `Foo` resolves to a non-object schema. We don't
 * follow refs ourselves (local-only resolution would still need to
 * handle remote / recursive refs) so users wanting composition should
 * inline the schema at the root or use `allOf`.
 *
 * The `$ref` rejection is **root-only**. Sub-schemas inside `anyOf` /
 * `oneOf` / `allOf` recurse with `isRoot=false`, where a `$ref` is
 * treated as opaque (assume-object-compatible) and deferred to Ajv at
 * runtime — otherwise common composition shapes like
 * `{anyOf:[{$ref:"#/$defs/Foo"}, {type:"string"}]}` would be wrongly
 * rejected at parse time even though Ajv can resolve them.
 */
function schemaRootAcceptsObject(
  schema: Record<string, unknown>,
  isRoot = true,
): boolean {
  if (isRoot && typeof schema['$ref'] === 'string') {
    // Reject any root `$ref`. The previous "accept when sibling
    // `type:"object"` is present" carve-out was unsound: Ajv applies
    // both keywords, so `{type:"object", $ref:"#/$defs/Foo",
    // $defs:{Foo:{type:"array"}}}` parses fine but no object argument
    // can satisfy both at runtime — the model would loop forever on
    // validation failures.
    return false;
  }

  const rawType = schema['type'];
  const typeIncludesObject =
    rawType !== undefined &&
    (Array.isArray(rawType) ? rawType : [rawType]).includes('object');

  if (rawType !== undefined && !typeIncludesObject) {
    return false;
  }

  // Root `const` / `enum` pin the value to specific literals. If those
  // literals can never be a JSON object (e.g. `{const: 1}` or
  // `{enum: ["a", "b"]}`), no object satisfies the schema — reject.
  if ('const' in schema) {
    const constVal = schema['const'];
    if (
      typeof constVal !== 'object' ||
      constVal === null ||
      Array.isArray(constVal)
    ) {
      return false;
    }
  }
  const enumVal = schema['enum'];
  if (Array.isArray(enumVal)) {
    const anyObjectMember = enumVal.some(
      (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
    );
    if (!anyObjectMember) return false;
  }

  // JSON Schema (draft-06+) treats `true` and `false` as valid subschemas
  // for any keyword that accepts a schema: `true` matches every value,
  // `false` matches nothing. Honour those alongside object subschemas so
  // shapes like `{anyOf:[true]}` or `{allOf:[true,{type:"object"}]}` pass
  // and `{anyOf:[false]}` is rejected.
  const variantAcceptsObject = (v: unknown): boolean => {
    if (v === true) return true;
    if (v === false) return false;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      // isRoot=false: nested branches don't trigger the root-only `$ref`
      // rejection — the parent's keyword scope already pins the
      // sub-schema's role to "candidate value type", and Ajv will
      // resolve the ref at runtime.
      return schemaRootAcceptsObject(v as Record<string, unknown>, false);
    }
    return false;
  };

  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key];
    if (Array.isArray(variants)) {
      // Empty anyOf/oneOf is unsatisfiable per JSON Schema — no value can
      // match a member of an empty union. Reject rather than treating it
      // as "no constraint".
      if (variants.length === 0) return false;
      if (!variants.some(variantAcceptsObject)) return false;
    }
  }

  const allOf = schema['allOf'];
  if (Array.isArray(allOf) && allOf.length > 0) {
    // allOf is conjunctive — `false` in any branch makes the schema
    // unsatisfiable, `true` is neutral.
    if (!allOf.every(variantAcceptsObject)) return false;
  }

  // Best-effort `not` handling: when `not` directly forbids object via its
  // own `type` keyword (e.g. `{not:{type:"object"}}` or
  // `{not:{type:["object","null"]}}`), the schema can never be satisfied
  // by an object — reject. We don't try to do full satisfiability analysis
  // for arbitrary `not` schemas (e.g. `not:{const:"foo"}` is fine, but
  // `not:{anyOf:[{type:"object"},…]}` would also reject objects); those
  // fall through to Ajv at runtime.
  const notSchema = schema['not'];
  if (
    typeof notSchema === 'object' &&
    notSchema !== null &&
    !Array.isArray(notSchema)
  ) {
    const notRecord = notSchema as Record<string, unknown>;
    const notType = notRecord['type'];
    if (notType !== undefined) {
      const types = Array.isArray(notType) ? notType : [notType];
      // If `not` is JUST `{type: "object"[…]}` (no additional keywords),
      // every object value matches the `not` subschema and so gets
      // excluded — schema is unsatisfiable for objects, reject.
      //
      // If `not` has additional constraints alongside `type` (e.g.
      // `{not:{type:"object",required:["error"]}}`), those constraints
      // NARROW what `not` excludes: only objects matching ALL of `not`'s
      // keywords are rejected, so objects that fail any of the
      // narrowing constraints survive. Example: `{}` satisfies
      // `{not:{type:"object",required:["error"]}}` because the value
      // lacks the `error` key. Rejecting at parse time would be a
      // false positive — defer to Ajv at runtime.
      if (types.includes('object') && Object.keys(notRecord).length === 1) {
        return false;
      }
    }
  }

  // Best-effort `if/then/else` handling for the decidable cases. The
  // semantics: if the value matches `if`, it must match `then`; otherwise
  // it must match `else` (defaults to `true`). For root-acceptance we can
  // only decide statically when `if` is itself a constant boolean
  // subschema:
  //   `if: true`  → every object matches `if`, so it MUST match `then`.
  //   `if: false` → no value matches `if`, so it must match `else`.
  // Other shapes for `if` (object schemas) depend on the candidate value
  // and fall through to Ajv at runtime — we can't decide acceptance
  // without seeing the value.
  if ('if' in schema) {
    const ifSchema = schema['if'];
    if (ifSchema === true) {
      // Object MUST match `then` (if absent, defaults to `true`, no
      // constraint on root acceptance).
      const thenSchema = schema['then'];
      if (thenSchema !== undefined && !variantAcceptsObject(thenSchema)) {
        return false;
      }
    } else if (ifSchema === false) {
      // Object MUST match `else` (if absent, defaults to `true`).
      const elseSchema = schema['else'];
      if (elseSchema !== undefined && !variantAcceptsObject(elseSchema)) {
        return false;
      }
    }
    // ifSchema is an object schema — runtime Ajv decides; do nothing.
  }

  // No narrowing at the root — lenient default, treated as object-compatible.
  return true;
}

/** 4 MiB — well above any real schema, well below an accidental
 * gigabyte-sized file that would OOM `fs.readFileSync` + `JSON.parse`.
 */
const MAX_JSON_SCHEMA_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Resolves the `--json-schema` argument into a parsed JSON Schema object.
 *
 * Accepts either a JSON literal or `@path/to/schema.json`. Fails fast with a
 * FatalConfigError if the input can't be read/parsed/compiled — invalid
 * schemas should not silently skip validation at runtime.
 */
export function resolveJsonSchemaArg(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new FatalConfigError('--json-schema cannot be empty.');
  }

  let payload: string;
  let payloadSource: 'inline' | 'file' = 'inline';
  let payloadSourcePath: string | undefined;
  if (trimmed.startsWith('@')) {
    const resolvedPath = resolvePath(trimmed.slice(1));
    payloadSource = 'file';
    payloadSourcePath = resolvedPath;
    try {
      // Stat first so we can refuse non-regular files (directories,
      // character devices like `/dev/zero`, FIFOs that would block
      // synchronously) and cap by size before pulling bytes into memory.
      // The cap (`MAX_JSON_SCHEMA_FILE_BYTES`) is set well above any real
      // schema and well below an accidental gigabyte-sized file that
      // would OOM `fs.readFileSync` + `JSON.parse`.
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        throw new FatalConfigError(
          `--json-schema "@${resolvedPath}" must be a regular file.`,
        );
      }
      if (stat.size > MAX_JSON_SCHEMA_FILE_BYTES) {
        throw new FatalConfigError(
          `--json-schema file "${resolvedPath}" is ${stat.size} bytes ` +
            `(>${MAX_JSON_SCHEMA_FILE_BYTES}). Refusing to read; this is ` +
            'almost certainly a wrong-path argument. Schemas should be ' +
            'small enough to fit in a few KiB; decompose with `$ref` if ' +
            'you need a large family of types.',
        );
      }
      payload = fs.readFileSync(resolvedPath, 'utf8');
    } catch (err) {
      if (err instanceof FatalConfigError) throw err;
      throw new FatalConfigError(
        `--json-schema could not read "${resolvedPath}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    payload = trimmed;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    // For inline JSON the user IS the source — echoing the SyntaxError
    // (which on Node ≥18 embeds a 10-char input snippet) is fine. For
    // @path, the error message would leak a prefix of the file's bytes
    // through stderr to whatever wrapping process surfaces it; emit a
    // generic message instead.
    if (payloadSource === 'file') {
      throw new FatalConfigError(
        `--json-schema content of "${payloadSourcePath}" is not valid JSON.`,
      );
    }
    throw new FatalConfigError(
      `--json-schema is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FatalConfigError(
      '--json-schema must be a JSON object describing a schema.',
    );
  }

  // The schema will be installed as a TOOL PARAMETER schema. All function-
  // calling APIs (Gemini/OpenAI/Anthropic) require tool arguments to be a
  // JSON object, so a schema that cannot accept objects registers an
  // unusable synthetic tool the model could never satisfy. `schemaRootAcceptsObject`
  // walks `type`/`const`/`enum`/`anyOf`/`oneOf`/`allOf`/`not`/`if` (with
  // best-effort decidable cases for the harder shapes); the strict Ajv
  // compile below catches structural validity. The two together cover both
  // "schema can be parsed" and "schema can be satisfied by an object value".
  if (!schemaRootAcceptsObject(parsed as Record<string, unknown>)) {
    throw new FatalConfigError(
      '--json-schema root must accept object-typed values (tool parameters ' +
        'are always JSON objects). At least one branch of a root anyOf/oneOf ' +
        'must be satisfiable by an object, and a root `type` (when present) ' +
        'must include "object".',
    );
  }

  // Ajv compile-time validation. SchemaValidator.validate is deliberately
  // lenient at runtime (falls back to no-op on compile failure to support
  // exotic MCP schemas) — but `--json-schema` is explicit user intent, so
  // surface a bad schema here rather than letting it silently no-op later.
  const compileError = SchemaValidator.compileStrict(parsed);
  if (compileError) {
    throw new FatalConfigError(
      `--json-schema is not a valid JSON Schema: ${compileError}`,
    );
  }

  return parsed as Record<string, unknown>;
}

function normalizeOutputFormat(
  format: string | OutputFormat | undefined,
): OutputFormat | undefined {
  if (!format) {
    return undefined;
  }
  if (format === OutputFormat.STREAM_JSON) {
    return OutputFormat.STREAM_JSON;
  }
  if (format === 'json' || format === OutputFormat.JSON) {
    return OutputFormat.JSON;
  }
  return OutputFormat.TEXT;
}

export async function parseArguments(): Promise<CliArgs> {
  let rawArgv = hideBin(process.argv);

  // hack: if the first argument is the CLI entry point, remove it
  if (
    rawArgv.length > 0 &&
    (rawArgv[0].endsWith('/dist/qwen-cli/cli.js') ||
      rawArgv[0].endsWith('/dist/cli.js') ||
      rawArgv[0].endsWith('/dist/cli/cli.js'))
  ) {
    rawArgv = rawArgv.slice(1);
  }

  const yargsInstance = yargs(rawArgv)
    .locale('en')
    .scriptName('qwen')
    .usage(TOP_LEVEL_USAGE)
    .option('telemetry', TOP_LEVEL_GLOBAL_OPTIONS.telemetry)
    .option('telemetry-target', TOP_LEVEL_GLOBAL_OPTIONS['telemetry-target'])
    .option(
      'telemetry-otlp-endpoint',
      TOP_LEVEL_GLOBAL_OPTIONS['telemetry-otlp-endpoint'],
    )
    .option(
      'telemetry-otlp-protocol',
      TOP_LEVEL_GLOBAL_OPTIONS['telemetry-otlp-protocol'],
    )
    .option(
      'telemetry-log-prompts',
      TOP_LEVEL_GLOBAL_OPTIONS['telemetry-log-prompts'],
    )
    .option('telemetry-outfile', TOP_LEVEL_GLOBAL_OPTIONS['telemetry-outfile'])
    .option('debug', TOP_LEVEL_GLOBAL_OPTIONS.debug)
    .option('bare', TOP_LEVEL_GLOBAL_OPTIONS.bare)
    .option('safe-mode', TOP_LEVEL_GLOBAL_OPTIONS['safe-mode'])
    .option('proxy', TOP_LEVEL_GLOBAL_OPTIONS.proxy)
    .option('insecure', TOP_LEVEL_GLOBAL_OPTIONS.insecure)
    .option('chat-recording', TOP_LEVEL_GLOBAL_OPTIONS['chat-recording'])
    .command(DEFAULT_COMMAND, DEFAULT_COMMAND_DESC, (yargsInstance: Argv) =>
      yargsInstance
        .positional('query', QUERY_POSITIONAL)
        .option('model', DEFAULT_COMMAND_OPTIONS.model)
        .option('fallback-model', {
          ...DEFAULT_COMMAND_OPTIONS['fallback-model'],
          string: true,
          coerce: (models: string[]) =>
            models
              .flatMap((m) => m.split(',').map((s) => s.trim()))
              .filter(Boolean),
        })
        .option('prompt', DEFAULT_COMMAND_OPTIONS.prompt)
        .option(
          'prompt-interactive',
          DEFAULT_COMMAND_OPTIONS['prompt-interactive'],
        )
        .option('system-prompt', DEFAULT_COMMAND_OPTIONS['system-prompt'])
        .option(
          'append-system-prompt',
          DEFAULT_COMMAND_OPTIONS['append-system-prompt'],
        )
        .option('sandbox', DEFAULT_COMMAND_OPTIONS.sandbox)
        .option('sandbox-image', DEFAULT_COMMAND_OPTIONS['sandbox-image'])
        .option('yolo', DEFAULT_COMMAND_OPTIONS.yolo)
        .option('approval-mode', DEFAULT_COMMAND_OPTIONS['approval-mode'])
        .option('acp', DEFAULT_COMMAND_OPTIONS.acp)
        .option('experimental-acp', {
          type: 'boolean' as const,
          description:
            'Starts the agent in ACP mode (deprecated, use --acp instead)',
          hidden: true,
        })
        .option('experimental-skills', {
          type: 'boolean' as const,
          description:
            'Deprecated: Skills are now enabled by default. This flag is ignored.',
          hidden: true,
        })
        .option('experimental-lsp', DEFAULT_COMMAND_OPTIONS['experimental-lsp'])
        .option(
          'restore-ask-user-question',
          DEFAULT_COMMAND_OPTIONS['restore-ask-user-question'],
        )
        .option('channel', DEFAULT_COMMAND_OPTIONS.channel)
        .option('allowed-mcp-server-names', {
          ...DEFAULT_COMMAND_OPTIONS['allowed-mcp-server-names'],
          string: true,
          coerce: (mcpServerNames: string[]) =>
            // Handle comma-separated values
            mcpServerNames.flatMap((mcpServerName) =>
              mcpServerName.split(',').map((m) => m.trim()),
            ),
        })
        .option('mcp-config', DEFAULT_COMMAND_OPTIONS['mcp-config'])
        .option('allowed-tools', {
          ...DEFAULT_COMMAND_OPTIONS['allowed-tools'],
          string: true,
          coerce: (tools: string[]) =>
            // Handle comma-separated values
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('extensions', {
          ...DEFAULT_COMMAND_OPTIONS.extensions,
          string: true,
          coerce: (extensions: string[]) =>
            // Handle comma-separated values
            extensions.flatMap((extension) =>
              extension.split(',').map((e) => e.trim()),
            ),
        })
        .option('list-extensions', DEFAULT_COMMAND_OPTIONS['list-extensions'])
        .option('include-directories', {
          ...DEFAULT_COMMAND_OPTIONS['include-directories'],
          string: true,
          coerce: (dirs: string[]) =>
            // Handle comma-separated values
            dirs.flatMap((dir) => dir.split(',').map((d) => d.trim())),
        })
        .option('openai-logging', DEFAULT_COMMAND_OPTIONS['openai-logging'])
        .option(
          'openai-logging-dir',
          DEFAULT_COMMAND_OPTIONS['openai-logging-dir'],
        )
        .option('openai-api-key', DEFAULT_COMMAND_OPTIONS['openai-api-key'])
        .option('openai-base-url', DEFAULT_COMMAND_OPTIONS['openai-base-url'])
        .option('screen-reader', DEFAULT_COMMAND_OPTIONS['screen-reader'])
        .option('input-format', DEFAULT_COMMAND_OPTIONS['input-format'])
        .option('output-format', DEFAULT_COMMAND_OPTIONS['output-format'])
        .option(
          'include-partial-messages',
          DEFAULT_COMMAND_OPTIONS['include-partial-messages'],
        )
        .option('json-fd', DEFAULT_COMMAND_OPTIONS['json-fd'])
        .option('json-file', DEFAULT_COMMAND_OPTIONS['json-file'])
        .option('json-schema', DEFAULT_COMMAND_OPTIONS['json-schema'])
        .option('input-file', DEFAULT_COMMAND_OPTIONS['input-file'])
        .option('continue', DEFAULT_COMMAND_OPTIONS.continue)
        .option('resume', DEFAULT_COMMAND_OPTIONS.resume)
        .option('session-id', DEFAULT_COMMAND_OPTIONS['session-id'])
        .option('fork-session', DEFAULT_COMMAND_OPTIONS['fork-session'])
        .option('sandbox-session-id', {
          type: 'string' as const,
          hidden: true,
        })
        .option('worktree', DEFAULT_COMMAND_OPTIONS.worktree)
        .option(
          'max-session-turns',
          DEFAULT_COMMAND_OPTIONS['max-session-turns'],
        )
        .option('max-wall-time', DEFAULT_COMMAND_OPTIONS['max-wall-time'])
        .option('max-tool-calls', DEFAULT_COMMAND_OPTIONS['max-tool-calls'])
        .option(
          'max-subagent-depth',
          DEFAULT_COMMAND_OPTIONS['max-subagent-depth'],
        )
        .option('core-tools', {
          ...DEFAULT_COMMAND_OPTIONS['core-tools'],
          string: true,
          coerce: (tools: string[]) =>
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('exclude-tools', {
          ...DEFAULT_COMMAND_OPTIONS['exclude-tools'],
          string: true,
          coerce: (tools: string[]) =>
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('disabled-slash-commands', {
          ...DEFAULT_COMMAND_OPTIONS['disabled-slash-commands'],
          string: true,
          coerce: (names: string[]) =>
            names.flatMap((n) => n.split(',').map((t) => t.trim())),
        })
        .option('auth-type', DEFAULT_COMMAND_OPTIONS['auth-type'])
        // Ensure validation flows through .fail() for clean UX
        .fail((msg: string, err: Error | undefined, yargs: Argv) => {
          writeStderrLine(msg || err?.message || 'Unknown error');
          yargs.showHelp();
          process.exit(1);
        })
        .check((argv: { [x: string]: unknown }) => {
          // The 'query' positional can be a string (for one arg) or string[] (for multiple).
          // This guard safely checks if any positional argument was provided.
          const query = argv['query'] as string | string[] | undefined;
          const hasPositionalQuery = Array.isArray(query)
            ? query.length > 0
            : !!query;

          if (argv['prompt'] && hasPositionalQuery) {
            return 'Cannot use both a positional prompt and the --prompt (-p) flag together';
          }
          if (argv['prompt'] && argv['promptInteractive']) {
            return 'Cannot use both --prompt (-p) and --prompt-interactive (-i) together';
          }
          if (argv['yolo'] && argv['approvalMode']) {
            return 'Cannot use both --yolo (-y) and --approval-mode together. Use --approval-mode=yolo instead.';
          }
          if (
            argv['includePartialMessages'] &&
            argv['outputFormat'] !== OutputFormat.STREAM_JSON
          ) {
            return '--include-partial-messages requires --output-format stream-json';
          }
          if (
            argv['inputFormat'] === 'stream-json' &&
            argv['outputFormat'] !== OutputFormat.STREAM_JSON
          ) {
            return '--input-format stream-json requires --output-format stream-json';
          }
          if (argv['continue'] && argv['resume']) {
            return 'Cannot use both --continue and --resume together. Use --continue to resume the latest session, or --resume <sessionId> to resume a specific session.';
          }
          const hasResume = argv['resume'] !== undefined;
          if (argv['sessionId'] && (argv['continue'] || hasResume)) {
            return 'Cannot use --session-id with --continue or --resume. Use --session-id to start a new session with a specific ID, or use --continue/--resume to resume an existing session.';
          }
          if (argv['forkSession'] && !(argv['continue'] || hasResume)) {
            return '--fork-session must be used with --resume or --continue.';
          }
          if (
            argv['sandboxSessionId'] &&
            (argv['sessionId'] || argv['continue'] || argv['resume'])
          ) {
            return 'Cannot use internal --sandbox-session-id with --session-id, --continue, or --resume.';
          }
          if (
            argv['sessionId'] &&
            !isValidSessionId(argv['sessionId'] as string)
          ) {
            return `Invalid --session-id: "${argv['sessionId']}". Must be a valid UUID (e.g., "123e4567-e89b-12d3-a456-426614174000").`;
          }
          if (
            argv['sandboxSessionId'] &&
            !isValidSessionId(argv['sandboxSessionId'] as string)
          ) {
            return `Invalid --sandbox-session-id: "${argv['sandboxSessionId']}". Must be a valid UUID (e.g., "123e4567-e89b-12d3-a456-426614174000").`;
          }
          // --resume accepts either a session UUID or a custom title
          if (argv['jsonFd'] != null && argv['jsonFile'] != null) {
            return '--json-fd and --json-file are mutually exclusive. Use one or the other.';
          }
          if (argv['jsonSchema']) {
            if (argv['promptInteractive']) {
              return '--json-schema cannot be used with --prompt-interactive (-i); structured output only terminates the non-interactive flow.';
            }
            if (argv['inputFormat'] === 'stream-json') {
              // The "first valid structured_output call ends the session"
              // contract assumes a single one-shot prompt. Stream-json
              // input keeps the process open waiting for more protocol
              // messages, so terminating on the first call would silently
              // drop subsequent prompts. Refuse the combination here
              // rather than letting the run race to whichever message
              // wins.
              return '--json-schema cannot be used with --input-format stream-json; the "first structured_output call ends the session" contract is incompatible with the long-lived stream-json input protocol.';
            }
            if (argv['acp'] || argv['experimentalAcp']) {
              // ACP runs an external IDE/Zed protocol on its own turn loop
              // (runAcpAgent), which doesn't honour the synthetic
              // structured_output contract. Without this check the tool
              // would register but its "session ends now" llmContent would
              // just be relayed back into the ACP chat, leaving the run
              // open and silently ignoring --json-schema.
              return '--json-schema cannot be used with --acp; structured output is only honoured by the headless non-interactive flow.';
            }
            const hasPrompt = !!argv['prompt'];
            const query = argv['query'] as string | string[] | undefined;
            const hasPositionalQuery = Array.isArray(query)
              ? query.length > 0
              : !!query;
            // Allow stdin piping (`echo "..." | qwen --json-schema ...`):
            // when stdin is not a TTY, the prompt is supplied via the pipe
            // and headless mode runs normally. Only reject true interactive
            // invocations with neither flag nor positional nor pipe — the
            // synthetic tool's "session ends now" llmContent has no
            // termination handler in the TUI loop, so silently launching
            // the TUI would strand the run.
            const stdinIsPiped = !process.stdin.isTTY;
            if (!hasPrompt && !hasPositionalQuery && !stdinIsPiped) {
              return '--json-schema only applies to non-interactive mode; pass a prompt via -p, as a positional argument, or piped via stdin.';
            }
          }
          return true;
        }),
    )
    // Register MCP subcommands
    .command(mcpCommand)
    // Register Extension subcommands
    .command(extensionsCommand)
    .command(authCommand)
    // Register Hooks subcommands
    .command(hooksCommand)
    // Register Channel subcommands
    .command(channelCommand)
    .command(boardCommand)
    // Register /review skill helpers (presubmit checks, cleanup)
    .command(reviewCommand)
    // Register `qwen serve` (Stage 1 daemon)
    .command(serveCommand)
    // Register sessions subcommands
    .command(sessionsCommand)
    // Register update command
    .command(updateCommand);

  for (const [option, message] of Object.entries(
    TOP_LEVEL_DEPRECATED_OPTIONS,
  )) {
    yargsInstance.deprecateOption(option, message);
  }

  yargsInstance
    .version(await getCliVersion()) // This will enable the --version flag based on package.json
    .alias('v', 'version')
    .help()
    .alias('h', 'help')
    .strict()
    .demandCommand(0, 0); // Allow base command to run with no subcommands

  yargsInstance.wrap(yargsInstance.terminalWidth());
  const result = await yargsInstance.parse();

  // If yargs handled --help/--version it will have exited; nothing to do here.

  // Handle case where MCP subcommands are executed - they should exit the process
  // and not return to main CLI logic
  if (
    result._.length > 0 &&
    (result._[0] === 'mcp' ||
      result._[0] === 'extensions' ||
      result._[0] === 'auth' ||
      result._[0] === 'hooks' ||
      result._[0] === 'channel' ||
      result._[0] === 'review' ||
      result._[0] === 'sessions' ||
      result._[0] === 'board' ||
      result._[0] === 'update')
  ) {
    // Note: `serve` is intentionally NOT in this list. Its handler blocks
    // forever (after the listener is up); SIGINT/SIGTERM in runQwenServe
    // drives shutdown. Hitting `process.exit(0)` here would kill the daemon.
    // MCP/Extensions/Auth/Hooks/Channel/Review commands handle their own
    // execution and exit. Returning here would let the main interactive
    // flow run, which would prompt for stdin input despite the user
    // having already invoked a subcommand.
    process.exit(process.exitCode ?? 0);
  }

  // Normalize query args: handle both quoted "@path file" and unquoted @path file
  const queryArg = (result as { query?: string | string[] | undefined }).query;
  const q: string | undefined = Array.isArray(queryArg)
    ? queryArg.join(' ')
    : queryArg;

  // Route positional args: explicit -i flag -> interactive; else -> one-shot (even for @commands)
  if (q && !result['prompt']) {
    const hasExplicitInteractive =
      result['promptInteractive'] === '' || !!result['promptInteractive'];
    if (hasExplicitInteractive) {
      result['promptInteractive'] = q;
    } else {
      result['prompt'] = q;
    }
  }

  // Keep CliArgs.query as a string for downstream typing
  (result as Record<string, unknown>)['query'] = q || undefined;

  // The import format is now only controlled by settings.memoryImportFormat
  // We no longer accept it as a CLI argument

  // Handle deprecated --experimental-acp flag
  if (result['experimentalAcp']) {
    writeStderrLine(
      '\x1b[33m⚠ Warning: --experimental-acp is deprecated and will be removed in a future release. Please use --acp instead.\x1b[0m',
    );
    // Map experimental-acp to acp if acp is not explicitly set
    if (!result['acp']) {
      (result as Record<string, unknown>)['acp'] = true;
    }
  }

  // Apply ACP fallback: if acp or experimental-acp is present but no explicit
  // --channel, attribute the launch — daemon-spawned children carry the serve
  // marker, the Tauri desktop shell additionally sets QWEN_CODE_DESKTOP.
  if ((result['acp'] || result['experimentalAcp']) && !result['channel']) {
    (result as Record<string, unknown>)['channel'] =
      resolveAcpChannelFallback();
  }

  return result as unknown as CliArgs;
}

// This function is now a thin wrapper around the server's implementation.
// It's kept in the CLI for now as App.tsx directly calls it for memory refresh.
// TODO: Consider if App.tsx should get memory via a server call or if Config should refresh itself.
export async function loadHierarchicalMemory(
  currentWorkingDirectory: string,
  includeDirectoriesToReadMemory: readonly string[] = [],
  fileService: FileDiscoveryService,
  extensionContextFilePaths: string[] = [],
  folderTrust: boolean,
  memoryImportFormat: 'flat' | 'tree' = 'tree',
  contextRuleExcludes: string[] = [],
  options: LoadServerHierarchicalMemoryOptions = {},
): Promise<LoadServerHierarchicalMemoryResponse> {
  // FIX: Use real, canonical paths for a reliable comparison to handle symlinks.
  const realCwd = fs.realpathSync(path.resolve(currentWorkingDirectory));
  const realHome = fs.realpathSync(path.resolve(homedir()));
  const isHomeDirectory = realCwd === realHome;

  // If it is the home directory, pass an empty string to the core memory
  // function to signal that it should skip the workspace search.
  const effectiveCwd = isHomeDirectory ? '' : currentWorkingDirectory;

  // Directly call the server function with the corrected path.
  return loadServerHierarchicalMemory(
    effectiveCwd,
    includeDirectoriesToReadMemory,
    fileService,
    extensionContextFilePaths,
    folderTrust,
    memoryImportFormat,
    contextRuleExcludes,
    options,
  );
}

/**
 * Merge CLI `--fallback-model` values with the `modelFallbacks` setting.
 * CLI values take precedence when provided; otherwise the setting value
 * (a comma-separated string) is split and used.
 *
 * @param cliValues  - Repeated/comma-split values from `--fallback-model`.
 * @param settingValue - Comma-separated string from the `modelFallbacks` setting.
 * @returns An array of model IDs (may be empty). Core-level normalization
 *          (dedup, cap at 3) is handled by `normalizeModelFallbacks` in Config.
 */
function resolveModelFallbacks(
  cliValues: string[] | undefined,
  settingValue: string | undefined,
): string[] | undefined {
  // CLI flag takes precedence when provided
  if (cliValues && cliValues.length > 0) {
    return cliValues;
  }
  // Fall back to settings (comma-separated string)
  if (settingValue && settingValue.trim().length > 0) {
    return settingValue
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

/**
 * Resolve the built-in WebSearch tool settings, with env overrides taking
 * precedence over `tools.webSearch` (mirroring the QWEN_SANDBOX_IMAGE
 * pattern): ENABLE_WEB_SEARCH for the flag, WEB_SEARCH_MODEL for the model
 * selector, WEB_SEARCH_EXTRACTOR for page reading.
 *
 * Env-only backend: WEB_SEARCH_BASE_URL mirrors a modelProviders entry's
 * baseUrl for environments that cannot write settings.json; the API key
 * comes from WEB_SEARCH_API_KEY, falling back to DASHSCOPE_API_KEY. When
 * set, it takes precedence over modelProviders resolution in the gate.
 */
function resolveWebSearchSettings(
  settings: Settings,
): WebSearchSettings | undefined {
  const webSearch = settings.tools?.webSearch;
  // A set-but-empty env var is "unset", not an override: dotenv templates and
  // CI wrappers export empty values, which must not clobber a valid
  // settings.json config (same rule as WEB_SEARCH_BASE_URL below).
  const envEnabled = process.env['ENABLE_WEB_SEARCH']?.trim() || undefined;
  const enabled =
    envEnabled !== undefined ? isTruthy(envEnabled) : webSearch?.enabled;
  const model = process.env['WEB_SEARCH_MODEL']?.trim() || webSearch?.model;
  const envExtractor = process.env['WEB_SEARCH_EXTRACTOR']?.trim() || undefined;
  const webExtractor =
    envExtractor !== undefined
      ? isTruthy(envExtractor)
      : webSearch?.webExtractor;
  const baseUrl = process.env['WEB_SEARCH_BASE_URL']?.trim() || undefined;
  const apiKeyEnv = baseUrl
    ? process.env['WEB_SEARCH_API_KEY']?.trim()
      ? 'WEB_SEARCH_API_KEY'
      : 'DASHSCOPE_API_KEY'
    : undefined;
  if (
    enabled === undefined &&
    model === undefined &&
    webExtractor === undefined &&
    baseUrl === undefined
  ) {
    return undefined;
  }
  return { enabled, model, webExtractor, baseUrl, apiKeyEnv };
}

/**
 * Resolves the wall-clock budget for a run. Returns seconds (`-1` =
 * unlimited). Order of precedence: `--max-wall-time` flag, then
 * `model.maxWallTimeSeconds` from settings, else unlimited.
 *
 * The CLI flag is a duration string (`30s` / `5m` / `1h` / `90`); the
 * settings entry is a plain number of seconds (parity with
 * `model.maxSessionTurns`). Both layers reject `0` and out-of-range
 * values up front — a typo in a CI guardrail should fail loud at startup,
 * not silently disable the budget.
 */
function resolveMaxWallTimeSeconds(argv: CliArgs, settings: Settings): number {
  if (argv.maxWallTime !== undefined && argv.maxWallTime !== null) {
    try {
      return parseDurationSeconds(String(argv.maxWallTime));
    } catch (err) {
      throw new Error(`--max-wall-time: ${(err as Error).message}`);
    }
  }
  const fromSettings = settings.model?.maxWallTimeSeconds;
  if (typeof fromSettings === 'number') {
    try {
      return validateMaxWallTimeSetting(fromSettings);
    } catch (err) {
      throw new Error(`settings.json: ${(err as Error).message}`);
    }
  }
  return -1;
}

function resolveGoalTokenBudget(settings: Settings): number | undefined {
  const fromSettings: unknown = settings.model?.goalTokenBudget;
  if (fromSettings === undefined) return undefined;
  try {
    return validateGoalTokenBudget(fromSettings);
  } catch (err) {
    throw new Error(`settings.json: ${(err as Error).message}`);
  }
}

/**
 * Resolves the tool-call budget for a run. Returns the validated count
 * (`-1` = unlimited). Order of precedence: `--max-tool-calls` flag, then
 * `model.maxToolCalls` from settings, else unlimited.
 *
 * Symmetric with `resolveMaxWallTimeSeconds`: yargs accepts `NaN` from
 * non-numeric flag values, and the enforcer's `>= 0` gate would silently
 * disable the budget for `NaN` / negatives. Validate up front so a typo
 * in a CI guardrail fails loudly.
 */
function resolveMaxToolCalls(argv: CliArgs, settings: Settings): number {
  if (argv.maxToolCalls !== undefined && argv.maxToolCalls !== null) {
    try {
      return validateMaxToolCalls(argv.maxToolCalls);
    } catch (err) {
      throw new Error(`--max-tool-calls: ${(err as Error).message}`);
    }
  }
  const fromSettings = settings.model?.maxToolCalls;
  if (typeof fromSettings === 'number') {
    try {
      return validateMaxToolCalls(fromSettings);
    } catch (err) {
      throw new Error(`settings.json: ${(err as Error).message}`);
    }
  }
  return -1;
}

/**
 * Resolves the sub-agent nesting cap. Order of precedence:
 * `--max-subagent-depth` flag, then `model.maxSubagentDepth` from settings,
 * else undefined (Config applies the default of 5).
 *
 * Yargs accepts `NaN` from non-numeric flag values, and Config's clamp
 * would silently fall back to the default — validate up front so a typo
 * fails loudly. Settings values stay lenient (Config clamps them) so a bad
 * settings.json cannot break startup.
 */
function resolveMaxSubagentDepth(
  argv: CliArgs,
  settings: Settings,
): number | undefined {
  const value = argv.maxSubagentDepth;
  if (value !== undefined && value !== null) {
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_SUBAGENT_DEPTH_LIMIT
    ) {
      throw new Error(
        `--max-subagent-depth must be an integer between 1 and ${MAX_SUBAGENT_DEPTH_LIMIT}; got ${value}.`,
      );
    }
    return value;
  }
  return settings.model?.maxSubagentDepth;
}

export function isDebugMode(argv: CliArgs): boolean {
  if (argv.debug) return true;
  const debugVal = process.env['DEBUG'];
  const debugModeVal = process.env['DEBUG_MODE'];
  return (
    debugVal === 'true' ||
    debugVal === '1' ||
    debugModeVal === 'true' ||
    debugModeVal === '1'
  );
}

/**
 * Validates that the provided config is a valid MCP server configuration object.
 */
function validateMcpServerConfig(
  config: unknown,
): config is Record<string, MCPServerConfig> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return false;
  }

  // Basic validation - each entry should be an object
  return Object.values(config).every(
    (server) => typeof server === 'object' && server !== null,
  );
}

/**
 * Parses MCP configuration from command-line argument.
 * Supports both file paths and inline JSON strings.
 * Handles both {"mcpServers": {...}} and direct {...} formats.
 *
 * @param mcpConfigArg - The --mcp-config value (file path or JSON string)
 * @returns Record of MCP server configurations, or null if no config provided
 * @throws FatalConfigError if the configuration is invalid
 */
function parseMcpConfig(
  mcpConfigArg: string | undefined,
): Record<string, MCPServerConfig> | null {
  if (!mcpConfigArg) {
    return null;
  }

  try {
    let parsed: unknown;

    // Check if it's a file path
    if (fs.existsSync(mcpConfigArg)) {
      debugLogger.debug(`Reading MCP config from file: ${mcpConfigArg}`);
      const content = fs.readFileSync(mcpConfigArg, 'utf-8');
      parsed = JSON.parse(stripJsonComments(content));
    } else {
      // Try parsing as JSON string
      debugLogger.debug('Parsing MCP config as JSON string');
      parsed = JSON.parse(mcpConfigArg);
    }

    // Handle both {"mcpServers": {...}} and direct {...} formats
    let servers: unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'mcpServers' in parsed &&
      typeof (parsed as { mcpServers: unknown }).mcpServers === 'object'
    ) {
      servers = (parsed as { mcpServers: unknown }).mcpServers;
    } else {
      servers = parsed;
    }

    // Validate the structure
    if (!validateMcpServerConfig(servers)) {
      throw new Error(
        'Invalid MCP server configuration format. Expected an object with server names as keys.',
      );
    }

    debugLogger.debug(
      `Loaded ${Object.keys(servers).length} MCP server(s) from --mcp-config`,
    );
    return servers as Record<string, MCPServerConfig>;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new FatalConfigError(
      `Invalid MCP configuration provided via --mcp-config: ${errorMessage}`,
    );
  }
}

/**
 * Builds the live-read closure for `Config.getDisabledSkillNames()`.
 *
 * The returned function reads through `loadedSettings.merged` on every
 * call, so `LoadedSettings` skill-setting mutations
 * are reflected without rebuilding `Config`. The closure is over the
 * `LoadedSettings` instance, NOT over its `.merged` snapshot — that
 * distinction matters because `LoadedSettings.setValue` replaces the
 * internal `_merged` object on every call. A closure over `.merged` would
 * stay frozen at construction time.
 *
 * Use this from every `loadCliConfig` call site (interactive entry, ACP
 * session start, etc.) so all surfaces — `<available_skills>` in the
 * model description, `/skill-name` slash commands, `/skills` listing and
 * completion — agree on which skills are currently disabled.
 */
export function buildDisabledSkillNamesProvider(
  loadedSettings: LoadedSettings,
): () => ReadonlySet<string> {
  return () => resolveSkillSettings(loadedSettings).disabledNames;
}

export function buildEnabledSkillNamesProvider(
  loadedSettings: LoadedSettings,
): () => ReadonlySet<string> {
  return () => resolveSkillSettings(loadedSettings).enabledNames;
}

/**
 * Thrown (instead of `process.exit(1)`) when a caller-supplied session id
 * already exists and `throwOnSessionIdConflict` is set. The interactive CLI
 * exits the process on a duplicate id, but that would kill a shared ACP child
 * and every session on its channel — embedded callers catch this and fail the
 * single request instead.
 */
export class SessionIdConflictError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, message: string) {
    super(message);
    this.name = 'SessionIdConflictError';
    this.sessionId = sessionId;
  }
}

export async function loadCliConfig(
  settings: Settings,
  argv: CliArgs,
  cwd: string = process.cwd(),
  overrideExtensions?: string[],
  /**
   * Optional separated hooks for proper source attribution.
   * If provided, these override settings.hooks for hook loading.
   */
  hooksConfig?: {
    userHooks?: Record<string, unknown>;
    projectHooks?: Record<string, unknown>;
  },
  /**
   * Live-read provider for the set of disabled skill names. Forwarded to
   * `ConfigParameters` so that `Config.getDisabledSkillNames()` reflects
   * effective skill availability even after `setValue` mutations within the
   * same process.
   *
   * Callers MUST close over the live `LoadedSettings` instance, NOT over
   * the `settings: Settings` snapshot passed as the first argument here —
   * `LoadedSettings.setValue` replaces `_merged`, so any closure over a
   * snapshot would only see cold data and the dialog/subcommand toggles
   * would not take effect on the model side. Use
   * `buildDisabledSkillNamesProvider(loadedSettings)` to construct it
   * correctly.
   */
  disabledSkillNamesProvider?: () => ReadonlySet<string>,
  /**
   * MCP servers injected by the embedding session (e.g. ACP / IDE clients).
   * Treated as a session-level source at the TOP of the precedence stack — above
   * settings and `.mcp.json`, below `--mcp-config` — and never approval-gated:
   * they are explicit, per-session, and not checked into the repo. Routing them
   * here (rather than merging into `settings.mcpServers`) keeps them from being
   * demoted below a project `.mcp.json` by `assembleMcpServers`. See issue #4615.
   */
  sessionMcpServers?: Record<string, MCPServerConfig>,
  /**
   * Lifecycle handle for the settings file watcher started in `llm.tsx`
   * before `Config.initialize()`. Passed through to `Config` so it can be
   * stopped during shutdown — only `stopWatching()` is exposed here to keep
   * core decoupled from the CLI-owned `SettingsWatcher` implementation.
   */
  settingsWatcher?: { stopWatching(): void },
  /**
   * When true, a duplicate caller-supplied session id throws
   * `SessionIdConflictError` instead of calling `process.exit(1)`. Embedded
   * callers (ACP/daemon) set this so one conflicting `newSession` degrades a
   * single request rather than terminating the shared child process.
   */
  throwOnSessionIdConflict = false,
  /**
   * Runtime-only host policy. This is deliberately not sourced from argv,
   * settings, or the environment: only an embedding host that owns the Config
   * construction may install the executor-boundary callback.
   */
  hostPolicy?: {
    toolInvocationGuard?: ToolInvocationGuard;
    /** Host-managed session whose exact private cwd is bound after bootstrap. */
    provisionalWorkspace?: true;
    sessionRestore?: {
      projectionSource: (
        sessionId: string,
      ) => Promise<SessionRestoreProjection | undefined>;
    };
  },
  enabledSkillNamesProvider?: () => ReadonlySet<string>,
): Promise<Config> {
  const provisionalWorkspace = hostPolicy?.provisionalWorkspace === true;
  const debugMode = isDebugMode(argv);
  if (debugMode && process.env['QWEN_DEBUG_LOG_FILE'] === undefined) {
    process.env['QWEN_DEBUG_LOG_FILE'] = '1';
  }
  const bareMode = isBareMode(argv.bare);
  const safeMode =
    argv.safeMode !== undefined ? argv.safeMode : isSafeModeEnv();

  // Surface `--insecure` as an env var so it reaches the undici dispatcher
  // layer (which controls TLS verification) without threading a flag through
  // every content generator and the preconnect path. Resolution there ORs this
  // with QWEN_TLS_INSECURE / NODE_TLS_REJECT_UNAUTHORIZED=0.
  if (argv.insecure) {
    process.env['QWEN_TLS_INSECURE'] = '1';
  }
  // When opting out of TLS verification, also set NODE_TLS_REJECT_UNAUTHORIZED
  // process-wide. The custom undici dispatcher handles the Node path, but this
  // makes the opt-out effective on runtimes/paths it does not cover (the Bun
  // runtime, and the proxy-creation fallback that uses the built-in fetch), and
  // surfaces a single explicit warning. Skipped when the user already set it,
  // since Node emits its own warning in that case.
  if (
    isTlsVerificationDisabled() &&
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] !== '0'
  ) {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    // The setting is process-wide, so the blast radius is every outbound HTTPS
    // connection (model API, OAuth, MCP servers, and child processes that
    // inherit the env), not just model calls. Log to the debug file too, so the
    // state is discoverable after the terminal scrollback is gone.
    const tlsWarning =
      'TLS certificate verification is disabled (--insecure / QWEN_TLS_INSECURE). All HTTPS connections in this process (API calls, OAuth, MCP servers, child processes) are vulnerable to man-in-the-middle attacks.';
    debugLogger.warn(tlsWarning);
    // eslint-disable-next-line no-console
    console.error(`WARNING: ${tlsWarning}`);
  }

  // Set runtime output directory from settings (env var QWEN_RUNTIME_DIR
  // is auto-detected inside getRuntimeBaseDir() at each call site).
  // Pass cwd so that relative paths like ".qwen" resolve per-project.
  if (!Storage.hasRuntimeBaseDirContext()) {
    Storage.setRuntimeBaseDir(settings.advanced?.runtimeOutputDir, cwd);
  }

  const ideMode = settings.ide?.enabled ?? false;

  const folderTrust = settings.security?.folderTrust?.enabled ?? false;
  const trustedFolder = isWorkspaceTrusted(settings)?.isTrusted ?? true;

  // Set the context filename in the server's memoryTool module BEFORE loading memory
  // TODO(b/343434939): This is a bit of a hack. The contextFileName should ideally be passed
  // directly to the Config constructor in core, and have core handle setMemoryFilename.
  // However, loadHierarchicalMemory is called *before* createServerConfig.
  if (settings.context?.fileName) {
    setServerMemoryFilename(settings.context.fileName);
  } else {
    // Reset to default context filenames if not provided in settings.
    setServerMemoryFilename(getAllMemoryFilenames());
  }

  // Automatically load output-language.md if it exists
  const projectStorage = new Storage(cwd);
  const projectOutputLanguagePath = path.join(
    projectStorage.getQwenDir(),
    'output-language.md',
  );
  const globalOutputLanguagePath = path.join(
    Storage.getGlobalQwenDir(),
    'output-language.md',
  );

  let outputLanguageFilePath: string | undefined;
  if (!bareMode && !safeMode) {
    if (!provisionalWorkspace && fs.existsSync(projectOutputLanguagePath)) {
      outputLanguageFilePath = projectOutputLanguagePath;
    } else if (fs.existsSync(globalOutputLanguagePath)) {
      outputLanguageFilePath = globalOutputLanguagePath;
    }
  }

  const fileService = provisionalWorkspace
    ? undefined
    : new FileDiscoveryService(
        cwd,
        settings.context?.fileFiltering?.customIgnoreFiles,
      );

  const includeDirectories = provisionalWorkspace
    ? []
    : (bareMode || safeMode ? [] : (settings.context?.includeDirectories ?? []))
        .map(resolvePath)
        .concat((argv.includeDirectories || []).map(resolvePath));

  // LSP configuration: enabled only via --experimental-lsp flag
  const lspEnabled =
    !provisionalWorkspace && !bareMode && argv.experimentalLsp === true;
  let lspClient: LspClient | undefined;
  const question = argv.promptInteractive || argv.prompt || '';
  const inputFormat: InputFormat =
    (argv.inputFormat as InputFormat | undefined) ?? InputFormat.TEXT;
  const argvOutputFormat = normalizeOutputFormat(
    argv.outputFormat as string | OutputFormat | undefined,
  );
  const settingsOutputFormat = normalizeOutputFormat(settings.output?.format);
  const outputFormat =
    argvOutputFormat ?? settingsOutputFormat ?? OutputFormat.TEXT;
  const outputSettingsFormat: OutputFormat =
    outputFormat === OutputFormat.STREAM_JSON
      ? settingsOutputFormat &&
        settingsOutputFormat !== OutputFormat.STREAM_JSON
        ? settingsOutputFormat
        : OutputFormat.TEXT
      : (outputFormat as OutputFormat);
  const includePartialMessages = Boolean(argv.includePartialMessages);

  // Determine approval mode with backward compatibility
  let approvalMode: ApprovalMode;
  if (argv.approvalMode) {
    approvalMode = parseApprovalModeValue(argv.approvalMode);
  } else if (argv.yolo) {
    approvalMode = ApprovalMode.YOLO;
  } else if (!bareMode && !safeMode && settings.tools?.approvalMode) {
    approvalMode = parseApprovalModeValue(settings.tools.approvalMode);
  } else if (bareMode || safeMode) {
    // Restricted modes strip permissions/allowlists and are meant to be
    // maximally restrictive, so they keep manual approval rather than the
    // AUTO default that normal sessions now get.
    approvalMode = ApprovalMode.DEFAULT;
  } else {
    approvalMode = ApprovalMode.AUTO;
  }

  // Force approval mode to default if the folder is not trusted.
  if (
    !trustedFolder &&
    approvalMode !== ApprovalMode.DEFAULT &&
    approvalMode !== ApprovalMode.PLAN
  ) {
    writeStderrLine(
      `Approval mode overridden to "default" because the current folder is not trusted.`,
    );
    approvalMode = ApprovalMode.DEFAULT;
  }

  let telemetrySettings;
  try {
    telemetrySettings = await resolveTelemetrySettings({
      argv,
      env: process.env as unknown as Record<string, string | undefined>,
      settings: settings.telemetry,
    });
  } catch (err) {
    if (err instanceof FatalConfigError) {
      throw new FatalConfigError(
        `Invalid telemetry configuration: ${err.message}.`,
      );
    }
    throw err;
  }

  // Interactive mode determination with priority:
  // 1. If promptInteractive (-i flag) is provided, it is explicitly interactive
  // 2. If outputFormat is stream-json or json (no matter input-format) along with query or prompt, it is non-interactive
  // 3. If no query or prompt is provided, check isTTY: TTY means interactive, non-TTY means non-interactive
  const hasQuery = !!argv.query;
  const hasPrompt = !!argv.prompt;
  let interactive: boolean;
  if (argv.promptInteractive) {
    // Priority 1: Explicit -i flag means interactive
    interactive = true;
  } else if (
    (outputFormat === OutputFormat.STREAM_JSON ||
      outputFormat === OutputFormat.JSON) &&
    (hasQuery || hasPrompt)
  ) {
    // Priority 2: JSON/stream-json output with query/prompt means non-interactive
    interactive = false;
  } else if (!hasQuery && !hasPrompt) {
    // Priority 3: No query or prompt means interactive only if TTY (format arguments ignored)
    interactive = process.stdin.isTTY ?? false;
  } else {
    // Default: If we have query/prompt but output format is TEXT, assume non-interactive
    // (fallback for edge cases where query/prompt is provided with TEXT output)
    interactive = false;
  }
  // ── Unified permissions construction ─────────────────────────────────────
  // All permission sources are merged here, before constructing Config.
  // The resulting three arrays are the single source of truth that Config /
  // PermissionManager will use.
  //
  // Sources (in order of precedence within each list):
  //   1. settings.permissions.{allow,ask,deny}  (persistent, merged by LoadedSettings)
  //   2. argv.coreTools   → allow  (allowlist mode: only these tools are available)
  //   3. argv.allowedTools → allow  (auto-approve these tools/commands)
  //   4. argv.excludeTools → deny   (block these tools completely)
  //   5. Non-interactive mode exclusions → deny (unless explicitly allowed above)

  // Start from settings-level rules.
  // Read from both new `permissions` and legacy `tools` paths for compatibility.
  // Note: settings.tools.core / argv.coreTools are intentionally NOT merged into
  // mergedAllow — they have whitelist semantics (only listed tools are registered),
  // not auto-approve semantics. They are passed via the `coreTools` Config param
  // and handled by PermissionManager.coreToolsAllowList.
  if (safeMode && argv.coreTools && argv.coreTools.length > 0) {
    writeStderrLine(
      '⚠ Safe mode: --core-tools flag is ignored (settings-sourced core tools are also disabled).\n',
    );
  }
  const resolvedCoreTools: string[] = [
    ...(bareMode || safeMode ? [] : (argv.coreTools ?? [])),
    ...(bareMode || safeMode ? [] : (settings.tools?.core ?? [])),
  ];
  const mergedAllow: string[] = [
    ...(bareMode || safeMode ? [] : (settings.permissions?.allow ?? [])),
    ...(bareMode || safeMode ? [] : (settings.tools?.allowed ?? [])),
  ];
  const mergedAsk: string[] = [
    ...(bareMode || safeMode ? [] : (settings.permissions?.ask ?? [])),
  ];
  const mergedDeny: string[] = [
    ...(bareMode || safeMode ? [] : (settings.permissions?.deny ?? [])),
    ...(bareMode || safeMode ? [] : (settings.tools?.exclude ?? [])),
  ];

  // argv.allowedTools adds allow rules (auto-approve).
  for (const t of argv.allowedTools ?? []) {
    if (t && !mergedAllow.includes(t)) mergedAllow.push(t);
  }

  // argv.excludeTools adds deny rules.
  for (const t of argv.excludeTools ?? []) {
    if (t && !mergedDeny.includes(t)) mergedDeny.push(t);
  }

  // Merge the slash-command denylist from settings + CLI flag + env var.
  // Settings merge (UNION across scopes) is already handled upstream; we
  // only de-duplicate while preserving case for diagnostic purposes.
  const disabledSlashCommands: string[] = [];
  const seenDisabled = new Set<string>();
  const addDisabled = (value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!seenDisabled.has(key)) {
      seenDisabled.add(key);
      disabledSlashCommands.push(trimmed);
    }
  };
  if (!bareMode && !safeMode) {
    for (const name of settings.slashCommands?.disabled ?? [])
      addDisabled(name);
  }
  for (const name of argv.disabledSlashCommands ?? []) addDisabled(name);
  for (const name of (process.env['QWEN_DISABLED_SLASH_COMMANDS'] ?? '').split(
    ',',
  )) {
    addDisabled(name);
  }

  // Resolve the per-workspace tool denylist. De-duplicate while preserving
  // original casing; shared helper since the MCP restart refresh path
  // must agree byte-for-byte with this.
  const disabledTools =
    bareMode || safeMode
      ? []
      : normalizeDisabledToolList(settings.tools?.disabled);
  const visibleTools =
    bareMode || safeMode
      ? []
      : normalizeDisabledToolList(settings.tools?.visible);
  // `tools.eager` restricts which schemas ride in the initial model request
  // (#9827). Unlisted tools stay registered and reachable via tool_search —
  // it is a schema-size knob, not an availability knob (#10075).
  //
  // An explicitly empty array must survive as an empty array, not collapse
  // into "unset": `[]` is an active allowlist naming nothing (defer
  // everything). `tools.core` differs: its empty list is treated as unset.
  // `normalizeDisabledToolList` maps undefined to `[]`,
  // so the Array.isArray guard has to come first — without it, absent and
  // explicitly-empty would reach core as the same value, which is exactly
  // the SDK divergence #10138 reports for coreTools.
  const eagerTools =
    bareMode || safeMode || !Array.isArray(settings.tools?.eager)
      ? undefined
      : normalizeDisabledToolList(settings.tools.eager);
  if (eagerTools !== undefined) {
    // `normalizeDisabledToolList` strips empty/whitespace-only and
    // non-string entries before `PermissionManager.initialize()` ever sees
    // the list, so the dropped-entries warning there can never fire for
    // that class on the real CLI path — and a degenerate list like
    // `tools.eager: [""]` would collapse to the active defer-everything
    // allowlist `[]` in silence. Warn here so the collapse always leaves a
    // signal (#10075).
    const droppedEagerEntries = (settings.tools?.eager ?? []).filter(
      (entry) => typeof entry !== 'string' || entry.trim() === '',
    );
    if (droppedEagerEntries.length > 0) {
      // eslint-disable-next-line no-console -- operator-facing breadcrumb; the debug log file is off in default runs, where this reshaping would otherwise be invisible
      console.warn(
        `tools.eager: ignoring ${droppedEagerEntries.length} unusable entr${
          droppedEagerEntries.length === 1 ? 'y' : 'ies'
        } (${droppedEagerEntries
          .map((entry) => JSON.stringify(entry))
          .join(', ')}). ` +
          `The allowlist stays active with ${eagerTools.length} entr${
            eagerTools.length === 1 ? 'y' : 'ies'
          }, so every other non-exempt tool is deferred to tool_search.`,
      );
    }
  }

  // Helper: check if a tool is explicitly covered by an allow rule OR by the
  // coreTools whitelist. Uses alias matching for coreTools (via isToolEnabled)
  // to preserve the original behaviour where "ShellTool", "Shell", and
  // "run_shell_command" are all accepted as the same tool.
  const isExplicitlyAllowed = (toolName: ToolName): boolean => {
    // 1. Check permissions.allow / allowedTools rules.
    if (mergedAllow.some((rule) => isToolEnabled(toolName, [rule], []))) {
      return true;
    }
    // 2. Check coreTools whitelist (with alias matching).
    // If coreTools is non-empty and explicitly includes this tool, it is
    // considered allowed for non-interactive mode exclusion purposes.
    if (resolvedCoreTools.length > 0) {
      return isToolEnabled(toolName, resolvedCoreTools, []);
    }
    return false;
  };

  // In non-interactive mode, tools that require a user prompt are denied unless
  // the caller has explicitly allowed them. Stream-JSON input is excluded from
  // this logic because approval can be sent programmatically via JSON messages.
  const isAcpMode = argv.acp || argv.experimentalAcp;
  if (
    !bareMode &&
    !interactive &&
    !isAcpMode &&
    inputFormat !== InputFormat.STREAM_JSON
  ) {
    const denyUnlessAllowed = (toolName: ToolName): void => {
      if (!isExplicitlyAllowed(toolName)) {
        const name = toolName as string;
        if (!mergedDeny.includes(name)) mergedDeny.push(name);
      }
    };

    switch (approvalMode) {
      case ApprovalMode.PLAN:
      case ApprovalMode.DEFAULT:
        // Deny all write/execute tools unless explicitly allowed.
        denyUnlessAllowed(ToolNames.SHELL as ToolName);
        denyUnlessAllowed(ToolNames.MONITOR as ToolName);
        denyUnlessAllowed(ToolNames.EDIT as ToolName);
        denyUnlessAllowed(ToolNames.WRITE_FILE as ToolName);
        break;
      case ApprovalMode.AUTO:
        // AUTO uses an LLM classifier to gate Shell/Monitor/Edit/WriteFile at
        // call time; but non-interactive mode has no UI for the classifier's
        // fallback path, so apply the same denylist as DEFAULT to keep parity
        // with the interactive AUTO safety guarantees (no zero-denial drift
        // toward YOLO behavior).
        denyUnlessAllowed(ToolNames.SHELL as ToolName);
        denyUnlessAllowed(ToolNames.MONITOR as ToolName);
        denyUnlessAllowed(ToolNames.EDIT as ToolName);
        denyUnlessAllowed(ToolNames.WRITE_FILE as ToolName);
        break;
      case ApprovalMode.AUTO_EDIT:
        // Shell-like execute tools still require a prompt in auto-edit mode.
        denyUnlessAllowed(ToolNames.SHELL as ToolName);
        denyUnlessAllowed(ToolNames.MONITOR as ToolName);
        break;
      case ApprovalMode.YOLO:
        // No extra denials for YOLO mode.
        break;
      default:
        break;
    }
  }

  let allowedMcpServers: Set<string> | undefined;
  let excludedMcpServers: Set<string> | undefined;
  if (argv.allowedMcpServerNames) {
    allowedMcpServers = new Set(argv.allowedMcpServerNames.filter(Boolean));
    excludedMcpServers = undefined;
  } else if (!bareMode && !safeMode) {
    // Settings-sourced allow/exclude lists are LOCAL/ambient state, same
    // category as settings.mcpServers itself — safe mode already drops the
    // latter (getMcpServers()) but this branch used to read the former
    // unconditionally (only bareMode was guarded), so a settings.json
    // mcp.allowed narrower than the caller's own top-tier servers would
    // silently filter them back out via getMcpServers()'s allowedMcpServers
    // filter (added in this same PR, #7827, for the `--allowed-mcp-server-
    // names` case) — defeating the very guarantee this PR exists to provide.
    // The argv.allowedMcpServerNames branch above is unaffected: that's an
    // explicit per-invocation argument, not local state, so it still applies
    // under safe mode same as topTierMcpServers itself.
    allowedMcpServers = settings.mcp?.allowed
      ? new Set(settings.mcp.allowed.filter(Boolean))
      : undefined;
    excludedMcpServers = settings.mcp?.excluded
      ? new Set(settings.mcp.excluded.filter(Boolean))
      : undefined;
  }

  const selectedAuthType =
    (argv.authType as AuthType | undefined) ||
    (bareMode ? undefined : settings.security?.auth?.selectedType) ||
    /* getAuthTypeFromEnv means no authType was explicitly provided, we infer the authType from env vars */
    getAuthTypeFromEnv();

  // Unified resolution of generation config with source attribution
  const resolvedCliConfig = resolveCliGenerationConfig({
    argv: {
      model: argv.model,
      openaiApiKey: argv.openaiApiKey,
      openaiBaseUrl: argv.openaiBaseUrl,
      openaiLogging: argv.openaiLogging,
      openaiLoggingDir: argv.openaiLoggingDir,
    },
    settings,
    selectedAuthType,
    env: process.env as Record<string, string | undefined>,
  });

  const { model: resolvedModel } = resolvedCliConfig;

  // Disable ToolSearch when explicitly configured or for models that benefit
  // from prefix-based KV caching. DeepSeek models (v3, v4, deepseek-chat)
  // all use prefix-based disk KV caching with heavily discounted cached
  // token pricing (up to 1/120 for v4). When tool_search is in the deny
  // list, client.ts eagerly reveals all deferred tools so every MCP tool
  // schema is in the initial declaration list, keeping the prompt prefix
  // stable and maximizing cache hit rates.
  // Note: no `^` anchor — model names may include a provider prefix
  // (e.g. "openrouter/deepseek/deepseek-v4-flash").
  const toolSearchExplicitlyEnabled = settings.tools?.toolSearch?.enabled;
  const shouldDisableToolSearch =
    toolSearchExplicitlyEnabled === false ||
    (toolSearchExplicitlyEnabled === undefined &&
      resolvedModel !== undefined &&
      /deepseek-(v3|v4|chat)/i.test(resolvedModel));
  if (shouldDisableToolSearch) {
    if (!mergedDeny.includes('tool_search')) {
      mergedDeny.push('tool_search');
    }
  }

  const sandboxConfig = await loadSandboxConfig(
    bareMode || safeMode ? ({} as Settings) : settings,
    argv,
  );
  const screenReader =
    argv.screenReader !== undefined
      ? argv.screenReader
      : (settings.ui?.accessibility?.screenReader ?? false);

  let sessionId: string | undefined;
  let sessionData: ResumedSessionData | undefined;
  let sessionRestoreProjection: SessionRestoreProjection | undefined;
  const sessionRestoreProjectionSource =
    hostPolicy?.sessionRestore?.projectionSource;
  let deferProjectionUntilWriterLease = false;

  if (argv.continue || argv.resume) {
    const sessionService = new SessionService(cwd);
    if (argv.continue) {
      sessionData = await sessionService.loadLastSession();
      if (sessionData) {
        sessionId = sessionData.conversation.sessionId;
      } else if (argv.forkSession) {
        writeStderrLine(
          'Cannot use --fork-session with --continue: no saved session found to fork.',
        );
        process.exit(1);
      }
    }

    if (argv.resume) {
      // By the time we get here, argv.resume has been resolved to a valid
      // session UUID by llm.tsx (which handles custom title lookup and
      // the interactive picker for ambiguous matches).
      sessionId = argv.resume;
      deferProjectionUntilWriterLease =
        sessionRestoreProjectionSource !== undefined &&
        (argv.chatRecording ?? settings.general?.chatRecording ?? true) &&
        isAcpMode === true &&
        settings.experimental?.sessionWriterLease === true;
      if (sessionRestoreProjectionSource) {
        if (!deferProjectionUntilWriterLease && !argv.forkSession) {
          addDaemonRequestAttribute(
            'qwen-code.daemon.session_restore.projection_acquisition',
            'preloaded',
          );
          sessionRestoreProjection =
            await sessionRestoreProjectionSource(sessionId);
        }
      } else {
        sessionData = await sessionService.loadSession(argv.resume);
      }
      if (!sessionRestoreProjectionSource && !sessionData) {
        const message = `No saved session found with ID ${argv.resume}. Run \`qwen --resume\` without an ID to choose from existing sessions.`;
        writeStderrLine(message);
        process.exit(1);
      }
    }

    if (argv.forkSession && sessionId) {
      const sourceSessionId = sessionId;
      const forkedSessionId = randomUUID();
      try {
        await sessionService.forkSession(sourceSessionId, forkedSessionId);
      } catch (err) {
        writeStderrLine(
          `Failed to fork session ${sourceSessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
      sessionId = forkedSessionId;
      if (sessionRestoreProjectionSource) {
        sessionData = undefined;
        if (!deferProjectionUntilWriterLease) {
          addDaemonRequestAttribute(
            'qwen-code.daemon.session_restore.projection_acquisition',
            'preloaded',
          );
          sessionRestoreProjection =
            await sessionRestoreProjectionSource(forkedSessionId);
        }
      } else {
        sessionData = await sessionService.loadSession(forkedSessionId);
        if (!sessionData) {
          writeStderrLine(`Failed to load forked session ${forkedSessionId}.`);
          process.exit(1);
        }
      }
    }
  } else if (argv.sandboxSessionId) {
    if (!process.env['SANDBOX']) {
      writeStderrLine('--sandbox-session-id is for internal sandbox use only.');
      process.exit(1);
    }
    sessionId = argv.sandboxSessionId;
  } else if (argv['sessionId']) {
    // Use provided session ID without session resumption
    // Check if session ID is already in use — case-insensitively: a legacy
    // mixed-case transcript still occupies the id, and creating a
    // case-only twin would make both spellings permanently unrestorable.
    // A daemon-generated fresh UUID (`sessionIdGenerated`) skips the check:
    // it has no case-twin to protect, and the check's readdir cost and
    // fail-closed policy must not hit the id-less creation hot path.
    if (!argv.sessionIdGenerated) {
      const sessionService = new SessionService(cwd);
      let occupied: boolean;
      try {
        occupied =
          (await sessionService.findSessionIdIgnoringCase(
            argv['sessionId'],
          )) !== undefined;
      } catch (error) {
        // Any read failure leaves the id unproven, and the resolver propagates
        // non-ENOENT errors. Assume occupied, as the previous existence check
        // did: startup must reach the guarded conflict message and honour
        // `throwOnSessionIdConflict` rather than die on a raw errno.
        debugLogger.debug(
          `Session id occupancy check failed for ${argv['sessionId']}: ${error}`,
        );
        occupied = true;
      }
      if (occupied) {
        const message = `Error: Session Id ${argv['sessionId']} already exists (active or archived). Delete or unarchive it first.`;
        if (throwOnSessionIdConflict) {
          throw new SessionIdConflictError(argv['sessionId'], message);
        }
        writeStderrLine(message);
        process.exit(1);
      }
    }
    sessionId = normalizeSessionIdForLookup(argv['sessionId']);
  }

  const modelProvidersConfig = settings.modelProviders;
  const providerProtocolConfig = settings.providerProtocol;
  const restoreSessionId = sessionId;
  const boundSessionRestoreProjectionSource =
    sessionRestoreProjectionSource && restoreSessionId
      ? () => sessionRestoreProjectionSource(restoreSessionId)
      : undefined;

  // Assemble MCP servers across all sources in precedence order (user/default
  // settings < project `.mcp.json` < workspace/system settings < `--mcp-config`)
  // and compute which gated (project/workspace) servers are still pending
  // approval (#4615), so the discovery layer can skip them with no connection
  // side effect. Loading `.mcp.json` is a pure read.
  // Top tier = session-injected (ACP/IDE) servers plus `--mcp-config`; CLI wins
  // over the session source on a name clash. Both sit above settings/`.mcp.json`
  // and are never gated (#4615).
  const cliMcpServers = parseMcpConfig(argv.mcpConfig);
  const topTierMcpServers =
    sessionMcpServers || cliMcpServers
      ? { ...sessionMcpServers, ...(cliMcpServers ?? {}) }
      : undefined;
  // Bare/safe mode still drop settings.mcpServers/`.mcp.json` entirely (local,
  // ambient, file-sourced state they're meant to distrust) — but top-tier
  // servers are an explicit, per-invocation argument from the caller (ACP
  // `session/new`, `--mcp-config`), not ambient local state, so they survive.
  const mcpServers =
    bareMode || safeMode
      ? { ...topTierMcpServers }
      : assembleMcpServers(settings.mcpServers, cwd, topTierMcpServers);
  // Top-tier servers are never gated (#4615, see the comment above), so this
  // is a no-op for them either way today. Skipped under safe mode anyway
  // (Copilot review, PR #7827): getPendingGatedMcpServers reads the local
  // mcpApprovals.json file, and safe mode shouldn't touch local/ambient
  // state at all, not even a read with no behavioral effect. Revisit if a
  // future gated top-tier source needs this to run under safe mode too.
  const pendingMcpServers =
    bareMode || safeMode || approvalMode === ApprovalMode.YOLO
      ? undefined
      : getPendingGatedMcpServers(mcpServers, cwd);

  const configParams: ConfigParameters = {
    sessionId,
    sessionData,
    sessionRestoreProjection,
    sessionRestoreProjectionSource: boundSessionRestoreProjectionSource,
    embeddingModel: DEFAULT_QWEN_EMBEDDING_MODEL,
    sandbox: sandboxConfig,
    targetDir: cwd,
    provisionalWorkspace,
    includeDirectories,
    loadMemoryFromIncludeDirectories: provisionalWorkspace
      ? false
      : bareMode || safeMode
        ? includeDirectories.length > 0
        : (settings.context?.loadFromIncludeDirectories ?? false),
    importFormat: settings.context?.importFormat || 'tree',
    debugMode,
    question,
    systemPrompt: argv.systemPrompt,
    appendSystemPrompt: argv.appendSystemPrompt,
    // Legacy fields – kept for backward compatibility with getCoreTools() etc.
    coreTools:
      bareMode || safeMode
        ? undefined
        : argv.coreTools || settings.tools?.core || undefined,
    allowedTools:
      bareMode || safeMode
        ? argv.allowedTools || undefined
        : argv.allowedTools || settings.tools?.allowed || undefined,
    excludeTools: mergedDeny,
    disabledSlashCommands:
      disabledSlashCommands.length > 0 ? disabledSlashCommands : undefined,
    disabledSkillNamesProvider:
      bareMode || safeMode ? undefined : disabledSkillNamesProvider,
    enabledSkillNamesProvider:
      bareMode || safeMode ? undefined : enabledSkillNamesProvider,
    terminalImageRenderSupportProvider: interactive
      ? async () => {
          const { getTerminalImageRenderSupport } = await import(
            '../ui/utils/terminal-image-renderer.js'
          );
          return getTerminalImageRenderSupport();
        }
      : undefined,
    disabledSkillLevels:
      bareMode || safeMode || !Array.isArray(settings.skills?.disabledLevels)
        ? undefined
        : settings.skills.disabledLevels.filter(isSkillLevel),
    customSkillDirs:
      bareMode || safeMode
        ? undefined
        : (Array.isArray(settings.skills?.directories)
            ? settings.skills.directories
            : []
          )
            .filter(
              (d): d is string => typeof d === 'string' && d.trim().length > 0,
            )
            .map((d) => d.trim()),
    disabledTools: disabledTools.length > 0 ? disabledTools : undefined,
    visibleTools: visibleTools.length > 0 ? visibleTools : undefined,
    eagerTools,
    toolSearchThreshold:
      bareMode || safeMode ? 0 : settings.tools?.toolSearch?.threshold,
    // New unified permissions (PermissionManager source of truth).
    permissions: {
      allow: mergedAllow.length > 0 ? mergedAllow : undefined,
      ask: mergedAsk.length > 0 ? mergedAsk : undefined,
      deny: mergedDeny.length > 0 ? mergedDeny : undefined,
      autoMode:
        bareMode || safeMode ? undefined : settings.permissions?.autoMode,
    },
    toolInvocationGuard: hostPolicy?.toolInvocationGuard,
    // Permission rule persistence callback (writes to settings files).
    onPersistPermissionRule: async (scope, ruleType, rule) => {
      const currentSettings = loadSettings(cwd);
      const settingScope =
        scope === 'project' ? SettingScope.Workspace : SettingScope.User;
      const key = `permissions.${ruleType}`;
      const currentRules: string[] =
        currentSettings.forScope(settingScope).settings.permissions?.[
          ruleType
        ] ?? [];
      if (!currentRules.includes(rule)) {
        currentSettings.setValue(settingScope, key, [...currentRules, rule]);
      }
    },
    toolDiscoveryCommand:
      bareMode || safeMode ? undefined : settings.tools?.discoveryCommand,
    toolCallCommand:
      bareMode || safeMode ? undefined : settings.tools?.callCommand,
    mcpServerCommand:
      bareMode || safeMode ? undefined : settings.mcp?.serverCommand,
    mcpToolIdleTimeoutMs: settings.mcp?.toolIdleTimeoutMs,
    mcpServers,
    topTierMcpServers,
    pendingMcpServers,
    allowedMcpServers: allowedMcpServers
      ? Array.from(allowedMcpServers)
      : undefined,
    // The flag ONLY (not the settings-derived list) — the hot-reload upper
    // bound. Undefined when `--allowed-mcp-server-names` was not passed.
    cliAllowedMcpServerNames: argv.allowedMcpServerNames
      ? argv.allowedMcpServerNames.filter(Boolean)
      : undefined,
    excludedMcpServers: excludedMcpServers
      ? Array.from(excludedMcpServers)
      : undefined,
    approvalMode,
    accessibility: {
      ...settings.ui?.accessibility,
      screenReader,
    },
    showResponseTokensPerSecond:
      settings.ui?.showResponseTokensPerSecond === true,
    telemetry: telemetrySettings,
    // Ordinary interactive TUI defers telemetry until after first paint; ACP
    // defers it until after the initialize response is written. Events emitted
    // before deferred init are an accepted startup-latency tradeoff. `qwen -i
    // "prompt"` still initializes eagerly because it auto-submits after render.
    deferTelemetryInitialization: isAcpMode || (interactive && !question),
    outboundCorrelation: settings.outboundCorrelation,
    usageStatisticsEnabled:
      parseBooleanEnvFlag(process.env['QWEN_USAGE_STATISTICS_ENABLED']) ??
      settings.privacy?.usageStatisticsEnabled ??
      true,
    clearContextOnIdle: settings.context?.clearContextOnIdle,
    fileFiltering: settings.context?.fileFiltering,
    plansDirectory: settings.plansDirectory,
    proxy:
      argv.proxy ||
      settings.proxy ||
      process.env['HTTPS_PROXY'] ||
      process.env['https_proxy'] ||
      process.env['HTTP_PROXY'] ||
      process.env['http_proxy'],
    cwd,
    fileDiscoveryService: fileService,
    bugCommand: settings.advanced?.bugCommand,
    model: resolvedModel,
    outputLanguageFilePath,
    sessionTokenLimit: settings.model?.sessionTokenLimit ?? -1,
    maxSessionTurns:
      argv.maxSessionTurns ?? settings.model?.maxSessionTurns ?? -1,
    goalTokenBudget: resolveGoalTokenBudget(settings),
    maxWallTimeSeconds: resolveMaxWallTimeSeconds(argv, settings),
    maxToolCalls: resolveMaxToolCalls(argv, settings),
    // Undefined flows through to Config's default (5) and clamp logic.
    maxSubagentDepth: resolveMaxSubagentDepth(argv, settings),
    experimentalZedIntegration: argv.acp || argv.experimentalAcp || false,
    // ACP/serve-scoped: only the spawned ACP child can re-hang a restored
    // ask_user_question. In the plain TUI the flag would skip load-time
    // orphan repair (client.ts) with nothing able to re-hang the question,
    // leaving the resumed session wedged until the next send repairs it.
    restoreAskUserQuestion:
      (argv.acp || argv.experimentalAcp || false) &&
      argv.restoreAskUserQuestion === true,
    sessionWriterLeaseEnabled:
      settings.experimental?.sessionWriterLease === true,
    cronEnabled: settings.experimental?.cron ?? true,
    cronRecurringMaxAgeDays: settings.experimental?.cronRecurringMaxAgeDays,
    lsToolEnabled: settings.tools?.listDirectory?.enabled === true,
    agentTeamEnabled: settings.experimental?.agentTeam ?? false,
    artifactEnabled: settings.experimental?.artifact ?? true,
    artifactAutoOpen: settings.artifact?.autoOpen ?? true,
    artifactPublisher: settings.artifact?.publisher ?? 'local',
    artifactHost: settings.artifact?.host
      ? {
          uploadCommand: settings.artifact?.host?.uploadCommand ?? '',
          urlTemplate: settings.artifact?.host?.urlTemplate ?? '',
          keyPrefix: settings.artifact?.host?.keyPrefix,
        }
      : undefined,
    artifactOss: settings.artifact?.oss
      ? {
          bucket: settings.artifact?.oss?.bucket ?? '',
          endpoint: settings.artifact?.oss?.endpoint ?? '',
          keyPrefix: settings.artifact?.oss?.keyPrefix,
          acl: settings.artifact?.oss?.acl,
          publicBaseUrl: settings.artifact?.oss?.publicBaseUrl,
        }
      : undefined,
    emitToolUseSummaries: settings.experimental?.emitToolUseSummaries ?? true,
    listExtensions: argv.listExtensions || false,
    locale: resolveLocaleForExtensions(settings),
    overrideExtensions: overrideExtensions || argv.extensions,
    noBrowser: !!process.env['NO_BROWSER'],
    authType: selectedAuthType,
    inputFormat,
    outputFormat,
    includePartialMessages,
    modelProvidersConfig,
    providerProtocolConfig,
    generationConfigSources: resolvedCliConfig.sources,
    generationConfig: resolvedCliConfig.generationConfig,
    initialModelRegistryBaseUrl: resolvedCliConfig.registryBaseUrl,
    warnings: resolvedCliConfig.warnings,
    bareMode,
    safeMode,
    allowedHttpHookUrls:
      bareMode || safeMode
        ? []
        : (settings.security?.allowedHttpHookUrls ?? []),
    allowPrivateNetworkHooks:
      bareMode || safeMode
        ? false
        : (settings.security?.allowPrivateNetworkHooks ?? false),
    cliVersion: await getCliVersion(),
    ideMode,
    chatCompression: settings.model?.chatCompression,
    autoCompactThreshold: settings.context?.autoCompactThreshold,
    folderTrust,
    interactive,
    trustedFolder,
    useRipgrep: settings.tools?.useRipgrep,
    useBuiltinRipgrep: settings.tools?.useBuiltinRipgrep,
    workflowsEnabled: settings.tools?.workflowsEnabled,
    shouldUseNodePtyShell: settings.tools?.shell?.enableInteractiveShell,
    shellDefaultTimeoutMs: settings.tools?.shell?.defaultTimeoutMs,
    shellHeartbeatIntervalMs: settings.tools?.shell?.heartbeatIntervalMs,
    preventSystemSleep: settings.general?.preventSystemSleep ?? true,
    skipNextSpeakerCheck: settings.model?.skipNextSpeakerCheck,
    skipWorkflowUsageWarning: settings.model?.skipWorkflowUsageWarning ?? false,
    skipLoopDetection: settings.model?.skipLoopDetection ?? true,
    maxToolCallsPerTurn: settings.model?.maxToolCallsPerTurn,
    skipStartupContext: settings.model?.skipStartupContext ?? false,
    truncateToolOutputThreshold: settings.tools?.truncateToolOutputThreshold,
    truncateToolOutputLines: settings.tools?.truncateToolOutputLines,
    toolOutputBatchBudget: settings.tools?.toolOutputBatchBudget,
    eventEmitter: appEvents,
    gitCoAuthor: settings.general?.gitCoAuthor,
    output: {
      format: outputSettingsFormat,
    },
    enableManagedAutoMemory:
      bareMode || safeMode
        ? false
        : (settings.memory?.enableManagedAutoMemory ?? true),
    enableManagedAutoDream:
      bareMode || safeMode
        ? false
        : (settings.memory?.enableManagedAutoDream ?? true),
    enableTeamMemory:
      bareMode || safeMode
        ? false
        : (settings.memory?.enableTeamMemory ?? false),
    enableTeamMemorySync:
      bareMode || safeMode
        ? false
        : (settings.memory?.enableTeamMemorySync ?? false),
    enableAutoSkill:
      bareMode || safeMode
        ? false
        : (settings.memory?.enableAutoSkill ?? false),
    autoSkillConfirm:
      bareMode || safeMode
        ? false
        : (settings.memory?.autoSkillConfirm ?? true),
    memoryAgentTimeoutMinutes: settings.memory?.agentTimeoutMinutes,
    memoryAgentMaxTurns: settings.memory?.agentMaxTurns,
    fastModel: settings.fastModel || undefined,
    webSearch:
      bareMode || safeMode ? undefined : resolveWebSearchSettings(settings),
    visionModel: settings.visionModel || undefined,
    compactionModel: settings.compactionModel || undefined,
    imageModel: settings.imageModel || undefined,
    visionBridgeTimeoutMs: settings.visionBridgeTimeoutMs,
    modelFallbacks: resolveModelFallbacks(
      argv.fallbackModel,
      settings.modelFallbacks,
    ),
    // Use separated hooks if provided, otherwise fall back to merged hooks
    userHooks:
      bareMode || safeMode
        ? undefined
        : (hooksConfig?.userHooks ?? settings.hooks),
    projectHooks: bareMode || safeMode ? undefined : hooksConfig?.projectHooks,
    hooks: bareMode || safeMode ? undefined : settings.hooks,
    disableAllHooks:
      bareMode || safeMode ? true : (settings.disableAllHooks ?? false),
    stopHookBlockingCap:
      bareMode || safeMode ? undefined : settings.stopHookBlockingCap,
    channel: argv.channel,
    // CLI flag wins over settings.json. `--json-fd` is fd-only (no settings
    // equivalent — fd passing is a spawn-time concern). `--json-file` and
    // `--input-file` fall back to settings.dualOutput.* when the flag is
    // absent.
    jsonFd: argv.jsonFd,
    jsonFile: argv.jsonFile ?? settings.dualOutput?.jsonFile,
    jsonSchema: resolveJsonSchemaArg(argv.jsonSchema),
    inputFile: argv.inputFile ?? settings.dualOutput?.inputFile,
    // Precedence: explicit CLI flag > settings file > default(true).
    // NOTE: do NOT set a yargs default for `chat-recording`, otherwise argv will
    // always be true and the settings file can never disable recording.
    chatRecording:
      argv.chatRecording ?? settings.general?.chatRecording ?? true,
    defaultFileEncoding: settings.general?.defaultFileEncoding,
    lsp: {
      enabled: lspEnabled,
    },
    agents: settings.agents
      ? {
          builtin: settings.agents.builtin
            ? {
                exploreModel: settings.agents.builtin.exploreModel,
              }
            : undefined,
          modelGrades: settings.agents.modelGrades,
          allowedGrades: settings.agents.allowedGrades,
          maxParallelAgents: settings.agents.maxParallelAgents,
          maxParallelAgentsByModel: settings.agents.maxParallelAgentsByModel,
          displayMode: settings.agents.displayMode,
          arena: settings.agents.arena
            ? {
                worktreeBaseDir: settings.agents.arena.worktreeBaseDir,
                preserveArtifacts:
                  settings.agents.arena.preserveArtifacts ?? false,
              }
            : undefined,
        }
      : undefined,
    worktree: settings.worktree
      ? {
          symlinkDirectories: settings.worktree.symlinkDirectories,
        }
      : undefined,
    settingsWatcher,
  };

  const config = new Config(configParams);

  if (lspEnabled) {
    try {
      const lspService = new NativeLspService(
        config,
        config.getWorkspaceContext(),
        appEvents,
        fileService!,
        ideContextStore,
        {
          requireTrustedWorkspace: folderTrust,
        },
      );

      await lspService.discoverAndPrepare();
      if (config.getDebugMode()) {
        debugLogger.debug(
          'Native LSP status after discovery:',
          lspService.getStatusSnapshot(),
        );
      }
      await lspService.start();
      if (config.getDebugMode()) {
        debugLogger.debug(
          'Native LSP status after startup:',
          lspService.getStatusSnapshot(),
        );
      }
      lspClient = new NativeLspClient(lspService);
      config.setLspClient(lspClient);
      try {
        config.setLspInitializationError(undefined);
      } catch {
        debugLogger.warn(
          'Failed to clear LSP initialization error after initialization',
        );
      }
    } catch (err) {
      try {
        config.setLspInitializationError(
          err instanceof Error ? err : String(err),
        );
      } catch {
        debugLogger.warn('LSP init error occurred after initialization:', err);
      }
      debugLogger.warn('Failed to initialize native LSP service:', err);
    }
  }

  return config;
}
