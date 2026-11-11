/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared brand constants with Qwen Code defaults.
 * Release builds inline product values; unbundled code reads launch environment.
 */

// Identity

/** Qwen Code display name, used in copy and titles. */
export const BRAND_NAME = process.env['BRAND_NAME'] || 'Qwen Code';

/** CLI name shown in headers, help text, and dialog titles. */
export const BRAND_CLI_NAME = process.env['BRAND_CLI_NAME'] || BRAND_NAME;

/** Lowercase slug, for file paths, tmp directories, package names */
export const BRAND_CLI_SLUG = process.env['BRAND_CLI_SLUG'] || 'qwen-code';

/** Slug used for temporary paths. */
export const BRAND_TEMP_PATH_SLUG =
  process.env['BRAND_TEMP_PATH_SLUG'] || BRAND_CLI_SLUG;

/** CLI executable / binary name (the thing users type in their shell) */
export const BRAND_CLI_BIN = process.env['BRAND_CLI_BIN'] || 'qwen';

/**
 * Site-independent CLI identifier for cross-process metadata that must stay
 * identical across editions (e.g. SDK MCP client identity).
 */
export const BRAND_FIXED_CLI_BIN =
  process.env['BRAND_FIXED_CLI_BIN'] || BRAND_CLI_BIN;

/** Stem of the run-scoped process log file. Defaults to `qwen`. */
export const BRAND_PROCESS_LOG_STEM =
  process.env['BRAND_PROCESS_LOG_STEM'] || 'qwen';

/** npm package used by updates and platform dependencies. */
export const BRAND_NPM_PACKAGE =
  process.env['BRAND_NPM_PACKAGE'] || '@qwen-code/qwen-code';

/** Package identities recognized by installation-source detection. */
export const BRAND_NPM_PACKAGES: readonly string[] = Object.freeze(
  (process.env['BRAND_NPM_PACKAGES'] || '@qwen-code/qwen-code').split(','),
);
export const BRAND_HOMEBREW_TOKEN =
  process.env['BRAND_HOMEBREW_TOKEN'] || 'qwen-code';

/**
 * Namespace for branded event names. Attribute and event
 * name types derive from this constant as literals, so the build value is
 * asserted to the default's literal type: a plain `string` would collapse the
 * discriminated event-name types.
 */
const DEFAULT_EVENT_NAMESPACE = 'qwen' as const;
export const BRAND_EVENT_NAMESPACE = (process.env['BRAND_EVENT_NAMESPACE'] ||
  DEFAULT_EVENT_NAMESPACE) as typeof DEFAULT_EVENT_NAMESPACE;

/** Prefix for branded event names */
export const BRAND_EVENT_PREFIX = `${BRAND_EVENT_NAMESPACE}_` as const;

// File names

/** Default user config directory name; release builds inline the product value. */
export const BRAND_USER_CONFIG_DIR_NAME =
  process.env['BRAND_USER_CONFIG_DIR_NAME'] || '.qwen';

/** Default project config directory name; independent of the user directory. */
export const BRAND_PROJECT_CONFIG_DIR_NAME =
  process.env['BRAND_PROJECT_CONFIG_DIR_NAME'] || '.qwen';

/** Ignore file name (analogous to .gitignore) */
export const BRAND_IGNORE_FILE = process.env['BRAND_IGNORE_FILE'] || '.qwenignore';

/** Directory containing plugin and marketplace manifests. */
export const BRAND_PLUGIN_META_DIR =
  process.env['BRAND_PLUGIN_META_DIR'] || '.qwen-plugin';

// Environment variable names

/** Environment variable prefix. Defaults to `QWEN_`. */
export const BRAND_ENV_PREFIX = process.env['BRAND_ENV_PREFIX'] || 'QWEN_';

/** Site-independent environment variable prefix. */
export const BRAND_FIXED_ENV_PREFIX =
  process.env['BRAND_FIXED_ENV_PREFIX'] || 'QWEN_';

/** Builds an environment variable name using BRAND_ENV_PREFIX. */
function E(suffix: string): string {
  return `${BRAND_ENV_PREFIX}${suffix}`;
}

/** Builds a site-independent variable name using BRAND_FIXED_ENV_PREFIX. */
function Q(suffix: string): string {
  return `${BRAND_FIXED_ENV_PREFIX}${suffix}`;
}

/** Stable namespace for cross-site filesystem and protocol identifiers. */
export const BRAND_PROTOCOL_NAMESPACE = BRAND_FIXED_ENV_PREFIX.replace(
  /_$/,
  '',
).toLowerCase();
export const BRAND_WORKTREE_OWNER_FILE = `${BRAND_PROTOCOL_NAMESPACE}-worktree.json`;
export const BRAND_WORKTREE_BASE_FILE = Q('BASE');
export const BRAND_WORKTREE_LOCK_DIR_NAME = `.${BRAND_PROTOCOL_NAMESPACE}`;

/** Site-independent hook/plugin protocol variable names. */
export const ENV_PROJECT_DIR = Q('PROJECT_DIR');
export const ENV_PLUGIN_ROOT = Q('PLUGIN_ROOT');
export const ENV_PLUGIN_DATA = Q('PLUGIN_DATA');
/** Skill template names; the session variable is distinct from launch overrides. */
export const ENV_SKILL_DIR = Q('SKILL_DIR');
export const ENV_SKILL_SESSION_ID = Q('SESSION_ID');
/** Skill body placeholders; these do not read configuration-root env overrides. */
export const ENV_SKILL_CONFIG_DIR = Q('CONFIG_DIR');
export const ENV_SKILL_USER_CONFIG_DIR = Q('USER_CONFIG_DIR');

/**
 * Overrides the OS home that `homedir()` resolves to; the user config root
 * becomes `<this>/${GLOBAL_CONFIG_DIR}`.
 */
export const ENV_CLI_HOME = E('CLI_HOME');

export const ENV_CONFIG_DIR = E('CONFIG_DIR');
export const ENV_CONFIG_DIR_NAME = E('CONFIG_DIR_NAME');

export const ENV_MAX_MCP_OUTPUT_TOKENS = E('CLI_MAX_MCP_OUTPUT_TOKENS');

/** Startup MCP wait budget in milliseconds, using the current product prefix. */
export const ENV_MCP_INIT_BUDGET_MS = E('MCP_INIT_BUDGET_MS');

export const ENV_INTEGRATION_TEST = E('CLI_INTEGRATION_TEST');

/** Parent CLI pid inherited by managed shells for self-termination guards. */
export const ENV_PID = E('PID');

export const ENV_WRITE_SYSTEM_MD = E('WRITE_SYSTEM_MD');

export const ENV_WORKTREE_HANDLED = E('CLI_WORKTREE_HANDLED');

export const ENV_WORKTREE_INFO = E('CLI_WORKTREE_INFO');

export const ENV_MODEL = E('MODEL');

/** Prefix executable for supported local command entry points. */
export const ENV_SHELL_PREFIX = E('SHELL_PREFIX');

/** Fallback shell-prefix variable. */
export const ENV_SHELL_PREFIX_COMPAT = 'CLAUDE_CODE_SHELL_PREFIX';

export const ENV_TEST_VAR = E('CLI_TEST_VAR');

export const ENV_FORCE_FILE_STORAGE = E('FORCE_FILE_STORAGE');

export const ENV_FORCE_ENCRYPTED_FILE_STORAGE = E(
  'FORCE_ENCRYPTED_FILE_STORAGE',
);

// Session and runtime environment variables

/** Home directory used by inbound uploads. */
export const ENV_PRODUCT_HOME = E('HOME');
export const ENV_RUNNING_ENV = E('RUNNING_ENV');
export const ENV_FORK_SUBAGENT = E('FORK_SUBAGENT');
export const ENV_AGENT_TEAMS = E('AGENT_TEAMS');
export const ENV_ENABLE_AGENT_SESSIONS = E('ENABLE_AGENT_SESSIONS');
/** Maximum Agent-tool nesting depth before spawning is refused. */
export const ENV_MAX_SUBAGENT_SPAWN_DEPTH = E(
  'CLI_MAX_SUBAGENT_SPAWN_DEPTH',
);
/** Maximum number of subagent runs that may hold a slot at the same time. */
export const ENV_MAX_CONCURRENT_SUBAGENTS = E(
  'CLI_MAX_CONCURRENT_SUBAGENTS',
);
/** Maximum images in one vision-model request before older ones are trimmed. */
export const ENV_MAX_REQUEST_IMAGES = E('MAX_REQUEST_IMAGES');

/**
 * Independent master switch for the cross-session auto-memory pipeline in
 * ordinary headless CLI sessions. SDK memory requests use their explicit
 * query options instead.
 */
export const ENV_MEMORY_HEADLESS = E('MEMORY_HEADLESS');

/** Project-scope Auto Memory override for ordinary headless sessions. */
export const ENV_MEMORY_PROJECT = E('MEMORY_PROJECT');

/** User-scope Auto Memory override for ordinary headless sessions. */
export const ENV_MEMORY_USER = E('MEMORY_USER');

/** Dream override for ordinary headless sessions. */
export const ENV_DREAM = E('DREAM');

function parseOptionalBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true;
  }
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false;
  }
  return undefined;
}

/**
 * Headless-mode master switch for Auto Memory. Truthy: `1` / `true` / `yes` /
 * `on`.
 */
export function isAutoMemoryHeadlessEnvEnabled(): boolean {
  return parseOptionalBooleanEnv(ENV_MEMORY_HEADLESS) === true;
}

/** Optional Project-scope override for ordinary headless sessions. */
export function getAutoMemoryHeadlessProjectEnvOverride(): boolean | undefined {
  return parseOptionalBooleanEnv(ENV_MEMORY_PROJECT);
}

/** Optional User-scope override for ordinary headless sessions. */
export function getAutoMemoryHeadlessUserEnvOverride(): boolean | undefined {
  return parseOptionalBooleanEnv(ENV_MEMORY_USER);
}

/** Optional Dream override for ordinary headless sessions. */
export function getAutoMemoryHeadlessDreamEnvOverride(): boolean | undefined {
  return parseOptionalBooleanEnv(ENV_DREAM);
}

// Variables shared across product sites
/** Enables lightweight startup profiling. */
export const ENV_PROFILING = Q('PROFILING');

/** Profile output directory; defaults to the logs/profile directory. */
export const ENV_PROFILE_DIR = Q('PROFILE_DIR');

/** Overrides the profiling log interval, in milliseconds. */
export const ENV_PROFILE_LOG_INTERVAL_MS = Q('PROFILE_LOG_INTERVAL_MS');

/** Set to `1` to write `startup-trace.json` (marks, milestones, memory) into the run log directory. */
export const ENV_STARTUP_TRACE = Q('STARTUP_TRACE');

/** Test-only pacing interval for fake response streams, in milliseconds. */
export const ENV_FAKE_STREAM_DELAY_MS = Q('FAKE_STREAM_DELAY_MS');

export const ENV_AGENT_SDK_ENTRYPOINT = Q('AGENT_SDK_ENTRYPOINT');
export const ENV_SECURITY_SCAN_SETTINGS_JSON = Q('SECURITY_SCAN_SETTINGS_JSON');
export const ENV_SECURITY_SCAN_RULES_FILE = Q('SECURITY_SCAN_RULES_FILE');
export const ENV_BUSINESS_SUB_TASK = Q('BUSINESS_SUB_TASK');
/** Set by the JetBrains plugin wrapper with IDE name/version. */
export const ENV_JB_IDE = 'JB_IDE';

// Client identity metadata

export const ENV_CLIENT_TYPE = E('CLIENT_TYPE');
export const ENV_CLIENT_VERSION = E('CLIENT_VERSION');
export const ENV_BUSINESS_PRODUCT = E('BUSINESS_PRODUCT');
export const ENV_BUSINESS_TYPE = E('BUSINESS_TYPE');
export const ENV_SCENE = E('SCENE');

// Internal environment variables
export const ENV_SUBAGENT_MODEL = E('SUBAGENT_MODEL');
export const ENV_PLAN_MODE_INTERVIEW_PHASE = E('PLAN_MODE_INTERVIEW_PHASE');
export const ENV_PLAN_PHASE4_VARIANT = E('PLAN_PHASE4_VARIANT');
export const ENV_PLAN_MODE_AGENT_COUNT = E('PLAN_MODE_AGENT_COUNT');
export const ENV_PLAN_MODE_EXPLORE_AGENT_COUNT = E(
  'PLAN_MODE_EXPLORE_AGENT_COUNT',
);
export const ENV_DISABLE_EXPLORE_PLAN_AGENTS = E('DISABLE_EXPLORE_PLAN_AGENTS');

/**
 * Suppresses automatic `Explore`/`Plan` subagent guidance in both the main
 * system prompt and plan-mode reminders. Explicit Agent calls remain available.
 * Truthy: `1` / `true` / `yes` / `on`.
 */
export function areExplorePlanAgentsDisabled(): boolean {
  return parseOptionalBooleanEnv(ENV_DISABLE_EXPLORE_PLAN_AGENTS) === true;
}

export const ENV_EMIT_SESSION_STATE_EVENTS = E('EMIT_SESSION_STATE_EVENTS');
export const ENV_PLUGIN_GIT_TIMEOUT_MS = E('PLUGIN_GIT_TIMEOUT_MS');
export const ENV_PLUGIN_CACHE_DIR = E('PLUGIN_CACHE_DIR');
export const ENV_PLUGIN_ZIP_CACHE = E('PLUGIN_ZIP_CACHE');
export const ENV_SESSION_STATE_PLAINTEXT = E('SESSION_STATE_PLAINTEXT');
export const ENV_EXPOSE_TOKEN_USAGE = E('EXPOSE_TOKEN_USAGE');
export const ENV_EXPOSE_REQUEST_ID = E('EXPOSE_REQUEST_ID');
export const ENV_RUNTIME_ROLE = E('RUNTIME_ROLE');
export const ENV_PARENT_SURFACE = E('PARENT_SURFACE');
export const ENV_CLI_PARENT_SURFACE = E('CLI_PARENT_SURFACE');
export const ENV_PARENT_TASK_ID = E('PARENT_TASK_ID');
export const ENV_TASK_ID = E('TASK_ID');
export const ENV_REMOTE_WORKER = E('REMOTE_WORKER');
/** Initial working directory for the CLI Worker. */
export const ENV_WORKER_CWD = E('WORKER_CWD');
export const ENV_GIT_BASH_PATH = E('GIT_BASH_PATH');
export const ENV_BASH_PATH = E('BASH_PATH');
export const ENV_CLI_GLOB_NO_IGNORE = E('CLI_GLOB_NO_IGNORE');
export const ENV_CLI_GLOB_HIDDEN = E('CLI_GLOB_HIDDEN');
export const ENV_CLI_GLOB_TIMEOUT_SECONDS = E('CLI_GLOB_TIMEOUT_SECONDS');
export const ENV_AUTOCOMPACT_WINDOW = E('AUTOCOMPACT_WINDOW');
export const ENV_AUTOCOMPACT_PCT_OVERRIDE = E('AUTOCOMPACT_PCT_OVERRIDE');
export const ENV_BLOCKING_LIMIT_OVERRIDE = E('BLOCKING_LIMIT_OVERRIDE');
export const ENV_REPEATED_TOOL_CALL_THRESHOLD = E(
  'REPEATED_TOOL_CALL_THRESHOLD',
);
export const ENV_REMOTE_CONTROL_SERVER = E('REMOTE_CONTROL_SERVER');

export const ENV_FEATURE_PREFIX = E('FEATURE_');

/**
 * Path of the Unix Domain Socket this session listens on for cross-session peer
 * messages. Written by the session itself once the bind succeeds; peers read it
 * out of the session registry, not out of this variable.
 */
export const ENV_MESSAGING_SOCKET = E('MESSAGING_SOCKET');

/**
 * Random token minted by the root session and inherited by every descendant
 * process. A peer presenting this token is known to be our own descendant.
 *
 * Provenance only — it selects a default inbound policy and must never be
 * treated as authentication. See docs/designs/2026-08-08-cross-session-peer-messaging.md §6.8.
 */
export const ENV_MESSAGING_SELF_TOKEN = E('MESSAGING_SELF_TOKEN');

/**
 * Overrides `general.dialogExpiry` with an explicit millisecond deadline.
 *
 * `0` means no deadline. Intended for tests and automation that need a shorter
 * or longer wait than the four settings values offer.
 */
export const ENV_USER_DIALOG_TIMEOUT_MS = E('USER_DIALOG_TIMEOUT_MS');

export const DEFAULT_CLIENT_TYPE = '5';
export const DEFAULT_BUSINESS_PRODUCT = 'cli';
export const DEFAULT_BUSINESS_TYPE = 'agent';
export const DEFAULT_SCENE = 'assistant';

// Service identifiers

/** Keychain service prefix for secrets storage */
export const BRAND_KEYCHAIN_PREFIX =
  process.env['BRAND_KEYCHAIN_PREFIX'] || 'qwen-code';

/** MCP client identification name */
export const BRAND_MCP_CLIENT_NAME =
  process.env['BRAND_MCP_CLIENT_NAME'] || 'qwen-code';

/** OAuth service name */
export const BRAND_OAUTH_SERVICE =
  process.env['BRAND_OAUTH_SERVICE'] || 'qwen-code-oauth';

/** Environment marker inherited by child tools running inside Qwen Code. */
export const BRAND_CLI_IDENTIFICATION_ENV_VAR =
  process.env['BRAND_CLI_IDENTIFICATION_ENV_VAR'] || 'QWEN_CODE';

// Website

/**
 * Product website origin. User-agent strings and user-facing links derive from
 * it; product entries supply their own site.
 */
export const BRAND_WEBSITE_URL =
  process.env['BRAND_WEBSITE_URL'] || 'https://qwen.ai';

// Environment access and client identity

export function readBrandEnv(name: string): string | undefined {
  return process.env[name];
}

export function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Backend client identity. Scene selects the matching model-list entry. */
export interface ClientIdentify {
  client_type: string;
  business_product: string;
  business_type: string;
  scene: string;
}

let configuredBusinessProduct: string | undefined;

/** Daemon 握手后固定归因，Query 不能改写。 */
export function configureBusinessProduct(product: string): void {
  if (configuredBusinessProduct !== undefined && configuredBusinessProduct !== product) {
    throw Object.assign(new Error('Daemon business.product cannot be changed'), {
      code: 'BUSINESS_PRODUCT_CONFLICT',
    });
  }
  configuredBusinessProduct = product;
}

export function getConfiguredBusinessProduct(): string | undefined {
  return configuredBusinessProduct;
}

/** 读取客户端身份；推理请求的归因由当次 business 覆盖。 */
export function getClientMetadata(): ClientIdentify {
  return {
    client_type: process.env[ENV_CLIENT_TYPE] ?? DEFAULT_CLIENT_TYPE,
    business_product:
      configuredBusinessProduct ??
      process.env[ENV_BUSINESS_PRODUCT] ?? DEFAULT_BUSINESS_PRODUCT,
    business_type: process.env[ENV_BUSINESS_TYPE] ?? DEFAULT_BUSINESS_TYPE,
    scene: process.env[ENV_SCENE] ?? DEFAULT_SCENE,
  };
}
