/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  AuthType,
  Config,
  DEFAULT_QWEN_EMBEDDING_MODEL,
  FileDiscoveryService,
  getAllGeminiMdFilenames,
  loadServerHierarchicalMemory,
  type LoadServerHierarchicalMemoryResponse,
  setGeminiMdFilename as setServerGeminiMdFilename,
  resolveTelemetrySettings,
  FatalConfigError,
  Storage,
  InputFormat,
  OutputFormat,
  SessionService,
  ideContextStore,
  type ResumedSessionData,
  type LspClient,
  type ToolName,
  ToolNames,
  NativeLspClient,
  createDebugLogger,
  NativeLspService,
  isBareMode,
  isToolEnabled,
  SchemaValidator,
  type ConfigParameters,
  type MCPServerConfig,
} from '@qwen-code/qwen-code-core';
import { extensionsCommand } from '../commands/extensions.js';
import { hooksCommand } from '../commands/hooks.js';
import type { Settings } from './settings.js';
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
import stripJsonComments from 'strip-json-comments';

import { resolvePath } from '../utils/resolvePath.js';
import { getCliVersion } from '../utils/version.js';
import { loadSandboxConfig } from './sandboxConfig.js';
import { appEvents } from '../utils/events.js';
import { mcpCommand } from '../commands/mcp.js';
import { channelCommand } from '../commands/channel.js';
import { authCommand } from '../commands/auth.js';
import { reviewCommand } from '../commands/review.js';
import { serveCommand } from '../commands/serve.js';

// UUID v4 regex pattern for validation
const SESSION_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(-agent-[a-zA-Z0-9_.-]+)?$/i;

/**
 * Validates if a string is a valid session ID format.
 * Accepts a standard UUID, or a UUID followed by `-agent-{suffix}`
 * (used by Arena to give each agent a deterministic session ID).
 */
export function isValidSessionId(value: string): boolean {
  return SESSION_ID_REGEX.test(value);
}

import { isWorkspaceTrusted } from './trustedFolders.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

const debugLogger = createDebugLogger('CONFIG');

const VALID_APPROVAL_MODE_VALUES = [
  'plan',
  'default',
  'auto-edit',
  'yolo',
] as const;

function formatApprovalModeError(value: string): Error {
  return new Error(
    `Invalid approval mode: ${value}. Valid values are: ${VALID_APPROVAL_MODE_VALUES.join(
      ', ',
    )}`,
  );
}

function parseApprovalModeValue(value: string): ApprovalMode {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'plan':
      return ApprovalMode.PLAN;
    case 'default':
      return ApprovalMode.DEFAULT;
    case 'yolo':
      return ApprovalMode.YOLO;
    case 'auto_edit':
    case 'autoedit':
    case 'auto-edit':
      return ApprovalMode.AUTO_EDIT;
    default:
      throw formatApprovalModeError(value);
  }
}

export interface CliArgs {
  query: string | undefined;
  model: string | undefined;
  sandbox: boolean | string | undefined;
  sandboxImage: string | undefined;
  debug: boolean | undefined;
  prompt: string | undefined;
  promptInteractive: string | undefined;
  systemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
  yolo: boolean | undefined;
  bare: boolean | undefined;
  approvalMode: string | undefined;
  telemetry: boolean | undefined;
  checkpointing: boolean | undefined;
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
  extensions: string[] | undefined;
  listExtensions: boolean | undefined;
  openaiLogging: boolean | undefined;
  openaiApiKey: string | undefined;
  openaiBaseUrl: string | undefined;
  openaiLoggingDir: string | undefined;
  proxy: string | undefined;
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
  /** Internal: preserve the outer session ID when relaunching in a sandbox */
  sandboxSessionId?: string | undefined;
  maxSessionTurns: number | undefined;
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
    .usage(
      'Usage: qwen [options] [command]\n\nQwen Code - Launch an interactive CLI, use -p/--prompt for non-interactive mode',
    )
    .option('telemetry', {
      type: 'boolean',
      description:
        'Enable telemetry? This flag specifically controls if telemetry is sent. Other --telemetry-* flags set specific values but do not enable telemetry on their own.',
    })
    .option('telemetry-target', {
      type: 'string',
      choices: ['local', 'gcp'],
      description:
        'Set the telemetry target (local or gcp). Overrides settings files.',
    })
    .option('telemetry-otlp-endpoint', {
      type: 'string',
      description:
        'Set the OTLP endpoint for telemetry. Overrides environment variables and settings files.',
    })
    .option('telemetry-otlp-protocol', {
      type: 'string',
      choices: ['grpc', 'http'],
      description:
        'Set the OTLP protocol for telemetry (grpc or http). Overrides settings files.',
    })
    .option('telemetry-log-prompts', {
      type: 'boolean',
      description:
        'Enable or disable logging of user prompts for telemetry. Overrides settings files.',
    })
    .option('telemetry-outfile', {
      type: 'string',
      description: 'Redirect all telemetry output to the specified file.',
    })
    .deprecateOption(
      'telemetry',
      'Use the "telemetry.enabled" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-target',
      'Use the "telemetry.target" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-otlp-endpoint',
      'Use the "telemetry.otlpEndpoint" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-otlp-protocol',
      'Use the "telemetry.otlpProtocol" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-log-prompts',
      'Use the "telemetry.logPrompts" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .deprecateOption(
      'telemetry-outfile',
      'Use the "telemetry.outfile" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .option('debug', {
      alias: 'd',
      type: 'boolean',
      description: 'Run in debug mode?',
      default: false,
    })
    .option('bare', {
      type: 'boolean',
      description:
        'Minimal mode: skip implicit startup auto-discovery and only honor explicitly provided CLI inputs.',
      default: false,
    })
    .option('proxy', {
      type: 'string',
      description: 'Proxy for Qwen Code, like schema://user:password@host:port',
    })
    .deprecateOption(
      'proxy',
      'Use the "proxy" setting in settings.json instead. This flag will be removed in a future version.',
    )
    .option('chat-recording', {
      type: 'boolean',
      description:
        'Enable chat recording to disk. If false, chat history is not saved and --continue/--resume will not work.',
    })
    .command('$0 [query..]', 'Launch Qwen Code CLI', (yargsInstance: Argv) =>
      yargsInstance
        .positional('query', {
          description:
            'Positional prompt. Defaults to one-shot; use -i/--prompt-interactive for interactive.',
        })
        .option('model', {
          alias: 'm',
          type: 'string',
          description: `Model`,
        })
        .option('prompt', {
          alias: 'p',
          type: 'string',
          description: 'Prompt. Appended to input on stdin (if any).',
        })
        .option('prompt-interactive', {
          alias: 'i',
          type: 'string',
          description:
            'Execute the provided prompt and continue in interactive mode',
        })
        .option('system-prompt', {
          type: 'string',
          description:
            'Override the main session system prompt for this run. Can be combined with --append-system-prompt.',
        })
        .option('append-system-prompt', {
          type: 'string',
          description:
            'Append instructions to the main session system prompt for this run. Can be combined with --system-prompt.',
        })
        .option('sandbox', {
          alias: 's',
          type: 'boolean',
          description: 'Run in sandbox?',
        })
        .option('sandbox-image', {
          type: 'string',
          description: 'Sandbox image URI.',
        })
        .option('yolo', {
          alias: 'y',
          type: 'boolean',
          description:
            'Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?',
          default: false,
        })
        .option('approval-mode', {
          type: 'string',
          choices: ['plan', 'default', 'auto-edit', 'yolo'],
          description:
            'Set the approval mode: plan (plan only), default (prompt for approval), auto-edit (auto-approve edit tools), yolo (auto-approve all tools)',
        })
        .option('checkpointing', {
          type: 'boolean',
          description: 'Enables checkpointing of file edits',
          default: false,
        })
        .option('acp', {
          type: 'boolean',
          description: 'Starts the agent in ACP mode',
        })
        .option('experimental-acp', {
          type: 'boolean',
          description:
            'Starts the agent in ACP mode (deprecated, use --acp instead)',
          hidden: true,
        })
        .option('experimental-skills', {
          type: 'boolean',
          description:
            'Deprecated: Skills are now enabled by default. This flag is ignored.',
          hidden: true,
        })
        .option('experimental-lsp', {
          type: 'boolean',
          description:
            'Enable experimental LSP (Language Server Protocol) feature for code intelligence',
          default: false,
        })
        .option('channel', {
          type: 'string',
          choices: ['VSCode', 'ACP', 'SDK', 'CI'],
          description: 'Channel identifier (VSCode, ACP, SDK, CI)',
        })
        .option('allowed-mcp-server-names', {
          type: 'array',
          string: true,
          description: 'Allowed MCP server names',
          coerce: (mcpServerNames: string[]) =>
            // Handle comma-separated values
            mcpServerNames.flatMap((mcpServerName) =>
              mcpServerName.split(',').map((m) => m.trim()),
            ),
        })
        .option('mcp-config', {
          type: 'string',
          description:
            'MCP server configuration as JSON string or file path. Can be a path to a JSON file or inline JSON with {"mcpServers": {...}} format.',
        })
        .option('allowed-tools', {
          type: 'array',
          string: true,
          description: 'Tools that are allowed to run without confirmation',
          coerce: (tools: string[]) =>
            // Handle comma-separated values
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('extensions', {
          alias: 'e',
          type: 'array',
          string: true,
          description:
            'A list of extensions to use. If not provided, all extensions are used.',
          coerce: (extensions: string[]) =>
            // Handle comma-separated values
            extensions.flatMap((extension) =>
              extension.split(',').map((e) => e.trim()),
            ),
        })
        .option('list-extensions', {
          alias: 'l',
          type: 'boolean',
          description: 'List all available extensions and exit.',
        })
        .option('include-directories', {
          alias: 'add-dir',
          type: 'array',
          string: true,
          description:
            'Additional directories to include in the workspace (comma-separated or multiple --include-directories)',
          coerce: (dirs: string[]) =>
            // Handle comma-separated values
            dirs.flatMap((dir) => dir.split(',').map((d) => d.trim())),
        })
        .option('openai-logging', {
          type: 'boolean',
          description:
            'Enable logging of OpenAI API calls for debugging and analysis',
        })
        .option('openai-logging-dir', {
          type: 'string',
          description:
            'Custom directory path for OpenAI API logs. Overrides settings files.',
        })
        .option('openai-api-key', {
          type: 'string',
          description: 'OpenAI API key to use for authentication',
        })
        .option('openai-base-url', {
          type: 'string',
          description: 'OpenAI base URL (for custom endpoints)',
        })
        .option('screen-reader', {
          type: 'boolean',
          description: 'Enable screen reader mode for accessibility.',
        })
        .option('input-format', {
          type: 'string',
          choices: ['text', 'stream-json'],
          description: 'The format consumed from standard input.',
          default: 'text',
        })
        .option('output-format', {
          alias: 'o',
          type: 'string',
          description: 'The format of the CLI output.',
          choices: ['text', 'json', 'stream-json'],
        })
        .option('include-partial-messages', {
          type: 'boolean',
          description:
            'Include partial assistant messages when using stream-json output.',
          default: false,
        })
        .option('json-fd', {
          type: 'number',
          description:
            'File descriptor for structured JSON event output (dual output mode). ' +
            'The TUI renders normally on stdout while JSON events are written to this fd. ' +
            'The caller must provide this fd via spawn stdio configuration.',
        })
        .option('json-file', {
          type: 'string',
          description:
            'File path for structured JSON event output (dual output mode). ' +
            'Can be a regular file, FIFO (named pipe), or /dev/fd/N.',
        })
        .option('json-schema', {
          type: 'string',
          description:
            "JSON Schema that the model's final output must conform to " +
            '(headless mode only). Accepts a JSON literal or "@path/to/schema.json". ' +
            'Registers a synthetic `structured_output` tool; the session ends on ' +
            'the first valid call.',
        })
        .option('input-file', {
          type: 'string',
          description:
            'File path for receiving remote input commands (bidirectional sync). ' +
            'An external process writes JSONL commands; the TUI watches and processes them.',
        })
        .option('continue', {
          alias: 'c',
          type: 'boolean',
          description:
            'Resume the most recent session for the current project.',
          default: false,
        })
        .option('resume', {
          alias: 'r',
          type: 'string',
          description:
            'Resume a specific session by its ID. Use without an ID to show session picker.',
        })
        .option('session-id', {
          type: 'string',
          description: 'Specify a session ID for this run.',
        })
        .option('sandbox-session-id', {
          type: 'string',
          hidden: true,
        })
        .option('max-session-turns', {
          type: 'number',
          description: 'Maximum number of session turns',
        })
        .option('core-tools', {
          type: 'array',
          string: true,
          description: 'Core tool paths',
          coerce: (tools: string[]) =>
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('exclude-tools', {
          type: 'array',
          string: true,
          description: 'Tools to exclude',
          coerce: (tools: string[]) =>
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('disabled-slash-commands', {
          type: 'array',
          string: true,
          description:
            'Slash command names to hide/disable (comma-separated or ' +
            'repeated). Merged with the `slashCommands.disabled` setting ' +
            'and QWEN_DISABLED_SLASH_COMMANDS. Matched case-insensitively ' +
            'against the final command name.',
          coerce: (names: string[]) =>
            names.flatMap((n) => n.split(',').map((t) => t.trim())),
        })
        .option('allowed-tools', {
          type: 'array',
          string: true,
          description: 'Tools to allow, will bypass confirmation',
          coerce: (tools: string[]) =>
            tools.flatMap((tool) => tool.split(',').map((t) => t.trim())),
        })
        .option('auth-type', {
          type: 'string',
          choices: [
            AuthType.USE_OPENAI,
            AuthType.USE_ANTHROPIC,
            AuthType.QWEN_OAUTH,
            AuthType.USE_GEMINI,
            AuthType.USE_VERTEX_AI,
          ],
          description: 'Authentication type',
        })
        .deprecateOption(
          'sandbox-image',
          'Use the "tools.sandboxImage" setting in settings.json instead. This flag will be removed in a future version.',
        )
        .deprecateOption(
          'checkpointing',
          'Use the "general.checkpointing.enabled" setting in settings.json instead. This flag will be removed in a future version.',
        )
        .deprecateOption(
          'prompt',
          'Use the positional prompt instead. This flag will be removed in a future version.',
        )
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
          if (argv['sessionId'] && (argv['continue'] || argv['resume'])) {
            return 'Cannot use --session-id with --continue or --resume. Use --session-id to start a new session with a specific ID, or use --continue/--resume to resume an existing session.';
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
    // Register /review skill helpers (presubmit checks, cleanup)
    .command(reviewCommand)
    // Register `qwen serve` (Stage 1 daemon — see issue #3803)
    .command(serveCommand);

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
      result._[0] === 'review')
  ) {
    // Note: `serve` is intentionally NOT in this list. Its handler blocks
    // forever (after the listener is up); SIGINT/SIGTERM in runQwenServe
    // drives shutdown. Hitting `process.exit(0)` here would kill the daemon.
    // MCP/Extensions/Auth/Hooks/Channel/Review commands handle their own
    // execution and exit. Returning here would let the main interactive
    // flow run, which would prompt for stdin input despite the user
    // having already invoked a subcommand.
    process.exit(0);
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

  // Apply ACP fallback: if acp or experimental-acp is present but no explicit --channel, treat as ACP
  if ((result['acp'] || result['experimentalAcp']) && !result['channel']) {
    (result as Record<string, unknown>)['channel'] = 'ACP';
  }

  return result as unknown as CliArgs;
}

// This function is now a thin wrapper around the server's implementation.
// It's kept in the CLI for now as App.tsx directly calls it for memory refresh.
// TODO: Consider if App.tsx should get memory via a server call or if Config should refresh itself.
export async function loadHierarchicalGeminiMemory(
  currentWorkingDirectory: string,
  includeDirectoriesToReadGemini: readonly string[] = [],
  fileService: FileDiscoveryService,
  extensionContextFilePaths: string[] = [],
  folderTrust: boolean,
  memoryImportFormat: 'flat' | 'tree' = 'tree',
  contextRuleExcludes: string[] = [],
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
    includeDirectoriesToReadGemini,
    fileService,
    extensionContextFilePaths,
    folderTrust,
    memoryImportFormat,
    contextRuleExcludes,
  );
}

export function isDebugMode(argv: CliArgs): boolean {
  return (
    argv.debug ||
    [process.env['DEBUG'], process.env['DEBUG_MODE']].some(
      (v) => v === 'true' || v === '1',
    )
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
): Promise<Config> {
  const debugMode = isDebugMode(argv);
  const bareMode = isBareMode(argv.bare);

  // Set runtime output directory from settings (env var QWEN_RUNTIME_DIR
  // is auto-detected inside getRuntimeBaseDir() at each call site).
  // Pass cwd so that relative paths like ".qwen" resolve per-project.
  Storage.setRuntimeBaseDir(settings.advanced?.runtimeOutputDir, cwd);

  const ideMode = settings.ide?.enabled ?? false;

  const folderTrust = settings.security?.folderTrust?.enabled ?? false;
  const trustedFolder = isWorkspaceTrusted(settings)?.isTrusted ?? true;

  // Set the context filename in the server's memoryTool module BEFORE loading memory
  // TODO(b/343434939): This is a bit of a hack. The contextFileName should ideally be passed
  // directly to the Config constructor in core, and have core handle setGeminiMdFilename.
  // However, loadHierarchicalGeminiMemory is called *before* createServerConfig.
  if (settings.context?.fileName) {
    setServerGeminiMdFilename(settings.context.fileName);
  } else {
    // Reset to default context filenames if not provided in settings.
    setServerGeminiMdFilename(getAllGeminiMdFilenames());
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
  if (!bareMode) {
    if (fs.existsSync(projectOutputLanguagePath)) {
      outputLanguageFilePath = projectOutputLanguagePath;
    } else if (fs.existsSync(globalOutputLanguagePath)) {
      outputLanguageFilePath = globalOutputLanguagePath;
    }
  }

  const fileService = new FileDiscoveryService(cwd);

  const includeDirectories = (
    bareMode ? [] : (settings.context?.includeDirectories ?? [])
  )
    .map(resolvePath)
    .concat((argv.includeDirectories || []).map(resolvePath));

  // LSP configuration: enabled only via --experimental-lsp flag
  const lspEnabled = !bareMode && argv.experimentalLsp === true;
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
  } else if (!bareMode && settings.tools?.approvalMode) {
    approvalMode = parseApprovalModeValue(settings.tools.approvalMode);
  } else {
    approvalMode = ApprovalMode.DEFAULT;
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
  const resolvedCoreTools: string[] = [
    ...(bareMode ? [] : (argv.coreTools ?? [])),
    ...(bareMode ? [] : (settings.tools?.core ?? [])),
  ];
  const mergedAllow: string[] = [
    ...(bareMode ? [] : (settings.permissions?.allow ?? [])),
    ...(bareMode ? [] : (settings.tools?.allowed ?? [])),
  ];
  const mergedAsk: string[] = [
    ...(bareMode ? [] : (settings.permissions?.ask ?? [])),
  ];
  const mergedDeny: string[] = [
    ...(bareMode ? [] : (settings.permissions?.deny ?? [])),
    ...(bareMode ? [] : (settings.tools?.exclude ?? [])),
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
  for (const name of settings.slashCommands?.disabled ?? []) addDisabled(name);
  for (const name of argv.disabledSlashCommands ?? []) addDisabled(name);
  for (const name of (process.env['QWEN_DISABLED_SLASH_COMMANDS'] ?? '').split(
    ',',
  )) {
    addDisabled(name);
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
  } else if (!bareMode) {
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
    bareMode ? ({} as Settings) : settings,
    argv,
  );
  const screenReader =
    argv.screenReader !== undefined
      ? argv.screenReader
      : (settings.ui?.accessibility?.screenReader ?? false);

  let sessionId: string | undefined;
  let sessionData: ResumedSessionData | undefined;

  if (argv.continue || argv.resume) {
    const sessionService = new SessionService(cwd);
    if (argv.continue) {
      sessionData = await sessionService.loadLastSession();
      if (sessionData) {
        sessionId = sessionData.conversation.sessionId;
      }
    }

    if (argv.resume) {
      // By the time we get here, argv.resume has been resolved to a valid
      // session UUID by gemini.tsx (which handles custom title lookup and
      // the interactive picker for ambiguous matches).
      sessionId = argv.resume;
      sessionData = await sessionService.loadSession(argv.resume);
      if (!sessionData) {
        const message = `No saved session found with ID ${argv.resume}. Run \`qwen --resume\` without an ID to choose from existing sessions.`;
        writeStderrLine(message);
        process.exit(1);
      }
    }
  } else if (argv.sandboxSessionId) {
    sessionId = argv.sandboxSessionId;
  } else if (argv['sessionId']) {
    // Use provided session ID without session resumption
    // Check if session ID is already in use
    const sessionService = new SessionService(cwd);
    const exists = await sessionService.sessionExists(argv['sessionId']);
    if (exists) {
      const message = `Error: Session Id ${argv['sessionId']} is already in use.`;
      writeStderrLine(message);
      process.exit(1);
    }
    sessionId = argv['sessionId'];
  }

  const modelProvidersConfig = settings.modelProviders;

  const configParams: ConfigParameters = {
    sessionId,
    sessionData,
    embeddingModel: DEFAULT_QWEN_EMBEDDING_MODEL,
    sandbox: sandboxConfig,
    targetDir: cwd,
    includeDirectories,
    loadMemoryFromIncludeDirectories: bareMode
      ? includeDirectories.length > 0
      : (settings.context?.loadFromIncludeDirectories ?? false),
    importFormat: settings.context?.importFormat || 'tree',
    debugMode,
    question,
    systemPrompt: argv.systemPrompt,
    appendSystemPrompt: argv.appendSystemPrompt,
    // Legacy fields – kept for backward compatibility with getCoreTools() etc.
    coreTools: bareMode
      ? undefined
      : argv.coreTools || settings.tools?.core || undefined,
    allowedTools: bareMode
      ? argv.allowedTools || undefined
      : argv.allowedTools || settings.tools?.allowed || undefined,
    excludeTools: mergedDeny,
    disabledSlashCommands:
      disabledSlashCommands.length > 0 ? disabledSlashCommands : undefined,
    // New unified permissions (PermissionManager source of truth).
    permissions: {
      allow: mergedAllow.length > 0 ? mergedAllow : undefined,
      ask: mergedAsk.length > 0 ? mergedAsk : undefined,
      deny: mergedDeny.length > 0 ? mergedDeny : undefined,
    },
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
    toolDiscoveryCommand: bareMode
      ? undefined
      : settings.tools?.discoveryCommand,
    toolCallCommand: bareMode ? undefined : settings.tools?.callCommand,
    mcpServerCommand: bareMode ? undefined : settings.mcp?.serverCommand,
    mcpServers: bareMode
      ? {}
      : (() => {
          const base = settings.mcpServers || {};
          const cliMcpServers = parseMcpConfig(argv.mcpConfig);
          return cliMcpServers ? { ...base, ...cliMcpServers } : base;
        })(),
    allowedMcpServers: allowedMcpServers
      ? Array.from(allowedMcpServers)
      : undefined,
    excludedMcpServers: excludedMcpServers
      ? Array.from(excludedMcpServers)
      : undefined,
    approvalMode,
    accessibility: {
      ...settings.ui?.accessibility,
      screenReader,
    },
    telemetry: telemetrySettings,
    usageStatisticsEnabled: settings.privacy?.usageStatisticsEnabled ?? true,
    clearContextOnIdle: settings.context?.clearContextOnIdle,
    fileFiltering: settings.context?.fileFiltering,
    checkpointing:
      argv.checkpointing || settings.general?.checkpointing?.enabled,
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
    experimentalZedIntegration: argv.acp || argv.experimentalAcp || false,
    cronEnabled: settings.experimental?.cron ?? false,
    emitToolUseSummaries: settings.experimental?.emitToolUseSummaries ?? true,
    listExtensions: argv.listExtensions || false,
    overrideExtensions: overrideExtensions || argv.extensions,
    noBrowser: !!process.env['NO_BROWSER'],
    authType: selectedAuthType,
    inputFormat,
    outputFormat,
    includePartialMessages,
    modelProvidersConfig,
    generationConfigSources: resolvedCliConfig.sources,
    generationConfig: resolvedCliConfig.generationConfig,
    warnings: resolvedCliConfig.warnings,
    bareMode,
    allowedHttpHookUrls: bareMode
      ? []
      : (settings.security?.allowedHttpHookUrls ?? []),
    cliVersion: await getCliVersion(),
    ideMode,
    chatCompression: settings.model?.chatCompression,
    folderTrust,
    interactive,
    trustedFolder,
    useRipgrep: settings.tools?.useRipgrep,
    useBuiltinRipgrep: settings.tools?.useBuiltinRipgrep,
    shouldUseNodePtyShell: settings.tools?.shell?.enableInteractiveShell,
    skipNextSpeakerCheck: settings.model?.skipNextSpeakerCheck,
    skipLoopDetection: settings.model?.skipLoopDetection ?? true,
    skipStartupContext: settings.model?.skipStartupContext ?? false,
    truncateToolOutputThreshold: settings.tools?.truncateToolOutputThreshold,
    truncateToolOutputLines: settings.tools?.truncateToolOutputLines,
    eventEmitter: appEvents,
    gitCoAuthor: settings.general?.gitCoAuthor,
    output: {
      format: outputSettingsFormat,
    },
    enableManagedAutoMemory: bareMode
      ? false
      : (settings.memory?.enableManagedAutoMemory ?? true),
    enableManagedAutoDream: settings.memory?.enableManagedAutoDream ?? false,
    enableAutoSkill: bareMode
      ? false
      : (settings.memory?.enableAutoSkill ?? false),
    fastModel: settings.fastModel || undefined,
    // Use separated hooks if provided, otherwise fall back to merged hooks
    userHooks: bareMode
      ? undefined
      : (hooksConfig?.userHooks ?? settings.hooks),
    projectHooks: bareMode ? undefined : hooksConfig?.projectHooks,
    hooks: bareMode ? undefined : settings.hooks, // Keep for backward compatibility
    disableAllHooks: bareMode ? true : (settings.disableAllHooks ?? false),
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
  };

  const config = new Config(configParams);

  if (lspEnabled) {
    try {
      const lspService = new NativeLspService(
        config,
        config.getWorkspaceContext(),
        appEvents,
        fileService,
        ideContextStore,
        {
          requireTrustedWorkspace: folderTrust,
        },
      );

      await lspService.discoverAndPrepare();
      await lspService.start();
      lspClient = new NativeLspClient(lspService);
      config.setLspClient(lspClient);
    } catch (err) {
      debugLogger.warn('Failed to initialize native LSP service:', err);
    }
  }

  return config;
}
