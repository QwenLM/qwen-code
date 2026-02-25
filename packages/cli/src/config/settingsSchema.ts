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
}

export interface SettingsSchema {
  [key: string]: SettingDefinition;
}

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

  // Coding Plan configuration
  codingPlan: {
    type: 'object',
    label: 'Coding Plan',
    category: 'Model',
    requiresRestart: false,
    default: {},
    description: 'Coding Plan template version tracking and configuration.',
    showInDialog: false,
    properties: {
      version: {
        type: 'string',
        label: 'Coding Plan Template Version',
        category: 'Model',
        requiresRestart: false,
        default: undefined as string | undefined,
        description:
          'SHA256 hash of the Coding Plan template. Used to detect template updates.',
        showInDialog: false,
      },
    },
  },

  // Environment variables fallback
  env: {
    type: 'object',
    label: 'Environment Variables',
    category: 'Advanced',
    requiresRestart: true,
    default: {} as Record<string, string>,
    description:
      'Environment variables to set as fallback defaults. These are loaded with the lowest priority: system environment variables > .env files > settings.env.',
    showInDialog: false,
    mergeStrategy: MergeStrategy.SHALLOW_MERGE,
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
      gitCoAuthor: {
        type: 'boolean',
        label: 'Attribution: commit',
        category: 'General',
        requiresRestart: false,
        default: true,
        description:
          'Automatically add a Co-authored-by trailer to git commit messages when commits are made through Qwen Code.',
        showInDialog: true,
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
          'Show welcome back dialog when returning to a project with conversation history.',
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
      summarizeToolOutput: {
        type: 'object',
        label: 'Summarize Tool Output',
        category: 'Model',
        requiresRestart: false,
        default: undefined as
          | Record<string, { tokenBudget?: number }>
          | undefined,
        description: 'Settings for summarizing tool output.',
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
        default: false,
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
            default: false,
            description:
              'Use node-pty for an interactive shell experience. Fallback to child_process still applies.',
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
      core: {
        type: 'array',
        label: 'Core Tools',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description: 'Paths to core tool definitions.',
        showInDialog: false,
      },
      allowed: {
        type: 'array',
        label: 'Allowed Tools',
        category: 'Advanced',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description:
          'A list of tool names that will bypass the confirmation dialog.',
        showInDialog: false,
      },
      exclude: {
        type: 'array',
        label: 'Exclude Tools',
        category: 'Tools',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description: 'Tool names to exclude from discovery.',
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
      enableToolOutputTruncation: {
        type: 'boolean',
        label: 'Enable Tool Output Truncation',
        category: 'General',
        requiresRestart: true,
        default: true,
        description: 'Enable truncation of large tool outputs.',
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
      },
      excluded: {
        type: 'array',
        label: 'Exclude MCP Servers',
        category: 'MCP',
        requiresRestart: true,
        default: undefined as string[] | undefined,
        description: 'A list of MCP servers to exclude.',
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
      tavilyApiKey: {
        type: 'string',
        label: 'Tavily API Key (Deprecated)',
        category: 'Advanced',
        requiresRestart: false,
        default: undefined as string | undefined,
        description:
          '⚠️ DEPRECATED: Please use webSearch.provider configuration instead. Legacy API key for the Tavily API.',
        showInDialog: false,
      },
    },
  },

  webSearch: {
    type: 'object',
    label: 'Web Search',
    category: 'Advanced',
    requiresRestart: true,
    default: undefined as
      | {
          provider: Array<{
            type: 'tavily' | 'google' | 'dashscope';
            apiKey?: string;
            searchEngineId?: string;
          }>;
          default: string;
        }
      | undefined,
    description: 'Configuration for web search providers.',
    showInDialog: false,
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
      visionModelPreview: {
        type: 'boolean',
        label: 'Vision Model Preview',
        category: 'Experimental',
        requiresRestart: false,
        default: true,
        description:
          'Enable vision model support and auto-switching functionality. When disabled, vision models like qwen-vl-max-latest will be hidden and auto-switching will not occur.',
        showInDialog: false,
      },
      vlmSwitchMode: {
        type: 'string',
        label: 'VLM Switch Mode',
        category: 'Experimental',
        requiresRestart: false,
        default: undefined as string | undefined,
        description:
          'Default behavior when images are detected in input. Values: once (one-time switch), session (switch for entire session), persist (continue with current model). If not set, user will be prompted each time. This is a temporary experimental feature.',
        showInDialog: false,
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
