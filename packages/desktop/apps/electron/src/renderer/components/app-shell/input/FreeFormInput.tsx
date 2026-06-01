import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Command as CommandPrimitive } from 'cmdk';
// eslint-disable-next-line import/no-internal-modules
import { AnimatePresence, motion } from 'motion/react';
import {
  Paperclip,
  ArrowUp,
  Square,
  Check,
  ChevronDown,
  AlertCircle,
  CornerDownRight,
  X,
} from 'lucide-react';
import { Icon_Home, Icon_Folder } from '@craft-agent/ui';

import { useDirectoryPicker } from '@/hooks/useDirectoryPicker';
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser';
import { Button } from '@/components/ui/button';
import {
  InlineSlashCommand,
  useInlineSlashCommand,
  type SlashCommandId,
} from '@/components/ui/slash-command-menu';
import {
  InlineMentionMenu,
  useInlineMention,
  type MentionItem,
} from '@/components/ui/mention-menu';
import {
  InlineLabelMenu,
  useInlineLabelMenu,
} from '@/components/ui/label-menu';
import type { LabelConfig } from '@craft-agent/shared/labels';
import { parseMentions } from '@/lib/mentions';
import {
  RichTextInput,
  type RichTextInputHandle,
} from '@/components/ui/rich-text-input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui';
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { coerceInputText } from '@/lib/input-text';
import { getNextPermissionMode } from '@/lib/permission-mode-cycle';
import { isMac, PATH_SEP, getPathBasename } from '@/lib/platform';
import { applySmartTypography } from '@/lib/smart-typography';
import { AttachmentPreview } from '../AttachmentPreview';
import {
  QWEN_MODELS,
  getModelShortName,
  getModelDisplayName,
  getModelContextWindow,
  type ModelDefinition,
} from '@config/models';
import { resolveEffectiveConnectionSlug } from '@config/llm-connections';
import { useOptionalAppShellContext } from '@/context/AppShellContext';
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover';
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge';
import type {
  AvailableSlashCommand,
  FileAttachment,
  LoadedSource,
  LoadedSkill,
  Message,
} from '../../../../shared/types';
import {
  PERMISSION_MODE_ORDER,
  type PermissionMode,
} from '@craft-agent/shared/agent/modes';
import { type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';
import { useEscapeInterrupt } from '@/context/EscapeInterruptContext';
import { hasOpenOverlay } from '@/lib/overlay-detection';
import { ToolbarStatusSlot } from './ToolbarStatusSlot';
import { buildPlanApprovalMessage } from '../plan-approval-message';
import { shouldHandleScopedInputEvent } from './input-event-guards';
import {
  clearPendingFocusForSession,
  consumePendingFocusForSession,
} from './focus-input-events';
import {
  getRecentWorkingDirs,
  addRecentWorkingDir,
  removeRecentWorkingDir,
} from './working-directory-history';
import { CompactPermissionModeSelector } from './CompactPermissionModeSelector';
import { FEATURE_FLAGS } from '@craft-agent/shared/feature-flags';

/**
 * Format token count for display (e.g., 1500 -> "1.5k", 200000 -> "200k")
 */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`;
  }
  return tokens.toString();
}

function clampUsagePercent(percent: number): number {
  return Math.max(0, Math.min(100, percent));
}

function formatUsagePercent(percent: number): string {
  return Number.isInteger(percent) ? percent.toString() : percent.toFixed(1);
}

function getModelContextWindowFromList(
  models: Array<ModelDefinition | string> | undefined,
  modelId: string,
): number | undefined {
  const model = models?.find(
    (item) => typeof item !== 'string' && item.id === modelId,
  );
  return typeof model === 'string' ? undefined : model?.contextWindow;
}

function formatFollowUpChipText(
  text: string,
  fallback: string,
  maxLength = 50,
): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized;
}

function logInputError(message: string, error: unknown): void {
  if (typeof window === 'undefined') return;
  window.electronAPI?.debugLog?.(message, error);
}

interface ContextUsageIndicatorProps {
  usedTokens: number;
  totalTokens?: number;
  isCompacting?: boolean;
  usagePercent?: number;
  usedDisplay?: string;
  totalDisplay?: string;
}

function ContextUsageIndicator({
  usedTokens,
  totalTokens,
  isCompacting = false,
  usagePercent,
  usedDisplay,
  totalDisplay,
}: ContextUsageIndicatorProps) {
  const { t } = useTranslation();
  const percent =
    usagePercent != null
      ? clampUsagePercent(usagePercent)
      : totalTokens && totalTokens > 0
        ? clampUsagePercent(Math.round((usedTokens / totalTokens) * 100))
        : null;
  const ringPercent = percent ?? 0;
  const percentDisplay = percent !== null ? formatUsagePercent(percent) : null;
  const usedLabel = usedDisplay ?? formatTokenCount(usedTokens);
  const totalLabel =
    totalDisplay ??
    (totalTokens ? formatTokenCount(totalTokens) : t('common.unknown'));
  const percentLabel =
    percent !== null
      ? t('chat.contextUsage.percentUsed', { percent: percentDisplay })
      : t('chat.contextUsage.percentUnknown');
  const ariaLabel =
    percent !== null
      ? t('chat.contextUsage.ariaLabel', {
          percent: percentDisplay,
          used: usedLabel,
          total: totalLabel,
        })
      : t('chat.contextUsage.ariaLabelUnknown', {
          used: usedLabel,
          total: totalLabel,
        });
  const toneClass =
    percent === null
      ? 'text-foreground/45'
      : percent >= 95
        ? 'text-destructive'
        : percent >= 80
          ? 'text-info'
          : 'text-foreground/60';

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          role="meter"
          tabIndex={0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          aria-label={ariaLabel}
          className={cn(
            'mr-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-foreground/60 outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring',
            toneClass,
          )}
        >
          <svg
            className="h-[18px] w-[18px]"
            viewBox="0 0 18 18"
            aria-hidden="true"
          >
            <circle
              cx="9"
              cy="9"
              r="6.5"
              fill="none"
              strokeWidth="3"
              className="stroke-foreground/15"
            />
            <circle
              cx="9"
              cy="9"
              r="6.5"
              fill="none"
              pathLength="100"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={`${ringPercent} 100`}
              className={cn(
                'origin-center -rotate-90 stroke-current transition-all duration-300',
                isCompacting && 'animate-pulse',
              )}
            />
          </svg>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className="w-[240px] px-4 py-3 text-center"
      >
        <div className="text-[13px] font-semibold text-muted-foreground">
          {t('chat.contextUsage.title')}
        </div>
        <div className="mt-1 text-[13px] font-semibold text-foreground">
          {percentLabel}
        </div>
        <div className="mt-3 text-[13px] font-semibold text-foreground">
          {t('chat.contextUsage.usedOfTotal', {
            used: usedLabel,
            total: totalLabel,
          })}
        </div>
        <div className="mt-3 text-[12px] font-medium text-muted-foreground">
          {isCompacting
            ? t('chat.contextUsage.compacting')
            : t('chat.contextUsage.autoCompact')}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Platform-specific modifier key for keyboard shortcuts */
const cmdKey = isMac ? '⌘' : 'Ctrl';
const EMPTY_AVAILABLE_COMMANDS: AvailableSlashCommand[] = [];
const EMPTY_AVAILABLE_SKILLS: string[] = [];

/** Default rotating placeholders are now generated inside FreeFormInput via useMemo + t() */

/** Fisher-Yates shuffle — returns a new array in random order */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export interface FollowUpInputItem {
  id: string;
  messageId: string;
  annotationId: string;
  index?: number;
  noteLabel: string;
  selectedText: string;
  color?: string;
}

export interface FreeFormInputProps {
  /** Placeholder text(s) for the textarea - can be array for rotation */
  placeholder?: string | string[];
  /** Whether input is disabled */
  disabled?: boolean;
  /** Whether the session is currently processing */
  isProcessing?: boolean;
  /** Callback when message is submitted (skillSlugs from @mentions) */
  onSubmit: (
    message: string,
    attachments?: FileAttachment[],
    skillSlugs?: string[],
  ) => void;
  /** Callback to stop processing. Pass silent=true to skip "Response interrupted" message */
  onStop?: (silent?: boolean) => void;
  /** External ref for the input */
  inputRef?: React.RefObject<RichTextInputHandle>;
  /** Current model ID */
  currentModel: string;
  /** Callback when model changes (includes connection slug for proper persistence) */
  onModelChange: (model: string, connection?: string) => void;
  // Thinking level (session-level setting)
  /** Current thinking level ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel;
  /** Callback when thinking level changes */
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  // Advanced options
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  /** Enabled permission modes for Shift+Tab cycling (min 2 modes) */
  enabledModes?: PermissionMode[];
  // Controlled input value (for persisting across mode switches and conversation changes)
  /** Current input value - if provided, component becomes controlled */
  inputValue?: string;
  /** Callback when input value changes */
  onInputChange?: (value: string) => void;
  /** Messages waiting for the next tool-result boundary */
  queuedInputMessages?: Message[];
  /** Persisted attachment draft for this session (seeds local state on session switch) */
  attachmentsValue?: FileAttachment[];
  /** Callback when attachment list changes (add, remove, clear on send) */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void;
  /** When true, removes container styling (shadow, bg, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean;
  /** Callback when component height changes (for external animation sync) */
  onHeightChange?: (height: number) => void;
  /** Callback when focus state changes */
  onFocusChange?: (focused: boolean) => void;
  // Source selection
  /** Available sources (enabled only) */
  sources?: LoadedSource[];
  /** Currently enabled source slugs for this session */
  enabledSourceSlugs?: string[];
  /** Callback when source selection changes */
  onSourcesChange?: (slugs: string[]) => void;
  // Skill selection (for @mentions)
  /** Available skills for @mention autocomplete */
  skills?: LoadedSkill[];
  // Label selection (for #labels)
  /** Available labels for #label autocomplete */
  labels?: LabelConfig[];
  /** Currently applied session labels */
  sessionLabels?: string[];
  /** Callback when a label is added via # menu */
  onLabelAdd?: (labelId: string) => void;
  /** Workspace ID for loading skill icons */
  workspaceId?: string;
  /** Current working directory path */
  workingDirectory?: string;
  /** Callback when working directory changes */
  onWorkingDirectoryChange?: (path: string) => void;
  /** Session folder path (for "Reset to Session Root" option) */
  sessionFolderPath?: string;
  /** Session ID for scoping events like approve-plan */
  sessionId?: string;
  /** Current session status of the session (for # menu state selection) */
  currentSessionStatus?: string;
  /** Disable send action (for tutorial guidance) */
  disableSend?: boolean;
  /** Whether the session is empty (no messages yet) - affects context badge prominence */
  isEmptySession?: boolean;
  /** Context status for showing compaction indicator and token usage */
  contextStatus?: {
    /** True when SDK is actively compacting the conversation */
    isCompacting?: boolean;
    /** Input tokens used so far in this session */
    inputTokens?: number;
    /** Model's context window size in tokens */
    contextWindow?: number;
    /** Percent used, if supplied by the provider's native /context report */
    usagePercent?: number;
    /** Provider-formatted input token count, if available */
    inputTokensDisplay?: string;
    /** Provider-formatted context window, if available */
    contextWindowDisplay?: string;
  };
  /** Follow-up annotations shown as context chips above the input */
  followUpItems?: FollowUpInputItem[];
  /** Callback when user clicks a follow-up chip body */
  onFollowUpClick?: (
    item: FollowUpInputItem,
    anchor?: { x: number; y: number },
  ) => void;
  /** Callback when user clicks the follow-up index badge */
  onFollowUpIndexClick?: (item: FollowUpInputItem) => void;
  /** Enable compact mode - hides attach, sources, working directory for popover embedding */
  compactMode?: boolean;
  // Connection selection (hierarchical connection → model selector)
  /** Current LLM connection slug (locked after first message) */
  currentConnection?: string;
  /** Callback when connection changes (only works when session is empty) */
  onConnectionChange?: (connectionSlug: string) => void;
  /** When true, the session's locked connection has been removed */
  connectionUnavailable?: boolean;
  /** Provider-advertised slash commands for the current session. */
  availableCommands?: AvailableSlashCommand[];
  /** Provider-advertised skill command names for the current session. */
  availableSkills?: string[];
}

/**
 * FreeFormInput - Self-contained textarea input with attachments and controls
 *
 * Features:
 * - Auto-growing textarea
 * - File attachments via button or drag-drop
 * - Slash commands menu
 * - Model selector
 * - Active option badges
 */
export function FreeFormInput({
  placeholder,
  disabled = false,
  isProcessing = false,
  onSubmit,
  onStop,
  inputRef: externalInputRef,
  currentModel,
  onModelChange,
  thinkingLevel = 'medium',
  permissionMode = 'ask',
  onPermissionModeChange,
  enabledModes = [...PERMISSION_MODE_ORDER],
  inputValue,
  onInputChange,
  queuedInputMessages = [],
  attachmentsValue,
  onAttachmentsChange,
  unstyled = false,
  onHeightChange,
  onFocusChange,
  sources = [],
  enabledSourceSlugs = [],
  onSourcesChange,
  skills = [],
  labels = [],
  sessionLabels = [],
  onLabelAdd,
  workspaceId,
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  sessionId,
  currentSessionStatus,
  disableSend = false,
  isEmptySession = false,
  contextStatus,
  followUpItems = [],
  onFollowUpClick,
  onFollowUpIndexClick,
  compactMode = false,
  currentConnection,
  connectionUnavailable = false,
  availableCommands,
  availableSkills,
}: FreeFormInputProps) {
  const { t } = useTranslation();
  const showSessionLabelsUi = FEATURE_FLAGS.sessionLabelsUi;
  const visibleLabels = showSessionLabelsUi ? labels : [];
  const visibleSessionLabels = showSessionLabelsUi ? sessionLabels : [];
  const onSubmitRef = React.useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  // Default rotating placeholders for onboarding/empty state (i18n-aware)
  const defaultPlaceholders = React.useMemo(() => {
    const placeholders = [
      t('chatInput.placeholder.workOn'),
      t('chatInput.placeholder.shiftTab'),
      t('chatInput.placeholder.mention'),
    ];
    if (showSessionLabelsUi) {
      placeholders.push(t('chatInput.placeholder.labels'));
    }
    placeholders.push(
      t('chatInput.placeholder.newLine'),
      t('chatInput.placeholder.sidebar', { key: cmdKey }),
      t('chatInput.placeholder.focusMode', { key: cmdKey }),
    );
    return placeholders;
  }, [showSessionLabelsUi, t]);

  const effectivePlaceholderProp = placeholder ?? defaultPlaceholders;

  // Read Qwen Code model metadata from context.
  // Uses optional variant so playground (no provider) doesn't crash.
  const appShellCtx = useOptionalAppShellContext();
  const llmConnections = React.useMemo(
    () => appShellCtx?.llmConnections ?? [],
    [appShellCtx?.llmConnections],
  );
  const qwenConnection = React.useMemo(
    () =>
      llmConnections.find((c) => c.providerType === 'qwen') ??
      llmConnections[0],
    [llmConnections],
  );
  const effectiveConnectionSlug = React.useMemo(
    () =>
      resolveEffectiveConnectionSlug(
        currentConnection,
        appShellCtx?.workspaceDefaultLlmConnection,
        llmConnections,
      ),
    [
      appShellCtx?.workspaceDefaultLlmConnection,
      currentConnection,
      llmConnections,
    ],
  );
  const currentLlmConnection = React.useMemo(() => {
    if (effectiveConnectionSlug) {
      return (
        llmConnections.find((c) => c.slug === effectiveConnectionSlug) ?? null
      );
    }
    return qwenConnection ?? null;
  }, [effectiveConnectionSlug, llmConnections, qwenConnection]);
  const [refreshedAvailableCommands, setRefreshedAvailableCommands] =
    React.useState<AvailableSlashCommand[]>(EMPTY_AVAILABLE_COMMANDS);
  const [refreshedAvailableSkills, setRefreshedAvailableSkills] =
    React.useState<string[]>(EMPTY_AVAILABLE_SKILLS);
  const effectiveAvailableCommands =
    availableCommands !== undefined
      ? availableCommands
      : refreshedAvailableCommands;
  const effectiveAvailableSkills =
    availableSkills !== undefined ? availableSkills : refreshedAvailableSkills;
  const hasProvidedQwenCapabilities =
    availableCommands !== undefined || availableSkills !== undefined;
  const useQwenAcpSkillMentions =
    !connectionUnavailable &&
    (currentLlmConnection?.providerType === 'qwen' ||
      effectiveAvailableSkills.length > 0);
  const disabledMentionSkillSlugs = React.useMemo(
    () =>
      new Set(
        skills
          .filter((skill) => skill.enabled === false)
          .map((skill) => skill.slug.toLowerCase()),
      ),
    [skills],
  );
  const qwenAcpMentionSkills = React.useMemo<LoadedSkill[]>(
    () =>
      effectiveAvailableSkills
        .filter(
          (skillName) =>
            !disabledMentionSkillSlugs.has(skillName.toLowerCase()),
        )
        .map((skillName) => ({
          slug: skillName,
          metadata: {
            name: skillName,
            description: '',
          },
          content: '',
          path: '',
          source: 'provider' as const,
        })),
    [disabledMentionSkillSlugs, effectiveAvailableSkills],
  );
  const enabledMentionSkills = React.useMemo(
    () => skills.filter((skill) => skill.enabled !== false),
    [skills],
  );
  const mentionSkills = useQwenAcpSkillMentions
    ? qwenAcpMentionSkills
    : enabledMentionSkills;
  const enableQwenSlashCommands =
    !connectionUnavailable &&
    (currentLlmConnection?.providerType === 'qwen' ||
      effectiveAvailableCommands.length > 0 ||
      effectiveAvailableSkills.length > 0);

  // Compute available models from Qwen Code. In the real app this list is
  // populated from ACP session/new models.availableModels; playground keeps
  // the Qwen seed list so local component demos remain useful.
  const availableModels = React.useMemo(() => {
    if (connectionUnavailable) return [];
    if (!appShellCtx) return QWEN_MODELS;
    return qwenConnection?.models ?? [];
  }, [appShellCtx, qwenConnection, connectionUnavailable]);

  // Get display name for current model (full name, not short name)
  const currentModelDisplayName = React.useMemo(() => {
    const model = availableModels.find((m) =>
      typeof m === 'string' ? m === currentModel : m.id === currentModel,
    );
    if (!model) {
      if (!currentModel) return t('common.model');
      // Fallback: use helper function to format unknown model IDs nicely
      return getModelDisplayName(currentModel);
    }
    return typeof model === 'string' ? model : model.name;
  }, [availableModels, currentModel, t]);

  const currentModelContextWindow = React.useMemo(() => {
    if (contextStatus?.contextWindow && contextStatus.contextWindow > 0) {
      return contextStatus.contextWindow;
    }

    return (
      getModelContextWindowFromList(
        currentLlmConnection?.models,
        currentModel,
      ) ??
      getModelContextWindowFromList(availableModels, currentModel) ??
      getModelContextWindow(currentModel)
    );
  }, [
    availableModels,
    contextStatus?.contextWindow,
    currentLlmConnection?.models,
    currentModel,
  ]);

  const contextUsageIndicator = React.useMemo(() => {
    if (isEmptySession) return null;

    const usedTokens = Math.max(0, contextStatus?.inputTokens ?? 0);
    if (!currentModelContextWindow && usedTokens === 0) return null;

    return {
      usedTokens,
      totalTokens: currentModelContextWindow,
      isCompacting: contextStatus?.isCompacting,
      usagePercent: contextStatus?.usagePercent,
      usedDisplay: contextStatus?.inputTokensDisplay,
      totalDisplay: contextStatus?.contextWindowDisplay,
    };
  }, [
    contextStatus?.inputTokens,
    contextStatus?.isCompacting,
    contextStatus?.usagePercent,
    contextStatus?.inputTokensDisplay,
    contextStatus?.contextWindowDisplay,
    currentModelContextWindow,
    isEmptySession,
  ]);

  // Access sessionStatuses and onSessionStatusChange from context for the # menu state picker
  const sessionStatuses = appShellCtx?.sessionStatuses ?? [];
  const onSessionStatusChange = appShellCtx?.onSessionStatusChange;
  // Resolve workspace rootPath for "Add New Label" deep link
  const workspaceRootPath = React.useMemo(() => {
    if (!appShellCtx || !workspaceId) return null;
    return (
      appShellCtx.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null
    );
  }, [appShellCtx, workspaceId]);

  // Workspace slug for SDK skill qualification (server-computed)
  // SDK expects "workspaceSlug:skillSlug" format, NOT UUID
  const workspaceSlug = React.useMemo(() => {
    if (!appShellCtx || !workspaceId) return workspaceId;
    return (
      appShellCtx.workspaces.find((w) => w.id === workspaceId)?.slug ??
      workspaceId
    );
  }, [appShellCtx, workspaceId]);

  // Read panel focus state from context (for multi-panel unfocused styling)
  const appShellContext = useOptionalAppShellContext();
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true;
  const [isInputFocused, setIsInputFocused] = React.useState(false);

  // Shuffle placeholder order when the source text changes so draft/new-session
  // screens do not stay stuck with an initial empty value.
  // In compact mode, suppress desktop-keyboard guidance that is noisy or misleading
  // on narrow/mobile-like layouts.
  const placeholderOptions = React.useMemo(() => {
    if (!Array.isArray(effectivePlaceholderProp)) {
      return effectivePlaceholderProp;
    }

    const nonEmptyOptions = effectivePlaceholderProp.filter(
      (entry) => entry.trim().length > 0,
    );
    if (!compactMode) return nonEmptyOptions;

    const compactOptions = nonEmptyOptions.filter((entry) => {
      const lower = entry.toLowerCase();
      return (
        !lower.includes('shift + tab') &&
        !lower.includes('shift + return') &&
        !lower.includes('toggle the sidebar') &&
        !lower.includes('focus mode') &&
        !lower.includes('⌘') &&
        !lower.includes('ctrl')
      );
    });

    return compactOptions.length > 0 ? compactOptions : nonEmptyOptions;
  }, [effectivePlaceholderProp, compactMode]);

  // Hide placeholder entirely when panel is unfocused in multi-panel layout,
  // unless the input itself has DOM focus. The draft composer can receive focus
  // before panel focus state catches up.
  const shuffledPlaceholder = React.useMemo(
    () =>
      Array.isArray(placeholderOptions)
        ? shuffleArray(placeholderOptions)
        : placeholderOptions,
    [placeholderOptions],
  );
  const effectivePlaceholder =
    isFocusedPanel || isInputFocused ? shuffledPlaceholder : '';

  // Performance optimization: Always use internal state for typing to avoid parent re-renders
  // Sync FROM parent on mount/change (for restoring drafts)
  // Sync TO parent on blur/submit (debounced persistence)
  const [input, setInput] = React.useState(() => coerceInputText(inputValue));
  const [attachments, setAttachments] = React.useState<FileAttachment[]>(
    attachmentsValue ?? [],
  );

  // Ref to track current attachments for use in event handlers (avoids stale closure issues)
  const attachmentsRef = React.useRef<FileAttachment[]>([]);
  React.useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Seed from parent when `attachmentsValue` changes (e.g., switching sessions).
  // `skipPersistRef` tells the save effect below that the next `attachments` change
  // is a prop-driven seed, not user intent — otherwise we'd echo the seed back to
  // the parent and risk persisting A's attachments under B's sessionId.
  const attachmentsRefsKey = React.useMemo(() => {
    if (!attachmentsValue) return '';
    return attachmentsValue.map((a) => a.path).join('|');
  }, [attachmentsValue]);
  const prevAttachmentsRefsKey = React.useRef(attachmentsRefsKey);
  const skipPersistRef = React.useRef(true); // treat initial mount as a prop-seed
  React.useEffect(() => {
    if (attachmentsValue === undefined) return;
    if (attachmentsRefsKey === prevAttachmentsRefsKey.current) return;
    prevAttachmentsRefsKey.current = attachmentsRefsKey;
    skipPersistRef.current = true;
    setAttachments(attachmentsValue);
  }, [attachmentsValue, attachmentsRefsKey]);

  // Persist user-initiated attachment changes back to the parent. The parent stores
  // refs (path + name) and debounces the disk write, so we fire eagerly on every
  // change — add/remove/send-clear.
  const onAttachmentsChangeRef = React.useRef(onAttachmentsChange);
  onAttachmentsChangeRef.current = onAttachmentsChange;
  React.useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    onAttachmentsChangeRef.current?.(attachments);
  }, [attachments]);

  // Optimistic state for source selection - updates UI immediately before IPC round-trip completes
  const [optimisticSourceSlugs, setOptimisticSourceSlugs] =
    React.useState(enabledSourceSlugs);

  // Sync from prop when server state changes (reconciles after IPC or on external updates)
  // Use content comparison (not reference) to avoid infinite loops with empty arrays
  const prevEnabledSourceSlugsRef = React.useRef(enabledSourceSlugs);
  React.useEffect(() => {
    const prev = prevEnabledSourceSlugsRef.current;
    const changed =
      enabledSourceSlugs.length !== prev.length ||
      enabledSourceSlugs.some((slug, i) => slug !== prev[i]);

    if (changed) {
      setOptimisticSourceSlugs(enabledSourceSlugs);
      prevEnabledSourceSlugsRef.current = enabledSourceSlugs;
    }
  }, [enabledSourceSlugs]);

  // Sync from parent when inputValue changes externally (e.g., switching sessions)
  const prevInputValueRef = React.useRef(coerceInputText(inputValue));
  React.useEffect(() => {
    if (inputValue === undefined) return;
    const nextInputValue = coerceInputText(inputValue);
    if (nextInputValue !== prevInputValueRef.current) {
      setInput(nextInputValue);
      prevInputValueRef.current = nextInputValue;
    }
  }, [inputValue]);

  // Debounced sync to parent (saves draft without blocking typing)
  const syncTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const syncToParent = React.useCallback(
    (value: string) => {
      if (!onInputChange) return;
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = setTimeout(() => {
        onInputChange(value);
        prevInputValueRef.current = value;
      }, 300); // Debounce 300ms
    },
    [onInputChange],
  );

  // Sync immediately on unmount to preserve input across mode switches
  // Also cleanup any pending debounced sync
  const inputRef = React.useRef(input);
  inputRef.current = input; // Keep ref in sync with state

  React.useEffect(
    () => () => {
      // Cancel pending debounced sync
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      // Immediately sync current value to parent on unmount
      // This preserves input when switching to structured input (e.g., permission request)
      if (onInputChange && inputRef.current !== prevInputValueRef.current) {
        onInputChange(inputRef.current);
      }
    },
    [onInputChange],
  );

  const [isDraggingOver, setIsDraggingOver] = React.useState(false);
  const [loadingCount, setLoadingCount] = React.useState(0);
  const [inputMaxHeight, setInputMaxHeight] = React.useState(540);
  const [modelDropdownOpen, setModelDropdownOpen] = React.useState(false);

  // Input settings (loaded from config)
  const [autoCapitalisation, setAutoCapitalisation] = React.useState(true);
  const [sendMessageKey, setSendMessageKey] = React.useState<
    'enter' | 'cmd-enter'
  >('enter');
  const [spellCheck, setSpellCheck] = React.useState(false);

  // Load input settings on mount
  React.useEffect(() => {
    const loadInputSettings = async () => {
      if (!window.electronAPI) return;
      try {
        const [autoCapEnabled, sendKey, spellCheckEnabled] = await Promise.all([
          window.electronAPI.getAutoCapitalisation(),
          window.electronAPI.getSendMessageKey(),
          window.electronAPI.getSpellCheck(),
        ]);
        setAutoCapitalisation(autoCapEnabled);
        setSendMessageKey(sendKey ?? 'enter');
        setSpellCheck(spellCheckEnabled);
      } catch (error) {
        logInputError('Failed to load input settings:', error);
      }
    };
    loadInputSettings();
  }, []);

  // Double-Esc interrupt: show warning overlay on first Esc, interrupt on second
  const { showEscapeOverlay } = useEscapeInterrupt();

  // Calculate max height: min(66% of window height, 540px)
  React.useEffect(() => {
    const updateMaxHeight = () => {
      const maxFromWindow = Math.floor(window.innerHeight * 0.66);
      setInputMaxHeight(Math.min(maxFromWindow, 540));
    };
    updateMaxHeight();
    window.addEventListener('resize', updateMaxHeight);
    return () => window.removeEventListener('resize', updateMaxHeight);
  }, []);

  const dragCounterRef = React.useRef(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Merge refs for RichTextInput
  const internalInputRef = React.useRef<RichTextInputHandle>(null);
  const richInputRef = externalInputRef || internalInputRef;

  // Track last caret position for focus restoration (e.g., after permission mode popover closes)
  const lastCaretPositionRef = React.useRef<number | null>(null);

  // Listen for craft:insert-text events (generic mechanism for inserting text into input)
  // Used by components that want to pre-fill the input with text
  React.useEffect(() => {
    const handleInsertText = (
      e: CustomEvent<{ text: string; sessionId?: string }>,
    ) => {
      const targetSessionId = e.detail?.sessionId;
      if (
        !shouldHandleScopedInputEvent({
          sessionId,
          isFocusedPanel,
          targetSessionId,
        })
      )
        return;

      const text = coerceInputText(e.detail?.text);
      setInput(text);
      syncToParent(text);
      // Focus the input after inserting
      setTimeout(() => {
        richInputRef.current?.focus();
        // Move cursor to end
        richInputRef.current?.setSelectionRange(text.length, text.length);
      }, 0);
    };

    window.addEventListener(
      'craft:insert-text',
      handleInsertText as EventListener,
    );
    return () =>
      window.removeEventListener(
        'craft:insert-text',
        handleInsertText as EventListener,
      );
  }, [sessionId, isFocusedPanel, syncToParent, richInputRef]);

  const clearInputDraft = React.useCallback(() => {
    setInput('');
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    onInputChange?.('');
    prevInputValueRef.current = '';
  }, [onInputChange]);

  const consumeInputDraftSnapshot = React.useCallback((): string => {
    const snapshot = input.trim();
    clearInputDraft();
    return snapshot;
  }, [input, clearInputDraft]);

  type PlanApprovalEventDetail = {
    sessionId?: string;
    planPath?: string;
    includeDraftInput?: boolean;
    source?: string;
  };

  // Listen for craft:approve-plan events (used by ResponseCard's Accept Plan button)
  // This disables safe mode AND submits the message in one action
  // Only process events for this session (sessionId must match)
  React.useEffect(() => {
    const handleApprovePlan = (e: CustomEvent<PlanApprovalEventDetail>) => {
      // Only handle if this event is for our session
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return;
      }

      const shouldIncludeDraft = e.detail?.includeDraftInput !== false;
      const draftInput = shouldIncludeDraft ? consumeInputDraftSnapshot() : '';
      const text = buildPlanApprovalMessage({
        planPath: e.detail?.planPath,
        draftInput,
      });

      // Switch to YOLO mode if in Plan mode (allow execution without prompts)
      // Only switch if currently in safe mode - if user is in 'ask' mode, respect their choice
      if (permissionMode === 'safe') {
        onPermissionModeChange?.('allow-all');
      }

      onSubmit(text, undefined);
    };

    window.addEventListener(
      'craft:approve-plan',
      handleApprovePlan as EventListener,
    );
    return () =>
      window.removeEventListener(
        'craft:approve-plan',
        handleApprovePlan as EventListener,
      );
  }, [
    sessionId,
    permissionMode,
    onPermissionModeChange,
    onSubmit,
    consumeInputDraftSnapshot,
  ]);

  // Listen for craft:approve-plan-with-compact events (Accept & Compact option)
  // This compacts the conversation first, then executes the plan.
  // The pending state is persisted to survive page reloads (CMD+R).
  React.useEffect(() => {
    const handleApprovePlanWithCompact = async (
      e: CustomEvent<PlanApprovalEventDetail>,
    ) => {
      // Only handle if this event is for our session
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return;
      }

      const planPath = e.detail?.planPath;
      const shouldIncludeDraft = e.detail?.includeDraftInput !== false;
      const draftInputSnapshot = shouldIncludeDraft
        ? consumeInputDraftSnapshot()
        : '';

      // Switch to YOLO mode if in Plan mode
      if (permissionMode === 'safe') {
        onPermissionModeChange?.('allow-all');
      }

      // Persist the pending plan execution state BEFORE sending /compact.
      // This allows reload recovery if CMD+R happens during compaction.
      if (sessionId) {
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'setPendingPlanExecution',
          planPath: planPath ?? '',
          draftInputSnapshot,
        });
      }

      // Send /compact to trigger compaction
      onSubmit('/compact', undefined);

      // Set up a one-time listener for compaction complete.
      // This handles the normal case (no reload during compaction).
      const handleCompactionComplete = async (
        compactEvent: CustomEvent<{ sessionId?: string }>,
      ) => {
        // Only handle if this is for our session
        if (compactEvent.detail?.sessionId !== sessionId) {
          return;
        }

        // Remove the listener (one-time use)
        window.removeEventListener(
          'craft:compaction-complete',
          handleCompactionComplete as unknown as EventListener,
        );

        const executionMessage = buildPlanApprovalMessage({
          planPath,
          draftInput: draftInputSnapshot,
        });
        onSubmit(executionMessage, undefined);

        // Clear the pending state since we just sent the execution message
        if (sessionId) {
          await window.electronAPI.sessionCommand(sessionId, {
            type: 'clearPendingPlanExecution',
          });
        }
      };

      window.addEventListener(
        'craft:compaction-complete',
        handleCompactionComplete as unknown as EventListener,
      );
    };

    window.addEventListener(
      'craft:approve-plan-with-compact',
      handleApprovePlanWithCompact as unknown as EventListener,
    );
    return () =>
      window.removeEventListener(
        'craft:approve-plan-with-compact',
        handleApprovePlanWithCompact as unknown as EventListener,
      );
  }, [
    sessionId,
    permissionMode,
    onPermissionModeChange,
    onSubmit,
    consumeInputDraftSnapshot,
  ]);

  // Reload recovery: Check for pending plan execution on mount.
  // If the page reloaded after compaction completed (awaitingCompaction = false),
  // we need to send the plan execution message that was interrupted by the reload.
  // Also listen for compaction-complete in case CMD+R happened during compaction.
  React.useEffect(() => {
    if (!sessionId) return;

    let hasExecuted = false;

    const isExpectedReconnectError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        message.includes('Connection closed') ||
        message.includes('Client disconnected') ||
        message.includes('transport') ||
        message.includes('socket')
      );
    };

    const executePendingPlan = async () => {
      if (hasExecuted) return;

      try {
        const pending =
          await window.electronAPI.getPendingPlanExecution(sessionId);
        if (
          !pending ||
          pending.awaitingCompaction ||
          pending.executionDispatched
        )
          return;

        // Mark dispatched before sending so reload recovery does not double-submit
        // the same plan if onSubmit succeeds but cleanup fails during a reconnect.
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'markPendingPlanExecutionDispatched',
        });

        // Compaction completed but we never sent the execution message (page reloaded).
        // Send it now and clear the pending state.
        hasExecuted = true;
        const executionMessage = buildPlanApprovalMessage({
          planPath: pending.planPath,
          draftInput: pending.draftInputSnapshot,
        });
        onSubmitRef.current(executionMessage, undefined);

        await window.electronAPI.sessionCommand(sessionId, {
          type: 'clearPendingPlanExecution',
        });
      } catch (error) {
        if (!isExpectedReconnectError(error)) {
          logInputError(
            '[FreeFormInput] Failed to resume pending plan execution:',
            error,
          );
        }
      }
    };

    // Check immediately on mount (handles case where compaction already completed)
    executePendingPlan();

    // Also listen for compaction-complete in case CMD+R happened during compaction.
    // When compaction finishes after reload, this listener will trigger execution.
    const handleCompactionComplete = async (
      e: CustomEvent<{ sessionId: string }>,
    ) => {
      if (e.detail?.sessionId !== sessionId) return;
      // Small delay to ensure markCompactionComplete has been called
      await new Promise((resolve) => setTimeout(resolve, 100));
      executePendingPlan();
    };

    window.addEventListener(
      'craft:compaction-complete',
      handleCompactionComplete as unknown as EventListener,
    );
    return () => {
      window.removeEventListener(
        'craft:compaction-complete',
        handleCompactionComplete as unknown as EventListener,
      );
    };
  }, [sessionId]);

  // Listen for craft:focus-input events (restore focus after popover/dropdown closes)
  React.useEffect(() => {
    const handleFocusInput = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail;
      const targetSessionId = detail?.sessionId;
      if (
        !shouldHandleScopedInputEvent({
          sessionId,
          isFocusedPanel,
          targetSessionId,
        })
      )
        return;

      if (targetSessionId) {
        clearPendingFocusForSession(targetSessionId);
      }

      richInputRef.current?.focus();
      // Restore caret position if saved, then clear it (one-shot)
      if (lastCaretPositionRef.current !== null) {
        richInputRef.current?.setSelectionRange(
          lastCaretPositionRef.current,
          lastCaretPositionRef.current,
        );
        lastCaretPositionRef.current = null;
      }
    };

    window.addEventListener('craft:focus-input', handleFocusInput);
    return () =>
      window.removeEventListener('craft:focus-input', handleFocusInput);
  }, [sessionId, isFocusedPanel, richInputRef]);

  // Recover queued focus requests after session switch/mount races.
  React.useEffect(() => {
    if (!consumePendingFocusForSession(sessionId)) return;

    setTimeout(() => {
      richInputRef.current?.focus();
    }, 0);
  }, [sessionId, richInputRef]);

  // Get the next available number for a pasted file prefix (e.g., pasted-image-1, pasted-image-2)
  const getNextPastedNumber = (
    prefix: 'image' | 'text' | 'file',
    existingAttachments: FileAttachment[],
  ): number => {
    const pattern = new RegExp(`^pasted-${prefix}-(\\d+)\\.`);
    let maxNum = 0;
    for (const att of existingAttachments) {
      const match = att.name.match(pattern);
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10));
      }
    }
    return maxNum + 1;
  };

  // Listen for craft:paste-files events (for global paste when input not focused)
  React.useEffect(() => {
    const handlePasteFiles = async (
      e: CustomEvent<{ files: File[]; sessionId?: string }>,
    ) => {
      if (disabled) return;

      const targetSessionId = e.detail?.sessionId;
      if (
        !shouldHandleScopedInputEvent({
          sessionId,
          isFocusedPanel,
          targetSessionId,
        })
      )
        return;

      const { files } = e.detail;
      if (!files || files.length === 0) return;

      setLoadingCount((prev) => prev + files.length);

      // Pre-assign sequential names using ref to avoid race conditions
      let nextImageNum = getNextPastedNumber('image', attachmentsRef.current);
      const fileNames: string[] = files.map((file) => {
        if (
          !file.name ||
          file.name === 'image.png' ||
          file.name === 'image.jpg' ||
          file.name === 'blob'
        ) {
          const ext = file.type.split('/')[1] || 'png';
          return `pasted-image-${nextImageNum++}.${ext}`;
        }
        return file.name;
      });

      for (let i = 0; i < files.length; i++) {
        try {
          const attachment = await readFileAsAttachment(files[i], fileNames[i]);
          if (attachment) {
            setAttachments((prev) => [...prev, attachment]);
          }
        } catch (error) {
          logInputError(
            '[FreeFormInput] Failed to process pasted file:',
            error,
          );
        }
        setLoadingCount((prev) => prev - 1);
      }

      // Focus the input after adding attachments
      richInputRef.current?.focus();
    };

    window.addEventListener(
      'craft:paste-files',
      handlePasteFiles as unknown as EventListener,
    );
    return () =>
      window.removeEventListener(
        'craft:paste-files',
        handlePasteFiles as unknown as EventListener,
      );
  }, [disabled, sessionId, isFocusedPanel, richInputRef]); // eslint-disable-line react-hooks/exhaustive-deps -- readFileAsAttachment is stable for the lifetime of this component instance.

  // Build active commands list for slash command menu
  const activeCommands = React.useMemo(() => {
    const active: SlashCommandId[] = [];
    // Add the currently active permission mode
    if (PERMISSION_MODE_ORDER.includes(permissionMode))
      active.push(permissionMode);
    return active;
  }, [permissionMode]);
  const qwenCommandRefreshKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setRefreshedAvailableCommands(EMPTY_AVAILABLE_COMMANDS);
    setRefreshedAvailableSkills(EMPTY_AVAILABLE_SKILLS);
    qwenCommandRefreshKeyRef.current = null;
  }, [currentLlmConnection?.slug, sessionId, workingDirectory]);

  React.useEffect(() => {
    if (
      !enableQwenSlashCommands ||
      !sessionId ||
      hasProvidedQwenCapabilities ||
      effectiveAvailableCommands.length > 0 ||
      effectiveAvailableSkills.length > 0
    )
      return;

    const refreshKey = `${sessionId}:${currentLlmConnection?.slug ?? ''}:${workingDirectory ?? ''}`;
    if (qwenCommandRefreshKeyRef.current === refreshKey) return;
    qwenCommandRefreshKeyRef.current = refreshKey;

    const api = window.electronAPI;
    if (!api?.sessionCommand) return;

    api.debugLog?.('[qwen] Requesting ACP slash command refresh', {
      sessionId,
      connection: currentLlmConnection?.slug,
      workingDirectory,
    });

    api
      .sessionCommand(sessionId, {
        type: 'refreshAvailableCommands',
        workspaceId,
        workingDirectory,
        llmConnection: currentLlmConnection?.slug,
        model: currentModel,
        permissionMode,
        thinkingLevel,
        enabledSourceSlugs,
      })
      .then((result) => {
        const payload = result as
          | {
              success?: boolean;
              availableCommands?: AvailableSlashCommand[];
              availableSkills?: string[];
              error?: string;
            }
          | undefined;
        const nextCommands = payload?.availableCommands ?? [];
        const nextSkills = payload?.availableSkills ?? [];
        if (
          payload?.success &&
          (nextCommands.length > 0 || nextSkills.length > 0)
        ) {
          setRefreshedAvailableCommands(nextCommands);
          setRefreshedAvailableSkills(nextSkills);
        }
        api.debugLog?.('[qwen] ACP slash command refresh result', {
          sessionId,
          success: payload?.success,
          commandCount: nextCommands.length,
          skillCount: nextSkills.length,
          commandNames: nextCommands.map((command) => command.name),
          error: payload?.error,
        });
      })
      .catch((error) => {
        api.debugLog?.(
          '[qwen] Failed to refresh slash commands:',
          String(error),
        );
      });
  }, [
    currentLlmConnection?.slug,
    enableQwenSlashCommands,
    effectiveAvailableCommands.length,
    effectiveAvailableSkills.length,
    hasProvidedQwenCapabilities,
    enabledSourceSlugs,
    currentModel,
    permissionMode,
    sessionId,
    thinkingLevel,
    workingDirectory,
    workspaceId,
  ]);

  // Handle slash command selection (mode/feature commands)
  const handleSlashCommand = React.useCallback(
    (commandId: SlashCommandId) => {
      if (PERMISSION_MODE_ORDER.includes(commandId as PermissionMode))
        onPermissionModeChange?.(commandId as PermissionMode);
      else if (commandId === 'compact' && !isProcessing)
        onSubmit('/compact', undefined);
    },
    [onPermissionModeChange, isProcessing, onSubmit],
  );

  // Handle folder selection from slash command menu
  const handleSlashFolderSelect = React.useCallback(
    (path: string) => {
      if (onWorkingDirectoryChange) {
        setRecentFolders(addRecentWorkingDir(path, workspaceId));
        onWorkingDirectoryChange(path);
      }
    },
    [onWorkingDirectoryChange, workspaceId],
  );

  // Get recent folders and home directory for slash menu and mention menu
  const [recentFolders, setRecentFolders] = React.useState<string[]>([]);
  const [homeDir, setHomeDir] = React.useState<string>('');

  React.useEffect(() => {
    setRecentFolders(getRecentWorkingDirs(workspaceId));
    window.electronAPI?.getHomeDir?.().then((dir: string) => {
      if (dir) setHomeDir(dir);
    });
  }, [workspaceId]);

  // Inline slash command hook (modes, features, and folders)
  const inlineSlash = useInlineSlashCommand({
    inputRef: richInputRef,
    onSelectCommand: handleSlashCommand,
    onSelectFolder: handleSlashFolderSelect,
    activeCommands,
    recentFolders,
    homeDir,
    availableCommands: effectiveAvailableCommands,
    availableSkills: effectiveAvailableSkills,
    enableQwenCommands: enableQwenSlashCommands,
  });
  const richInputSlashCommandNames = React.useMemo(() => {
    const names = new Set<string>(['compact']);
    for (const section of inlineSlash.sections) {
      for (const item of section.items) {
        if ('type' in item && item.type === 'folder') continue;
        const commandText =
          'insertText' in item ? item.insertText?.trim() : undefined;
        if (!commandText?.startsWith('/')) continue;
        const commandName = commandText.slice(1).split(/\s+/)[0];
        if (commandName) names.add(commandName);
      }
    }
    return [...names];
  }, [inlineSlash.sections]);

  // Handle mention selection (sources, skills, files)
  const handleMentionSelect = React.useCallback(
    (item: MentionItem) => {
      // For sources: enable the source immediately
      if (item.type === 'source' && item.source && onSourcesChange) {
        const slug = item.source.config.slug;
        if (!optimisticSourceSlugs.includes(slug)) {
          const newSlugs = [...optimisticSourceSlugs, slug];
          setOptimisticSourceSlugs(newSlugs);
          onSourcesChange(newSlugs);
        }
      }

      // Files via @ mention in text are sufficient context for the agent.
      // Skills also don't need special handling beyond text insertion.
    },
    [optimisticSourceSlugs, onSourcesChange],
  );

  // Inline mention hook (for skills, sources, and files)
  const inlineMention = useInlineMention({
    inputRef: richInputRef,
    skills: mentionSkills,
    sources,
    basePath: workingDirectory,
    onSelect: handleMentionSelect,
    // Use workspace slug (not UUID) for SDK skill qualification
    workspaceId: workspaceSlug,
  });

  // Inline label menu hook (for #labels)
  const handleLabelSelect = React.useCallback(
    (labelId: string) => {
      onLabelAdd?.(labelId);
    },
    [onLabelAdd],
  );

  const inlineLabel = useInlineLabelMenu({
    inputRef: richInputRef,
    labels: visibleLabels,
    sessionLabels: visibleSessionLabels,
    onSelect: handleLabelSelect,
    sessionStatuses,
    activeStateId: currentSessionStatus,
  });

  // "Add New Label" handler: cleans up the #trigger text and opens a controlled
  // EditPopover so the user can describe the label before the agent creates it.
  const [addLabelPopoverOpen, setAddLabelPopoverOpen] = React.useState(false);
  const [addLabelPrefill, setAddLabelPrefill] = React.useState('');
  const handleAddLabel = React.useCallback(
    (prefill: string) => {
      if (!workspaceRootPath) return;

      // Remove the #trigger text from input
      const cleaned = inlineLabel.handleSelect('');
      setInput(cleaned);
      syncToParent(cleaned);
      inlineLabel.close();

      // Store the prefill text (e.g., "Test" from "#Test") to pre-fill the popover
      // Format: "Add new label {prefill}" so user can just press enter or modify
      setAddLabelPrefill(prefill ? t('labels.addNewLabel', { prefill }) : '');

      // Open the EditPopover for label creation
      setAddLabelPopoverOpen(true);
    },
    [workspaceRootPath, inlineLabel, syncToParent, t],
  );

  // Memoize the add-label config so the EditPopover doesn't recreate on every render
  const addLabelEditConfig = React.useMemo(() => {
    if (!workspaceRootPath) return null;
    return getEditConfig('add-label', workspaceRootPath);
  }, [workspaceRootPath]);

  // Report height changes to parent (for external animation sync)
  React.useLayoutEffect(() => {
    if (!onHeightChange || !containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(entry.contentRect.height);
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [onHeightChange]);

  // In compact mode, immediately report collapsed height when processing state changes
  // This ensures smooth animation timing when input collapses/expands
  React.useEffect(() => {
    if (!onHeightChange || !compactMode) return;
    if (isProcessing) {
      // Collapsed state - only bottom bar visible (~44px)
      onHeightChange(44);
    }
    // When not processing, ResizeObserver will report the full height
  }, [compactMode, isProcessing, onHeightChange]);

  // Check if running in Electron environment (has electronAPI)
  const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI;

  // Shared helper: read a File, add as attachment, decrement loading count
  const processFileAttachment = async (file: File, overrideName?: string) => {
    try {
      const attachment = await readFileAsAttachment(file, overrideName);
      if (attachment) {
        setAttachments((prev) => [...prev, attachment]);
      }
    } catch (error) {
      logInputError('[FreeFormInput] Failed to read file:', error);
    }
    setLoadingCount((prev) => prev - 1);
  };

  // File attachment handlers
  const handleAttachClick = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  const handleFileInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileList = Array.from(files);
    setLoadingCount((prev) => prev + fileList.length);

    for (const file of fileList) {
      await processFileAttachment(file);
    }

    // Reset input so re-selecting the same file triggers onChange again
    e.target.value = '';
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // Helper to read a File using FileReader API
  const readFileAsAttachment = async (
    file: File,
    overrideName?: string,
  ): Promise<FileAttachment | null> => {
    // Capture the absolute OS path at attach time. Works for <input type="file"> and
    // OS drag-drop; returns null for clipboard paste and web-drag (no disk origin).
    // When null, the draft layer falls back to persisting content inline (Track C).
    const realPath = hasElectronAPI
      ? (window.electronAPI.getFilePath?.(file) ?? null)
      : null;

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async () => {
        const result = reader.result as ArrayBuffer;
        // Chunked base64 encoding — btoa + reduce fails on large files (>1MB)
        // due to O(n²) string concatenation and browser string-length limits
        const bytes = new Uint8Array(result);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(
            ...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)),
          );
        }
        const base64 = btoa(binary);

        let type: FileAttachment['type'] = 'unknown';
        const fileName = overrideName || file.name;
        if (file.type.startsWith('image/')) type = 'image';
        else if (file.type === 'application/pdf') type = 'pdf';
        else if (
          file.type.includes('text') ||
          fileName.match(/\.(txt|md|json|js|ts|tsx|py|css|html)$/i)
        )
          type = 'text';
        else if (
          file.type.includes('officedocument') ||
          fileName.match(/\.(docx?|xlsx?|pptx?)$/i)
        )
          type = 'office';

        const mimeType = file.type || 'application/octet-stream';

        // For text files, decode the ArrayBuffer as UTF-8 text
        let text: string | undefined;
        if (type === 'text') {
          text = new TextDecoder('utf-8').decode(new Uint8Array(result));
        }

        let thumbnailBase64: string | undefined;
        if (hasElectronAPI) {
          try {
            const thumb = await window.electronAPI.generateThumbnail(
              base64,
              mimeType,
            );
            if (thumb) thumbnailBase64 = thumb;
          } catch {
            // Thumbnail generation is optional, continue without it
          }
        }

        resolve({
          type,
          path: realPath ?? fileName,
          name: fileName,
          mimeType,
          base64,
          text,
          size: file.size,
          thumbnailBase64,
        });
      };
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(file);
    });
  };

  // Clipboard paste handler for files/images
  const handlePaste = async (e: React.ClipboardEvent) => {
    if (disabled) return;

    const clipboardItems = e.clipboardData?.files;
    if (!clipboardItems || clipboardItems.length === 0) return;

    // We have files to process - prevent default text paste behavior
    e.preventDefault();

    const files = Array.from(clipboardItems);
    setLoadingCount((prev) => prev + files.length);

    // Pre-assign sequential names using ref to avoid race conditions
    let nextImageNum = getNextPastedNumber('image', attachmentsRef.current);
    const fileNames: string[] = files.map((file) => {
      if (
        !file.name ||
        file.name === 'image.png' ||
        file.name === 'image.jpg' ||
        file.name === 'blob'
      ) {
        const ext = file.type.split('/')[1] || 'png';
        return `pasted-image-${nextImageNum++}.${ext}`;
      }
      return file.name;
    });

    for (let i = 0; i < files.length; i++) {
      await processFileAttachment(files[i], fileNames[i]);
    }
  };

  // Handle long text paste - convert to file attachment
  const handleLongTextPaste = React.useCallback(
    (text: string) => {
      const nextNum = getNextPastedNumber('text', attachmentsRef.current);
      const fileName = `pasted-text-${nextNum}.txt`;
      const attachment: FileAttachment = {
        type: 'text',
        path: fileName,
        name: fileName,
        mimeType: 'text/plain',
        text,
        size: new Blob([text]).size,
      };
      setAttachments((prev) => [...prev, attachment]);
      // Focus input after adding attachment
      richInputRef.current?.focus();
    },
    [richInputRef],
  );

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);
    if (disabled) return;

    const files = Array.from(e.dataTransfer.files);
    setLoadingCount(files.length);

    for (const file of files) {
      await processFileAttachment(file);
    }
  };

  // Submit message - backend handles queueing and interruption
  const submitMessage = React.useCallback(() => {
    const hasContent =
      input.trim() || attachments.length > 0 || followUpItems.length > 0;
    if (!hasContent || disabled) return false;

    // Tutorial may disable sending to guide user through specific steps
    if (disableSend) return false;

    // Parse all @mentions (skills, sources, folders)
    const skillSlugs = mentionSkills.map((s) => s.slug);
    const sourceSlugs = sources.map((s) => s.config.slug);
    const mentions = parseMentions(input, skillSlugs, sourceSlugs);

    // Enable any mentioned sources that aren't already enabled
    if (mentions.sources.length > 0 && onSourcesChange) {
      const newSlugs = [
        ...new Set([...optimisticSourceSlugs, ...mentions.sources]),
      ];
      if (newSlugs.length > optimisticSourceSlugs.length) {
        setOptimisticSourceSlugs(newSlugs);
        onSourcesChange(newSlugs);
      }
    }

    onSubmit(
      input.trim(),
      attachments.length > 0 ? attachments : undefined,
      mentions.skills.length > 0 ? mentions.skills : undefined,
    );
    setInput('');
    setAttachments([]);
    // Clear draft immediately (cancel any pending debounced sync)
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    onInputChange?.('');
    prevInputValueRef.current = '';

    // Restore focus after state updates
    requestAnimationFrame(() => {
      richInputRef.current?.focus();
    });

    return true;
  }, [
    input,
    attachments,
    followUpItems,
    disabled,
    disableSend,
    onInputChange,
    onSubmit,
    mentionSkills,
    sources,
    optimisticSourceSlugs,
    onSourcesChange,
    richInputRef,
  ]);

  // Listen for craft:submit-input events (simulate pressing the Send button)
  React.useEffect(() => {
    const handleSubmitInput = (e: CustomEvent<{ sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId;
      if (
        !shouldHandleScopedInputEvent({
          sessionId,
          isFocusedPanel,
          targetSessionId,
        })
      )
        return;
      submitMessage();
    };

    window.addEventListener(
      'craft:submit-input',
      handleSubmitInput as EventListener,
    );
    return () =>
      window.removeEventListener(
        'craft:submit-input',
        handleSubmitInput as EventListener,
      );
  }, [sessionId, isFocusedPanel, submitMessage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    submitMessage();
  };

  const handleStop = (silent = false) => {
    onStop?.(silent);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // During IME composition, ESC should cancel composition, not trigger app/menu ESC behavior.
    if (e.key === 'Escape' && e.nativeEvent.isComposing) {
      return;
    }

    // Don't submit when mention menu is open AND has visible content
    if (inlineMention.isOpen) {
      // Only intercept navigation/selection keys if menu actually shows items or is loading
      const hasVisibleContent =
        inlineMention.sections.some((s) => s.items.length > 0) ||
        inlineMention.isSearching;
      if (
        hasVisibleContent &&
        (e.key === 'Enter' ||
          e.key === 'Tab' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown')
      ) {
        // These keys are handled by the InlineMentionMenu component
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        inlineMention.close();
        return;
      }
    }

    // Don't submit when slash command menu is open - let it handle the Enter key
    if (inlineSlash.isOpen) {
      if (
        e.key === 'Enter' ||
        e.key === 'Tab' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown'
      ) {
        // These keys are handled by the InlineSlashCommand component
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        inlineSlash.close();
        return;
      }
    }

    // Don't submit when label menu is open - let it handle navigation keys
    if (inlineLabel.isOpen) {
      if (
        e.key === 'Enter' ||
        e.key === 'Tab' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown'
      ) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        inlineLabel.close();
        return;
      }
    }

    if (
      e.key === 'Tab' &&
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      onPermissionModeChange
    ) {
      e.preventDefault();
      e.stopPropagation();
      onPermissionModeChange(
        getNextPermissionMode(permissionMode, enabledModes),
      );
      return;
    }

    // Skip submission during IME composition - user is confirming composed characters, not sending
    // Handle send key based on user preference:
    // - 'enter': Enter sends (Shift+Enter for newline)
    // - 'cmd-enter': ⌘/Ctrl+Enter sends (Enter for newline)
    if (sendMessageKey === 'enter') {
      // Enter sends, Shift+Enter adds newline
      if (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        submitMessage();
      }
      // Also allow Cmd/Ctrl+Enter to send (power user shortcut)
      if (
        e.key === 'Enter' &&
        (e.metaKey || e.ctrlKey) &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        submitMessage();
      }
    } else {
      // cmd-enter mode: ⌘/Ctrl+Enter sends, plain Enter adds newline
      if (
        e.key === 'Enter' &&
        (e.metaKey || e.ctrlKey) &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        submitMessage();
      }
      // Plain Enter is allowed to pass through (adds newline)
    }
    if (e.key === 'Escape') {
      // Skip blur if a popover/overlay is open — let the overlay handle ESC instead.
      // This prevents the input from consuming ESC when focus gets pulled back here
      // while a popover is still visible (portal DOM isolation means the event won't
      // reach the popover's DismissableLayer otherwise).
      if (!hasOpenOverlay()) {
        richInputRef.current?.blur();
      }
    }
  };

  // Handle input changes from RichTextInput
  const handleInputChange = React.useCallback(
    (value: string) => {
      const nextValue = coerceInputText(value);
      // Get previous input value before updating state
      const prevValue = inputRef.current;

      setInput(nextValue);
      syncToParent(nextValue); // Debounced sync to parent for draft persistence

      // Sync source selection when mentions are removed from input
      if (onSourcesChange) {
        const sourceSlugs = sources.map((s) => s.config.slug);

        // Parse mentions from previous and current input
        const prevMentions = parseMentions(prevValue, [], sourceSlugs);
        const currMentions = parseMentions(nextValue, [], sourceSlugs);

        // Remove sources that were mentioned before but not anymore
        const removedSources = prevMentions.sources.filter(
          (slug) => !currMentions.sources.includes(slug),
        );
        if (removedSources.length > 0) {
          const newSlugs = optimisticSourceSlugs.filter(
            (slug) => !removedSources.includes(slug),
          );
          setOptimisticSourceSlugs(newSlugs);
          onSourcesChange(newSlugs);
        }
      }
    },
    [syncToParent, sources, optimisticSourceSlugs, onSourcesChange],
  );

  // Handle input with cursor position (for menu detection)
  const handleRichInput = React.useCallback(
    (value: string, cursorPosition: number) => {
      const nextValue = coerceInputText(value);

      // Update inline slash command state
      inlineSlash.handleInputChange(nextValue, cursorPosition);

      // Update inline mention state (for @mentions - skills, sources, folders)
      inlineMention.handleInputChange(nextValue, cursorPosition);

      // Update inline label state (for #labels)
      inlineLabel.handleInputChange(nextValue, cursorPosition);

      // Auto-capitalize first letter (but not for slash commands, @mentions, or #labels)
      // Only if autoCapitalisation setting is enabled
      let newValue = nextValue;
      if (
        autoCapitalisation &&
        nextValue.length > 0 &&
        nextValue.charAt(0) !== '/' &&
        nextValue.charAt(0) !== '@' &&
        nextValue.charAt(0) !== '#'
      ) {
        const capitalizedFirst = nextValue.charAt(0).toUpperCase();
        if (capitalizedFirst !== nextValue.charAt(0)) {
          newValue = capitalizedFirst + nextValue.slice(1);
          // Set cursor position BEFORE state update so it's used when useEffect syncs the value
          richInputRef.current?.setSelectionRange(
            cursorPosition,
            cursorPosition,
          );
          setInput(newValue);
          syncToParent(newValue);
          return;
        }
      }

      // Apply smart typography (-> to →, etc.)
      const typography = applySmartTypography(nextValue, cursorPosition);
      if (typography.replaced) {
        newValue = typography.text;
        // Set cursor position BEFORE state update so it's used when useEffect syncs the value
        richInputRef.current?.setSelectionRange(
          typography.cursor,
          typography.cursor,
        );
        setInput(newValue);
        syncToParent(newValue);
      }
    },
    [
      inlineSlash,
      inlineMention,
      inlineLabel,
      syncToParent,
      autoCapitalisation,
      richInputRef,
    ],
  );

  // Handle inline slash command selection (removes the /command text)
  const handleInlineSlashCommandSelect = React.useCallback(
    (commandId: SlashCommandId) => {
      const { value: newValue, cursorPosition } =
        inlineSlash.handleSelectCommand(commandId);
      setInput(newValue);
      syncToParent(newValue);
      setTimeout(() => {
        richInputRef.current?.focus();
        if (cursorPosition !== undefined) {
          richInputRef.current?.setSelectionRange(
            cursorPosition,
            cursorPosition,
          );
        }
      }, 0);
    },
    [inlineSlash, syncToParent, richInputRef],
  );

  // Handle inline slash folder selection (inserts a directory badge)
  const handleInlineSlashFolderSelect = React.useCallback(
    (path: string) => {
      const newValue = inlineSlash.handleSelectFolder(path);
      setInput(newValue);
      syncToParent(newValue);
      richInputRef.current?.focus();
    },
    [inlineSlash, syncToParent, richInputRef],
  );

  // Handle inline mention selection (inserts appropriate mention text)
  const handleInlineMentionSelect = React.useCallback(
    (item: MentionItem) => {
      const { value: newValue, cursorPosition } =
        inlineMention.handleSelect(item);
      setInput(newValue);
      syncToParent(newValue);
      // Focus input and restore cursor position after badge renders
      setTimeout(() => {
        richInputRef.current?.focus();
        richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition);
      }, 0);
    },
    [inlineMention, syncToParent, richInputRef],
  );

  // Handle inline label selection (removes the #label text from input)
  const handleInlineLabelSelect = React.useCallback(
    (labelId: string) => {
      const newValue = inlineLabel.handleSelect(labelId);
      setInput(newValue);
      syncToParent(newValue);
      richInputRef.current?.focus();
    },
    [inlineLabel, syncToParent, richInputRef],
  );

  // Handle inline state selection from # menu (removes #text, changes session state)
  const handleInlineStateSelect = React.useCallback(
    (stateId: string) => {
      const newValue = inlineLabel.handleSelect('');
      setInput(newValue);
      syncToParent(newValue);
      if (sessionId) {
        onSessionStatusChange?.(sessionId, stateId);
      }
      richInputRef.current?.focus();
    },
    [inlineLabel, syncToParent, sessionId, onSessionStatusChange, richInputRef],
  );

  const followUpLayoutKey = React.useMemo(
    () =>
      followUpItems
        .map((item) =>
          [
            item.id,
            item.index ?? '',
            item.noteLabel,
            item.selectedText,
            item.color ?? '',
          ].join('::'),
        )
        .join('|'),
    [followUpItems],
  );
  const previousFollowUpLayoutKeyRef = React.useRef<string | null>(null);
  const [animateFollowUpLayout, setAnimateFollowUpLayout] =
    React.useState(false);

  React.useEffect(() => {
    const previous = previousFollowUpLayoutKeyRef.current;
    previousFollowUpLayoutKeyRef.current = followUpLayoutKey;

    if (previous == null || previous === followUpLayoutKey) return;

    setAnimateFollowUpLayout(true);
    const timer = window.setTimeout(() => {
      setAnimateFollowUpLayout(false);
    }, 220);

    return () => window.clearTimeout(timer);
  }, [followUpLayoutKey]);

  const hasContent =
    input.trim() || attachments.length > 0 || followUpItems.length > 0;

  return (
    <form onSubmit={handleSubmit}>
      <div
        ref={containerRef}
        className={cn(
          'overflow-hidden transition-all',
          // Container styling - only when not wrapped by InputContainer
          !unstyled && 'rounded-[16px] shadow-middle',
          !unstyled && 'bg-background',
          isDraggingOver &&
            'ring-2 ring-foreground ring-offset-2 ring-offset-background bg-foreground/5',
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Inline Slash Command Autocomplete */}
        <InlineSlashCommand
          open={inlineSlash.isOpen}
          onOpenChange={(open) => !open && inlineSlash.close()}
          sections={inlineSlash.sections}
          activeCommands={activeCommands}
          onSelectCommand={handleInlineSlashCommandSelect}
          onSelectFolder={handleInlineSlashFolderSelect}
          filter={inlineSlash.filter}
          position={inlineSlash.position}
        />

        {/* Inline Mention Autocomplete (skills, sources, files) */}
        <InlineMentionMenu
          open={inlineMention.isOpen}
          onOpenChange={(open) => !open && inlineMention.close()}
          sections={inlineMention.sections}
          onSelect={handleInlineMentionSelect}
          filter={inlineMention.filter}
          position={inlineMention.position}
          workspaceId={workspaceId}
          maxWidth={280}
          isSearching={inlineMention.isSearching}
        />

        {/* Inline Label & State Autocomplete (#labels / #states) */}
        <InlineLabelMenu
          open={inlineLabel.isOpen}
          onOpenChange={(open) => !open && inlineLabel.close()}
          items={inlineLabel.items}
          onSelect={handleInlineLabelSelect}
          onAddLabel={showSessionLabelsUi ? handleAddLabel : undefined}
          filter={inlineLabel.filter}
          position={inlineLabel.position}
          states={inlineLabel.states}
          activeStateId={inlineLabel.activeStateId}
          onSelectState={handleInlineStateSelect}
        />

        {/* Controlled EditPopover for "Add New Label" — opens when user selects
            the option from the # menu with no matches.
            Spread the full config so optional fields like `inlineExecution`,
            `displayLabel`, and `displayLabelKey` reach the popover. The previous
            cherry-pick dropped `inlineExecution: true`, which made the popover
            fall back to the same-window deep-link path; that worked inside
            Electron but launched the desktop app from the WebUI via `craftagents://`.
            Match the AppShell pattern (which already uses spread). */}
        {showSessionLabelsUi && addLabelEditConfig && (
          <EditPopover
            trigger={
              <span className="absolute top-0 left-0 w-0 h-0 overflow-hidden" />
            }
            open={addLabelPopoverOpen}
            onOpenChange={setAddLabelPopoverOpen}
            {...addLabelEditConfig}
            defaultValue={addLabelPrefill}
            secondaryAction={
              workspaceRootPath
                ? {
                    label: 'Edit File',
                    filePath: `${workspaceRootPath}/labels/config.json`,
                  }
                : undefined
            }
            side="top"
            align="start"
          />
        )}

        {/* Attachment Preview */}
        <AttachmentPreview
          attachments={attachments}
          onRemove={handleRemoveAttachment}
          disabled={disabled}
          loadingCount={loadingCount}
        />

        {/* Follow-up context chips */}
        <AnimatePresence initial={false}>
          {followUpItems.length > 0 && (
            <motion.div
              key="follow-up-chips"
              layout={animateFollowUpLayout}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0.2, 1] }}
              className="overflow-hidden"
            >
              <motion.div
                layout={animateFollowUpLayout}
                className="px-3 pt-3.5 pb-0"
              >
                <motion.div
                  layout={animateFollowUpLayout}
                  className="flex flex-wrap gap-1"
                >
                  <AnimatePresence initial={false}>
                    {followUpItems.map((item, idx) => {
                      const chipIndex = item.index ?? idx + 1;
                      const tooltipText =
                        item.selectedText.trim() || t('chat.selectedText');
                      const selectedExcerpt = formatFollowUpChipText(
                        item.selectedText,
                        t('chat.selectedText'),
                        50,
                      );
                      const noteExcerpt = formatFollowUpChipText(
                        item.noteLabel,
                        t('chat.followUp'),
                        50,
                      );

                      return (
                        <motion.button
                          key={item.id}
                          type="button"
                          layout={animateFollowUpLayout}
                          initial={{ opacity: 0, y: 6, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -4, scale: 0.98 }}
                          transition={{
                            duration: 0.16,
                            ease: [0.2, 0, 0.2, 1],
                          }}
                          className="inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-[6px] bg-foreground/2 pl-1.5 pr-2 py-1 text-[13px] text-foreground/80 select-none transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={(event) => {
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            onFollowUpClick?.(item, {
                              x: rect.left + rect.width / 2,
                              y: rect.top - 8,
                            });
                          }}
                        >
                          <Tooltip delayDuration={250}>
                            <TooltipTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                className="inline-flex h-4 min-w-4 cursor-pointer items-center justify-center rounded-[4px] bg-background px-0.5 text-[10px] font-medium text-foreground shadow-minimal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                }}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  onFollowUpIndexClick?.(item);
                                }}
                                onKeyDown={(event) => {
                                  if (
                                    event.key === 'Enter' ||
                                    event.key === ' '
                                  ) {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onFollowUpIndexClick?.(item);
                                  }
                                }}
                              >
                                {chipIndex}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent
                              side="top"
                              className="max-w-[420px] break-words text-xs"
                            >
                              {tooltipText}
                            </TooltipContent>
                          </Tooltip>
                          <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap pr-0.5 text-left">
                            <span className="italic text-foreground/60">
                              {selectedExcerpt}
                            </span>
                            <span className="mx-1 text-foreground/40">·</span>
                            <span>{noteExcerpt}</span>
                          </span>
                        </motion.button>
                      );
                    })}
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {queuedInputMessages.length > 0 && (
            <motion.div
              key="queued-input-messages"
              initial={{ opacity: 0, y: 6, height: 0 }}
              animate={{ opacity: 1, y: 0, height: 'auto' }}
              exit={{ opacity: 0, y: -4, height: 0 }}
              transition={{ duration: 0.16, ease: [0.2, 0, 0.2, 1] }}
              className="overflow-hidden border-b border-border/40"
            >
              <div className="flex flex-col">
                {queuedInputMessages.map((message) => (
                  <div
                    key={message.id}
                    className="flex min-h-10 items-center gap-2 px-5 py-2 text-[13px] text-foreground/60"
                  >
                    <CornerDownRight className="h-4 w-4 shrink-0 text-foreground/35" />
                    <span className="min-w-0 flex-1 truncate">
                      {message.content}
                    </span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Rich Text Input with inline mention badges */}
        {/* In compact mode, hide input while processing (collapses to just bottom bar) */}
        {!(compactMode && isProcessing) && (
          <RichTextInput
            ref={richInputRef}
            value={input}
            onChange={handleInputChange}
            onInput={handleRichInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onLongTextPaste={handleLongTextPaste}
            onFocus={() => {
              setIsInputFocused(true);
              onFocusChange?.(true);
            }}
            onBlur={() => {
              setIsInputFocused(false);
              // Save caret position before losing focus (for restoration via craft:focus-input)
              lastCaretPositionRef.current =
                richInputRef.current?.selectionStart ?? null;
              onFocusChange?.(false);
            }}
            placeholder={effectivePlaceholder}
            disabled={disabled}
            skills={mentionSkills}
            sources={sources}
            workspaceId={workspaceSlug}
            slashCommandNames={richInputSlashCommandNames}
            className="pl-5 pr-4 pt-4 pb-3 overflow-y-auto min-h-[88px]"
            style={{ maxHeight: inputMaxHeight }}
            data-tutorial="chat-input"
            spellCheck={spellCheck}
          />
        )}

        {/* Bottom Row: Controls - wrapped in relative container for status slot overlay */}
        <div className="relative">
          {/* Status slot overlay - escape interrupt (highest priority), browser status, etc. */}
          <ToolbarStatusSlot
            showEscapeOverlay={isProcessing && showEscapeOverlay}
            sessionId={sessionId}
          />

          <div
            className={cn(
              'flex items-center gap-1 px-2 py-2',
              !compactMode && 'border-t border-border/50',
            )}
          >
            {/* Hidden file input for attach button (shared by compact and desktop) */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />

            {/* Compact mode: permission mode drawer + standard icon badges for attach/working dir */}
            {compactMode && (
              <>
                {onPermissionModeChange && (
                  <CompactPermissionModeSelector
                    permissionMode={permissionMode}
                    onPermissionModeChange={onPermissionModeChange}
                  />
                )}
                <FreeFormInputContextBadge
                  icon={<Paperclip className="h-4 w-4" />}
                  label={
                    attachments.length > 0
                      ? t('chat.filesCount', { count: attachments.length })
                      : t('chat.attach')
                  }
                  isExpanded={false}
                  hasSelection={attachments.length > 0}
                  showChevron={false}
                  onClick={handleAttachClick}
                  tooltip={t('chat.attachFilesTooltip')}
                  disabled={disabled}
                />
                {onWorkingDirectoryChange && (
                  <WorkingDirectoryBadge
                    workingDirectory={workingDirectory}
                    onWorkingDirectoryChange={onWorkingDirectoryChange}
                    sessionFolderPath={sessionFolderPath}
                    isEmptySession={false}
                    workspaceId={workspaceId}
                  />
                )}
              </>
            )}

            {/* Desktop: full badges row with labels and working directory */}
            {!compactMode && (
              <div className="flex items-center gap-1 min-w-32 shrink overflow-hidden">
                {/* 1. Attach Files Badge */}
                <FreeFormInputContextBadge
                  icon={<Paperclip className="h-4 w-4" />}
                  label={
                    attachments.length > 0
                      ? t('chat.filesCount', { count: attachments.length })
                      : t('chat.attachFiles')
                  }
                  isExpanded={isEmptySession}
                  hasSelection={attachments.length > 0}
                  showChevron={false}
                  onClick={handleAttachClick}
                  tooltip={t('chat.attachFilesTooltip')}
                  disabled={disabled}
                />

                {/* 2. Working Directory Selector Badge */}
                {onWorkingDirectoryChange && (
                  <WorkingDirectoryBadge
                    workingDirectory={workingDirectory}
                    onWorkingDirectoryChange={onWorkingDirectoryChange}
                    sessionFolderPath={sessionFolderPath}
                    isEmptySession={isEmptySession}
                    workspaceId={workspaceId}
                  />
                )}
              </div>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Right side: Context + Model + Send - never shrink so they're always visible */}
            <div className="flex items-center shrink-0">
              {/* 4. Context Usage Indicator */}
              {!compactMode && contextUsageIndicator && (
                <ContextUsageIndicator
                  usedTokens={contextUsageIndicator.usedTokens}
                  totalTokens={contextUsageIndicator.totalTokens}
                  isCompacting={contextUsageIndicator.isCompacting}
                  usagePercent={contextUsageIndicator.usagePercent}
                  usedDisplay={contextUsageIndicator.usedDisplay}
                  totalDisplay={contextUsageIndicator.totalDisplay}
                />
              )}

              {/* 5. Model Selector - Hidden in compact mode (EditPopover embedding) */}
              {!compactMode && (
                <DropdownMenu
                  open={modelDropdownOpen}
                  onOpenChange={setModelDropdownOpen}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            'input-toolbar-btn inline-flex items-center h-7 px-1.5 gap-0.5 text-[13px] shrink-0 rounded-[6px] hover:bg-foreground/5 transition-colors select-none',
                            modelDropdownOpen && 'bg-foreground/5',
                            connectionUnavailable && 'text-destructive',
                          )}
                        >
                          {connectionUnavailable ? (
                            <>
                              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                              {t('common.unavailable')}
                            </>
                          ) : (
                            <>
                              {currentModelDisplayName}
                              <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
                            </>
                          )}
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {t('common.model')}
                    </TooltipContent>
                  </Tooltip>
                  <StyledDropdownMenuContent
                    side="top"
                    align="end"
                    sideOffset={8}
                    className="min-w-[260px]"
                  >
                    {connectionUnavailable ? (
                      <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
                        <AlertCircle className="h-8 w-8 text-destructive mb-2" />
                        <div className="font-medium text-sm mb-1">
                          {t('chat.connectionUnavailable')}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('chat.connectionUnavailableDescription')}
                        </div>
                      </div>
                    ) : availableModels.length === 0 ? (
                      <StyledDropdownMenuItem
                        disabled
                        className="flex items-center justify-between px-2 py-2 rounded-lg"
                      >
                        <div className="text-left">
                          <div className="font-medium text-sm">
                            {t('common.loading')}
                          </div>
                        </div>
                      </StyledDropdownMenuItem>
                    ) : (
                      <>
                        {availableModels.map((model) => {
                          const modelId =
                            typeof model === 'string' ? model : model.id;
                          const modelName =
                            typeof model === 'string'
                              ? getModelShortName(model)
                              : model.name;
                          const isSelected = currentModel === modelId;
                          const descriptionKey =
                            typeof model !== 'string' &&
                            'descriptionKey' in model
                              ? (model.descriptionKey as string)
                              : undefined;
                          const description = descriptionKey
                            ? t(descriptionKey)
                            : typeof model !== 'string' &&
                                'description' in model
                              ? (model.description as string)
                              : '';
                          return (
                            <StyledDropdownMenuItem
                              key={modelId}
                              onSelect={() =>
                                onModelChange(modelId, qwenConnection?.slug)
                              }
                              className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                            >
                              <div className="text-left">
                                <div className="font-medium text-sm">
                                  {modelName}
                                </div>
                                {description && (
                                  <div className="text-xs text-muted-foreground">
                                    {description}
                                  </div>
                                )}
                              </div>
                              {isSelected && (
                                <Check className="h-3 w-3 text-foreground shrink-0 ml-3" />
                              )}
                            </StyledDropdownMenuItem>
                          );
                        })}
                      </>
                    )}
                  </StyledDropdownMenuContent>
                </DropdownMenu>
              )}

              {/* 6. Send/Stop Button - Always show stop when processing */}
              {isProcessing ? (
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  aria-label={t('chat.stopResponse')}
                  className="send-btn h-7 w-7 rounded-full shrink-0 hover:bg-foreground/15 active:bg-foreground/20 ml-2"
                  onClick={() => handleStop(false)}
                >
                  <Square className="h-3 w-3 fill-current" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="icon"
                  aria-label={t('shortcuts.sendMessage')}
                  className="send-btn h-7 w-7 rounded-full shrink-0 ml-2"
                  disabled={!hasContent || disabled || disableSend}
                  data-tutorial="send-button"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

/**
 * Format path for display, with home directory shortened
 */
function formatPathForDisplay(path: string, homeDir: string): string {
  let displayPath = path;
  if (homeDir && path.startsWith(homeDir)) {
    const relativePath = path.slice(homeDir.length);
    // Remove leading separator if present, show root separator if empty
    displayPath = relativePath.startsWith(PATH_SEP)
      ? relativePath.slice(1)
      : relativePath || PATH_SEP;
  }
  return `in ${displayPath}`;
}

/**
 * WorkingDirectoryBadge - Context badge for selecting working directory
 * Uses cmdk for filterable folder list when there are more than 5 recent folders.
 */
function WorkingDirectoryBadge({
  workingDirectory,
  onWorkingDirectoryChange,
  sessionFolderPath,
  isEmptySession = false,
  workspaceId,
}: {
  workingDirectory?: string;
  onWorkingDirectoryChange: (path: string) => void;
  sessionFolderPath?: string;
  isEmptySession?: boolean;
  workspaceId?: string;
}) {
  const { t } = useTranslation();
  const [recentDirs, setRecentDirs] = React.useState<string[]>([]);
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const [homeDir, setHomeDir] = React.useState<string>('');
  const [gitBranch, setGitBranch] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Load home directory and recent directories on mount
  React.useEffect(() => {
    setRecentDirs(getRecentWorkingDirs(workspaceId));
    window.electronAPI?.getHomeDir?.().then((dir: string) => {
      if (dir) setHomeDir(dir);
    });
  }, [workspaceId]);

  // Fetch git branch when working directory changes
  React.useEffect(() => {
    if (workingDirectory) {
      window.electronAPI
        ?.getGitBranch?.(workingDirectory)
        .then((branch: string | null) => {
          setGitBranch(branch);
        });
    } else {
      setGitBranch(null);
    }
  }, [workingDirectory]);

  // Reset filter, refresh history, and focus input when popover opens
  React.useEffect(() => {
    if (popoverOpen) {
      setFilter('');
      setRecentDirs(getRecentWorkingDirs(workspaceId));
      // Focus input after popover animation completes (only if filter is shown)
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [popoverOpen, workspaceId]);

  const handleFolderSelected = React.useCallback(
    (selectedPath: string) => {
      setRecentDirs(addRecentWorkingDir(selectedPath, workspaceId));
      onWorkingDirectoryChange(selectedPath);
    },
    [onWorkingDirectoryChange, workspaceId],
  );

  const {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(handleFolderSelected);

  const handleChooseFolder = () => {
    setPopoverOpen(false);
    pickDirectory();
  };

  const handleSelectRecent = (path: string) => {
    setRecentDirs(addRecentWorkingDir(path, workspaceId)); // Move to top of recent list
    onWorkingDirectoryChange(path);
    setPopoverOpen(false);
  };

  const handleReset = () => {
    if (sessionFolderPath) {
      onWorkingDirectoryChange(sessionFolderPath);
      setPopoverOpen(false);
    }
  };

  const handleRemoveRecent = (e: React.MouseEvent, path: string) => {
    e.stopPropagation(); // Don't trigger the item's onSelect
    setRecentDirs(removeRecentWorkingDir(path, workspaceId));
  };

  // Filter out current directory from recent list and sort alphabetically by folder name
  const filteredRecent = recentDirs
    .filter((p) => p !== workingDirectory)
    .sort((a, b) => {
      const nameA = getPathBasename(a).toLowerCase();
      const nameB = getPathBasename(b).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  // Show filter input only when more than 5 recent folders
  const showFilter = filteredRecent.length > 5;

  // Determine label - "Work in Folder" if not set or at session root, otherwise folder name
  const hasFolder =
    !!workingDirectory && workingDirectory !== sessionFolderPath;
  const folderName = hasFolder
    ? getPathBasename(workingDirectory) || 'Folder'
    : 'Work in Folder';

  // Show reset option when a folder is selected and it differs from session folder
  const showReset =
    hasFolder && sessionFolderPath && sessionFolderPath !== workingDirectory;

  // Styles matching todo-filter-menu.tsx for consistency
  const MENU_CONTAINER_STYLE =
    'min-w-[200px] max-w-[400px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small p-0';
  const MENU_LIST_STYLE =
    'max-h-[200px] overflow-y-auto p-1 [&_[cmdk-list-sizer]]:space-y-px';
  const MENU_ITEM_STYLE =
    'flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px] outline-none';

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <span className="shrink min-w-0 overflow-hidden">
            <FreeFormInputContextBadge
              icon={<Icon_Home className="h-4 w-4" />}
              label={folderName}
              isExpanded={isEmptySession}
              hasSelection={hasFolder}
              showChevron={true}
              isOpen={popoverOpen}
              tooltip={
                hasFolder ? (
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      {t('chat.workingDirectory')}
                    </span>
                    <span className="text-xs opacity-70">
                      {formatPathForDisplay(workingDirectory, homeDir)}
                    </span>
                    {gitBranch && (
                      <span className="text-xs opacity-70">
                        {t('chat.onBranch', { branch: gitBranch })}
                      </span>
                    )}
                  </span>
                ) : (
                  t('chat.chooseWorkingDirectory')
                )
              }
            />
          </span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className={MENU_CONTAINER_STYLE}
        >
          <CommandPrimitive shouldFilter={showFilter}>
            {/* Filter input - only shown when more than 5 recent folders */}
            {showFilter && (
              <div className="border-b border-border/50 px-3 py-2">
                <CommandPrimitive.Input
                  ref={inputRef}
                  value={filter}
                  onValueChange={setFilter}
                  placeholder={t('chat.filterFolders')}
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 placeholder:select-none"
                />
              </div>
            )}

            <CommandPrimitive.List className={MENU_LIST_STYLE}>
              {/* Current Folder Display - shown at top with checkmark */}
              {hasFolder && (
                <CommandPrimitive.Item
                  value={`current-${workingDirectory}`}
                  className={cn(
                    MENU_ITEM_STYLE,
                    'pointer-events-none bg-foreground/5',
                  )}
                  disabled
                >
                  <Icon_Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 min-w-0 truncate">
                    <span>{folderName}</span>
                    <span className="text-muted-foreground ml-1.5">
                      {formatPathForDisplay(workingDirectory, homeDir)}
                    </span>
                  </span>
                  <Check className="h-4 w-4 shrink-0" />
                </CommandPrimitive.Item>
              )}

              {/* Separator after current folder */}
              {hasFolder && filteredRecent.length > 0 && (
                <div className="h-px bg-border my-1 mx-1" />
              )}

              {/* Recent Directories - filterable (current directory already filtered out via filteredRecent) */}
              {filteredRecent.map((path) => {
                const recentFolderName = getPathBasename(path) || 'Folder';
                return (
                  <CommandPrimitive.Item
                    key={path}
                    value={`${recentFolderName} ${path}`}
                    onSelect={() => handleSelectRecent(path)}
                    className={cn(
                      MENU_ITEM_STYLE,
                      'group/item data-[selected=true]:bg-foreground/5',
                    )}
                  >
                    <Icon_Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 min-w-0 truncate">
                      <span>{recentFolderName}</span>
                      <span className="text-muted-foreground ml-1.5">
                        {formatPathForDisplay(path, homeDir)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={(e) => handleRemoveRecent(e, path)}
                      className="shrink-0 h-3 w-3 rounded-[3px] flex items-center justify-center opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-all"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </CommandPrimitive.Item>
                );
              })}

              {/* Empty state when filtering */}
              {showFilter && (
                <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
                  {t('chat.noFoldersFound')}
                </CommandPrimitive.Empty>
              )}
            </CommandPrimitive.List>

            {/* Bottom actions - always visible, outside scrollable area */}
            <div className="border-t border-border/50 p-1">
              <button
                type="button"
                onClick={handleChooseFolder}
                className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
              >
                {t('chat.chooseFolder')}
              </button>
              {showReset && (
                <button
                  type="button"
                  onClick={handleReset}
                  className={cn(
                    MENU_ITEM_STYLE,
                    'w-full hover:bg-foreground/5',
                  )}
                >
                  {t('common.reset')}
                </button>
              )}
            </div>
          </CommandPrimitive>
        </PopoverContent>
      </Popover>
      <ServerDirectoryBrowser
        open={showServerBrowser}
        mode={serverBrowserMode}
        onSelect={confirmServerBrowser}
        onCancel={cancelServerBrowser}
        initialPath={workingDirectory}
      />
    </>
  );
}
