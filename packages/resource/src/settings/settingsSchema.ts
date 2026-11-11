/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// --------------------------------------------------------------------------
// IMPORTANT: After adding or updating settings, run `npm run schema:settings`
// to regenerate the settings JSON schema.
// --------------------------------------------------------------------------

import type { AuthType } from './settingsEnums.js';
import type { MCPServerConfig } from './mcpServerConfig.js';
import type {
  AgentOverride,
  CustomTheme,
  ModelPreferenceEntry,
  SessionRetentionSettings,
} from './settingsValueTypes.js';
import type { JudgmentSettings } from './judgmentSettings.js';
import { normalizePermissionModeValue } from './permissionMode.js';

export type SettingsType =
  | 'boolean'
  | 'string'
  | 'number'
  | 'array'
  | 'object'
  | 'enum';

export type SettingsValue =
  | boolean
  | string
  | number
  | string[]
  | object
  | undefined;

/**
 * Setting datatypes that "toggle" through a fixed list of options
 * (e.g. an enum or true/false) rather than allowing for free form input
 * (like a number or string).
 */
export const TOGGLE_TYPES: ReadonlySet<SettingsType | undefined> = new Set([
  'boolean',
  'enum',
]);

export interface SettingEnumOption {
  value: string | number;
  label: string;
}

function oneLine(strings: TemplateStringsArray, ...values: unknown[]): string {
  let result = '';
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += String(values[i]);
    }
  }
  return result.replace(/\s+/g, ' ').trim();
}

export interface SettingCollectionDefinition {
  type: SettingsType;
  description?: string;
  properties?: SettingsSchema;
  /**
   * Numeric lower bound. Only applies to number settings.
   */
  minimum?: number;
  /**
   * Exclusive numeric lower bound. Only applies to number settings.
   */
  exclusiveMinimum?: number;
  /** Enum type options */
  options?: readonly SettingEnumOption[];
  /**
   * Optional reference identifier for generators that emit a `$ref`.
   * For example, a JSON schema generator can use this to point to a shared definition.
   */
  ref?: string;
  /**
   * Optional merge strategy for dynamically added properties.
   * Used when this collection definition is referenced via additionalProperties.
   */
  mergeStrategy?: MergeStrategy;
  /** Runtime validation only: known retired fields that must fail even though
   * collection objects otherwise allow unknown keys for forward compatibility. */
  forbiddenProperties?: readonly string[];
}

export enum MergeStrategy {
  // Replace the old value with the new value. This is the default.
  REPLACE = 'replace',
  // Concatenate arrays.
  CONCAT = 'concat',
  // Merge arrays, ensuring unique values.
  UNION = 'union',
  // Shallow merge objects.
  SHALLOW_MERGE = 'shallow_merge',
}

export interface SettingDefinition {
  type: SettingsType;
  label: string;
  category: string;
  requiresRestart: boolean;
  default: SettingsValue;
  /**
   * Runtime-owned default used when no value is persisted in the selected
   * settings scope. The settings dialog resolves this source generically
   * instead of duplicating feature-specific fallback logic.
   */
  runtimeDefaultSource?: 'autoMemoryProject' | 'autoMemoryUser' | 'autoDream';
  description?: string;
  parentKey?: string;
  childKey?: string;
  key?: string;
  properties?: SettingsSchema;
  showInDialog?: boolean;
  ignoreInDocs?: boolean;
  deprecated?: boolean;
  mergeStrategy?: MergeStrategy;
  /**
   * Fixed choices shown by the settings dialog. An `enum` also restricts
   * configuration-file validation to these values, while another primitive
   * type can keep permissive validation and still use a selector in the UI.
   */
  options?: readonly SettingEnumOption[];
  /**
   * Runtime-only normalization applied before matching a value against
   * `options`. This does not change the persisted setting or JSON schema.
   */
  normalizeOptionValue?: (value: SettingsValue) => string | number | undefined;
  /** Optional dialog choice that removes the saved value instead of persisting an enum value. */
  unsetOptionLabel?: string;
  /**
   * Numeric lower bound. Only applies to number settings.
   */
  minimum?: number;
  /**
   * Exclusive numeric lower bound. Only applies to number settings.
   */
  exclusiveMinimum?: number;
  /**
   * For collection types (e.g. arrays), describes the shape of each item.
   */
  items?: SettingCollectionDefinition;
  /**
   * For map-like objects without explicit `properties`, describes the shape of the values.
   */
  additionalProperties?: SettingCollectionDefinition;
  /**
   * Optional unit to display after the value (e.g. '%').
   */
  unit?: string;
  /**
   * Optional reference identifier for generators that emit a `$ref`.
   */
  ref?: string;
}

export interface SettingsSchema {
  [key: string]: SettingDefinition;
}

export type MemoryImportFormat = 'tree' | 'flat';
export type DnsResolutionOrder = 'ipv4first' | 'verbatim';
/** Inbound policy for cross-session peer messages. */
export type CrossSessionInboundSetting = 'accept' | 'hold' | 'refuse';
/** How long a dialog waits for an answer before taking its safe default. */
export type DialogExpirySetting = '60s' | '5m' | '10m' | 'never';
/** Which external spell checker the prompt input drives. */
export type SpellcheckCheckerSetting =
  | 'auto'
  | 'aspell'
  | 'hunspell'
  | 'ispell';

export interface CustomProviderModelSetting {
  model: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
    cacheControl?: boolean;
    thinking?: {
      modes: Array<'enabled' | 'adaptive'>;
      preferredMode?: 'enabled' | 'adaptive';
      requiresBudgetForEnabled?: boolean;
      supportsEffort?: boolean;
      supportedEffortLevels?: Array<
        'low' | 'medium' | 'high' | 'xhigh' | 'max'
      >;
      requiredBetasForEffort?: string[];
    };
  };
}

export interface CustomProviderSetting {
  baseUrl: string;
  apiKey: string;
  type?: 'openai-compatible' | 'alibaba' | 'aliyun-bailian';
  protocol?: 'openai' | 'openai-responses' | 'anthropic' | 'gemini';
  authType?: 'bearer' | 'api-key' | 'google-api-key';
  displayName?: string;
  model?: string;
  firstPayloadTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  anthropic?: {
    version?: string | false;
    betas?: string[];
    queryParams?: Record<string, string>;
    cache?: {
      mode?: 'off' | 'auto';
      ttl?: '5m' | '1h';
    };
  };
  models?: CustomProviderModelSetting[];
  routing?: Partial<
    Record<
      'utility' | 'session_title' | 'summary' | 'compact' | 'subagent',
      string
    >
  >;
}

/**
 * The canonical schema for all settings.
 * The structure of this object defines the structure of the `Settings` type.
 * `as const` is crucial for TypeScript to infer the most specific types possible.
 */
export interface SettingsSchemaDefaults {
  DEFAULT_MAX_TURNS: number;
  DEFAULT_CHAT_MODEL_MAX_ATTEMPTS: number;
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD: number;
  DEFAULT_CONTEXT_FILENAME: string;
  SHELL_TOOL_NAME: string;
  getCliName: () => string;
  BRAND_IGNORE_FILE: string;
  DEFAULT_MIN_RETENTION: string;
  REMOVED_PROVIDER_MODEL_FIELDS: readonly string[];
  REMOVED_MODEL_GENERATION_FIELDS: readonly string[];
}

export function createSettingsSchema({
  DEFAULT_MAX_TURNS,
  DEFAULT_CHAT_MODEL_MAX_ATTEMPTS,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
  DEFAULT_CONTEXT_FILENAME,
  SHELL_TOOL_NAME,
  getCliName,
  BRAND_IGNORE_FILE,
  DEFAULT_MIN_RETENTION,
  REMOVED_PROVIDER_MODEL_FIELDS,
  REMOVED_MODEL_GENERATION_FIELDS,
}: SettingsSchemaDefaults) {
  return {
    judgment: {
      type: 'object',
      ref: 'JudgmentSettings',
      label: 'Judgment Backend',
      category: 'Model',
      requiresRestart: true,
      default: undefined as JudgmentSettings | undefined,
      description:
        'Typed judgments via a managed Bailian or TypeSafe service.',
      showInDialog: false,
    },

    ultracode: {
      type: 'boolean',
      label: 'UltraCode',
      category: 'Advanced',
      requiresRestart: false,
      default: false,
      description:
        'Use xhigh reasoning together with persistent Workflow orchestration guidance.',
      showInDialog: false,
    },

    workflowKeywordTriggerEnabled: {
      type: 'boolean',
      label: 'UltraCode Keyword Trigger',
      category: 'Advanced',
      requiresRestart: false,
      default: true,
      description:
        'Allow the local interactive prompt to opt one turn into Workflow orchestration with the ultracode keyword.',
      showInDialog: false,
    },

    // Maintained for compatibility/criticality
    mcpServers: {
      type: 'object',
      label: 'MCP Servers',
      category: 'Advanced',
      requiresRestart: true,
      default: {} as Record<string, MCPServerConfig>,
      description: 'Configuration for MCP servers.',
      showInDialog: false,
      mergeStrategy: MergeStrategy.SHALLOW_MERGE,
      additionalProperties: {
        type: 'object',
        ref: 'MCPServerConfig',
      },
    },

    autoMemoryEnabled: {
      type: 'boolean',
      label: 'Project Auto Memory',
      category: 'General',
      requiresRestart: true,
      default: undefined as boolean | undefined,
      runtimeDefaultSource: 'autoMemoryProject',
      description:
        'Automatically save and load reusable information for the current project. When unset, the QCS rollout default applies.',
      showInDialog: true,
    },

    autoMemoryUserScopeEnabled: {
      type: 'boolean',
      label: 'User Auto Memory',
      category: 'General',
      requiresRestart: true,
      default: undefined as boolean | undefined,
      runtimeDefaultSource: 'autoMemoryUser',
      description:
        'Automatically save and load reusable information shared across projects. When unset, the QCS rollout default applies.',
      showInDialog: true,
    },

    promptSuggestionEnabled: {
      type: 'boolean',
      label: 'Prompt Suggestions',
      category: 'UI',
      requiresRestart: false,
      default: true,
      description: 'Show suggested next actions after a completed turn.',
      showInDialog: true,
    },

    dream: {
      type: 'object',
      label: 'Dream',
      category: 'Advanced',
      requiresRestart: true,
      default: {},
      description:
        'Settings for auto-memory consolidation scheduling. Only applies when auto-memory is enabled.',
      showInDialog: false,
      properties: {
        enabled: {
          type: 'boolean',
          label: 'Dream',
          category: 'General',
          requiresRestart: true,
          default: undefined as boolean | undefined,
          runtimeDefaultSource: 'autoDream',
          description:
            'Enable background auto-memory consolidation. When unset, the QCS rollout default applies.',
          showInDialog: true,
        },
        minHours: {
          type: 'number',
          label: 'Minimum Dream Interval Hours',
          category: 'Advanced',
          requiresRestart: true,
          default: undefined as number | undefined,
          exclusiveMinimum: 0,
          description: 'Minimum hours between dream consolidation runs.',
          showInDialog: false,
        },
        minSessions: {
          type: 'number',
          label: 'Minimum Dream Sessions',
          category: 'Advanced',
          requiresRestart: true,
          default: undefined as number | undefined,
          exclusiveMinimum: 0,
          description:
            'Minimum number of other project sessions touched since the last consolidation before dream can run.',
          showInDialog: false,
        },
        scanThrottleMinutes: {
          type: 'number',
          label: 'Dream Scan Throttle Minutes',
          category: 'Advanced',
          requiresRestart: true,
          default: undefined as number | undefined,
          exclusiveMinimum: 0,
          description:
            'Minimum minutes between consecutive transcript directory scans in the same process.',
          showInDialog: false,
        },
      },
    },

    outputStyle: {
      type: 'string',
      label: 'Output Style',
      category: 'General',
      requiresRestart: true,
      default: undefined as string | undefined,
      description:
        'Active output style name. Applies on top of the mandatory identity guards — it can only extend the system prompt, not replace it.',
      showInDialog: false,
    },

    language: {
      type: 'string',
      label: 'Language',
      category: 'General',
      requiresRestart: true,
      default: undefined as string | undefined,
      description:
        'Preferred language for AI responses (e.g., "Chinese", "Japanese", "Spanish"). Leave empty for default (English).',
      showInDialog: false,
    },

    respondToBashCommands: {
      type: 'boolean',
      label: 'Respond to Shell Commands',
      category: 'General',
      requiresRestart: false,
      default: false,
      description:
        'Whether the model responds after an input-box `!` shell command finishes. ' +
        'Set to false to add the command and output to context without starting a model turn.',
      showInDialog: true,
    },

    spellcheck: {
      type: 'object',
      label: 'Spellcheck',
      category: 'UI',
      requiresRestart: false,
      default: {},
      description: oneLine`Underlines misspelled words in the prompt input as you
      type, using an aspell, hunspell, or ispell installation found on PATH.
      Read from your own settings only — the whole block from the
      highest-precedence of the --settings flag and user settings applies, and
      a block in a project's config directory (settings.json or
      settings.local.json) is ignored. The block is taken whole rather than merged field by field,
      so the effective block must carry every value it needs.`,
      showInDialog: false,
      properties: {
        enabled: {
          type: 'boolean',
          label: 'Enable Spellcheck',
          category: 'UI',
          requiresRestart: false,
          default: false,
          description:
            'Turn on spell checking of the prompt input. Off by default; nothing runs and no process starts until this is true.',
          showInDialog: false,
        },
        checker: {
          type: 'enum',
          label: 'Spellcheck Checker',
          category: 'UI',
          requiresRestart: false,
          default: 'auto' as SpellcheckCheckerSetting,
          description: oneLine`Which spell checker to run. "auto" (the default)
          takes the first of aspell, hunspell, or ispell found on PATH; naming
          one restricts the search to it. Spell checking stays off when no
          checker is found.`,
          showInDialog: false,
          options: [
            { value: 'auto', label: 'Auto' },
            { value: 'aspell', label: 'Aspell' },
            { value: 'hunspell', label: 'Hunspell' },
            { value: 'ispell', label: 'Ispell' },
          ],
        },
        language: {
          type: 'string',
          label: 'Spellcheck Dictionary',
          category: 'UI',
          requiresRestart: false,
          default: undefined as string | undefined,
          description: oneLine`Dictionary to use, passed to the checker as-is
          (aspell --lang, hunspell -d, ispell -d), e.g. "en_GB". Must be a plain
          dictionary name; anything else is ignored and the checker's own
          default dictionary applies.`,
          showInDialog: false,
        },
        color: {
          type: 'string',
          label: 'Spellcheck Color',
          category: 'UI',
          requiresRestart: false,
          default: undefined as string | undefined,
          description: oneLine`Color of misspelled words, which are also
          underlined: a color name such as "red", "#rrggbb", "rgb(r,g,b)",
          "ansi256(n)", or "ansi:<name>". Defaults to the theme's error color.`,
          showInDialog: false,
        },
      },
    },

    worktree: {
      type: 'object',
      label: 'Worktree',
      category: 'Advanced',
      requiresRestart: true,
      default: {},
      description: oneLine`
      Creation defaults shared by the --worktree startup flag, the EnterWorktree
      tool, and worktree-isolated subagents. Only applied when a worktree is
      actually requested; these settings never move an ordinary session. Read
      once at startup, so changes take effect in the next session.
    `,
      showInDialog: false,
      properties: {
        baseRef: {
          type: 'string',
          label: 'Worktree Base Ref',
          category: 'Advanced',
          requiresRestart: true,
          default: 'fresh' as string,
          description: oneLine`
          Commit a new worktree starts from. "fresh" uses the origin default
          branch so the task is decoupled from local state; "head" uses the
          HEAD of the checkout that requested it, inheriting unpushed commits
          but never uncommitted changes.
        `,
          showInDialog: false,
          options: [
            { value: 'fresh', label: 'Origin default branch (fresh)' },
            { value: 'head', label: 'Current checkout HEAD (head)' },
          ],
        },
        sparsePaths: {
          type: 'array',
          label: 'Worktree Sparse Paths',
          category: 'Advanced',
          requiresRestart: true,
          default: [] as string[],
          description: oneLine`
          Repository-relative directories to check out via sparse-checkout cone
          mode. An empty list checks out the whole tree. Absolute paths,
          "."/".." segments, and paths escaping the repository are rejected.
          Requires Git 2.27+; enabling this makes Git store sparse settings in
          per-worktree config, which upgrades the repository's config format.
        `,
          showInDialog: false,
        },
        symlinkDirectories: {
          type: 'array',
          label: 'Worktree Symlink Directories',
          category: 'Advanced',
          requiresRestart: true,
          default: [] as string[],
          description: oneLine`
          Repository-relative directories to symlink from the main checkout into
          a new worktree, e.g. "node_modules", to avoid duplicating large
          dependency trees. Entries that are not real directories inside the
          repository, or whose destination escapes the worktree, are skipped.
        `,
          showInDialog: false,
        },
      },
    },

    autoMode: {
      type: 'object',
      label: 'Auto Mode Classifier',
      category: 'General',
      requiresRestart: true,
      default: {},
      showInDialog: false,
      description: 'User-only auto permission classifier selection.',
      properties: {
        jevQuestionMode: {
          type: 'enum',
          label: 'Jev Questions',
          category: 'General',
          requiresRestart: true,
          default: 'single',
          showInDialog: false,
          description:
            'User-only experimental Jev question mode. Multi requires all three checks to pass at probability 0.6.',
          options: [
            { value: 'single', label: 'Single' },
            { value: 'multi', label: 'Multi' },
          ],
        },
        classifier: {
          type: 'enum',
          label: 'Classifier',
          category: 'General',
          requiresRestart: true,
          default: 'jev',
          showInDialog: false,
          description:
            'Use the existing LLM classifier or the user-configured judgment model.',
          options: [
            { value: 'llm', label: 'LLM' },
            { value: 'jev', label: 'Jev' },
          ],
        },
      },
    },
    general: {
      type: 'object',
      label: 'General',
      category: 'General',
      requiresRestart: false,
      default: {},
      description: 'General application settings.',
      showInDialog: false,
      properties: {
        preferredEditor: {
          type: 'string',
          label: 'Preferred Editor',
          category: 'General',
          requiresRestart: false,
          default: undefined as string | undefined,
          description: 'The preferred editor to open files in.',
          showInDialog: false,
        },
        dialogExpiry: {
          type: 'string',
          label: 'Dialog Expiry',
          category: 'General',
          requiresRestart: false,
          default: undefined as DialogExpirySetting | undefined,
          description:
            "How long a dialog raised on this session's behalf waits for an answer before resolving to its safe no-action default. Applies to the approval prompt for a held cross-session message, which is dropped and reported to the sender as expired. Defaults to 5m. 'never' removes the deadline, except for cross-session approvals, which keep the default so one unanswered prompt cannot suppress every later one. Read from your own settings only, never from a repository.",
          showInDialog: false,
        },
        vimMode: {
          type: 'boolean',
          label: 'Vim Mode',
          category: 'General',
          requiresRestart: false,
          default: false,
          description: 'Enable Vim keybindings',
          showInDialog: true,
        },
        defaultPermissionMode: {
          type: 'string',
          label: 'Default Permission Mode',
          category: 'General',
          requiresRestart: false,
          default: 'default',
          description: oneLine`
          The default permission mode for tool execution.
          Accepts: default, accept_edits, auto, bypass_permissions, dont_ask.
          Aliases: yolo = bypass_permissions, acceptEdits = accept_edits, dontAsk = dont_ask.
          Case-insensitive. The legacy value plan remains supported for configuration compatibility.
        `,
          showInDialog: true,
          normalizeOptionValue: (value: SettingsValue) =>
            typeof value === 'string'
              ? normalizePermissionModeValue(value)
              : undefined,
          options: [
            { value: 'default', label: 'Default' },
            { value: 'accept_edits', label: 'Accept Edits' },
            { value: 'auto', label: 'Auto' },
            { value: 'bypass_permissions', label: 'YOLO' },
            { value: 'dont_ask', label: "Don't Ask" },
          ],
        },
        autoMode: {
          type: 'object',
          label: 'Auto Mode',
          category: 'General',
          requiresRestart: false,
          default: {},
          description: oneLine`
            Auto mode classifier rules. Each list is appended after the
            classifier's built-in entries of the same kind and takes part in
            the decision as a rule; built-in entries cannot be removed.
          `,
          showInDialog: false,
          properties: {
            allow: {
              type: 'array',
              label: 'Allow Rules',
              category: 'General',
              requiresRestart: false,
              default: [] as string[],
              description: oneLine`
                Exceptions: natural-language descriptions of actions the
                classifier must allow even when a soft deny rule matches.
                Example: "MCP chrome-devtools tool calls for browser debugging".
              `,
              showInDialog: false,
            },
            soft_deny: {
              type: 'array',
              label: 'Soft Deny Rules',
              category: 'General',
              requiresRestart: false,
              default: [] as string[],
              description: oneLine`
                Natural-language descriptions of actions the classifier should
                block unless the user explicitly asked for them or an allow
                rule applies.
              `,
              showInDialog: false,
            },
            hard_deny: {
              type: 'array',
              label: 'Hard Deny Rules',
              category: 'General',
              requiresRestart: false,
              default: [] as string[],
              description: oneLine`
                Natural-language descriptions of actions the classifier always
                blocks, regardless of user instructions or allow rules.
              `,
              showInDialog: false,
            },
            environment: {
              type: 'array',
              label: 'Environment',
              category: 'General',
              requiresRestart: false,
              default: [] as string[],
              description: oneLine`
                Facts about your setup, such as trusted domains, internal
                registries or source-control orgs. An entry about the same item
                as a built-in default takes precedence. Example: "Trusted
                internal domains: *.example-corp.com".
              `,
              showInDialog: false,
            },
          },
        },
        enableAutoUpdate: {
          type: 'boolean',
          label: 'Enable Auto Update',
          category: 'General',
          requiresRestart: false,
          default: true,
          description: 'Enable automatic updates.',
          showInDialog: true,
        },
        enableAutoUpdateNotification: {
          type: 'boolean',
          label: 'Enable Auto Update Notification',
          category: 'General',
          requiresRestart: false,
          default: true,
          description: 'Enable update notification prompts.',
          showInDialog: false,
        },
        enableNotifications: {
          type: 'boolean',
          label: 'Enable Notifications',
          category: 'General',
          requiresRestart: false,
          default: false,
          description:
            'Enable run-event notifications for action-required prompts and session completion.',
          showInDialog: false,
        },
        fileCheckpointing: {
          type: 'object',
          label: 'File Checkpointing',
          category: 'General',
          requiresRestart: true,
          default: {},
          description: 'File checkpointing settings for code rewind.',
          showInDialog: false,
          properties: {
            enabled: {
              type: 'boolean',
              label: 'Enable File Checkpointing',
              category: 'General',
              requiresRestart: true,
              default: true,
              description: 'Enable file checkpointing for code rewind',
              showInDialog: false,
            },
          },
        },
        plan: {
          type: 'object',
          label: 'Plan',
          category: 'General',
          requiresRestart: true,
          default: {},
          description: 'Planning features configuration.',
          showInDialog: false,
          properties: {
            enabled: {
              type: 'boolean',
              label: 'Enable Plan Mode',
              category: 'General',
              requiresRestart: true,
              default: true,
              description:
                'Enable Plan Mode for read-only safety during planning. When disabled, /plan command and --permission-mode plan are both rejected.',
              showInDialog: true,
            },
            directory: {
              type: 'string',
              label: 'Plan Directory',
              category: 'General',
              requiresRestart: true,
              default: undefined as string | undefined,
              description:
                'The directory where planning artifacts are stored. If not specified, defaults to the system temporary directory. A custom directory requires a policy to allow write access in Plan Mode.',
              showInDialog: false,
            },
          },
        },
        retryFetchErrors: {
          type: 'boolean',
          label: 'Retry Fetch Errors',
          category: 'General',
          requiresRestart: false,
          default: true,
          description:
            'Retry on "exception TypeError: fetch failed sending request" errors.',
          showInDialog: false,
        },
        maxAttempts: {
          type: 'number',
          label: 'Max Chat Model Attempts',
          category: 'General',
          requiresRestart: false,
          default: DEFAULT_CHAT_MODEL_MAX_ATTEMPTS,
          description: `Maximum number of attempts for requests to the main chat model. The default allows ${DEFAULT_CHAT_MODEL_MAX_ATTEMPTS - 1} retries; use 1 to disable retries.`,
          showInDialog: false,
        },
        debugKeystrokeLogging: {
          type: 'boolean',
          label: 'Debug Keystroke Logging',
          category: 'General',
          requiresRestart: false,
          default: false,
          description: 'Enable debug logging of keystrokes to the console.',
          showInDialog: false,
        },
        sessionRetention: {
          type: 'object',
          label: 'Session Retention',
          category: 'General',
          requiresRestart: false,
          default: undefined as SessionRetentionSettings | undefined,
          showInDialog: false,
          properties: {
            enabled: {
              type: 'boolean',
              label: 'Enable Session Cleanup',
              category: 'General',
              requiresRestart: false,
              default: false as boolean,
              description:
                'Enable automatic cleanup of sessions and associated tool outputs (disabled by default). Diagnostic logs are cleaned independently after 30 days.',
              showInDialog: false,
            },
            maxAge: {
              type: 'string',
              label: 'Keep chat history',
              category: 'General',
              requiresRestart: false,
              default: '30d' as string,
              description:
                'Automatically delete chats older than this time period (e.g., "30d", "7d", "24h", "1w")',
              showInDialog: false,
            },
            maxCount: {
              type: 'number',
              label: 'Max Count-Limited Cleanup Targets',
              category: 'General',
              requiresRestart: false,
              default: undefined as number | undefined,
              description:
                'Maximum number of count-limited cleanup targets to keep. Transcript JSONL files ignore this setting and are deleted only by maxAge.',
              showInDialog: false,
            },
            minRetention: {
              type: 'string',
              label: 'Min Retention Period',
              category: 'General',
              requiresRestart: false,
              default: DEFAULT_MIN_RETENTION,
              description: `Minimum retention period (safety limit, defaults to "${DEFAULT_MIN_RETENTION}")`,
              showInDialog: false,
            },
          },
          description: 'Settings for automatic session cleanup.',
        },
      },
    },
    output: {
      type: 'object',
      label: 'Output',
      category: 'General',
      requiresRestart: false,
      default: {},
      description: 'Settings for the CLI output.',
      showInDialog: false,
      properties: {
        format: {
          type: 'enum',
          label: 'Output Format',
          category: 'General',
          requiresRestart: false,
          default: 'text',
          description: 'The format of the CLI output. Can be `text` or `json`.',
          showInDialog: false,
          options: [
            { value: 'text', label: 'Text' },
            { value: 'json', label: 'JSON' },
          ],
        },
      },
    },

    ui: {
      type: 'object',
      label: 'UI',
      category: 'UI',
      requiresRestart: false,
      default: {},
      description: 'User interface settings.',
      showInDialog: false,
      properties: {
        language: {
          type: 'enum',
          label: 'Display Language',
          category: 'UI',
          requiresRestart: false,
          default: 'en',
          description: 'Language used by the interactive interface.',
          showInDialog: true,
          options: [
            { value: 'auto', label: 'Auto' },
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en', label: 'English' },
          ],
        },
        theme: {
          type: 'string',
          label: 'Theme',
          category: 'UI',
          requiresRestart: false,
          default: 'auto' as string | undefined,
          description:
            'The color theme for the UI, or `auto` to follow the terminal background color. See the CLI themes guide for available options.',
          showInDialog: false,
        },
        autoThemeSwitching: {
          type: 'boolean',
          label: 'Auto Theme Switching',
          category: 'UI',
          requiresRestart: false,
          default: true,
          description:
            'Re-check the terminal background color while running and update the theme when `ui.theme` is `auto`. Disable to resolve the theme once at startup and then hold it.',
          showInDialog: false,
        },
        autoThemePair: {
          type: 'object',
          label: 'Auto Theme Pair',
          category: 'UI',
          requiresRestart: false,
          // Structurally identical to AutoThemePair in ui/themes/theme-manager.ts;
          // spelled out here so the schema does not pull in the theme registry.
          default: {} as { dark?: string; light?: string },
          description:
            'Themes to use for dark and light terminal backgrounds when `ui.theme` is `auto`. Defaults to `Default` and `Default Light`.',
          showInDialog: false,
          ref: 'AutoThemePair',
        },
        terminalBackgroundPollingInterval: {
          type: 'number',
          label: 'Terminal Background Polling Interval',
          category: 'UI',
          requiresRestart: false,
          default: 60,
          description:
            'Interval in seconds to poll the terminal background color.',
          showInDialog: false,
        },
        customThemes: {
          type: 'object',
          label: 'Custom Themes',
          category: 'UI',
          requiresRestart: false,
          default: {} as Record<string, CustomTheme>,
          description: 'Custom theme definitions.',
          showInDialog: false,
          additionalProperties: {
            type: 'object',
            ref: 'CustomTheme',
          },
        },
        hideWindowTitle: {
          type: 'boolean',
          label: 'Hide Window Title',
          category: 'UI',
          requiresRestart: true,
          default: false,
          description: 'Hide the window title bar',
          showInDialog: false,
        },
        inlineThinkingMode: {
          type: 'enum',
          label: 'Inline Thinking',
          category: 'UI',
          requiresRestart: false,
          default: 'full',
          description: 'Display model thinking inline: off or full.',
          showInDialog: true,
          options: [
            { value: 'off', label: 'Off' },
            { value: 'full', label: 'Full' },
          ],
        },
        maxTurns: {
          type: 'enum',
          label: 'Max Turns Per Run',
          category: 'UI',
          requiresRestart: false,
          default: DEFAULT_MAX_TURNS,
          description:
            'Maximum model/tool-loop turns for one submitted prompt in the interactive TUI. Does not affect -p/--print mode.',
          showInDialog: true,
          options: [
            { value: 1000, label: '1,000' },
            { value: 2000, label: '2,000' },
            { value: 3000, label: '3,000' },
            { value: 'unlimited', label: 'Unlimited' },
          ],
        },
        dynamicWindowTitle: {
          type: 'boolean',
          label: 'Dynamic Window Title',
          category: 'UI',
          requiresRestart: false,
          default: true,
          description:
            'Update the terminal window title with current status icons (Ready: ◇, Action Required: ▲, Working: ✦)',
          showInDialog: false,
        },
        showHomeDirectoryWarning: {
          type: 'boolean',
          label: 'Show Home Directory Warning',
          category: 'UI',
          requiresRestart: true,
          default: true,
          get description() {
            return `Show a warning when running ${getCliName()} in the home directory.`;
          },
          showInDialog: false,
        },
        showCompatibilityWarnings: {
          type: 'boolean',
          label: 'Show Compatibility Warnings',
          category: 'UI',
          requiresRestart: true,
          default: true,
          description:
            'Show warnings about terminal or OS compatibility issues.',
          showInDialog: false,
        },
        hideTips: {
          type: 'boolean',
          label: 'Hide Tips',
          category: 'UI',
          requiresRestart: false,
          default: false,
          description: 'Hide helpful tips in the UI',
          showInDialog: false,
        },
        escapePastedAtSymbols: {
          type: 'boolean',
          label: 'Escape Pasted @ Symbols',
          category: 'UI',
          requiresRestart: false,
          default: false,
          description:
            'When enabled, @ symbols in pasted text are escaped to prevent unintended @path expansion.',
          showInDialog: true,
        },
        showShortcutsHint: {
          type: 'boolean',
          label: 'Show Shortcuts Hint',
          category: 'UI',
          requiresRestart: false,
          default: true,
          description: 'Show the "? for shortcuts" hint above the input.',
          showInDialog: true,
        },
        compactToolOutput: {
          type: 'boolean',
          label: 'Compact Tool Output',
          category: 'UI',
          requiresRestart: false,
          default: true,
          description:
            'Display tool outputs (like directory listings and file reads) in a compact, structured format.',
          showInDialog: false,
        },
        copyFullResponse: {
          type: 'boolean',
          label: 'Always Copy Full Response',
          category: 'UI',
          requiresRestart: false,
          default: false,
          description:
            'Skip the /copy picker and always copy the full assistant response.',
          showInDialog: true,
        },
        hideBanner: {
          type: 'boolean',
          label: 'Hide Banner',
          category: 'UI',
          requiresRestart: false,
          default: false,
          description: 'Hide the application banner',
          showInDialog: false,
        },
        hideContextSummary: {
          type: 'boolean',
          label: 'Hide Context Summary',
          category: 'UI',
          requiresRestart: false,
          default: false,
          description: `Hide the context summary (${DEFAULT_CONTEXT_FILENAME}, MCP servers) above the input.`,
          showInDialog: false,
        },
        footer: {
          type: 'object',
          label: 'Footer',
          category: 'UI',
          requiresRestart: false,
          default: {},
          description:
            'Deprecated and ignored. Retained so existing settings files keep validating; the legacy footer is retired.',
          showInDialog: false,
          deprecated: true,
          properties: {
            items: {
              type: 'array',
              label: 'Footer Items',
              category: 'UI',
              requiresRestart: false,
              default: undefined as string[] | undefined,
              description:
                'Deprecated and ignored. Retained so existing settings files keep validating; the legacy footer is retired.',
              showInDialog: false,
              deprecated: true,
              items: { type: 'string' },
            },
            showLabels: {
              type: 'boolean',
              label: 'Show Footer Labels',
              category: 'UI',
              requiresRestart: false,
              default: true,
              description:
                'Deprecated and ignored. Retained so existing settings files keep validating; the legacy footer is retired.',
              showInDialog: false,
              deprecated: true,
            },
            hideCWD: {
              type: 'boolean',
              label: 'Hide CWD',
              category: 'UI',
              requiresRestart: false,
              default: false,
              description:
                'Deprecated and ignored. Retained so existing settings files keep validating; the legacy footer is retired.',
              showInDialog: false,
              deprecated: true,
            },
            hideModelInfo: {
              type: 'boolean',
              label: 'Hide Model Info',
              category: 'UI',
              requiresRestart: false,
              default: false,
              description:
                'Deprecated and ignored. Retained so existing settings files keep validating; the legacy footer is retired.',
              showInDialog: false,
              deprecated: true,
            },
            hideContextPercentage: {
              type: 'boolean',
              label: 'Hide Context Window Percentage',
              category: 'UI',
              requiresRestart: false,
              default: true,
              description:
                'Deprecated and ignored. Retained so existing settings files keep validating; the legacy footer is retired.',
              showInDialog: false,
              deprecated: true,
            },
          },
        },
        rotatingInfoLine: {
          type: 'object',
          label: 'Rotating Info Line',
          category: 'UI',
          requiresRestart: false,
          default: {},
          description:
            'A rotating single-line info display above the input box (context summary, tips).',
          showInDialog: false,
          properties: {
            enabled: {
              type: 'boolean',
              label: 'Enable Rotating Info Line',
              category: 'UI',
              requiresRestart: false,
              default: true,
              description:
                'Cycle through info groups above the input box on an interval.',
              showInDialog: false,
            },
            intervalMs: {
              type: 'number',
              label: 'Rotation Interval (ms)',
              category: 'UI',
              requiresRestart: false,
              default: 4000,
              description:
                'Milliseconds between rotations of the info line above the input box.',
              showInDialog: false,
            },
            animation: {
              type: 'string',
              label: 'Rotation Animation',
              category: 'UI',
              requiresRestart: false,
              default: 'fade',
              description:
                "Transition used when the rotating line changes: 'fade' (cross-fade) or 'none' (instant swap).",
              showInDialog: false,
            },
          },
        },
        hideFooter: {
          type: 'boolean',
          label: 'Hide Footer',
          category: 'UI',
          requiresRestart: false,
          default: false,
          description:
            'Deprecated and ignored. Retained so existing settings files keep validating; the legacy footer is retired.',
          showInDialog: false,
          deprecated: true,
        },
        collapseDrawerDuringApproval: {
          type: 'boolean',
          label: 'Collapse Drawer During Approval',
          category: 'UI',
          requiresRestart: false,
          default: true,
          description:
            'Whether to collapse the UI drawer when a tool is awaiting confirmation.',
          showInDialog: false,
        },
        showMemoryUsage: {
          type: 'boolean',
          label: 'Show Memory Usage',
          category: 'UI',
          requiresRestart: false,
          default: false,
          description:
            'Deprecated and ignored. Retained so existing settings files keep validating; the legacy footer is retired.',
          showInDialog: false,
          deprecated: true,
        },
        showLineNumbers: {
          type: 'boolean',
          label: 'Show Line Numbers',
          category: 'UI',
          requiresRestart: false,
          default: true,
          description: 'Show line numbers in the chat.',
          showInDialog: false,
        },
        renderMermaid: {
          type: 'boolean',
          label: 'Render Mermaid Diagrams',
          category: 'UI',
          requiresRestart: false,
          default: true,
          description:
            'Render closed ```mermaid code blocks as text diagrams in the chat.',
          showInDialog: false,
        },
        showCitations: {
          type: 'boolean',
          label: 'Show Citations',
          category: 'UI',
          requiresRestart: false,
          default: false,
          description: 'Show citations for generated text in the chat.',
          showInDialog: false,
        },
        showModelInfoInChat: {
          type: 'boolean',
          label: 'Show Model Info In Chat',
          category: 'UI',
          requiresRestart: false,
          default: false,
          description: 'Show the model name in the chat for each model turn.',
          showInDialog: false,
        },
        showUserIdentity: {
          type: 'boolean',
          label: 'Show User Identity',
          category: 'UI',
          requiresRestart: false,
          default: true,
          description:
            "Show the signed-in user's identity (e.g. email) in the UI.",
          showInDialog: false,
        },
        useAlternateBuffer: {
          type: 'boolean',
          label: 'Use Alternate Screen Buffer',
          category: 'UI',
          requiresRestart: true,
          default: false,
          description:
            'Use an alternate screen buffer for the UI, preserving shell history.',
          showInDialog: false,
        },
        renderProcess: {
          type: 'boolean',
          label: 'Render Process',
          category: 'UI',
          requiresRestart: true,
          default: true,
          description: 'Enable Ink render process for the UI.',
          showInDialog: false,
        },
        terminalBuffer: {
          type: 'boolean',
          label: 'Terminal Buffer',
          category: 'UI',
          requiresRestart: true,
          default: true,
          description:
            'Use the new terminal buffer architecture for rendering.',
          showInDialog: false,
        },
        useBackgroundColor: {
          type: 'boolean',
          label: 'Use Background Color',
          category: 'UI',
          requiresRestart: false,
          default: true,
          description: 'Whether to use background colors in the UI.',
          showInDialog: false,
        },
        incrementalRendering: {
          type: 'boolean',
          label: 'Incremental Rendering',
          category: 'UI',
          requiresRestart: true,
          default: true,
          description:
            'Enable incremental rendering for the UI. This option will reduce flickering but may cause rendering artifacts. Only supported when useAlternateBuffer is enabled.',
          showInDialog: false,
        },
        showSpinner: {
          type: 'boolean',
          label: 'Show Spinner',
          category: 'UI',
          requiresRestart: false,
          default: true,
          description: 'Show the spinner during operations.',
          showInDialog: false,
        },
        loadingPhrases: {
          type: 'enum',
          label: 'Loading Phrases',
          category: 'UI',
          requiresRestart: false,
          default: 'off',
          description:
            'What to show while the model is working: tips, witty comments, all, or off.',
          showInDialog: false,
          options: [
            { value: 'tips', label: 'Tips' },
            { value: 'witty', label: 'Witty' },
            { value: 'all', label: 'All' },
            { value: 'off', label: 'Off' },
          ],
        },
        errorVerbosity: {
          type: 'enum',
          label: 'Error Verbosity',
          category: 'UI',
          requiresRestart: false,
          default: 'low',
          description:
            'Controls whether recoverable errors are hidden (low) or fully shown (full).',
          showInDialog: false,
          options: [
            { value: 'low', label: 'Low' },
            { value: 'full', label: 'Full' },
          ],
        },
        customWittyPhrases: {
          type: 'array',
          label: 'Custom Witty Phrases',
          category: 'UI',
          requiresRestart: false,
          default: [] as string[],
          description: oneLine`
          Custom witty phrases to display during loading.
          When provided, the CLI cycles through these instead of the defaults.
        `,
          showInDialog: false,
          items: { type: 'string' },
        },
        accessibility: {
          type: 'object',
          label: 'Accessibility',
          category: 'UI',
          requiresRestart: true,
          default: {},
          description: 'Accessibility settings.',
          showInDialog: false,
          properties: {
            enableLoadingPhrases: {
              type: 'boolean',
              label: 'Enable Loading Phrases',
              category: 'UI',
              requiresRestart: true,
              default: true,
              description:
                '@deprecated Use ui.loadingPhrases instead. Enable loading phrases during operations.',
              showInDialog: false,
            },
            screenReader: {
              type: 'boolean',
              label: 'Screen Reader Mode',
              category: 'UI',
              requiresRestart: true,
              default: false,
              description:
                'Render output in plain-text to be more screen reader accessible',
              showInDialog: false,
            },
          },
        },
      },
    },

    privacy: {
      type: 'object',
      label: 'Privacy',
      category: 'Privacy',
      requiresRestart: false,
      default: {},
      description: 'Privacy-related settings.',
      showInDialog: false,
      properties: {
        usageStatisticsEnabled: {
          type: 'boolean',
          label: 'Privacy Settings',
          category: 'Privacy',
          requiresRestart: false,
          default: true,
          description:
            'Enable sharing usage data to help improve the product. When disabled, enters Privacy Mode.',
          showInDialog: false,
        },
      },
    },

    model: {
      type: 'object',
      label: 'Model',
      category: 'Model',
      requiresRestart: false,
      default: {},
      description: 'Settings related to the generative model.',
      showInDialog: false,
      properties: {
        name: {
          type: 'string',
          label: 'Model',
          category: 'Model',
          requiresRestart: false,
          default: undefined as string | undefined,
          description: 'The model to use for conversations.',
          showInDialog: false,
        },
        reasoningEffort: {
          type: 'enum',
          label: 'Reasoning Effort',
          category: 'Model',
          requiresRestart: false,
          default: undefined as string | undefined,
          description:
            'Deprecated: migrated into model.preferences[modelId].reasoning.effort. Explicit reasoning effort for models that support effort levels.',
          showInDialog: false,
          options: [
            { value: 'disabled', label: 'Disabled' },
            { value: 'off', label: 'Off' },
            { value: 'none', label: 'None' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
          ],
        },
        contextWindow: {
          type: 'number',
          label: 'Context Window',
          category: 'Model',
          requiresRestart: false,
          default: undefined as number | undefined,
          description:
            'Deprecated: migrated into model.preferences[modelId].contextWindow. Explicit context window in tokens for models that support context window options.',
          showInDialog: false,
        },
        functionSwitchSelections: {
          type: 'object',
          label: 'Model Function Switches',
          category: 'Model',
          requiresRestart: false,
          default: undefined as Record<string, string> | undefined,
          description:
            'Deprecated: model function switches were removed. The value is ignored.',
          showInDialog: false,
          deprecated: true,
          ignoreInDocs: true,
        },
        preferences: {
          type: 'object',
          label: 'Per-Model Preferences',
          category: 'Model',
          requiresRestart: false,
          default: undefined as
            | Record<string, ModelPreferenceEntry>
            | undefined,
          description:
            'Per-model persisted user preferences with flattened generation params, keyed by model id.',
          showInDialog: false,
          additionalProperties: {
            type: 'object',
            ref: 'ModelPreferenceEntry',
          },
        },
        summarizeToolOutput: {
          type: 'object',
          label: 'Summarize Tool Output',
          category: 'Model',
          requiresRestart: false,
          default: undefined as
            | Record<string, { tokenBudget?: number }>
            | undefined,
          description: oneLine`
          Enables or disables summarization of tool output.
          Configure per-tool token budgets (for example {"${SHELL_TOOL_NAME}": {"tokenBudget": 2000}}).
          Currently only the ${SHELL_TOOL_NAME} tool supports summarization.
        `,
          showInDialog: false,
          additionalProperties: {
            type: 'object',
            description:
              'Per-tool summarization settings with an optional tokenBudget.',
            ref: 'SummarizeToolOutputSettings',
          },
        },
      },
    },

    modelConfigs: {
      type: 'object',
      label: 'Model Configs',
      category: 'Model',
      requiresRestart: false,
      default: {},
      description: 'Model configurations.',
      showInDialog: false,
      properties: {
        aliases: {
          type: 'object',
          label: 'Model Config Aliases',
          category: 'Model',
          requiresRestart: false,
          default: {},
          description:
            'Named presets for model configs. Can be used in place of a model name and can inherit from other aliases using an `extends` property.',
          showInDialog: false,
        },
        customAliases: {
          type: 'object',
          label: 'Custom Model Config Aliases',
          category: 'Model',
          requiresRestart: false,
          default: {},
          description:
            'Custom named presets for model configs. These are merged with (and override) the built-in aliases.',
          showInDialog: false,
        },
        customOverrides: {
          type: 'array',
          label: 'Custom Model Config Overrides',
          category: 'Model',
          requiresRestart: false,
          default: [],
          description:
            'Custom model config overrides. These are merged with (and added to) the built-in overrides.',
          showInDialog: false,
        },
        overrides: {
          type: 'array',
          label: 'Model Config Overrides',
          category: 'Model',
          requiresRestart: false,
          default: [],
          description:
            'Apply specific configuration overrides based on matches, with a primary key of model (or alias). The most specific match will be used.',
          showInDialog: false,
        },
        customModels: {
          type: 'array',
          label: 'Custom BYOK Models',
          category: 'Model',
          requiresRestart: true,
          default: [],
          description:
            'Bring-your-own-key (BYOK) models declared locally. Each item requires `provider`, `apiKey` and `model`; optional `type` (matching the provider model type key), `baseURL`, `key` (used with `-m`, defaults to "<provider>/<model>"), `displayName`, `format` (API format/style metadata, allowed values: "openai" or "anthropic"), `isReasoning`, `isVl`, `maxInputTokens`. These are merged into the model catalog and selectable via `-m <key>`.',
          showInDialog: false,
        },
      },
    },

    providers: {
      type: 'object',
      label: 'Custom Model Providers',
      category: 'Model',
      requiresRestart: true,
      default: {} as Record<string, CustomProviderSetting>,
      description:
        'Local custom provider configurations loaded for supported runtime modes.',
      showInDialog: false,
      mergeStrategy: MergeStrategy.SHALLOW_MERGE,
      additionalProperties: {
        type: 'object',
        mergeStrategy: MergeStrategy.SHALLOW_MERGE,
        forbiddenProperties: REMOVED_PROVIDER_MODEL_FIELDS,
        properties: {
          type: {
            type: 'enum',
            label: 'Provider Type',
            category: 'Model',
            requiresRestart: true,
            default: undefined as CustomProviderSetting['type'],
            description:
              'Provider behavior and built-in defaults. Omit for OpenAI-compatible providers.',
            showInDialog: false,
            options: [
              {
                value: 'openai-compatible',
                label: 'OpenAI Compatible',
              },
              {
                value: 'alibaba',
                label: 'Alibaba Cloud Model Studio',
              },
              {
                value: 'aliyun-bailian',
                label: 'Alibaba Cloud Model Studio (Compatibility Alias)',
              },
            ],
          },
          protocol: {
            type: 'enum',
            label: 'Provider Protocol',
            category: 'Model',
            requiresRestart: true,
            default: 'openai',
            description: 'Wire protocol used by the provider.',
            showInDialog: false,
            options: [
              { value: 'openai', label: 'OpenAI Compatible' },
              { value: 'openai-responses', label: 'OpenAI Responses' },
              { value: 'anthropic', label: 'Anthropic Compatible' },
              { value: 'gemini', label: 'Google Gemini' },
            ],
          },
          authType: {
            type: 'enum',
            label: 'Authentication Type',
            category: 'Model',
            requiresRestart: true,
            default: undefined as CustomProviderSetting['authType'],
            description:
              'Authentication header style. Defaults to bearer when omitted.',
            showInDialog: false,
            options: [
              { value: 'bearer', label: 'Bearer Token' },
              { value: 'api-key', label: 'API Key' },
              { value: 'google-api-key', label: 'Google API Key' },
            ],
          },
          anthropic: {
            type: 'object',
            label: 'Anthropic Protocol Options',
            category: 'Model',
            requiresRestart: true,
            default: undefined as CustomProviderSetting['anthropic'],
            description:
              'Optional Messages protocol headers, URL parameters, and prompt caching policy.',
            showInDialog: false,
            properties: {
              version: {
                type: 'string',
                ref: 'StringOrFalse',
                label: 'Anthropic Version',
                category: 'Model',
                requiresRestart: true,
                default: '2023-06-01',
                description:
                  'Value of anthropic-version. Set false to omit the header.',
                showInDialog: false,
              },
              betas: {
                type: 'array',
                label: 'Anthropic Betas',
                category: 'Model',
                requiresRestart: true,
                default: [] as string[],
                description:
                  'Explicit beta identifiers sent in the anthropic-beta header.',
                showInDialog: false,
                items: { type: 'string' },
              },
              queryParams: {
                type: 'object',
                label: 'Anthropic Query Parameters',
                category: 'Model',
                requiresRestart: true,
                default: {} as Record<string, string>,
                description:
                  'Explicit query parameters appended to the Messages endpoint.',
                showInDialog: false,
                additionalProperties: { type: 'string' },
              },
              cache: {
                type: 'object',
                label: 'Anthropic Prompt Cache',
                category: 'Model',
                requiresRestart: true,
                default: { mode: 'auto', ttl: '5m' },
                description:
                  'Prompt-cache breakpoint policy for the Messages request.',
                showInDialog: false,
                properties: {
                  mode: {
                    type: 'enum',
                    label: 'Cache Mode',
                    category: 'Model',
                    requiresRestart: true,
                    default: 'auto',
                    options: [
                      { value: 'off', label: 'Off' },
                      { value: 'auto', label: 'Automatic' },
                    ],
                    showInDialog: false,
                  },
                  ttl: {
                    type: 'enum',
                    label: 'Cache TTL',
                    category: 'Model',
                    requiresRestart: true,
                    default: '5m',
                    options: [
                      { value: '5m', label: '5 minutes' },
                      { value: '1h', label: '1 hour' },
                    ],
                    showInDialog: false,
                  },
                },
              },
            },
          },
          baseUrl: {
            type: 'string',
            label: 'Base URL',
            category: 'Model',
            requiresRestart: true,
            default: '',
            description: 'Provider base URL.',
            showInDialog: false,
          },
          apiKey: {
            type: 'string',
            label: 'API Key',
            category: 'Model',
            requiresRestart: true,
            default: '',
            description:
              'Provider API key. Environment references are recommended.',
            showInDialog: false,
          },
          displayName: {
            type: 'string',
            label: 'Display Name',
            category: 'Model',
            requiresRestart: true,
            default: undefined as string | undefined,
            description: 'Provider name shown in model selection UI.',
            showInDialog: false,
          },
          model: {
            type: 'string',
            label: 'Default Model',
            category: 'Model',
            requiresRestart: true,
            default: undefined as string | undefined,
            description:
              'Default provider-native model id. All request purposes use the selected model unless routing explicitly overrides a purpose.',
            showInDialog: false,
          },
          firstPayloadTimeoutMs: {
            type: 'number',
            label: 'First Payload Timeout',
            category: 'Model',
            requiresRestart: true,
            default: undefined as number | undefined,
            description:
              'Maximum time in milliseconds to wait for the first effective model payload.',
            showInDialog: false,
            exclusiveMinimum: 0,
          },
          streamIdleTimeoutMs: {
            type: 'number',
            label: 'Stream Idle Timeout',
            category: 'Model',
            requiresRestart: true,
            default: undefined as number | undefined,
            description:
              'Maximum gap between response chunks in milliseconds. Zero or omission disables the limit.',
            showInDialog: false,
            minimum: 0,
          },
          routing: {
            type: 'object',
            label: 'Purpose Routing',
            category: 'Model',
            requiresRestart: true,
            default: {} as CustomProviderSetting['routing'],
            description:
              'Optional explicit model overrides keyed by semantic request purpose.',
            showInDialog: false,
            properties: Object.fromEntries(
              [
                'utility',
                'session_title',
                'summary',
                'compact',
                'subagent',
              ].map((purpose) => [
                purpose,
                {
                  type: 'string',
                  label: `${purpose} Model`,
                  category: 'Model',
                  requiresRestart: true,
                  default: undefined as string | undefined,
                  showInDialog: false,
                },
              ]),
            ) as SettingsSchema,
          },
          models: {
            type: 'array',
            label: 'Models',
            category: 'Model',
            requiresRestart: true,
            default: [] as CustomProviderModelSetting[],
            description:
              'Optional capability and limit metadata for provider models. Referenced models that are omitted use conservative defaults.',
            showInDialog: false,
            items: {
              type: 'object',
              forbiddenProperties: REMOVED_MODEL_GENERATION_FIELDS,
              properties: {
                model: {
                  type: 'string',
                  label: 'Model ID',
                  category: 'Model',
                  requiresRestart: true,
                  default: '',
                  showInDialog: false,
                },
                displayName: {
                  type: 'string',
                  label: 'Display Name',
                  category: 'Model',
                  requiresRestart: true,
                  default: undefined as string | undefined,
                  showInDialog: false,
                },
                contextWindow: {
                  type: 'number',
                  label: 'Context Window',
                  category: 'Model',
                  requiresRestart: true,
                  default: undefined as number | undefined,
                  showInDialog: false,
                  exclusiveMinimum: 0,
                },
                maxOutputTokens: {
                  type: 'number',
                  label: 'Maximum Output Tokens',
                  category: 'Model',
                  requiresRestart: true,
                  default: undefined as number | undefined,
                  showInDialog: false,
                  exclusiveMinimum: 0,
                },
                maxTokensField: {
                  type: 'enum',
                  label: 'Maximum Token Field',
                  category: 'Model',
                  requiresRestart: true,
                  default: 'max_tokens',
                  options: [
                    { value: 'max_tokens', label: 'max_tokens' },
                    {
                      value: 'max_completion_tokens',
                      label: 'max_completion_tokens',
                    },
                  ],
                  showInDialog: false,
                },
                capabilities: {
                  type: 'object',
                  label: 'Capabilities',
                  category: 'Model',
                  requiresRestart: true,
                  default: {} as CustomProviderModelSetting['capabilities'],
                  showInDialog: false,
                  properties: {
                    tools: {
                      type: 'boolean',
                      label: 'Tools',
                      category: 'Model',
                      requiresRestart: true,
                      default: true,
                      showInDialog: false,
                    },
                    vision: {
                      type: 'boolean',
                      label: 'Vision',
                      category: 'Model',
                      requiresRestart: true,
                      default: false,
                      showInDialog: false,
                    },
                    cacheControl: {
                      type: 'boolean',
                      label: 'Cache Control',
                      category: 'Model',
                      requiresRestart: true,
                      default: false,
                      description:
                        'Whether the model accepts Anthropic-style content-block cache_control markers.',
                      showInDialog: false,
                    },
                    thinking: {
                      type: 'object',
                      ref: 'CustomProviderThinkingCapability',
                      label: 'Thinking',
                      category: 'Model',
                      requiresRestart: true,
                      default: undefined,
                      showInDialog: false,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    agent: {
      type: 'string' as const,
      label: 'Default Agent',
      category: 'Advanced' as const,
      requiresRestart: true,
      default: undefined as string | undefined,
      description:
        "Name of an agent to use for the main thread. When set, the main session uses this agent's system prompt, tools, and model configuration.",
      showInDialog: false,
    },

    agents: {
      type: 'object',
      label: 'Agents',
      category: 'Advanced',
      requiresRestart: true,
      default: {},
      description: 'Settings for subagents.',
      showInDialog: false,
      properties: {
        overrides: {
          type: 'object',
          label: 'Agent Overrides',
          category: 'Advanced',
          requiresRestart: true,
          default: {} as Record<string, AgentOverride>,
          description:
            'Override settings for specific agents, e.g. to disable the agent, set a custom model config, or run config.',
          showInDialog: false,
          additionalProperties: {
            type: 'object',
            ref: 'AgentOverride',
          },
        },
      },
    },

    context: {
      type: 'object',
      label: 'Context',
      category: 'Context',
      requiresRestart: false,
      default: {},
      description: 'Settings for managing context provided to the model.',
      showInDialog: false,
      properties: {
        fileName: {
          type: 'string',
          label: 'Context File Name',
          category: 'Context',
          requiresRestart: false,
          default: DEFAULT_CONTEXT_FILENAME,
          ref: 'StringOrStringArray',
          description:
            'The name of the context file or files to load into memory. Accepts either a single string or an array of strings.',
          showInDialog: false,
        },
        importFormat: {
          type: 'string',
          label: 'Memory Import Format',
          category: 'Context',
          requiresRestart: false,
          default: undefined as MemoryImportFormat | undefined,
          description: 'The format to use when importing memory.',
          showInDialog: false,
        },
        discoveryMaxDirs: {
          type: 'number',
          label: 'Memory Discovery Max Dirs',
          category: 'Context',
          requiresRestart: false,
          default: 200,
          description: 'Maximum number of directories to search for memory.',
          showInDialog: false,
        },
        memoryBoundaryMarkers: {
          type: 'array',
          label: 'Memory Boundary Markers',
          category: 'Context',
          requiresRestart: true,
          default: ['.git'] as string[],
          description:
            `File or directory names that mark the boundary for ${DEFAULT_CONTEXT_FILENAME} discovery. ` +
            'The upward traversal stops at the first directory containing any of these markers. ' +
            'An empty array disables parent traversal.',
          showInDialog: false,
          items: { type: 'string' },
        },
        loadMemoryFromIncludeDirectories: {
          type: 'boolean',
          label: 'Load Memory From Additional Directories',
          category: 'Context',
          requiresRestart: false,
          default: false,
          description: oneLine`
          Controls how ${DEFAULT_CONTEXT_FILENAME} files are loaded at startup.
          When true, trusted additional workspace directories are scanned; when false, only the current directory is used.
        `,
          showInDialog: true,
        },
        fileFiltering: {
          type: 'object',
          label: 'File Filtering',
          category: 'Context',
          requiresRestart: true,
          default: {},
          description: 'Settings for git-aware file filtering.',
          showInDialog: false,
          properties: {
            respectGitIgnore: {
              type: 'boolean',
              label: 'Respect .gitignore',
              category: 'Context',
              requiresRestart: true,
              default: true,
              description: 'Respect .gitignore files when searching.',
              showInDialog: false,
            },
            respectBrandIgnore: {
              type: 'boolean',
              label: `Respect ${BRAND_IGNORE_FILE}`,
              category: 'Context',
              requiresRestart: true,
              default: true,
              description: `Respect ${BRAND_IGNORE_FILE} files when searching.`,
              showInDialog: false,
            },
            enableRecursiveFileSearch: {
              type: 'boolean',
              label: 'Enable Recursive File Search',
              category: 'Context',
              requiresRestart: true,
              default: true,
              description: oneLine`
              Enable recursive file search functionality when completing @ references in the prompt.
            `,
              showInDialog: false,
            },
            enableFuzzySearch: {
              type: 'boolean',
              label: 'Enable Fuzzy Search',
              category: 'Context',
              requiresRestart: true,
              default: true,
              description: 'Enable fuzzy search when searching for files.',
              showInDialog: false,
            },
            customIgnoreFilePaths: {
              type: 'array',
              label: 'Custom Ignore File Paths',
              category: 'Context',
              requiresRestart: true,
              default: [] as string[],
              description: `Additional ignore file paths to respect. These files take precedence over ${BRAND_IGNORE_FILE} and .gitignore. Files earlier in the array take precedence over files later in the array, e.g. the first file takes precedence over the second one.`,
              showInDialog: false,
              items: { type: 'string' },
              mergeStrategy: MergeStrategy.UNION,
            },
          },
        },
      },
    },

    tools: {
      type: 'object',
      label: 'Tools',
      category: 'Tools',
      requiresRestart: true,
      default: {},
      description: 'Settings for built-in and custom tools.',
      showInDialog: false,
      properties: {
        shell: {
          type: 'object',
          label: 'Shell',
          category: 'Tools',
          requiresRestart: false,
          default: {},
          description: 'Settings for shell execution.',
          showInDialog: false,
          properties: {
            pager: {
              type: 'string',
              label: 'Pager',
              category: 'Tools',
              requiresRestart: false,
              default: 'cat' as string | undefined,
              description:
                'The pager command to use for shell output. Defaults to `cat`.',
              showInDialog: false,
            },
            showColor: {
              type: 'boolean',
              label: 'Show Color',
              category: 'Tools',
              requiresRestart: false,
              default: true,
              description: 'Show color in shell output.',
              showInDialog: false,
            },
            inactivityTimeout: {
              type: 'number',
              label: 'Inactivity Timeout',
              category: 'Tools',
              requiresRestart: false,
              default: 300,
              description:
                'The maximum time in seconds allowed without output from the shell command. Defaults to 5 minutes.',
              showInDialog: false,
            },
          },
        },

        core: {
          type: 'array',
          label: 'Core Tools',
          category: 'Tools',
          requiresRestart: true,
          default: undefined as string[] | undefined,
          description: oneLine`
          Restrict the set of built-in tools with an allowlist.
          Tools not in this list will be denied. See the built-in tools documentation for available names.
        `,
          showInDialog: false,
          items: { type: 'string' },
        },
        exclude: {
          type: 'array',
          label: 'Exclude Tools',
          category: 'Tools',
          requiresRestart: true,
          default: undefined as string[] | undefined,
          description: 'Tool names to exclude.',
          showInDialog: false,
          items: { type: 'string' },
          mergeStrategy: MergeStrategy.UNION,
        },
        useRipgrep: {
          type: 'boolean',
          label: 'Use Ripgrep',
          category: 'Tools',
          requiresRestart: false,
          default: true,
          description:
            'Use ripgrep for file content search instead of the fallback implementation. Provides faster search performance.',
          showInDialog: false,
        },
        truncateToolOutputThreshold: {
          type: 'number',
          label: 'Tool Output Truncation Threshold',
          category: 'General',
          requiresRestart: true,
          default: DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
          description:
            'Maximum characters to show when truncating large tool outputs. Set to 0 or negative to disable truncation.',
          showInDialog: false,
        },
        disableLLMCorrection: {
          type: 'boolean',
          label: 'Disable LLM Correction',
          category: 'Tools',
          requiresRestart: true,
          default: true,
          description: oneLine`
          Disable LLM-based error correction for edit tools.
          When enabled, tools will fail immediately if exact string matches are not found, instead of attempting to self-correct.
        `,
          showInDialog: false,
        },
      },
    },

    codeMode: {
      type: 'object',
      label: 'Code Mode',
      category: 'Tools',
      requiresRestart: true,
      default: {},
      description: 'Isolated JavaScript orchestration of permitted tools.',
      showInDialog: false,
      properties: {
        mode: {
          type: 'enum',
          label: 'Code Mode',
          category: 'Tools',
          requiresRestart: true,
          default: undefined as 'off' | 'on' | 'only' | undefined,
          description:
            'Requires service availability. Default inherits local or remote settings; Off disables CodeMode; On keeps direct tools; Only routes supported tools through scripts.',
          unsetOptionLabel: 'Follow default',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
            { value: 'only', label: 'Only' },
          ],
          showInDialog: true,
        },
        deferredTools: {
          type: 'array',
          label: 'Code Mode Deferred Tools',
          category: 'Tools',
          requiresRestart: true,
          default: [] as string[],
          description:
            'Tools hidden from agents that have CodeMode and found with searchTools inside scripts. Accepts names, * patterns such as mcp__docs__*, and !name to keep a tool declared, including tools deferred by default such as ImageGen. Tools without CodeMode support stay declared.',
          showInDialog: false,
          items: { type: 'string' },
        },
        mcpDeferThreshold: {
          type: 'number',
          label: 'Code Mode MCP Defer Threshold',
          category: 'Tools',
          requiresRestart: true,
          default: 10,
          description:
            'In on mode, MCP tools stay declared when every server has been discovered before the first request and their declarations use less than this percent of the context window; otherwise scripts discover them. Decided again after clear, resume, rewind and compaction. 0 always defers.',
          showInDialog: false,
        },
      },
    },
    mcp: {
      type: 'object',
      label: 'MCP',
      category: 'MCP',
      requiresRestart: true,
      default: {},
      description: 'Settings for Model Context Protocol (MCP) servers.',
      showInDialog: false,
      properties: {
        serverCommand: {
          type: 'string',
          label: 'MCP Server Command',
          category: 'MCP',
          requiresRestart: true,
          default: undefined as string | undefined,
          description: 'Command to start an MCP server.',
          showInDialog: false,
        },
        allowed: {
          type: 'array',
          label: 'Allow MCP Servers',
          category: 'MCP',
          requiresRestart: true,
          default: undefined as string[] | undefined,
          description: 'A list of MCP servers to allow.',
          showInDialog: false,
          items: { type: 'string' },
        },
        excluded: {
          type: 'array',
          label: 'Exclude MCP Servers',
          category: 'MCP',
          requiresRestart: true,
          default: undefined as string[] | undefined,
          description: 'A list of MCP servers to exclude.',
          showInDialog: false,
          items: { type: 'string' },
        },
        enableAllProjectMcpServers: {
          type: 'boolean',
          label: 'Enable All Project MCP Servers',
          category: 'MCP',
          requiresRestart: true,
          default: false,
          description: 'Automatically approve all project-level MCP servers.',
          showInDialog: false,
        },
        enabledProjectMcpServers: {
          type: 'array',
          label: 'Enabled Project MCP Servers',
          category: 'MCP',
          requiresRestart: true,
          default: [] as string[],
          description: 'List of approved project-level MCP server names.',
          showInDialog: false,
          items: { type: 'string' },
          mergeStrategy: MergeStrategy.UNION,
        },
        disabledProjectMcpServers: {
          type: 'array',
          label: 'Disabled Project MCP Servers',
          category: 'MCP',
          requiresRestart: true,
          default: [] as string[],
          description: 'List of rejected project-level MCP server names.',
          showInDialog: false,
          items: { type: 'string' },
          mergeStrategy: MergeStrategy.UNION,
        },
        lazyLoad: {
          type: 'boolean',
          label: 'Lazy-load MCP tools',
          category: 'MCP',
          requiresRestart: true,
          default: false,
          description:
            'When enabled, agents without CodeMode reach MCP tools through three meta tools ' +
            '(mcp_list / mcp_get / mcp_call) instead of individual schema declarations. With ' +
            'CodeMode enabled, scripts always discover and call MCP tools through searchTools and ' +
            'tools[name], whatever this setting says. Saves ' +
            'first-turn prompt tokens for users with many MCP servers. ' +
            'Disabled by default; set to true (or set the MCP lazy-load environment variable to 1) to opt in.',
          showInDialog: false,
        },
      },
    },

    security: {
      type: 'object',
      label: 'Security',
      category: 'Security',
      requiresRestart: true,
      default: {},
      description: 'Security-related settings.',
      showInDialog: false,
      properties: {
        crossSessionInbound: {
          type: 'string',
          label: 'Inbound Cross-Session Messages',
          category: 'Security',
          requiresRestart: false,
          default: undefined as CrossSessionInboundSetting | undefined,
          description:
            "How to handle SendMessage traffic from your other sessions on this machine: 'accept' delivers it, 'hold' parks it for your review in /peers without letting the model act, 'refuse' opts this session out. An explicit value always wins. A repository's checked-in settings.json may only tighten it, and a 'hold' set there asks you per message rather than parking silently, because that is the repository's decision and not yours; your own settings.local.json is yours and carries no such limit. Unset means match the permission mode of the sending session.",
          showInDialog: false,
        },
        disableYoloMode: {
          type: 'boolean',
          label: 'Disable Bypass Permissions Mode',
          category: 'Security',
          requiresRestart: true,
          default: false,
          description:
            'Disable bypass permissions mode, even if enabled by a flag.',
          showInDialog: false,
        },
        blockGitExtensions: {
          type: 'boolean',
          label: 'Blocks extensions from Git',
          category: 'Security',
          requiresRestart: true,
          default: false,
          description: 'Blocks installing and loading extensions from Git.',
          showInDialog: false,
        },
        allowedExtensions: {
          type: 'array',
          label: 'Extension Source Regex Allowlist',
          category: 'Security',
          requiresRestart: true,
          default: [] as string[],
          description:
            'List of Regex patterns for allowed extensions. If nonempty, only extensions that match the patterns in this list are allowed. Overrides the blockGitExtensions setting.',
          showInDialog: false,
          items: { type: 'string' },
        },
        folderTrust: {
          type: 'object',
          label: 'Folder Trust',
          category: 'Security',
          requiresRestart: false,
          default: {},
          description: 'Settings for folder trust.',
          showInDialog: false,
          properties: {
            enabled: {
              type: 'boolean',
              label: 'Folder Trust',
              category: 'Security',
              requiresRestart: true,
              default: true,
              description: 'Setting to track whether Folder trust is enabled.',
              showInDialog: true,
            },
          },
        },
        environmentVariableRedaction: {
          type: 'object',
          label: 'Environment Variable Redaction',
          category: 'Security',
          requiresRestart: false,
          default: {},
          description: 'Settings for environment variable redaction.',
          showInDialog: false,
          properties: {
            allowed: {
              type: 'array',
              label: 'Allowed Environment Variables',
              category: 'Security',
              requiresRestart: true,
              default: [] as string[],
              description:
                'Environment variables to always allow (bypass redaction).',
              showInDialog: false,
              items: { type: 'string' },
            },
            blocked: {
              type: 'array',
              label: 'Blocked Environment Variables',
              category: 'Security',
              requiresRestart: true,
              default: [] as string[],
              description: 'Environment variables to always redact.',
              showInDialog: false,
              items: { type: 'string' },
            },
            enabled: {
              type: 'boolean',
              label: 'Enable Environment Variable Redaction',
              category: 'Security',
              requiresRestart: true,
              default: false,
              description:
                'Enable redaction of environment variables that may contain secrets.',
              showInDialog: false,
            },
          },
        },
        auth: {
          type: 'object',
          label: 'Authentication',
          category: 'Security',
          requiresRestart: true,
          default: {},
          description: 'Authentication settings.',
          showInDialog: false,
          properties: {
            selectedType: {
              type: 'string',
              label: 'Selected Auth Type',
              category: 'Security',
              requiresRestart: true,
              default: undefined as AuthType | undefined,
              description: 'The currently selected authentication type.',
              showInDialog: false,
            },
            qoderRegion: {
              type: 'enum',
              label: 'Qoder Account Region',
              category: 'Security',
              requiresRestart: true,
              default: undefined as 'global' | 'cn' | undefined,
              description:
                'The account region used for Qoder sign-in: global or cn.',
              showInDialog: false,
              options: [
                { value: 'global', label: 'International' },
                { value: 'cn', label: 'China' },
              ],
            },
            enforcedType: {
              type: 'string',
              label: 'Enforced Auth Type',
              category: 'Advanced',
              requiresRestart: true,
              default: undefined as AuthType | undefined,
              description:
                'The required auth type. If this does not match the selected auth type, the user will be prompted to re-authenticate.',
              showInDialog: false,
            },
          },
        },
        enableAllExternalImports: {
          type: 'boolean',
          label: 'Enable All External Imports',
          category: 'Security',
          requiresRestart: true,
          default: false,
          description:
            'Automatically approve all external @import references in AGENTS.md files, even when they point outside the project root.',
          showInDialog: false,
        },
        approvedExternalImportProjects: {
          type: 'array',
          label: 'Approved External Import Projects',
          category: 'Security',
          requiresRestart: true,
          default: [] as string[],
          description:
            'List of project directories where external @import references in AGENTS.md files have been approved.',
          showInDialog: false,
          items: { type: 'string' },
          mergeStrategy: MergeStrategy.UNION,
        },
      },
    },

    advanced: {
      type: 'object',
      label: 'Advanced',
      category: 'Advanced',
      requiresRestart: true,
      default: {},
      description: 'Advanced settings for power users.',
      showInDialog: false,
      properties: {
        autoConfigureMemory: {
          type: 'boolean',
          label: 'Auto Configure Max Old Space Size',
          category: 'Advanced',
          requiresRestart: true,
          default: true,
          description: 'Automatically configure Node.js memory limits',
          showInDialog: false,
        },
        dnsResolutionOrder: {
          type: 'string',
          label: 'DNS Resolution Order',
          category: 'Advanced',
          requiresRestart: true,
          default: undefined as DnsResolutionOrder | undefined,
          description: 'The DNS resolution order.',
          showInDialog: false,
        },
        useProxyFromEnvironment: {
          type: 'boolean',
          label: 'Use Proxy Environment Variables',
          category: 'Advanced',
          requiresRestart: true,
          default: true,
          description:
            'Whether the CLI, including SDK integrations, automatically uses HTTPS_PROXY, https_proxy, HTTP_PROXY, or http_proxy when no explicit startup proxy is supplied.',
          showInDialog: true,
        },
        excludedEnvVars: {
          type: 'array',
          label: 'Excluded Project Environment Variables',
          category: 'Advanced',
          requiresRestart: false,
          default: ['DEBUG', 'DEBUG_MODE'] as string[],
          description: 'Environment variables to exclude from project context.',
          showInDialog: false,
          items: { type: 'string' },
          mergeStrategy: MergeStrategy.UNION,
        },
      },
    },

    experimental: {
      type: 'object',
      label: 'Experimental',
      category: 'Experimental',
      requiresRestart: true,
      default: {},
      description: 'Setting to enable experimental features',
      showInDialog: false,
      properties: {
        adk: {
          type: 'object',
          label: 'ADK',
          category: 'Experimental',
          requiresRestart: true,
          default: {},
          description: 'Settings for the Agent Development Kit (ADK).',
          showInDialog: false,
          properties: {
            agentSessionNoninteractiveEnabled: {
              type: 'boolean',
              label: 'Agent Session Non-interactive Enabled',
              category: 'Experimental',
              requiresRestart: true,
              default: false,
              description: 'Enable non-interactive agent sessions.',
              showInDialog: false,
            },
            agentSessionInteractiveEnabled: {
              type: 'boolean',
              label: 'Interactive Agent Session Enabled',
              category: 'Experimental',
              requiresRestart: true,
              default: false,
              description:
                'Enable the agent session implementation for the interactive CLI.',
              showInDialog: false,
            },
          },
        },
        enableAgents: {
          type: 'boolean',
          label: 'Enable Agents',
          category: 'Experimental',
          requiresRestart: true,
          default: true,
          description: 'Enable subagents.',
          showInDialog: false,
        },
        extensionManagement: {
          type: 'boolean',
          label: 'Extension Management',
          category: 'Experimental',
          requiresRestart: true,
          default: true,
          description: 'Enable extension management features.',
          showInDialog: false,
        },
        extensionConfig: {
          type: 'boolean',
          label: 'Extension Configuration',
          category: 'Experimental',
          requiresRestart: true,
          default: true,
          description: 'Enable requesting and fetching of extension settings.',
          showInDialog: false,
        },
        extensionReloading: {
          type: 'boolean',
          label: 'Extension Reloading',
          category: 'Experimental',
          requiresRestart: true,
          default: false,
          description:
            'Enables extension loading/unloading within the CLI session.',
          showInDialog: false,
        },
        useOSC52Paste: {
          type: 'boolean',
          label: 'Use OSC 52 Paste',
          category: 'Experimental',
          requiresRestart: false,
          default: false,
          description:
            'Use OSC 52 for pasting. This may be more robust than the default system when using remote terminal sessions (if your terminal is configured to allow it).',
          showInDialog: true,
        },
        useOSC52Copy: {
          type: 'boolean',
          label: 'Use OSC 52 Copy',
          category: 'Experimental',
          requiresRestart: false,
          default: false,
          description:
            'Use OSC 52 for copying. This may be more robust than the default system when using remote terminal sessions (if your terminal is configured to allow it).',
          showInDialog: true,
        },
        modelSteering: {
          type: 'boolean',
          label: 'Model Steering',
          category: 'Experimental',
          requiresRestart: false,
          default: false,
          description:
            'Enable model steering (user hints) to guide the model during tool execution.',
          showInDialog: false,
        },
        generalistProfile: {
          type: 'boolean',
          label: 'Use the generalist profile to manage agent contexts.',
          category: 'Experimental',
          requiresRestart: true,
          default: false,
          description:
            'Suitable for general coding and software development tasks.',
          showInDialog: false,
        },
        contextManagement: {
          type: 'boolean',
          label: 'Enable Context Management',
          category: 'Experimental',
          requiresRestart: true,
          default: false,
          description: 'Enable logic for context management.',
          showInDialog: false,
        },
        topicUpdateNarration: {
          type: 'boolean',
          label: 'Topic & Update Narration',
          category: 'Experimental',
          requiresRestart: true,
          default: false,
          description:
            'Enable the experimental Topic & Update communication model for reduced chattiness and structured progress reporting.',
          showInDialog: false,
        },
      },
    },
    extensions: {
      type: 'object',
      label: 'Extensions',
      category: 'Extensions',
      requiresRestart: true,
      default: {},
      description: 'Settings for extensions.',
      showInDialog: false,
      properties: {
        disabled: {
          type: 'array',
          label: 'Disabled Extensions',
          category: 'Extensions',
          requiresRestart: true,
          default: [] as string[],
          description: 'List of disabled extensions.',
          showInDialog: false,
          items: { type: 'string' },
          mergeStrategy: MergeStrategy.UNION,
        },
        workspacesWithMigrationNudge: {
          type: 'array',
          label: 'Workspaces with Migration Nudge',
          category: 'Extensions',
          requiresRestart: false,
          default: [] as string[],
          description:
            'List of workspaces for which the migration nudge has been shown.',
          showInDialog: false,
          items: { type: 'string' },
          mergeStrategy: MergeStrategy.UNION,
        },
      },
    },

    plugins: {
      type: 'object',
      label: 'Plugins',
      category: 'Plugins',
      requiresRestart: true,
      default: {},
      description: 'Settings for the plugin system.',
      showInDialog: false,
      properties: {
        enabled: {
          type: 'array',
          label: 'Enabled Plugins (Deprecated)',
          category: 'Plugins',
          requiresRestart: true,
          default: [] as string[],
          description:
            'Deprecated: use top-level enabledPlugins instead. Retained for migration only.',
          showInDialog: false,
          items: { type: 'string' },
          mergeStrategy: MergeStrategy.UNION,
        },
        disabled: {
          type: 'array',
          label: 'Disabled Plugins (Deprecated)',
          category: 'Plugins',
          requiresRestart: true,
          default: [] as string[],
          description:
            'Deprecated: use top-level enabledPlugins with value false instead. Retained for migration only.',
          showInDialog: false,
          items: { type: 'string' },
          mergeStrategy: MergeStrategy.UNION,
        },
        autoUpdate: {
          type: 'boolean',
          label: 'Auto-Update Plugins',
          category: 'Plugins',
          requiresRestart: false,
          default: true,
          description:
            'Automatically refresh eligible marketplace data and update already-installed plugins in the background. Declared marketplace source changes are still reconciled.',
          showInDialog: false,
        },
      },
    },

    skills: {
      type: 'object',
      label: 'Skills',
      category: 'Advanced',
      requiresRestart: true,
      default: {},
      description: 'Settings for agent skills.',
      showInDialog: false,
      properties: {
        enabled: {
          type: 'boolean',
          label: 'Enable Agent Skills',
          category: 'Advanced',
          requiresRestart: true,
          default: true,
          description: 'Enable Agent Skills.',
          showInDialog: false,
        },
        loadFromAgentsDirectory: {
          type: 'boolean',
          label: 'Load Skills from .agents/skills',
          category: 'Advanced',
          requiresRestart: true,
          default: true,
          description:
            'Load skills from legacy .agents/skills directories for this session. The user source is shared across sessions; trusted project settings can enable it when needed. SDK mode defaults this off unless explicitly enabled. Restart the CLI after changing this setting.',
          showInDialog: true,
        },
        disabled: {
          type: 'array',
          label: 'Disabled Skills',
          category: 'Advanced',
          requiresRestart: true,
          default: [] as string[],
          description: 'List of disabled skills.',
          showInDialog: false,
          items: { type: 'string' },
          mergeStrategy: MergeStrategy.UNION,
        },
        disableShellExecution: {
          type: 'boolean',
          label: 'Disable Skill Shell Execution',
          category: 'Advanced',
          requiresRestart: false,
          default: false,
          description:
            'When true, shell injection commands (!`cmd` and ```! cmd ```) in skill prompts are disabled. ' +
            'Commands are replaced with a placeholder message. Built-in and managed skills are not affected.',
          showInDialog: false,
        },
      },
    },

    skillOverrides: {
      type: 'object',
      label: 'Skill Visibility Overrides',
      category: 'Advanced',
      requiresRestart: false,
      default: {} as Record<string, string>,
      description:
        'Per-skill visibility overrides. Maps skill names to visibility: ' +
        '"on" (fully visible), "off" (hidden from model and rejected on invoke), ' +
        '"name-only" (listed by name without description), ' +
        '"user-invocable-only" (hidden from model but invocable via slash command).',
      showInDialog: false,
      mergeStrategy: MergeStrategy.SHALLOW_MERGE,
    },

    skillListingMaxDescChars: {
      type: 'number',
      label: 'Skill Listing Max Description Characters',
      category: 'Advanced',
      requiresRestart: false,
      default: undefined as number | undefined,
      description:
        'Maximum number of characters for each skill description in the model-facing listing. ' +
        'Longer descriptions are truncated with an ellipsis included in the limit. Defaults to 300 in all entry points.',
      showInDialog: false,
    },

    skillListingBudgetFraction: {
      type: 'number',
      label: 'Skill Listing Budget Fraction',
      category: 'Advanced',
      requiresRestart: false,
      default: undefined as number | undefined,
      description:
        'Fraction of the context window budget (0–1) allocated to the skill listing. ' +
        'Defaults to 0.05 in all entry points, independent of Workflow availability. The soft budget is at least one display column, including when set to 0. ' +
        'The listing keeps all skill names and bundled descriptions, dropping lower-priority descriptions when over budget.',
      showInDialog: false,
    },

    enabledPlugins: {
      type: 'object',
      label: 'Enabled Plugins',
      category: 'Plugins',
      requiresRestart: true,
      default: {} as Record<string, boolean>,
      description:
        'Map of plugin IDs (plugin@marketplace) to enabled state. ' +
        'true enables the plugin; false explicitly disables. ' +
        'Replaces plugins.enabled and plugins.disabled.',
      showInDialog: false,
      additionalProperties: { type: 'boolean' },
      mergeStrategy: MergeStrategy.SHALLOW_MERGE,
    },

    extraKnownMarketplaces: {
      type: 'object',
      label: 'Extra Marketplaces',
      category: 'Plugins',
      requiresRestart: true,
      default: {} as Record<
        string,
        { source: string; type: string; ref?: string }
      >,
      description:
        'Additional marketplace sources to register on startup. Keys are marketplace names, values describe the source (e.g., { "source": "owner/repo", "type": "github" }).',
      showInDialog: false,
      mergeStrategy: MergeStrategy.SHALLOW_MERGE,
    },

    strictKnownMarketplaces: {
      type: 'boolean',
      label: 'Strict Known Marketplaces',
      category: 'Plugins',
      requiresRestart: true,
      default: false,
      description:
        'When enabled, only plugins from known (pre-configured) marketplaces can be installed. Useful for enterprise environments.',
      showInDialog: false,
    },

    blockedMarketplaces: {
      type: 'array',
      label: 'Blocked Marketplaces',
      category: 'Plugins',
      requiresRestart: true,
      default: [] as string[],
      description:
        'List of marketplace names that are blocked. Plugins from these marketplaces cannot be installed or loaded.',
      showInDialog: false,
      items: { type: 'string' },
      mergeStrategy: MergeStrategy.UNION,
    },

    pluginConfigs: {
      type: 'object',
      label: 'Plugin Configs',
      category: 'Advanced',
      requiresRestart: false,
      default: {} as Record<
        string,
        {
          mcpServers?: Record<
            string,
            Record<string, string | number | boolean | string[]>
          >;
        }
      >,
      description:
        'Per-plugin configuration values. Keyed by plugin id (plain name for local/flag plugins, "name@marketplace" for marketplace plugins). ' +
        "`mcpServers.<server>.<key>` values are substituted into `${user_config.<key>}` placeholders in that plugin's MCP server command/args/env at load time.",
      showInDialog: false,
      mergeStrategy: MergeStrategy.SHALLOW_MERGE,
    },

    disableAllHooks: {
      type: 'boolean',
      label: 'Disable All Hooks',
      category: 'Advanced',
      requiresRestart: false,
      default: false,
      description:
        'When true, all hooks and statusLine execution are disabled regardless of individual settings. Top-level kill switch.',
      showInDialog: false,
    },

    allowedHttpHookUrls: {
      type: 'array',
      label: 'Allowed HTTP Hook URLs',
      category: 'Advanced',
      requiresRestart: true,
      default: undefined as string[] | undefined,
      description:
        'Allowlist of URL patterns that HTTP hooks may target. Supports * as a wildcard. Undefined allows all URLs; an empty array blocks all HTTP hooks.',
      showInDialog: false,
      items: { type: 'string' },
      mergeStrategy: MergeStrategy.UNION,
    },

    hooksConfig: {
      type: 'object',
      label: 'HooksConfig',
      category: 'Advanced',
      requiresRestart: false,
      default: {},
      description:
        'Hook configurations for intercepting and customizing agent behavior.',
      showInDialog: false,
      properties: {
        enabled: {
          type: 'boolean',
          label: 'Enable Hooks',
          category: 'Advanced',
          requiresRestart: true,
          default: true,
          description:
            'Canonical toggle for the hooks system. When disabled, no hooks will be executed.',
          showInDialog: false,
        },
        notifications: {
          type: 'boolean',
          label: 'Hook Notifications',
          category: 'Advanced',
          requiresRestart: false,
          default: false,
          description:
            'Show hook lifecycle messages (started/completed/progress) in chat history. Hook failures are always shown regardless of this setting.',
          showInDialog: false,
        },
        headlessFastMode: {
          type: 'boolean',
          label: 'Headless Fast Hooks',
          category: 'Advanced',
          requiresRestart: true,
          default: false,
          description:
            'Skip user hooks in headless mode. This can bypass user-defined audit or policy hooks.',
          showInDialog: false,
        },
      },
    },

    hooks: {
      type: 'object',
      label: 'Hook Events',
      category: 'Advanced',
      requiresRestart: false,
      default: {},
      description: 'Event-specific hook configurations.',
      showInDialog: false,
      properties: {
        PreToolUse: {
          type: 'array',
          label: 'Pre Tool Use Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute before tool execution. Can intercept, validate, or modify tool calls.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        PostToolUse: {
          type: 'array',
          label: 'Post Tool Use Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute after tool execution. Can process results, log outputs, or trigger follow-up actions.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        PostToolUseFailure: {
          type: 'array',
          label: 'Post Tool Use Failure Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when a tool execution fails. Can handle errors, retry, or log failures.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        SubagentStart: {
          type: 'array',
          label: 'Subagent Start Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute before a subagent loop starts. Can set up context or initialize resources.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        SubagentStop: {
          type: 'array',
          label: 'Subagent Stop Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute after a subagent loop completes. Can perform cleanup or summarize results.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        Notification: {
          type: 'array',
          label: 'Notification Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute on notification events (errors, warnings, info). Can log or alert on specific conditions.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        SessionStart: {
          type: 'array',
          label: 'Session Start Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when a session starts. Can initialize session-specific resources or state.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        SessionEnd: {
          type: 'array',
          label: 'Session End Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when a session ends. Can perform cleanup or persist session data.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        PreCompact: {
          type: 'array',
          label: 'Pre-Compact Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute before chat history compression. Can back up or analyze conversation before compression.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        PostCompact: {
          type: 'array',
          label: 'Post-Compact Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute after chat history compression. Can verify or process compressed context.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        Stop: {
          type: 'array',
          label: 'Stop Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when the agent is about to stop. Can block the stop to keep the agent running.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        QueryEnd: {
          type: 'array',
          label: 'Query End Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Notification-only hooks that execute after a top-level request reaches its final outcome.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        UserPromptSubmit: {
          type: 'array',
          label: 'User Prompt Submit Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when the user submits a prompt. Can modify the prompt or inject additional context.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        ConfigChange: {
          type: 'array',
          label: 'Config Change Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when configuration changes are detected.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        StopFailure: {
          type: 'array',
          label: 'Stop Failure Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when the agent encounters a fatal error and must stop.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        TeammateIdle: {
          type: 'array',
          label: 'Teammate Idle Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when a teammate agent attempts to become idle.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        InstructionsLoaded: {
          type: 'array',
          label: 'Instructions Loaded Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when instruction/memory files are loaded.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        CwdChanged: {
          type: 'array',
          label: 'CWD Changed Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description: 'Hooks that execute when the working directory changes.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        FileChanged: {
          type: 'array',
          label: 'File Changed Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when a file is created, modified, or deleted by a tool.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        WorktreeCreate: {
          type: 'array',
          label: 'Worktree Create Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description: 'Hooks that execute when a git worktree is created.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        WorktreeRemove: {
          type: 'array',
          label: 'Worktree Remove Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description: 'Hooks that execute when a git worktree is removed.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        Elicitation: {
          type: 'array',
          label: 'Elicitation Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when the agent requests user input via elicitation.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        ElicitationResult: {
          type: 'array',
          label: 'Elicitation Result Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute after the user responds to an elicitation.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        TaskCreated: {
          type: 'array',
          label: 'Task Created Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when a task is created. Can veto task creation.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        TaskCompleted: {
          type: 'array',
          label: 'Task Completed Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            'Hooks that execute when a task is completed. Can veto task completion.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        PermissionRequest: {
          type: 'array',
          label: 'Permission Request Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description: 'Hooks that execute when a permission request is made.',
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
        PermissionDenied: {
          type: 'array',
          label: 'Permission Denied Hooks',
          category: 'Advanced',
          requiresRestart: false,
          default: [],
          description:
            "Hooks that execute when auto mode's classifier denies a tool call.",
          showInDialog: false,
          ref: 'HookDefinitionArray',
          mergeStrategy: MergeStrategy.CONCAT,
        },
      },
      additionalProperties: {
        type: 'array',
        description:
          'Custom hook event arrays that contain hook definitions for user-defined events',
        mergeStrategy: MergeStrategy.CONCAT,
      },
    },

    statusLine: {
      type: 'object',
      label: 'Status Line',
      category: 'Appearance',
      requiresRestart: false,
      default: {},
      description:
        'Custom status line configuration. Runs a shell command that receives session data as JSON on stdin and displays its stdout below the input prompt.',
      showInDialog: false,
      properties: {
        type: {
          type: 'string',
          label: 'Status Line Type',
          category: 'Appearance',
          requiresRestart: false,
          default: 'command',
          description:
            'The type of status line. Currently only "command" is supported.',
          showInDialog: false,
        },
        command: {
          type: 'string',
          label: 'Command',
          category: 'Appearance',
          requiresRestart: false,
          default: '',
          description:
            'Shell command to execute for the status line. Receives JSON session data on stdin. Output (including ANSI colors) is displayed below the input prompt.',
          showInDialog: false,
        },
        padding: {
          type: 'number',
          label: 'Padding',
          category: 'Appearance',
          requiresRestart: false,
          default: 0,
          description:
            'Horizontal padding (in characters) applied to the status line output.',
          showInDialog: false,
        },
        colors: {
          type: 'object',
          label: 'Status Line Colors',
          category: 'Appearance',
          requiresRestart: false,
          default: {},
          description:
            'Custom colors for individual segments of the built-in default status line. ' +
            'Values can be CSS/hex colors (e.g., "#ff6600"), ANSI names ("red", "cyan"), ' +
            'or natural-language color names ("ocean blue", "scarlet", "forest green", "coral"). ' +
            'Empty string or omitted means "use theme default". ' +
            'Note: the context progress bar ignores custom colors and auto-changes ' +
            'based on usage thresholds (green/yellow/red).',
          showInDialog: false,
          properties: {
            model: {
              type: 'string',
              label: 'Model Name Color',
              category: 'Appearance',
              requiresRestart: false,
              default: '',
              description:
                'Color for the model name segment. Empty string uses the theme primary text color.',
              showInDialog: false,
            },
            branch: {
              type: 'string',
              label: 'Workspace Path Color',
              category: 'Appearance',
              requiresRestart: false,
              default: '',
              description:
                'Color for the workspace path segment. Empty string uses the theme primary text color. ' +
                'The key is named "branch" for backwards compatibility; the default status line has no git branch segment.',
              showInDialog: false,
            },
            separator: {
              type: 'string',
              label: 'Separator Color',
              category: 'Appearance',
              requiresRestart: false,
              default: '',
              description:
                'Color for the " · " separators between segments. Empty string uses the theme comment color.',
              showInDialog: false,
            },
          },
        },
      },
    },

    compression: {
      type: 'object',
      label: 'Compression',
      category: 'Advanced',
      requiresRestart: true,
      default: {},
      description: 'Settings for conversation history compression.',
      showInDialog: false,
      properties: {
        autoCompact: {
          type: 'object',
          label: 'Auto Compact',
          category: 'Advanced',
          requiresRestart: true,
          default: {},
          showInDialog: false,
          properties: {
            maxConsecutiveFailures: {
              type: 'number',
              label: 'Maximum Consecutive Failures',
              category: 'Advanced',
              requiresRestart: true,
              default: 3,
              description:
                'Stop automatic compaction after this many consecutive failures in one user query.',
              showInDialog: false,
            },
          },
        },
      },
    },

    contextManagement: {
      type: 'object',
      label: 'Context Management',
      category: 'Experimental',
      requiresRestart: true,
      default: {},
      description: 'Settings for context management tool output masking.',
      showInDialog: false,
      properties: {
        tools: {
          type: 'object',
          label: 'Context Management Tools',
          category: 'Context Management',
          requiresRestart: true,
          default: {},
          showInDialog: false,
          properties: {
            outputMasking: {
              type: 'object',
              label: 'Tool Output Masking',
              category: 'Context Management',
              requiresRestart: true,
              ignoreInDocs: false,
              default: {},
              description:
                'Advanced settings for tool output masking to manage context window efficiency.',
              showInDialog: false,
              properties: {
                protectionThresholdTokens: {
                  type: 'number',
                  label: 'Tool Protection Threshold (Tokens)',
                  category: 'Context Management',
                  requiresRestart: true,
                  default: 50_000,
                  description:
                    'Minimum number of tokens to protect from masking (most recent tool outputs).',
                  showInDialog: false,
                },
                minPrunableThresholdTokens: {
                  type: 'number',
                  label: 'Min Prunable Tokens Threshold',
                  category: 'Context Management',
                  requiresRestart: true,
                  default: 30_000,
                  description:
                    'Minimum prunable tokens required to trigger a masking pass.',
                  showInDialog: false,
                },
                protectLatestTurn: {
                  type: 'boolean',
                  label: 'Protect Latest Turn',
                  category: 'Context Management',
                  requiresRestart: true,
                  default: true,
                  description:
                    'Ensures the absolute latest turn is never masked, regardless of token count.',
                  showInDialog: false,
                },
              },
            },
          },
        },
      },
    },
    agentsMdExcludes: {
      type: 'array',
      label: `${DEFAULT_CONTEXT_FILENAME} Excludes`,
      category: 'Context',
      requiresRestart: true,
      default: [] as string[],
      description:
        `Glob patterns or absolute paths of ${DEFAULT_CONTEXT_FILENAME} files to exclude from loading. ` +
        'Patterns are matched against absolute file paths using picomatch. ' +
        'Only applies to project and local memory types (global and extension files cannot be excluded). ' +
        `Examples: "/home/user/monorepo/${DEFAULT_CONTEXT_FILENAME}", "**/${DEFAULT_CONTEXT_FILENAME}"`,
      showInDialog: true,
      items: { type: 'string' },
    },

    permissions: {
      type: 'object',
      label: 'Permissions',
      category: 'Permissions',
      requiresRestart: false,
      default: {} as {
        additionalDirectories?: string[];
        trustDirectories?: string[];
      },
      description: 'Workspace permission settings.',
      showInDialog: false,
      properties: {
        additionalDirectories: {
          type: 'array',
          label: 'Additional Directories',
          category: 'Permissions',
          requiresRestart: false,
          default: [] as string[],
          description:
            'Additional directories added to the workspace context via /add-dir. ' +
            'These directories are trusted for file access within this project.',
          showInDialog: false,
          items: { type: 'string' },
        },
        trustDirectories: {
          type: 'array',
          label: 'Trusted Directories',
          category: 'Permissions',
          requiresRestart: false,
          default: [] as string[],
          description:
            'Directories explicitly trusted by the user. Stored at the user level ' +
            'so they are not overwritten by project-level settings.',
          showInDialog: false,
          items: { type: 'string' },
        },
      },
    },
  } as const satisfies SettingsSchema;
}

export type SettingsSchemaType = ReturnType<typeof createSettingsSchema>;

export type SettingsJsonSchemaDefinition = Record<string, unknown>;

export interface SettingsSchemaReferences {
  definitions: Record<string, SettingsJsonSchemaDefinition>;
  fieldValidators?: Readonly<
    Record<string, Readonly<Record<string, (value: unknown) => void>>>
  >;
}

const MODEL_GENERATION_PREFERENCE_PROPERTIES = {
  temperature: {
    type: 'number',
    minimum: 0,
    description: 'Sampling temperature.',
  },
  topP: {
    type: 'number',
    minimum: 0,
    maximum: 1,
    description: 'Nucleus-sampling probability.',
  },
  topK: {
    type: 'integer',
    exclusiveMinimum: 0,
    description: 'Positive integer top-k sampling limit.',
  },
  maxTokens: {
    type: 'integer',
    exclusiveMinimum: 0,
    description: 'Positive integer maximum output token count.',
  },
  reasoning: {
    type: 'object',
    description: 'Reasoning/thinking controls.',
    additionalProperties: false,
    properties: {
      thinking: {
        type: 'object',
        ref: 'LlmThinkingConfig',
        description:
          'Explicit thinking mode. Fixed-budget thinking requires budgetTokens.',
      },
      enabled: {
        type: 'boolean',
        description:
          "Whether thinking is enabled using the model's provider-native mode.",
      },
      effort: {
        type: 'string',
        enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        description: 'Reasoning effort level.',
      },
      budgetTokens: {
        type: 'integer',
        exclusiveMinimum: 0,
        deprecated: true,
        description:
          'Deprecated compatibility field. Use thinking.type=enabled with thinking.budgetTokens.',
      },
      preserve: {
        type: 'boolean',
        description:
          'Whether prior reasoning content is preserved across turns.',
      },
    },
  },
} as const;

export function createSettingsSchemaDefinitions(
  getCliName: () => string,
): Record<string, SettingsJsonSchemaDefinition> {
  return {
    JudgmentSettings: {
      anyOf: [
        {
          type: 'object',
          properties: {
            backend: { type: 'string', enum: ['bailian'] },
            model: {
              type: 'string',
              description: 'JEV model ID. Defaults to pre-dashscope-jev-kev.',
            },
          },
          required: ['backend'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            backend: { type: 'string', enum: ['typesafe'] },
            model: { type: 'string', description: 'TypeSafe model ID.' },
            baseUrl: {
              type: 'string',
              description: 'TypeSafe API root, without /v1/systemone.',
            },
            apiKey: {
              type: 'string',
              description:
                'TypeSafe API key; supports environment variable references.',
            },
          },
          required: ['backend', 'model', 'baseUrl', 'apiKey'],
          additionalProperties: false,
        },
      ],
    },

    LlmThinkingConfig: {
      description: 'Provider-independent thinking mode.',
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: {
              type: 'string',
              enum: ['adaptive', 'disabled'],
            },
          },
          required: ['type'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['enabled'] },
            budgetTokens: { type: 'integer', exclusiveMinimum: 0 },
          },
          required: ['type', 'budgetTokens'],
        },
      ],
    },
    ModelPreferenceEntry: {
      type: 'object',
      description: 'Persisted options for one model id.',
      additionalProperties: false,
      properties: {
        contextWindow: {
          type: 'integer',
          exclusiveMinimum: 0,
          description: 'Selected context window in tokens.',
        },
        ...MODEL_GENERATION_PREFERENCE_PROPERTIES,
        generation: {
          type: 'object',
          deprecated: true,
          description:
            'Deprecated compatibility wrapper. Generation fields are migrated to the preference entry.',
          additionalProperties: false,
          properties: MODEL_GENERATION_PREFERENCE_PROPERTIES,
        },
        functionSwitchSelections: {
          type: 'object',
          deprecated: true,
          description:
            'Deprecated: model function switches were removed. Kept so existing settings stay valid; the value is ignored.',
          additionalProperties: { type: 'string' },
        },
      },
    },
    MCPServerConfig: {
      type: 'object',
      description:
        'Definition of a Model Context Protocol (MCP) server configuration.',
      // MCP configs can contain provider-specific metadata. Keep validating
      // every field owned by the CLI, but tolerate
      // unknown fields so metadata added by another MCP config producer does not
      // cause the entire server entry to be skipped.
      additionalProperties: true,
      properties: {
        command: {
          type: 'string',
          description: 'Executable invoked for stdio transport.',
        },
        args: {
          type: 'array',
          description:
            'Command-line arguments for the stdio transport command.',
          items: { type: 'string' },
        },
        env: {
          type: 'object',
          description: 'Environment variables to set for the server process.',
          additionalProperties: { type: 'string' },
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the server process.',
        },
        url: {
          type: 'string',
          description:
            'URL for SSE or HTTP transport. Use with "type" field to specify transport type.',
        },
        headers: {
          type: 'object',
          description: 'Additional HTTP headers sent to the server.',
          additionalProperties: { type: 'string' },
        },
        tcp: {
          type: 'string',
          description: 'TCP address for websocket transport.',
        },
        type: {
          type: 'string',
          description:
            'Transport type. Use "stdio" for local command, "sse" for Server-Sent Events, "http" (or "streamable-http") for Streamable HTTP, or "ws" for WebSocket.',
          enum: ['stdio', 'sse', 'http', 'ws', 'streamable-http'],
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds for MCP requests.',
        },
        trust: {
          type: 'boolean',
          description:
            'Marks the server as trusted. Trusted servers may gain additional capabilities.',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of the server.',
        },
        includeTools: {
          type: 'array',
          description:
            'Subset of tools that should be enabled for this server. When omitted all tools are enabled.',
          items: { type: 'string' },
        },
        excludeTools: {
          type: 'array',
          description:
            'Tools that should be disabled for this server even if exposed.',
          items: { type: 'string' },
        },
        toolOverrides: {
          type: 'object',
          description:
            'Optional model-surface overrides keyed by the raw MCP tool name.',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              exposedName: {
                type: 'string',
                description:
                  'Tool name exposed to the model. Requires alwaysLoad to be true.',
                pattern: '^[A-Za-z0-9_-]{1,64}$',
              },
              alwaysLoad: {
                type: 'boolean',
                description:
                  'Keep this tool directly registered when MCP lazy loading is active.',
              },
            },
          },
        },
        extension: {
          type: 'object',
          get description() {
            return `Metadata describing the ${getCliName()} extension that owns this MCP server.`;
          },
          additionalProperties: { type: ['string', 'boolean', 'number'] },
        },
        oauth: {
          type: 'object',
          description:
            'OAuth configuration for authenticating with the server.',
          additionalProperties: true,
        },
        disabled: {
          type: 'boolean',
          description:
            'Whether the MCP server is disabled. When true, the server will not be started.',
        },
        headersHelper: {
          type: 'string',
          description:
            'Shell command that prints a JSON object of HTTP headers to stdout. Executed at connection time to generate dynamic headers (for example short-lived auth tokens) that are merged on top of `headers`.',
        },
        alwaysAllow: {
          type: 'array',
          description:
            'Tool names from this server that should bypass user confirmation.',
          items: { type: 'string' },
        },
        deferred: {
          type: 'boolean',
          description:
            'Keep this server\'s tools out of model tool declarations. Agents with CodeMode find them with searchTools inside scripts; other agents use mcp_list/mcp_get/mcp_call. Tools with toolOverrides alwaysLoad stay declared.',
        },
      },
    },
    SummarizeToolOutputSettings: {
      type: 'object',
      description:
        'Controls summarization behavior for individual tools. All properties are optional.',
      additionalProperties: false,
      properties: {
        tokenBudget: {
          type: 'number',
          description:
            'Maximum number of tokens used when summarizing tool output.',
        },
      },
    },
    AgentOverride: {
      type: 'object',
      description: 'Override settings for a specific agent.',
      additionalProperties: false,
      properties: {
        modelConfig: {
          type: 'object',
          additionalProperties: true,
        },
        runConfig: {
          type: 'object',
          description: 'Run configuration for an agent.',
          additionalProperties: false,
          properties: {
            maxTimeMinutes: {
              type: 'number',
              description:
                'The maximum execution time for the agent in minutes.',
            },
            maxTurns: {
              type: 'integer',
              minimum: 1,
              description: 'The maximum number of conversational turns.',
            },
          },
        },
        tools: {
          type: 'array',
          description: 'Tool names available to the agent.',
          items: { type: 'string' },
        },
        enabled: {
          type: 'boolean',
          description: 'Whether to enable the agent.',
        },
      },
    },
    AutoThemePair: {
      type: 'object',
      description:
        'Themes to use for dark and light terminal backgrounds when `ui.theme` is `auto`. Either key may be omitted to keep its default.',
      additionalProperties: false,
      properties: {
        dark: {
          type: 'string',
          description:
            'Theme to use on a dark terminal background. Defaults to `Default`.',
        },
        light: {
          type: 'string',
          description:
            'Theme to use on a light terminal background. Defaults to `Default Light`.',
        },
      },
    },
    CustomTheme: {
      type: 'object',
      get description() {
        return `Custom theme definition used for styling ${getCliName()} output. Colors are provided as hex strings or named ANSI colors.`;
      },
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          enum: ['custom'],
          default: 'custom',
        },
        name: {
          type: 'string',
          description: 'Theme display name.',
        },
        text: {
          type: 'object',
          additionalProperties: false,
          properties: {
            primary: { type: 'string' },
            secondary: { type: 'string' },
            link: { type: 'string' },
            accent: { type: 'string' },
          },
        },
        background: {
          type: 'object',
          additionalProperties: false,
          properties: {
            primary: { type: 'string' },
            diff: {
              type: 'object',
              additionalProperties: false,
              properties: {
                added: { type: 'string' },
                removed: { type: 'string' },
              },
            },
          },
        },
        border: {
          type: 'object',
          additionalProperties: false,
          properties: {
            default: { type: 'string' },
            focused: { type: 'string' },
          },
        },
        ui: {
          type: 'object',
          additionalProperties: false,
          properties: {
            comment: { type: 'string' },
            symbol: { type: 'string' },
            gradient: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        status: {
          type: 'object',
          additionalProperties: false,
          properties: {
            error: { type: 'string' },
            success: { type: 'string' },
            warning: { type: 'string' },
          },
        },
        Background: { type: 'string' },
        Foreground: { type: 'string' },
        LightBlue: { type: 'string' },
        AccentBlue: { type: 'string' },
        AccentPurple: { type: 'string' },
        AccentCyan: { type: 'string' },
        AccentGreen: { type: 'string' },
        AccentYellow: { type: 'string' },
        AccentRed: { type: 'string' },
        DiffAdded: { type: 'string' },
        DiffRemoved: { type: 'string' },
        Comment: { type: 'string' },
        Gray: { type: 'string' },
        DarkGray: { type: 'string' },
        GradientColors: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['type', 'name'],
    },
    StringOrStringArray: {
      description: 'Accepts either a single string or an array of strings.',
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    },
    StringOrFalse: {
      description: 'Accepts either a string value or false.',
      anyOf: [{ type: 'string' }, { type: 'boolean', enum: [false] }],
    },
    CustomProviderThinkingCapability: {
      description: 'Structured Anthropic thinking capability.',
      type: 'object',
      additionalProperties: false,
      properties: {
        modes: {
          type: 'array',
          items: { type: 'string', enum: ['enabled', 'adaptive'] },
          uniqueItems: true,
          description: 'All thinking modes supported by the model.',
        },
        preferredMode: {
          type: 'string',
          enum: ['enabled', 'adaptive'],
          description:
            'Preferred mode when the model supports more than one thinking mode.',
        },
        requiresBudgetForEnabled: {
          type: 'boolean',
          description:
            "Whether enabled thinking requires a fixed budget_tokens value. Inherits the built-in model's policy when omitted; otherwise defaults to true.",
        },
        supportsEffort: { type: 'boolean' },
        supportedEffortLevels: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        },
        requiredBetasForEffort: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['modes'],
    },
    HookDefinitionArray: {
      type: 'array',
      description: 'Array of hook definition objects for a specific event.',
      items: {
        type: 'object',
        description:
          'Hook definition specifying matcher pattern and hook configurations.',
        properties: {
          matcher: {
            type: 'string',
            description:
              'Pattern to match against the event context (tool name, notification type, etc.). Supports exact match, regex (/pattern/), and wildcards (*).',
          },
          hooks: {
            type: 'array',
            description: 'Hooks to execute when the matcher matches.',
            items: {
              type: 'object',
              description: 'Individual hook configuration.',
              properties: {
                name: {
                  type: 'string',
                  description: 'Unique identifier for the hook.',
                },
                type: {
                  type: 'string',
                  description:
                    'Type of hook (`command` | `http` | `prompt` | `agent`).',
                },
                command: {
                  type: 'string',
                  description:
                    'Shell command to execute. Receives JSON input via stdin and returns JSON output via stdout.',
                },
                timeout: {
                  type: 'number',
                  description: 'Timeout in seconds for hook execution.',
                },
                if: {
                  type: 'string',
                  description:
                    'Per-hook condition filter. Format: `"ToolName(arg_pattern)"` or `"ToolName"`. ' +
                    'A trailing `:*` is treated as a prefix rule (e.g. `"Bash(git commit:*)"` matches `git commit` and `git commit -m ...`).',
                },
                shell: {
                  type: 'string',
                  description:
                    "Shell to use for command hooks: 'bash' or 'powershell'. Defaults to system shell.",
                },
                args: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    "Optional argv array for exec form. When set, the hook runs as spawn(command, args, { shell: false }) — no shell parses or quotes anything. 'shell' is ignored. Use this when paths or arguments contain shell metacharacters that would require complex quoting.",
                },
                async: {
                  type: 'boolean',
                  description:
                    'Run hook in the background without blocking the current operation.',
                },
                asyncRewake: {
                  type: 'boolean',
                  description:
                    'If true, hook runs in background and wakes the model on exit code 2 (blocking error). Implies async.',
                },
                rewakeMessage: {
                  type: 'string',
                  description:
                    '@internal Custom prefix for the system-reminder shown to the model when an asyncRewake hook exits with code 2. ' +
                    'The hook output is appended after this prefix.',
                },
                rewakeSummary: {
                  type: 'string',
                  description:
                    '@internal One-line summary shown to the user in the terminal when an asyncRewake hook exits with code 2. ' +
                    'Defaults to "Stop hook feedback".',
                },
                statusMessage: {
                  type: 'string',
                  description:
                    'Custom status message for spinner/status line display while the hook runs.',
                },
                once: {
                  type: 'boolean',
                  description:
                    'Remove the hook from the registry after its first successful execution. Only effective for session-scoped hooks.',
                },
              },
            },
          },
        },
      },
    },
  };
}

type InferSettings<T extends SettingsSchema> = {
  -readonly [K in keyof T]?: T[K] extends { properties: SettingsSchema }
    ? InferSettings<T[K]['properties']>
    : T[K]['type'] extends 'enum'
      ? T[K]['options'] extends readonly SettingEnumOption[]
        ? T[K]['options'][number]['value']
        : T[K]['default']
      : T[K]['default'] extends boolean
        ? boolean
        : T[K]['default'] extends string
          ? string
          : T[K]['default'] extends ReadonlyArray<infer U>
            ? U[]
            : T[K]['default'];
};

type InferMergedSettings<T extends SettingsSchema> = {
  -readonly [K in keyof T]-?: T[K] extends { properties: SettingsSchema }
    ? InferMergedSettings<T[K]['properties']>
    : T[K]['type'] extends 'enum'
      ? T[K]['options'] extends readonly SettingEnumOption[]
        ? T[K]['options'][number]['value']
        : T[K]['default']
      : T[K]['default'] extends boolean
        ? boolean
        : T[K]['default'] extends string
          ? string
          : T[K]['default'] extends ReadonlyArray<infer U>
            ? U[]
            : T[K]['default'];
};

export type Settings = InferSettings<SettingsSchemaType>;
export type MergedSettings = InferMergedSettings<SettingsSchemaType>;
