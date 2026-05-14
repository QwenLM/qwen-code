/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MCPServerConfig,
  BugCommandSettings,
  TelemetrySettings,
  AuthType,
  ChatCompressionSettings,
  ModelProvidersConfig,
} from '@qwen-code/qwen-code-core';
import {
  ApprovalMode,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
} from '@qwen-code/qwen-code-core';
import type { CustomTheme } from '../ui/themes/theme.js';
import { getLanguageSettingsOptions } from '../i18n/languages.js';

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
  description?: string;
  parentKey?: string;
  key?: string;
  properties?: SettingsSchema;
  showInDialog?: boolean;
  mergeStrategy?: MergeStrategy;
  /** Enum type options  */
  options?: readonly SettingEnumOption[];
  /** Schema for array items when type is 'array' */
  items?: SettingItemDefinition;
  /**
   * Primitive shapes a field accepted before it was expanded to its current
   * type. The exported JSON Schema wraps the field in `anyOf` so values from
   * those older shapes don't trip the IDE validator while the runtime
   * migration is still pending. Has no runtime effect — it's purely a
   * compatibility hint for editors.
   *
   * Narrowed to the subset our generator can faithfully emit as a
   * one-liner `{ type: <legacyType> }` schema fragment. `'enum'` is
   * not a valid JSON Schema `type` value at all (enum constraints
   * use the `enum` keyword, not `type: 'enum'`), so allowing it here
   * would silently produce an invalid `settings.schema.json`.
   * `'object'` IS a valid JSON Schema type, but a bare
   * `{ type: 'object' }` legacy entry would accept ANY object value
   * — most likely not what the field's pre-expansion shape actually
   * permitted. Future legacy shapes that need `enum` / structured-
   * object compatibility should land their own branch in
   * `convertSettingToJsonSchema` (with proper `enum:` / `properties:`
   * companions) instead of widening this set.
   */
  legacyTypes?: ReadonlyArray<'boolean' | 'string' | 'number' | 'array'>;
  /**
   * Escape hatch for the JSON Schema generator: when set, this object is
   * emitted verbatim under the setting's properties entry instead of the
   * shape derived from `type`/`properties`/etc. The `description` is still
   * carried forward from the SettingDefinition.
   *
   * Use sparingly — for most settings the generator's normal mapping is
   * preferable so the source schema stays the single source of truth. The
   * one valid case so far is settings whose accepted runtime shape is a
   * union (e.g. string | { path } | { small, large }) that the
   * SettingDefinition `type` field cannot express.
   */
  jsonSchemaOverride?: Record<string, unknown>;
}

/**
 * Schema definition for array item types.
 * Supports simple types (string, number, boolean) and complex object types.
 */
export interface SettingItemDefinition {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  properties?: Record<
    string,
    SettingItemDefinition & {
      required?: boolean;
      enum?: string[];
      additionalProperties?: SettingItemDefinition;
    }
  >;
  items?: SettingItemDefinition;
  required?: boolean;
  enum?: string[];
  description?: string;
  additionalProperties?: boolean | SettingItemDefinition;
}

export interface SettingsSchema {
  [key: string]: SettingDefinition;
}

/**
 * Source for a single tier of custom ASCII art. Either an inline string
 * or a reference to a file on disk that contains the art.
 */
export type AsciiArtSource = string | { path: string };

/**
 * Setting value for `ui.customAsciiArt`. Accepts a bare source (treated as
 * both width tiers), or a width-aware `{small, large}` object.
 */
export type CustomAsciiArtSetting =
  | AsciiArtSource
  | { small?: AsciiArtSource; large?: AsciiArtSource };

/**
 * Common items schema for hook definitions.
 * Used by all hook event types in the hooks configuration.
 */
const HOOK_DEFINITION_ITEMS: SettingItemDefinition = {
  type: 'object',
  description:
    'A hook definition with an optional matcher and a list of hook configurations.',
  properties: {
    matcher: {
      type: 'string',
      description:
        'An optional matcher pattern to filter when this hook definition applies.',
    },
    sequential: {
      type: 'boolean',
      description:
        'Whether the hooks should be executed sequentially instead of in parallel.',
    },
    hooks: {
      type: 'array',
      description: 'The list of hook configurations to execute.',
      required: true,
      items: {
        type: 'object',
        description:
          'A hook configuration entry that defines a hook to execute.',
        properties: {
          type: {
            type: 'string',
            description:
              'The type of hook. Note: "function" type is only available via SDK registration, not settings.json.',
            enum: ['command', 'http'],
            required: true,
          },
          command: {
            type: 'string',
            description:
              'The command to execute when the hook is triggered. Required for "command" type.',
          },
          url: {
            type: 'string',
            description:
              'The URL to send the POST request to. Required for "http" type.',
          },
          headers: {
            type: 'object',
            description:
              'HTTP headers to include in the request. Supports env var interpolation ($VAR, ${VAR}).',
            additionalProperties: { type: 'string' },
          },
          allowedEnvVars: {
            type: 'array',
            description:
              'List of environment variables allowed for interpolation in headers and URL.',
            items: { type: 'string' },
          },
          name: {
            type: 'string',
            description: 'An optional name for the hook.',
          },
          description: {
            type: 'string',
            description: 'An optional description of what the hook does.',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds for the hook execution.',
          },
          env: {
            type: 'object',
            description:
              'Environment variables to set when executing the hook command.',
            additionalProperties: { type: 'string' },
          },
          async: {
            type: 'boolean',
            description:
              'Whether to execute the hook asynchronously (non-blocking, for "command" type only).',
          },
          once: {
            type: 'boolean',
            description:
              'Whether to execute the hook only once per session (for "http" type).',
          },
          statusMessage: {
            type: 'string',
            description: 'A message to display while the hook is executing.',
          },
          shell: {
            type: 'string',
            description: 'The shell to use for command execution.',
            enum: ['bash', 'powershell'],
          },
        },
      },
    },
  },
};

export type MemoryImportFormat = 'tree' | 'flat';
export type DnsResolutionOrder = 'ipv4first' | 'verbatim';

/**
 * The canonical schema for all settings.
 * The structure of this object defines the structure of the `Settings` type.
 * `as const` is crucial for TypeScript to infer the most specific types possible.
 */
const SETTINGS_SCHEMA = {
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
  },

  // Channels configuration (Telegram, Discord, etc.)
  channels: {
    type: 'object',
    label: 'Channels',
    category: 'Advanced',
    requiresRestart: true,
    default: {} as Record<string, Record<string, unknown>>,
    description: 'Configuration for messaging channels.',
    showInDialog: false,
    mergeStrategy: MergeStrategy.SHALLOW_MERGE,
  },

  // Model providers configuration grouped by authType
  modelProviders: {
    type: 'object',
    label: 'Model Providers',
    category: 'Model',
    requiresRestart: false,
    default: {} as ModelProvidersConfig,
    description:
      'Model providers configuration grouped by authType. Each authType contains an array of model configurations.',
    showInDialog: false,
    mergeStrategy: MergeStrategy.REPLACE,
  },

  // Environment variables fallback
  env: {
    type: 'object',
    label: 'Environment Variables',
    category: 'Advanced',
    requiresRestart: true,
    default: {} as Record<string, string>,
    description:
      'Environment variables to set as fallback defaults. These are loaded with the lowest priority: system environment variables > .env files > settings.json env field.',
    showInDialog: false,
    mergeStrategy: MergeStrategy.SHALLOW_MERGE,
  },

  proxy: {
    type: 'string',
    label: 'Proxy',
    category: 'Advanced',
    requiresRestart: true,
    default: undefined as string | undefined,
    description:
      'Proxy URL for CLI HTTP requests. Takes precedence over proxy environment variables when --proxy is not provided.',
    showInDialog: false,
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
        showInDialog: true,
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
      enableAutoUpdate: {
        type: 'boolean',
        label: 'Enable Auto Update',
        category: 'General',
        requiresRestart: false,
        default: true,
        description:
          'Enable automatic update checks and installations on startup.',
        showInDialog: true,
      },
      showSessionRecap: {
        type: 'boolean',
        label: 'Show Session Recap',
        category: 'General',
        requiresRestart: false,
        // Off by default — an ambient background LLM call isn't something
        // users should be opted into silently, especially when `fastModel`
        // is unset and the call would land on the main coding model.
        // Manual `/recap` works regardless.
        default: false,
        description:
          'Auto-show a one-line "where you left off" recap when returning to the terminal after being away. Off by default. Use /recap to trigger manually regardless of this setting.',
        showInDialog: true,
      },
      sessionRecapAwayThresholdMinutes: {
        type: 'number',
        label: 'Session Recap Away Threshold (minutes)',
        category: 'General',
        requiresRestart: false,
        default: 5,
        description:
          "How many minutes the terminal must be blurred before an auto-recap fires on the next focus-in. Matches Claude Code's default of 5 minutes; raise if you briefly alt-tab and do not want recaps to pile up.",
        showInDialog: true,
      },
      gitCoAuthor: {
        type: 'object',
        label: 'Attribution',
        category: 'General',
        requiresRestart: false,
        // Match `normalizeGitCoAuthor`'s runtime defaults so the IDE
        // schema publishes the same "enabled by default" hint users see
        // at runtime. The empty-object form here would silently lose
        // editor-surfaced defaults.
        default: { commit: true, pr: true },
        description:
          'Attribution added to git commits and pull requests created through Qwen Code.',
        showInDialog: false,
        // Pre-V4 settings stored this as a single boolean. The V3→V4
        // migration rewrites those on first launch, but the IDE schema
        // validator runs before that — accept the boolean shape so users
        // editing settings.json in VS Code don't see a spurious warning
        // until they run qwen once. Config.normalizeGitCoAuthor handles
        // the boolean at runtime.
        legacyTypes: ['boolean'],
        properties: {
          commit: {
            type: 'boolean',
            label: 'Attribution: commit',
            category: 'General',
            requiresRestart: false,
            default: true,
            description:
              'Add a Co-authored-by trailer to git commit messages AND attach a per-file AI-attribution git note (`refs/notes/ai-attribution`) for commits made through Qwen Code. Disabling skips both.',
            showInDialog: true,
          },
          pr: {
            type: 'boolean',
            label: 'Attribution: PR',
            category: 'General',
            requiresRestart: false,
            default: true,
            description:
              'Append a Qwen Code attribution line to PR descriptions when running `gh pr create`.',
            showInDialog: true,
          },
        },
      },
      checkpointing: {
        type: 'object',
        label: 'Checkpointing',
        category: 'General',
        requiresRestart: true,
        default: {},
        description: 'Session checkpointing settings.',
        showInDialog: false,
        properties: {
          enabled: {
            type: 'boolean',
            label: 'Enable Checkpointing',
            category: 'General',
            requiresRestart: true,
            default: false,
            description: 'Enable session checkpointing for recovery',
            showInDialog: false,
          },
        },
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
      language: {
        type: 'enum',
        label: 'Language: UI',
        category: 'General',
        requiresRestart: true,
        default: 'auto',
        description:
          'The language for the user interface. Use "auto" to detect from system settings. ' +
          'You can also use custom language codes (e.g., "es", "fr") by placing JS language files ' +
          'in ~/.qwen/locales/ (e.g., ~/.qwen/locales/es.js).',
        showInDialog: true,
        options: [] as readonly SettingEnumOption[],
      },
      outputLanguage: {
        type: 'string',
        label: 'Language: Model',
        category: 'General',
        requiresRestart: true,
        default: 'auto',
        description:
          'The language for LLM output. Use "auto" to detect from system settings, ' +
          'or set a specific language.',
        showInDialog: true,
      },
      dynamicCommandTranslation: {
        type: 'boolean',
        label: 'Language: Dynamic Command Translation',
        category: 'General',
        requiresRestart: false,
        default: false,
        description:
          'Enable AI translation for dynamic slash command descriptions. ' +
          'When disabled, dynamic commands use their original descriptions and do not trigger translation model calls.',
        showInDialog: true,
      },
      terminalBell: {
        type: 'boolean',
        label: 'Terminal Bell Notification',
        category: 'General',
        requiresRestart: false,
        default: true,
        description:
          'Play terminal bell sound when response completes or needs approval.',
        showInDialog: true,
      },
      chatRecording: {
        type: 'boolean',
        label: 'Chat Recording',
        category: 'General',
        requiresRestart: true,
        default: true,
        description:
          'Enable saving chat history to disk. Disabling this will also prevent --continue and --resume from working.',
        showInDialog: false,
      },
      defaultFileEncoding: {
        type: 'enum',
        label: 'Default File Encoding',
        category: 'General',
        requiresRestart: false,
        default: 'utf-8',
        description:
          'Default encoding for new files. Use "utf-8" (default) for UTF-8 without BOM, or "utf-8-bom" for UTF-8 with BOM. Only change this if your project specifically requires BOM.',
        showInDialog: false,
        options: [
          { value: 'utf-8', label: 'UTF-8 (without BOM)' },
          { value: 'utf-8-bom', label: 'UTF-8 with BOM' },
        ],
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
        description: 'The format of the CLI output.',
        showInDialog: false,
        options: [
          { value: 'text', label: 'Text' },
          { value: 'json', label: 'JSON' },
        ],
      },
    },
  },

  dualOutput: {
    type: 'object',
    label: 'Dual Output',
    category: 'Advanced',
    requiresRestart: true,
    default: {},
    description:
      'Dual-output sidecar mode: emit structured JSON events to a ' +
      'second channel while the TUI renders normally on stdout. See ' +
      'docs/users/features/dual-output.md. CLI flags take precedence ' +
      'over these settings.',
    showInDialog: false,
    properties: {
      jsonFile: {
        type: 'string',
        label: 'JSON Event File',
        category: 'Advanced',
        requiresRestart: true,
        default: undefined as string | undefined,
        description:
          'File path for structured JSON event output. Equivalent to ' +
          '--json-file. Ignored if --json-fd or --json-file is also set.',
        showInDialog: false,
      },
      inputFile: {
        type: 'string',
        label: 'Remote Input File',
        category: 'Advanced',
        requiresRestart: true,
        default: undefined as string | undefined,
        description:
          'File path for remote input commands (JSONL). Equivalent to ' +
          '--input-file. Ignored if --input-file is also set.',
        showInDialog: false,
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
      theme: {
        type: 'string',
        label: 'Theme',
        category: 'UI',
        requiresRestart: false,
        default: 'Qwen Dark' as string,
        description: 'The color theme for the UI.',
        showInDialog: true,
      },
      statusLine: {
        type: 'object',
        label: 'Status Line',
        category: 'UI',
        requiresRestart: false,
        default: undefined as
          | {
              type: 'command';
              command: string;
              refreshInterval?: number;
            }
          | undefined,
        description:
          'Custom status line display configuration. Optional `refreshInterval` (seconds, >= 1) re-runs the command on a timer so external data stays fresh.',
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
      showStatusInTitle: {
        type: 'boolean',
        label: 'Show Status in Title',
        category: 'UI',
        requiresRestart: false,
        default: false,
        description:
          'Show Qwen Code status and thoughts in the terminal window title',
        showInDialog: false,
      },
      hideTips: {
        type: 'boolean',
        label: 'Hide Tips',
        category: 'UI',
        requiresRestart: false,
        default: false,
        description: 'Hide helpful tips in the UI',
        showInDialog: true,
      },
      showLineNumbers: {
        type: 'boolean',
        label: 'Show Line Numbers in Code',
        category: 'UI',
        requiresRestart: false,
        default: true,
        description: 'Show line numbers in the code output.',
        showInDialog: true,
      },
      renderMode: {
        type: 'enum',
        label: 'Markdown Render Mode',
        category: 'UI',
        requiresRestart: false,
        default: 'render',
        description:
          'Default Markdown display mode. Use "render" for rich visual previews, or "raw" to show source-oriented Markdown by default. Toggle during a session with Alt/Option+M; on macOS the terminal must send Option as Meta.',
        showInDialog: true,
        options: [
          { value: 'render', label: 'Render visual previews' },
          { value: 'raw', label: 'Show raw source' },
        ],
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
      customWittyPhrases: {
        type: 'array',
        label: 'Custom Witty Phrases',
        category: 'UI',
        requiresRestart: false,
        default: [] as string[],
        description: 'Custom witty phrases to display during loading.',
        showInDialog: false,
      },
      enableWelcomeBack: {
        type: 'boolean',
        label: 'Show Welcome Back Dialog',
        category: 'UI',
        requiresRestart: false,
        default: true,
        description:
          'Show welcome back dialog when returning to a project with conversation history. Choosing "Start new chat session" suppresses the dialog for that project until the project summary changes.',
        showInDialog: true,
      },
      enableUserFeedback: {
        type: 'boolean',
        label: 'Enable User Feedback',
        category: 'UI',
        requiresRestart: false,
        default: true,
        description:
          'Show optional feedback dialog after conversations to help improve Qwen performance.',
        showInDialog: true,
      },
      enableFollowupSuggestions: {
        type: 'boolean',
        label: 'Enable Follow-up Suggestions',
        category: 'UI',
        requiresRestart: false,
        default: false,
        description:
          'Show context-aware follow-up suggestions after task completion. Press Tab or Right Arrow to accept, Enter to accept and submit.',
        showInDialog: true,
      },
      enableCacheSharing: {
        type: 'boolean',
        label: 'Enable Cache Sharing for Suggestions',
        category: 'UI',
        requiresRestart: false,
        default: true,
        description:
          'Use cache-aware forked queries for suggestion generation. Reduces cost on providers that support prefix caching (experimental).',
        showInDialog: false,
      },
      enableSpeculation: {
        type: 'boolean',
        label: 'Enable Speculative Execution',
        category: 'UI',
        requiresRestart: false,
        default: false,
        description:
          'Speculatively execute accepted suggestions before submission. Results appear instantly when you accept (experimental).',
        showInDialog: false,
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
            description: 'Enable loading phrases (disable for accessibility)',
            showInDialog: true,
          },
          screenReader: {
            type: 'boolean',
            label: 'Screen Reader Mode',
            category: 'UI',
            requiresRestart: true,
            default: undefined as boolean | undefined,
            description:
              'Render output in plain-text to be more screen reader accessible',
            showInDialog: false,
          },
        },
      },
      feedbackLastShownTimestamp: {
        type: 'number',
        label: 'Feedback Last Shown Timestamp',
        category: 'UI',
        requiresRestart: false,
        default: 0,
        description: 'The last time the feedback dialog was shown.',
        showInDialog: false,
      },
      compactMode: {
        type: 'boolean',
        label: 'Compact Mode',
        category: 'UI',
        requiresRestart: false,
        default: false,
        description:
          'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).',
        showInDialog: true,
      },
      shellOutputMaxLines: {
        type: 'number',
        label: 'Shell Output Max Lines',
        category: 'UI',
        requiresRestart: false,
        default: 5,
        description:
          'Max number of shell output lines shown inline. Set to 0 to disable the cap and show full output. The hidden line count is still surfaced via the `+N lines` indicator.',
        showInDialog: true,
      },
      hideBanner: {
        type: 'boolean',
        label: 'Hide Banner',
        category: 'UI',
        requiresRestart: false,
        default: false,
        description: 'Hide the startup ASCII banner and info panel.',
        showInDialog: true,
      },
      customBannerTitle: {
        type: 'string',
        label: 'Custom Banner Title',
        category: 'UI',
        requiresRestart: false,
        default: '' as string,
        description:
          'Replace the default ">_ Qwen Code" title shown in the banner info panel. The version suffix is always appended.',
        showInDialog: false,
      },
      customBannerSubtitle: {
        type: 'string',
        label: 'Custom Banner Subtitle',
        category: 'UI',
        requiresRestart: false,
        default: '' as string,
        description:
          'Optional subtitle line rendered between the banner title and the auth/model line. When unset, the info panel keeps its blank spacer row.',
        showInDialog: false,
      },
      customAsciiArt: {
        type: 'object',
        label: 'Custom ASCII Art',
        category: 'UI',
        requiresRestart: false,
        default: undefined as CustomAsciiArtSetting | undefined,
        description:
          'Replace the default QWEN ASCII art. Accepts an inline string, {"path": "..."}, or {"small": ..., "large": ...} for width-aware selection.',
        showInDialog: false,
        // The runtime accepts three shapes (inline string, {path}, or
        // {small,large} where each tier is itself string-or-{path}). The
        // SettingDefinition `type: 'object'` keeps the in-app dialog out of
        // the way (we don't want a multi-line ASCII editor in the TUI), but
        // the JSON Schema needs a real union so VS Code stops flagging the
        // documented bare-string form.
        // The `oneOf` here uses three *mutually exclusive* branches rather
        // than one permissive object branch, so VS Code rejects nonsense
        // like `{ path, small, large }` (which the runtime would also
        // reject — see `normalizeTiers` in `customBanner.ts`).
        jsonSchemaOverride: {
          oneOf: [
            { type: 'string' },
            // Bare `{path}` — no tier keys allowed.
            {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
            // Width-aware `{small?, large?}` — `path` not allowed at this
            // level; each tier is itself string-or-`{path}`.
            {
              type: 'object',
              properties: {
                small: {
                  oneOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: { path: { type: 'string' } },
                      required: ['path'],
                      additionalProperties: false,
                    },
                  ],
                },
                large: {
                  oneOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: { path: { type: 'string' } },
                      required: ['path'],
                      additionalProperties: false,
                    },
                  ],
                },
              },
              additionalProperties: false,
            },
          ],
        },
      },
    },
  },

  ide: {
    type: 'object',
    label: 'IDE',
    category: 'IDE',
    requiresRestart: true,
    default: {},
    description: 'IDE integration settings.',
    showInDialog: false,
    properties: {
      enabled: {
        type: 'boolean',
        label: 'Auto-connect to IDE',
        category: 'IDE',
        requiresRestart: true,
        default: false,
        description: 'Enable IDE integration mode',
        showInDialog: true,
      },
      hasSeenNudge: {
        type: 'boolean',
        label: 'Has Seen IDE Integration Nudge',
        category: 'IDE',
        requiresRestart: false,
        default: false,
        description: 'Whether the user has seen the IDE integration nudge.',
        showInDialog: false,
      },
    },
  },

  privacy: {
    type: 'object',
    label: 'Privacy',
    category: 'Privacy',
    requiresRestart: true,
    default: {},
    description: 'Privacy-related settings.',
    showInDialog: false,
    properties: {
      usageStatisticsEnabled: {
        type: 'boolean',
        label: 'Enable Usage Statistics',
        category: 'Privacy',
        requiresRestart: true,
        default: true,
        description: 'Enable collection of usage statistics',
        showInDialog: true,
      },
    },
  },

  telemetry: {
    type: 'object',
    label: 'Telemetry',
    category: 'Advanced',
    requiresRestart: true,
    default: undefined as TelemetrySettings | undefined,
    description: 'Telemetry configuration.',
    showInDialog: false,
    jsonSchemaOverride: {
      type: 'object',
      properties: {
        includeSensitiveSpanAttributes: {
          description:
            'Include prompt, function_args, and response_text in spans created by the log-to-span bridge. Only controls bridge spans; OTel logs and other telemetry sinks may still receive response_text.',
          type: 'boolean',
          default: false,
        },
      },
      additionalProperties: true,
    },
  },

  fastModel: {
    type: 'string',
    label: 'Fast Model',
    category: 'Model',
    requiresRestart: false,
    default: '',
    description:
      'Model used for generating prompt suggestions and speculative execution. Leave empty to use the main model. A smaller/faster model (e.g., qwen3-coder-flash) reduces latency and cost.',
    showInDialog: true,
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
      maxSessionTurns: {
        type: 'number',
        label: 'Max Session Turns',
        category: 'Model',
        requiresRestart: false,
        default: -1,
        description:
          'Maximum number of user/model/tool turns to keep in a session. -1 means unlimited.',
        showInDialog: false,
      },
      chatCompression: {
        type: 'object',
        label: 'Chat Compression',
        category: 'Model',
        requiresRestart: false,
        default: undefined as ChatCompressionSettings | undefined,
        description: 'Chat compression settings.',
        showInDialog: false,
      },
      sessionTokenLimit: {
        type: 'number',
        label: 'Session Token Limit',
        category: 'Model',
        requiresRestart: false,
        default: undefined as number | undefined,
        description: 'The maximum number of tokens allowed in a session.',
        showInDialog: false,
      },
      skipNextSpeakerCheck: {
        type: 'boolean',
        label: 'Skip Next Speaker Check',
        category: 'Model',
        requiresRestart: false,
        default: true,
        description: 'Skip the next speaker check.',
        showInDialog: false,
      },
      skipLoopDetection: {
        type: 'boolean',
        label: 'Skip Loop Detection',
        category: 'Model',
        requiresRestart: false,
        default: true,
        description: 'Disable all loop detection checks (streaming and LLM).',
        showInDialog: false,
      },
      skipStartupContext: {
        type: 'boolean',
        label: 'Skip Startup Context',
        category: 'Model',
        requiresRestart: true,
        default: false,
        description:
          'Avoid sending the workspace startup context at the beginning of each session.',
        showInDialog: false,
      },
      enableOpenAILogging: {
        type: 'boolean',
        label: 'Enable OpenAI Logging',
        category: 'Model',
        requiresRestart: false,
        default: false,
        description: 'Enable OpenAI logging.',
        showInDialog: false,
      },
      openAILoggingDir: {
        type: 'string',
        label: 'OpenAI Logging Directory',
        category: 'Model',
        requiresRestart: false,
        default: undefined as string | undefined,
        description:
          'Custom directory path for OpenAI API logs. If not specified, defaults to logs/openai in the current working directory.',
        showInDialog: false,
      },
      generationConfig: {
        type: 'object',
        label: 'Generation Configuration',
        category: 'Model',
        requiresRestart: false,
        default: undefined as Record<string, unknown> | undefined,
        description: 'Generation configuration settings.',
        showInDialog: false,
        properties: {
          timeout: {
            type: 'number',
            label: 'Timeout',
            category: 'Generation Configuration',
            requiresRestart: false,
            default: undefined as number | undefined,
            description: 'Request timeout in milliseconds.',
            parentKey: 'generationConfig',
            showInDialog: false,
          },
          maxRetries: {
            type: 'number',
            label: 'Max Retries',
            category: 'Generation Configuration',
            requiresRestart: false,
            default: undefined as number | undefined,
            description: 'Maximum number of retries for failed requests.',
            parentKey: 'generationConfig',
            showInDialog: false,
          },
          enableCacheControl: {
            type: 'boolean',
            label: 'Enable Cache Control',
            category: 'Generation Configuration',
            requiresRestart: false,
            default: true,
            description: 'Enable cache control for DashScope providers.',
            parentKey: 'generationConfig',
            showInDialog: false,
          },
          splitToolMedia: {
            type: 'boolean',
            label: 'Split Tool Result Media',
            category: 'Generation Configuration',
            requiresRestart: false,
            default: false,
            description:
              'When true, media (images / audio / video / files) returned by MCP tool calls is split into a follow-up user message instead of being embedded in the tool message. Required for strict OpenAI-compatible servers (e.g., LM Studio) that reject non-text content on `role: "tool"` messages with HTTP 400 "Invalid \'messages\' in payload". Default false preserves the prior behavior for permissive providers. See QwenLM/qwen-code#3616.',
            parentKey: 'generationConfig',
            showInDialog: false,
          },
          schemaCompliance: {
            type: 'enum',
            label: 'Tool Schema Compliance',
            category: 'Generation Configuration',
            requiresRestart: false,
            default: 'auto',
            description:
              'The compliance mode for tool schemas sent to the model. Use "openapi_30" for strict OpenAPI 3.0 compatibility (e.g., for Gemini).',
            parentKey: 'generationConfig',
            showInDialog: false,
            options: [
              { value: 'auto', label: 'Auto (Default)' },
              { value: 'openapi_30', label: 'OpenAPI 3.0 Strict' },
            ],
          },
          contextWindowSize: {
            type: 'number',
            label: 'Context Window Size',
            category: 'Generation Configuration',
            requiresRestart: false,
            default: undefined,
            description:
              "Overrides the default context window size for the selected model. Use this setting when a provider's effective context limit differs from Qwen Code's default. This value defines the model's assumed maximum context capacity, not a per-request token limit.",
            parentKey: 'generationConfig',
            showInDialog: false,
          },
        },
      },
    },
  },

  modelPricing: {
    type: 'object',
    label: 'Model Pricing',
    category: 'Model',
    requiresRestart: false,
    default: undefined as
      | Record<
          string,
          {
            inputPerMillionTokens?: number;
            outputPerMillionTokens?: number;
          }
        >
      | undefined,
    description:
      'Optional per-model pricing for cost estimation in /stats model. Example: {"qwen3-coder": {"inputPerMillionTokens": 0.30, "outputPerMillionTokens": 1.20}}',
    showInDialog: false,
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
        type: 'object',
        label: 'Context File Name',
        category: 'Context',
        requiresRestart: false,
        default: undefined as string | string[] | undefined,
        description: 'The name of the context file.',
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
      includeDirectories: {
        type: 'array',
        label: 'Include Directories',
        category: 'Context',
        requiresRestart: false,
        default: [] as string[],
        description:
          'Additional directories to include in the workspace context. Missing directories will be skipped with a warning.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
      },
      loadFromIncludeDirectories: {
        type: 'boolean',
        label: 'Load Memory From Include Directories',
        category: 'Context',
        requiresRestart: false,
        default: false,
        description: 'Whether to load memory files from include directories.',
        showInDialog: false,
      },
      clearContextOnIdle: {
        type: 'object',
        label: 'Clear Context On Idle',
        category: 'Context',
        requiresRestart: false,
        default: {},
        description:
          'Settings for clearing stale context after idle periods. Use -1 to disable a threshold.',
        showInDialog: false,
        properties: {
          toolResultsThresholdMinutes: {
            type: 'number',
            label: 'Tool Results Idle Threshold (minutes)',
            category: 'Context',
            requiresRestart: false,
            default: 60 as number,
            description:
              'Minutes of inactivity before clearing old tool result content. Use -1 to disable.',
            showInDialog: false,
          },
          toolResultsNumToKeep: {
            type: 'number',
            label: 'Tool Results Number To Keep',
            category: 'Context',
            requiresRestart: false,
            default: 5 as number,
            description:
              'Number of most-recent compactable tool results to preserve when clearing. Floor at 1.',
            showInDialog: false,
          },
        },
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
            description: 'Respect .gitignore files when searching',
            showInDialog: true,
          },
          respectQwenIgnore: {
            type: 'boolean',
            label: 'Respect .qwenignore',
            category: 'Context',
            requiresRestart: true,
            default: true,
            description: 'Respect .qwenignore files when searching',
            showInDialog: true,
          },
          enableRecursiveFileSearch: {
            type: 'boolean',
            label: 'Enable Recursive File Search',
            category: 'Context',
            requiresRestart: true,
            default: true,
            description: 'Enable recursive file search functionality',
            showInDialog: false,
          },
          enableFuzzySearch: {
            type: 'boolean',
            label: 'Enable Fuzzy Search',
            category: 'Context',
            requiresRestart: true,
            default: true,
            description: 'Enable fuzzy search when searching for files.',
            showInDialog: true,
          },
        },
      },
    },
  },

  memory: {
    type: 'object',
    label: 'Memory',
    category: 'Memory',
    requiresRestart: false,
    default: {},
    description: 'Settings for managed auto-memory.',
    showInDialog: false,
    properties: {
      enableManagedAutoMemory: {
        type: 'boolean',
        label: 'Enable Managed Auto-Memory',
        category: 'Memory',
        requiresRestart: false,
        default: true,
        description:
          'Enable background extraction of memories from conversations.',
        showInDialog: false,
      },
      enableManagedAutoDream: {
        type: 'boolean',
        label: 'Enable Managed Auto-Dream',
        category: 'Memory',
        requiresRestart: false,
        default: false,
        description:
          'Enable automatic consolidation (dream) of collected memories.',
        showInDialog: false,
      },
      enableAutoSkill: {
        type: 'boolean',
        label: 'Enable Auto Skill',
        category: 'Memory',
        requiresRestart: false,
        default: false,
        description:
          'Enable background review for reusable project skills after tool-heavy sessions.',
        showInDialog: false,
      },
    },
  },

  slashCommands: {
    type: 'object',
    label: 'Slash Commands',
    category: 'Advanced',
    requiresRestart: true,
    default: {},
    description:
      'Configuration for slash commands exposed by the CLI. Useful for ' +
      'locking down the command surface in multi-tenant or enterprise ' +
      'deployments.',
    showInDialog: false,
    properties: {
      disabled: {
        type: 'array',
        label: 'Disabled Slash Commands',
        category: 'Advanced',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description:
          'Slash command names to hide and refuse to execute. Matched ' +
          'case-insensitively against the final command name (for extension ' +
          'commands this is the disambiguated form, e.g. "myext.deploy"). ' +
          'Merged as a union across settings scopes, so workspace settings ' +
          'can add to but not remove entries defined in system/user settings.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.UNION,
      },
    },
  },

  permissions: {
    type: 'object',
    label: 'Permissions',
    category: 'Tools',
    requiresRestart: true,
    default: {},
    description:
      'Permission rules controlling tool usage. Rules are evaluated in priority order: deny > ask > allow.',
    showInDialog: false,
    properties: {
      allow: {
        type: 'array',
        label: 'Allow Rules',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description:
          'Tools or commands that are auto-approved without confirmation. ' +
          'Examples: "ShellTool", "Bash(git *)", "ReadFileTool".',
        showInDialog: false,
        mergeStrategy: MergeStrategy.UNION,
      },
      ask: {
        type: 'array',
        label: 'Ask Rules',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description:
          'Tools or commands that always require user confirmation. ' +
          'Takes precedence over allow rules.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.UNION,
      },
      deny: {
        type: 'array',
        label: 'Deny Rules',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description:
          'Tools or commands that are always blocked. Highest priority rule. ' +
          'Examples: "ShellTool", "Bash(rm -rf *)".',
        showInDialog: false,
        mergeStrategy: MergeStrategy.UNION,
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
      sandbox: {
        type: 'object',
        label: 'Sandbox',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as boolean | string | undefined,
        description:
          'Sandbox execution environment (can be a boolean or a path string).',
        showInDialog: false,
      },
      sandboxImage: {
        type: 'string',
        label: 'Sandbox Image',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as string | undefined,
        description:
          'Sandbox image URI used by Docker/Podman when --sandbox-image and QWEN_SANDBOX_IMAGE are not set.',
        showInDialog: false,
      },
      toolSearch: {
        type: 'object',
        label: 'Tool Search',
        category: 'Tools',
        requiresRestart: true,
        default: {},
        description: 'Settings for the ToolSearch discovery mechanism.',
        showInDialog: false,
        properties: {
          enabled: {
            type: 'boolean',
            label: 'Enable ToolSearch',
            category: 'Tools',
            requiresRestart: true,
            default: true,
            description:
              'When enabled, MCP tools are loaded on-demand via ToolSearch to reduce prompt size. Disable this for models that rely on prefix-based KV caching (e.g. DeepSeek) to keep the prompt prefix stable and maximize cache hit rates.',
            showInDialog: true,
          },
        },
      },
      shell: {
        type: 'object',
        label: 'Shell',
        category: 'Tools',
        requiresRestart: false,
        default: {},
        description: 'Settings for shell execution.',
        showInDialog: false,
        properties: {
          enableInteractiveShell: {
            type: 'boolean',
            label: 'Interactive Shell (PTY)',
            category: 'Tools',
            requiresRestart: true,
            default: true,
            description:
              'Use node-pty for an interactive shell experience. Falls back to child_process if PTY is unavailable.',
            showInDialog: true,
          },
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
            default: false,
            description: 'Show color in shell output.',
            showInDialog: false,
          },
        },
      },
      // Legacy tool permission fields – kept for backward compatibility.
      // Use permissions.{allow,ask,deny} instead.
      core: {
        type: 'array',
        label: 'Core Tools (deprecated)',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description: 'Deprecated. Use permissions.allow instead.',
        showInDialog: false,
      },
      allowed: {
        type: 'array',
        label: 'Allowed Tools (deprecated)',
        category: 'Advanced',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description: 'Deprecated. Use permissions.allow instead.',
        showInDialog: false,
      },
      exclude: {
        type: 'array',
        label: 'Exclude Tools (deprecated)',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description: 'Deprecated. Use permissions.deny instead.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.UNION,
      },
      approvalMode: {
        type: 'enum',
        label: 'Tool Approval Mode',
        category: 'Tools',
        requiresRestart: false,
        default: ApprovalMode.DEFAULT,
        description:
          'Approval mode for tool usage. Controls how tools are approved before execution.',
        showInDialog: true,
        options: [
          { value: ApprovalMode.PLAN, label: 'Plan' },
          { value: ApprovalMode.DEFAULT, label: 'Default' },
          { value: ApprovalMode.AUTO_EDIT, label: 'Auto Edit' },
          { value: ApprovalMode.YOLO, label: 'YOLO' },
        ],
      },
      autoAccept: {
        type: 'boolean',
        label: 'Auto Accept',
        category: 'Tools',
        requiresRestart: false,
        default: false,
        description:
          'Automatically accept and execute tool calls that are considered safe (e.g., read-only operations) without explicit user confirmation.',
        showInDialog: false,
      },
      discoveryCommand: {
        type: 'string',
        label: 'Tool Discovery Command',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as string | undefined,
        description: 'Command to run for tool discovery.',
        showInDialog: false,
      },
      callCommand: {
        type: 'string',
        label: 'Tool Call Command',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as string | undefined,
        description: 'Command to run for tool calls.',
        showInDialog: false,
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
      useBuiltinRipgrep: {
        type: 'boolean',
        label: 'Use Builtin Ripgrep',
        category: 'Tools',
        requiresRestart: false,
        default: true,
        description:
          'Use the bundled ripgrep binary. When set to false, the system-level "rg" command will be used instead. This setting is only effective when useRipgrep is true.',
        showInDialog: false,
      },
      truncateToolOutputThreshold: {
        type: 'number',
        label: 'Tool Output Truncation Threshold',
        category: 'General',
        requiresRestart: true,
        default: DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
        description:
          'Truncate tool output if it is larger than this many characters. Set to -1 to disable.',
        showInDialog: false,
      },
      truncateToolOutputLines: {
        type: 'number',
        label: 'Tool Output Truncation Lines',
        category: 'General',
        requiresRestart: true,
        default: DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
        description: 'The number of lines to keep when truncating tool output.',
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
        mergeStrategy: MergeStrategy.CONCAT,
      },
      excluded: {
        type: 'array',
        label: 'Exclude MCP Servers',
        category: 'MCP',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description: 'A list of MCP servers to exclude.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
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
            default: false,
            description: 'Setting to track whether Folder trust is enabled.',
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
          useExternal: {
            type: 'boolean',
            label: 'Use External Auth',
            category: 'Security',
            requiresRestart: true,
            default: undefined as boolean | undefined,
            description: 'Whether to use an external authentication flow.',
            showInDialog: false,
          },
          apiKey: {
            type: 'string',
            label: 'API Key',
            category: 'Security',
            requiresRestart: true,
            default: undefined as string | undefined,
            description: 'API key for OpenAI compatible authentication.',
            showInDialog: false,
          },
          baseUrl: {
            type: 'string',
            label: 'Base URL',
            category: 'Security',
            requiresRestart: true,
            default: undefined as string | undefined,
            description: 'Base URL for OpenAI compatible API.',
            showInDialog: false,
          },
        },
      },
      allowedHttpHookUrls: {
        type: 'array',
        label: 'Allowed HTTP Hook URLs',
        category: 'Security',
        requiresRestart: false,
        default: [] as string[],
        description:
          'Whitelist of URL patterns for HTTP hooks. Supports * wildcard. If empty, all URLs are allowed (subject to SSRF protection).',
        showInDialog: false,
        items: {
          type: 'string',
          description: 'URL pattern (supports * wildcard)',
        },
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
        default: false,
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
      excludedEnvVars: {
        type: 'array',
        label: 'Excluded Project Environment Variables',
        category: 'Advanced',
        requiresRestart: false,
        default: ['DEBUG', 'DEBUG_MODE'] as string[],
        description: 'Environment variables to exclude from project context.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.UNION,
      },
      bugCommand: {
        type: 'object',
        label: 'Bug Command',
        category: 'Advanced',
        requiresRestart: false,
        default: undefined as BugCommandSettings | undefined,
        description: 'Configuration for the bug report command.',
        showInDialog: false,
      },
      runtimeOutputDir: {
        type: 'string',
        label: 'Runtime Output Directory',
        category: 'Advanced',
        requiresRestart: true,
        default: undefined as string | undefined,
        description:
          'Custom directory for runtime output (temp files, debug logs, session data, todos, etc.). ' +
          'Config files remain at ~/.qwen (or QWEN_HOME if set). Env var QWEN_RUNTIME_DIR takes priority.',
        showInDialog: false,
      },
    },
  },

  agents: {
    type: 'object',
    label: 'Agents',
    category: 'Advanced',
    requiresRestart: false,
    default: {},
    description:
      'Settings for multi-agent collaboration features (Arena, Team, Swarm).',
    showInDialog: false,
    properties: {
      displayMode: {
        type: 'enum',
        label: 'Display Mode',
        category: 'Advanced',
        requiresRestart: false,
        default: undefined as string | undefined,
        description:
          'Display mode for multi-agent sessions. Currently only "in-process" is supported.',
        showInDialog: false,
        options: [
          { value: 'in-process', label: 'In-process' },
          // { value: 'tmux', label: 'tmux' },
          // { value: 'iterm2', label: 'iTerm2' },
        ],
      },
      arena: {
        type: 'object',
        label: 'Arena',
        category: 'Advanced',
        requiresRestart: false,
        default: {},
        description: 'Settings for Arena (multi-model competitive execution).',
        showInDialog: false,
        properties: {
          worktreeBaseDir: {
            type: 'string',
            label: 'Worktree Base Directory',
            category: 'Advanced',
            requiresRestart: true,
            default: undefined as string | undefined,
            description:
              'Custom base directory for Arena worktrees. Defaults to ~/.qwen/arena.',
            showInDialog: false,
          },
          preserveArtifacts: {
            type: 'boolean',
            label: 'Preserve Arena Artifacts',
            category: 'Advanced',
            requiresRestart: false,
            default: false,
            description:
              'When enabled, Arena worktrees and session state files are preserved after the session ends or the main agent exits.',
            showInDialog: true,
          },
          maxRoundsPerAgent: {
            type: 'number',
            label: 'Max Rounds Per Agent',
            category: 'Advanced',
            requiresRestart: false,
            default: undefined as number | undefined,
            description:
              'Maximum number of rounds (turns) each agent can execute. No limit if unset.',
            showInDialog: false,
          },
          timeoutSeconds: {
            type: 'number',
            label: 'Timeout (seconds)',
            category: 'Advanced',
            requiresRestart: false,
            default: undefined as number | undefined,
            description:
              'Total timeout in seconds for the Arena session. No limit if unset.',
            showInDialog: false,
          },
        },
      },
      team: {
        type: 'object',
        label: 'Team',
        category: 'Advanced',
        requiresRestart: false,
        default: {},
        description:
          'Settings for Agent Team (role-based collaborative execution). Reserved for future use.',
        showInDialog: false,
      },
      swarm: {
        type: 'object',
        label: 'Swarm',
        category: 'Advanced',
        requiresRestart: false,
        default: {},
        description:
          'Settings for Agent Swarm (parallel sub-agent execution). Reserved for future use.',
        showInDialog: false,
      },
    },
  },

  disableAllHooks: {
    type: 'boolean',
    label: 'Disable All Hooks',
    category: 'Advanced',
    requiresRestart: true, // Future enhancement: consider supporting mid-session toggle for better UX
    default: false,
    description:
      'Temporarily disable all hooks without deleting configurations. Default is false (hooks enabled).',
    showInDialog: false,
  },

  hooks: {
    type: 'object',
    label: 'Hooks',
    category: 'Advanced',
    requiresRestart: false,
    default: {},
    description:
      'Hook event configurations for extending CLI behavior at various lifecycle points.',
    showInDialog: false,
    properties: {
      UserPromptSubmit: {
        type: 'array',
        label: 'Before Agent Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description:
          'Hooks that execute before agent processing. Can modify prompts or inject context.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      Stop: {
        type: 'array',
        label: 'After Agent Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description:
          'Hooks that execute after agent processing. Can post-process responses or log interactions.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      Notification: {
        type: 'array',
        label: 'Notification Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description: 'Hooks that execute when notifications are sent.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      PreToolUse: {
        type: 'array',
        label: 'Pre Tool Use Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description: 'Hooks that execute before tool execution.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      PostToolUse: {
        type: 'array',
        label: 'Post Tool Use Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description: 'Hooks that execute after successful tool execution.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      PostToolUseFailure: {
        type: 'array',
        label: 'Post Tool Use Failure Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description: 'Hooks that execute when tool execution fails. ',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      SessionStart: {
        type: 'array',
        label: 'Session Start Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description: 'Hooks that execute when a new session starts or resumes.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      SessionEnd: {
        type: 'array',
        label: 'Session End Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description: 'Hooks that execute when a session ends.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      PreCompact: {
        type: 'array',
        label: 'Pre Compact Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description: 'Hooks that execute before conversation compaction.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      SubagentStart: {
        type: 'array',
        label: 'Subagent Start Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description:
          'Hooks that execute when a subagent (Task tool call) is started.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      SubagentStop: {
        type: 'array',
        label: 'Subagent Stop Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description:
          'Hooks that execute right before a subagent (Task tool call) concludes its response.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
      PermissionRequest: {
        type: 'array',
        label: 'Permission Request Hooks',
        category: 'Advanced',
        requiresRestart: false,
        default: [],
        description:
          'Hooks that execute when a permission dialog is displayed.',
        showInDialog: false,
        mergeStrategy: MergeStrategy.CONCAT,
        items: HOOK_DEFINITION_ITEMS,
      },
    },
  },

  experimental: {
    type: 'object',
    label: 'Experimental',
    category: 'Experimental',
    requiresRestart: true,
    default: {},
    description: 'Settings to enable experimental features.',
    showInDialog: false,
    properties: {
      cron: {
        type: 'boolean',
        label: 'Enable Cron/Loop Tools',
        category: 'Experimental',
        requiresRestart: true,
        default: false,
        description:
          'Enable in-session cron/loop tools (experimental). When enabled, the model can create recurring prompts using cron_create, cron_list, and cron_delete tools. Can also be enabled via QWEN_CODE_ENABLE_CRON=1 environment variable.',
        showInDialog: true,
      },
      emitToolUseSummaries: {
        type: 'boolean',
        label: 'Tool Use Summaries',
        category: 'Experimental',
        requiresRestart: false,
        default: true,
        description:
          'Generate a short LLM-based label after each tool batch completes. In compact mode the label replaces the generic `Tool × N` header; in full mode it appears as a dim `● <label>` line below the tool group. Requires a fast model to be configured; runs in parallel with the next API call so latency is hidden. Currently affects interactive CLI rendering only — SDK / non-interactive emission of the `tool_use_summary` message is not yet wired (the message factory is exported for a follow-up PR). Can be overridden with QWEN_CODE_EMIT_TOOL_USE_SUMMARIES=0 or =1.',
        showInDialog: true,
      },
    },
  },
} as const satisfies SettingsSchema;

export type SettingsSchemaType = typeof SETTINGS_SCHEMA;

export function getSettingsSchema(): SettingsSchemaType {
  // Inject dynamic language options
  const schema = SETTINGS_SCHEMA as unknown as SettingsSchema;
  if (schema['general']?.properties?.['language']) {
    (
      schema['general'].properties['language'] as {
        options?: SettingEnumOption[];
      }
    ).options = getLanguageSettingsOptions();
  }
  return SETTINGS_SCHEMA;
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
        : T[K]['default'];
};

export type Settings = InferSettings<SettingsSchemaType>;
