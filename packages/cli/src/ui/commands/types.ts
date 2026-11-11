/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type {
  HistoryItemWithoutId,
  HistoryItem,
  ConfirmationRequest,
} from '../types.js';
import type { FullScreenPanelActions } from '../contexts/FullScreenPanelContext.js';
import type {
  UiLocale,
  Logger,
  CommandActionReturn,
  AgentDefinition,
  AgentLoopContext,
  SessionResumeData,
  Message,
  HookEventName,
  PendingHookOutput,
  PromptBuildResult,
  ConfigStartupGate,
  PastedContent,
} from '@qwen-code/core';
import type { SessionHandle } from '../../session/session.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type {
  ExtensionUpdateAction,
  ExtensionUpdateStatus,
} from '../state/extensions.js';
import type { RunManualCompress } from '../hooks/localSession.shared.js';

// Grouped dependencies for clarity and easier mocking
export interface CommandContext {
  /** Parent operation cancellation, supplied by headless and ACP callers. */
  abortSignal?: AbortSignal;
  // Invocation properties for when commands are called.
  invocation?: {
    /** The raw, untrimmed input string from the user. */
    raw: string;
    /** The primary name of the command that was matched. */
    name: string;
    /** The arguments string that follows the command name. */
    args: string;
    /**
     * Images pasted in the prompt input alongside this command, keyed by
     * their `[Image #N]` placeholder id in `args`.
     */
    pastedContents?: Record<number, PastedContent>;
  };
  // Core services and configuration
  services: {
    // TODO(abhipatel12): Ensure that config is never null.
    agentContext: AgentLoopContext | null;
    settings: LoadedSettings;
    logger: Logger;
    /** Current conversation operations, independent of product and local configuration. */
    sessionHandle?: SessionHandle;
  };
  // UI state and history management
  ui: {
    /** Effective display language from the local TUI i18n provider. */
    locale?: UiLocale;
    /** Adds a new item to the history display. */
    addItem: UseHistoryManagerReturn['addItem'] &
      ((
        itemData: HistoryItemWithoutId,
        baseTimestamp?: number,
        isResuming?: boolean,
      ) => number);
    /** Updates an existing history item. */
    updateItem: UseHistoryManagerReturn['updateItem'];
    /** Clears all history items and the console screen. */
    clear: () => void;
    /**
     * Sets the transient debug message displayed in the application footer in debug mode.
     */
    setDebugMessage: (message: string) => void;
    /** The currently pending history item, if any. */
    pendingItem: HistoryItemWithoutId | null;
    /**
     * Sets a pending item in the history, which is useful for indicating
     * that a long-running operation is in progress.
     *
     * @param item The pending item, `null`, or an updater receiving the latest item.
     */
    setPendingItem: Dispatch<SetStateAction<HistoryItemWithoutId | null>>;
    /**
     * Loads a new set of history items, replacing the current history.
     *
     * @param history The array of history items to load.
     * @param postLoadInput Optional text to set in the input buffer after loading history.
     */
    loadHistory: (
      history: HistoryItem[] | HistoryItemWithoutId[],
      postLoadInput?: string,
      options?: {
        messages?: Message[];
      },
    ) => void | Promise<void>;
    resumeSession: (
      resumedSessionData: SessionResumeData,
      postLoadInput?: string,
    ) => Promise<boolean>;
    /** Toggles a special display mode. */
    toggleCorgiMode: () => void;
    toggleDebugProfiler: () => void;
    toggleVimEnabled: () => Promise<boolean>;
    reloadCommands: () => void;
    openAgentConfigDialog: (
      name: string,
      definition: AgentDefinition,
    ) => void;
    extensionsUpdateState: Map<string, ExtensionUpdateStatus>;
    dispatchExtensionStateUpdate: (action: ExtensionUpdateAction) => void;
    addConfirmUpdateExtensionRequest: (
      value: ConfirmationRequest | null,
    ) => void;
    /**
     * Sets a confirmation request to be displayed to the user.
     * Pass `null` to dismiss any currently active confirmation request.
     *
     * @param value The confirmation request details, or `null` to clear.
     */
    setConfirmationRequest: (value: ConfirmationRequest | null) => void;
    removeComponent: () => void;
    removeFullScreenComponent: () => void;
    /** Sets a full-screen dialog that replaces the entire layout. */
    setFullScreenComponent: (content: ReactNode) => void;
    /** Opens the workflow task panel in the main task-view slot. */
    viewWorkflowSessions: () => void;
    /** Sets a custom dialog component to display, or null to close it. */
    setCustomDialog: (dialog: ReactNode | null) => void;
    /**
     * Full-screen panel management.
     * Use this to open/close/toggle named panels (debug console, tool views, etc.)
     * Panels registered via this API render in the same fullscreen slot.
     */
    fullScreenPanel: FullScreenPanelActions;
    toggleShortcutsHelp: () => void;
    /** Registers a cancellable callback, returns an unregister function. */
    registerCancellable: (callback: () => void) => () => void;
  };
  // Session-specific data
  session: {
    stats: SessionStatsState;
    /** A transient list of shell commands the user has approved for this session. */
    sessionShellAllowlist: Set<string>;
  };
  // Flag to indicate if an overwrite has been confirmed
  overwriteConfirmed?: boolean;

  // ── Conversation history access (from the local session owner) ──
  // Commands read `context.messages` and write via `context.setMessages`
  // to operate on the shared REPL state.

  /** 当前会话历史快照，包含宿主消息与标准模型载荷。 */
  messages?: readonly Message[];

  /** Functional updater to replace/modify conversation history. */
  setMessages?: (updater: (prev: Message[]) => Message[]) => void;

  /**
   * Explicitly persist a runtime Message to the transcript JSONL.
   * Used by commands (e.g. /compact) that inject synthetic messages which
   * must survive across resume but are not emitted through the normal query
   * loop.
   */
  recordMessage?: (message: Message) => Promise<void>;
  /**
   * Run the compression pipeline + apply post-compact recovery attachments
   * (files/plan/invoked_skills/plan_mode/delta re-announcements) in one shot.
   * Shared with the auto-compact path — both entries produce identical
   * runtime + transcript state post-compaction. Used by the /compact command.
   */
  runManualCompress?: RunManualCompress;

  /** Builds the current TUI system prompt when no completed turn has cached it. */
  ensurePromptBuildResult?: () => Promise<PromptBuildResult | undefined>;

  /**
   * Queue hook additionalContext into the attachment pipeline.
   * Used by reset commands to inject SessionStart hook context
   * into the new session's first API request.
   */
  queueHookContext?: (
    context: string,
    hookEventName?: HookEventName,
    sourceType?: PendingHookOutput['sourceType'],
  ) => void;
}

/** The return type for a command action that results in the app quitting. */
export interface QuitActionReturn {
  type: 'quit';
  messages: HistoryItem[];
}

/**
 * The return type for a command action that needs to open a dialog.
 */
export interface OpenDialogActionReturn {
  type: 'dialog';
  props?: Record<string, unknown>;

  dialog:
    | 'theme'
    | 'editor'
    | 'settings'
    | 'sessionBrowser'
    | 'rewind'
    | 'agentConfig'
    | 'agentBrowser'
    | 'mcpBrowser'
    | 'mcpApproval'
    | 'hookBrowser'
    | 'hookConfig'
    | 'skillBrowser'
    | 'pluginBrowser';
}

/**
 * The return type for a command action that needs to pause and request
 * confirmation for a set of shell commands before proceeding.
 */
export interface ConfirmShellCommandsActionReturn {
  type: 'confirm_shell_commands';
  /** The list of shell commands that require user confirmation. */
  commandsToConfirm: string[];
  /** The original invocation context to be re-run after confirmation. */
  originalInvocation: {
    raw: string;
  };
}

export interface ConfirmActionReturn {
  type: 'confirm_action';
  /** The React node to display as the confirmation prompt. */
  prompt: ReactNode;
  /** Whether to show an explicit cancel option. Escape always cancels. */
  showCancelOption?: boolean;
  /** Whether to hide the shared confirmation dialog title. */
  hideTitle?: boolean;
  /** Optional action to run directly after confirmation. */
  onConfirm?: () => void | Promise<void>;
  /** The original invocation context to be re-run after confirmation. */
  originalInvocation: {
    raw: string;
  };
}

export interface OpenCustomDialogActionReturn {
  type: 'custom_dialog';
  component: ReactNode;
}

export interface OpenFullScreenDialogActionReturn {
  type: 'fullscreen_dialog';
  component: ReactNode;
}

/**
 * The return type for a command action whose text result should be recorded
 * in the LLM transcript and made visible to the model in future turns.
 *
 * Use this instead of `{ type: 'message', messageType: 'info' }` when the
 * output represents a meaningful state change the model should be aware of
 * (e.g. "Entered Vim mode", "Model changed to my-model").
 */
export interface LocalCommandResultReturn {
  type: 'local_command_result';
  text: string;
  severity?: 'info' | 'error';
}

export type SlashCommandActionReturn =
  | CommandActionReturn<HistoryItemWithoutId[]>
  | QuitActionReturn
  | OpenDialogActionReturn
  | ConfirmShellCommandsActionReturn
  | ConfirmActionReturn
  | OpenCustomDialogActionReturn
  | OpenFullScreenDialogActionReturn
  | LocalCommandResultReturn;

export enum CommandKind {
  BUILT_IN = 'built-in',
  MCP_PROMPT = 'mcp-prompt',
  AGENT = 'agent',
  SKILL = 'skill',
  PLUGIN = 'plugin',
  WORKFLOW = 'workflow',
  DYNAMIC = 'dynamic',
}

export type BridgeCommandType = 'prompt' | 'local' | 'local-jsx';

export type BridgeCommandTypeResolver =
  | BridgeCommandType
  | ((
      args: string,
      context: {
        input: string;
        command: SlashCommand;
      },
    ) => BridgeCommandType);

// The standardized contract for any command in the system.
export interface SlashCommand {
  name: string;
  /**
   * Human-friendly label used by UI surfaces and routing. Command routing
   * matches against `name`, `displayName`, then `altNames` in order via
   * `findCommandByPart`. Typically sourced from a skill/plugin's frontmatter
   * `name:` (when present); falls back to `name` when omitted.
   */
  displayName?: string;
  altNames?: string[];
  description: string;
  hidden?: boolean;

  /** Register after regular commands, only when all names and aliases are available. */
  fallback?: boolean;

  kind: CommandKind;

  /**
   * Controls whether the command auto-executes when selected with Enter.
   *
   * If true, pressing Enter on the suggestion will execute the command immediately.
   * If false or undefined, pressing Enter will autocomplete the command into the prompt window.
   */
  autoExecute?: boolean;

  /**
   * Whether this command can be safely executed while the agent is busy (e.g. streaming a response).
   */
  isSafeConcurrent?: boolean;

  /**
   * If true, the command is an instant UI toggle that runs without setting
   * isProcessing, adding to conversation history, or triggering the loading
   * indicator. The action is executed synchronously and the processor returns
   * immediately.
   */
  isInstant?: boolean;

  // Optional metadata for plugin commands
  pluginName?: string;

  // Optional metadata for MCP commands
  mcpServerName?: string;

  // Optional metadata for prompt-style dynamic commands.
  hasUserSpecifiedDescription?: boolean;
  whenToUse?: string;
  progressMessage?: string;
  contentLength?: number;
  source?: string;
  loadedFrom?: string;
  workflow?: {
    source: string;
    pluginName?: string;
    pluginManifest?: unknown;
    pluginRepository?: string;
    pluginPath?: string;
  };

  // The action to run. Optional for parent commands that only group sub-commands.
  action?: (
    context: CommandContext,
    args: string, // TODO: Remove args. CommandContext now contains the complete invocation.
  ) =>
    | void
    | SlashCommandActionReturn
    | Promise<void | SlashCommandActionReturn>;

  // Strings use the same text for display and insertion. Objects can display a
  // friendly label while inserting a canonical value.
  completion?: (
    context: CommandContext,
    partialArg: string,
  ) =>
    | Promise<
        Array<string | { label: string; value: string; description?: string }>
      >
    | Array<string | { label: string; value: string; description?: string }>;

  /**
   * Whether to show the loading indicator while fetching completions.
   * Defaults to true. Set to false for fast completions to avoid flicker.
   */
  showCompletionLoading?: boolean;

  /**
   * Whether the command expects arguments.
   * If false, and the command is a subcommand, the command parser may treat
   * any following text as arguments for the parent command instead of this subcommand,
   * provided the parent command has an action.
   * Defaults to true.
   */
  takesArgs?: boolean;

  /** Hint text for command arguments, displayed as dim text after the command name. */
  argumentHint?: string;

  /** Named argument list for progressive hint display (e.g., ['source', 'dest']). */
  argNames?: string[];

  /**
   * If true, the user's input text will not be added to the conversation feed
   * when this command is executed. Useful for transient dialogs like /btw.
   */
  hideInput?: boolean;

  /**
   * Keep the command visible in the conversation feed without persisting its
   * input as transcript context. Session-navigation commands use this because
   * their input belongs to the UI transition, not either conversation chain.
   */
  omitInputFromTranscript?: boolean;

  /**
   * Runtime behavior when invoked from Remote Control / bridge input.
   * Mirrors cc command types: prompt commands are safe, local commands need an
   * allowlist, and local-jsx commands are blocked because they require TUI.
   */
  bridgeCommandType?: BridgeCommandTypeResolver;

  /**
   * Startup gates that must be ready before this command action runs.
   * The active mode policy owns how these gates are waited on.
   */
  requiredStartupGates?: ConfigStartupGate[];

  subCommands?: SlashCommand[];
}
