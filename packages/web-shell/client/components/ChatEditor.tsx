import {
  forwardRef,
  memo,
  useImperativeHandle,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ReactNode,
  RefObject,
  DragEvent as ReactDragEvent,
  ChangeEvent as ReactChangeEvent,
} from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import {
  DAEMON_APPROVAL_MODES,
  useOptionalWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type { CommandInfo } from '../adapters/types';
import type { AttachmentPreviewRequest } from '../adapters/messageTypes';
import type { UseDaemonFollowupSuggestionReturn } from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonSessionGroupPresetColor,
  DaemonWorkspaceGitStatus,
  ReasoningSelection,
} from '@qwen-code/sdk/daemon';
import type { CommandDisplayCategoryOrder } from '../utils/commandDisplay';
import type { SkillInfo } from '../completions/slashCompletion';
import { useI18n } from '../i18n';
import type { DaemonReasoningControls } from '@qwen-code/web-shell/daemon-react-sdk';
import { useWebShellPortalRoot } from '../portalRoot';
import {
  useWebShellCustomization,
  type WebShellComposerInput,
  type WebShellComposerTag,
  type WebShellComposerTagIconMap,
  type WebShellAtProvider,
  type WebShellBuiltinAtProvidersConfig,
} from '../customization';
import {
  useComposerCore,
  type ComposerSubmitMetadata,
  type EditorHandle,
  type SlashMenuState,
  getComposerTagDisplay,
  getComposerTagLabel,
  getComposerTagValue,
} from '../hooks/useComposerCore';
import { AtMentionPanel } from './AtMentionPanel';
import { useFileUpload, type FileUploadItem } from '../hooks/useFileUpload';
import { fileReferenceInsertText } from '../hooks/useAtMentionMenu';
import { AddMenu } from './composer/AddMenu';
import { computePrependSkillTransaction } from './composer/prependSkillInvocation';
import { cssUrlVar } from '../utils/cssUrlVar';
import {
  getComposerTagIconUrl,
  isBuiltinComposerTagIconUrl,
  isPreviewableFileComposerTag,
} from '../utils/composerTag';
import { isSafeImageSrc } from './messages/Markdown';
import { ModeIcon } from './ModeIcon';
import { planSlashSectionRows } from '../utils/slashSectionPlan';
import { getModelDisplayName } from '../utils/modelDisplay';
import { getContextUsageLevel } from '../utils/contextUsage';
import { formatContextUsageDetail } from '../utils/formatTokenCount';
import { VoiceButton } from '../voice/VoiceButton';
import { LiveVoiceButton } from '../live/LiveVoiceButton';
import type {
  VoiceStatusRevision,
  VoiceWorkspaceTarget,
} from '../voice/voice-workspace-target';
import {
  GitBranchChipContent,
  GitBranchIndicator,
  gitBranchAriaLabel,
} from './GitBranchIndicator';
import { GitModePopover, type SessionGitIntent } from './GitModePopover';
import { BranchPickerPopover } from './BranchPickerPopover';
import { WorkspaceIndicator } from './WorkspaceIndicator';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderClosedIcon,
  LoaderCircleIcon,
  SlashIcon,
  UploadIcon,
  XIcon,
} from 'lucide-react';
import { FileTypeIcon } from './FileTypeIcon';
import { WorkspaceSelector } from './WorkspaceSelector';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from './ui/popover';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';
import {
  filterToolbarDropdownItems,
  getToolbarExpansionBudget,
  getToolbarItemVisibilityWithHysteresis,
  resolveToolbarModelLabel,
  type ToolbarDropdownItem,
} from './toolbarDropdown';
import styles from './ChatEditor.module.css';

const MAX_DROP_DIALOG_ROWS = 100;

export type ComposerToolbarAction =
  | 'approvalMode'
  | 'contextUsage'
  | 'gitBranch'
  | 'model'
  | 'commands'
  | 'files'
  | 'widthMode'
  | 'voice'
  | 'workspace'
  // Unlike the actions above, `addMenu` is never shown unless the host
  // lists it explicitly in `visibleToolbarActions` — the generic gate
  // defaults to "show" when the prop is absent, so `+` checks the prop
  // directly to stay off by default.
  | 'addMenu';

// Dropped folders surface in `dataTransfer.files` as 0-byte Files; only the
// items API can tell them apart, and folder uploads are out of scope.
function collectDroppedFiles(dataTransfer: DataTransfer): File[] {
  const items = dataTransfer.items;
  if (!items || items.length === 0) {
    return Array.from(dataTransfer.files);
  }
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

const ACTIVE_TOOLBAR_ACTIONS = [
  'approvalMode',
  'commands',
  'contextUsage',
  'gitBranch',
  'model',
  'widthMode',
  'voice',
  'workspace',
] as const satisfies readonly ComposerToolbarAction[];
const ACTIVE_TOOLBAR_ACTION_SET = new Set<ComposerToolbarAction>(
  ACTIVE_TOOLBAR_ACTIONS,
);

interface ChatEditorProps {
  onSubmit: (
    text: string,
    images?: import('../adapters/promptTypes').PromptImage[],
    files?: import('../adapters/promptTypes').PromptFile[],
    commitAccepted?: import('../hooks/useComposerCore').ComposerSubmitCommit,
    metadata?: ComposerSubmitMetadata,
  ) => boolean | void;
  onInputTextChange?: (text: string) => void;
  onAttachmentsChange?: (hasAttachments: boolean) => void;
  onCycleMode?: () => void;
  cycleModeOnTab?: boolean;
  onToggleShortcuts?: () => void;
  onCancel?: () => void;
  isRunning?: boolean;
  isPreparing?: boolean;
  /** First Esc armed a cancel — the send button shows an "Esc to stop" hint. */
  cancelArmed?: boolean;
  disabled?: boolean;
  placeholderText?: string;
  commands: CommandInfo[];
  skills?: SkillInfo[];
  slashCommandCategoryOrder?: CommandDisplayCategoryOrder;
  autoSubmitSlashCommands?: boolean;
  queuedMessages?: string[];
  onPopQueuedMessages?: () => boolean;
  onClearQueuedMessages?: () => boolean;
  currentMode?: string;
  sessionWorkflowEnabled?: boolean;
  currentModel?: string;
  gitBranch?: string;
  /** Whether the session is in a worktree (styles the git chip purple). */
  gitWorktree?: boolean;
  /** Git working directory for worktree sessions; targets git operations. */
  gitCwd?: string;
  /** Git mode intent for the empty-state composer chip (branch/worktree selection). */
  gitModeIntent?: SessionGitIntent;
  /** Callback when the user changes the git mode intent via the composer chip popover. */
  onGitModeIntentChange?: (intent: SessionGitIntent) => void;
  /** Enriched working-tree summary (dirty / ahead-behind / stash / operation). */
  gitStatus?: DaemonWorkspaceGitStatus;
  /** Opens the working-tree Changes dialog; makes the git chip clickable. */
  onOpenGitDiff?: () => void;
  /** Opens the commit dialog. */
  onOpenCommit?: () => void;
  /** Workspace name shown in the pane composer's `workspace` toolbar chip. */
  workspaceName?: string;
  /** Full workspace cwd, used as the chip's tooltip. */
  workspaceTitle?: string;
  /**
   * Stable per-workspace accent color for the chip, so it stays distinguishable
   * from other panes' chips even when it collapses to an icon on a narrow split.
   */
  workspaceColor?: DaemonSessionGroupPresetColor;
  chatWidthMode?: '1000' | 'wide';
  showChatWidthToggle?: boolean;
  chatWidthToggleMin?: number;
  visibleToolbarActions?: readonly ComposerToolbarAction[];
  /** Current context-window occupancy for the `contextUsage` toolbar ring. */
  tokenCount?: number;
  contextWindow?: number;
  /** Keep Context Usage available before a restored session reports usage. */
  contextUsageAlwaysVisible?: boolean;
  /** Show the context-usage breakdown, exactly like typing /context. */
  onShowContextUsage?: () => void;
  availableModels?: Array<{ id: string; label?: string }>;
  onSelectMode?: (mode: string) => void;
  onSelectModel?: (model: string) => void;
  reasoning?: DaemonReasoningControls;
  onSelectReasoningEffort?: (value: ReasoningSelection) => Promise<void> | void;
  workspaces?: Array<{
    id: string;
    cwd: string;
    label: string;
    primary: boolean;
    trusted: boolean;
  }>;
  selectedWorkspaceCwd?: string;
  noWorkspaceSupported?: boolean;
  noWorkspaceSelected?: boolean;
  workspaceSelectionDisabled?: boolean;
  onSelectWorkspace?: (workspaceCwd: string | undefined) => void;
  onSelectNoWorkspace?: () => void;
  scratchWorkspaceSupported?: boolean;
  existingFolderWorkspaceSupported?: boolean;
  workspaceMutationBusy?: boolean;
  onCreateScratchWorkspace?: () => void;
  onOpenExistingWorkspace?: () => void;
  atWorkspaceCwd?: string;
  composerScopeKey?: string;
  workspaceFeaturesEnabled?: boolean;
  onChatWidthModeChange?: (mode: '1000' | 'wide') => void;
  onFocusFooter?: () => boolean;
  dialogOpen?: boolean;
  followupState?: UseDaemonFollowupSuggestionReturn['followupState'];
  onAcceptFollowup?: UseDaemonFollowupSuggestionReturn['onAcceptFollowup'];
  onDismissFollowup?: UseDaemonFollowupSuggestionReturn['onDismissFollowup'];
  sessionId?: string;
  sessionName?: string;
  composerInput?: WebShellComposerInput;
  composerInputVersion?: number;
  builtinAtProviders?: WebShellBuiltinAtProvidersConfig;
  atProviders?: readonly WebShellAtProvider[];
  composerTagIcons?: WebShellComposerTagIconMap;
  voiceTarget?: VoiceWorkspaceTarget;
  voiceStatusRevision?: VoiceStatusRevision;
  onImageIngestionNotice?: (tone: 'warning' | 'error', message: string) => void;
  /** Click a pasted image in the composer to preview it in the right panel. */
  onImagePreview?: (src: string, alt?: string) => void;
  onAttachmentPreview?: (file: AttachmentPreviewRequest) => void;
  compactOverlays?: boolean;
}

const CHAT_EDITOR_THEME = {
  '&': {
    fontSize: '14px',
    background: 'transparent',
    border: 'none',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    maxHeight: 'var(--chat-editor-input-max-height, 300px)',
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  '.cm-content': {
    padding: '0',
    fontFamily: 'var(--font-sans, system-ui, sans-serif)',
    color: 'var(--chat-editor-text-primary, #e0e0e0)',
    caretColor: 'var(--chat-editor-accent-color, #4a9eff)',
    fontSize: '14px',
    lineHeight: '1.6',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-placeholder': {
    color: 'var(--chat-editor-text-dimmed, #666)',
  },
  '.cm-followup-ghost': {
    color: 'var(--chat-editor-text-dimmed, #666)',
    opacity: '0.72',
    pointerEvents: 'none',
    userSelect: 'none',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--chat-editor-selection-bg) !important',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--chat-editor-selection-bg) !important',
  },
  '&.cm-focused .cm-content ::selection': {
    backgroundColor: 'var(--chat-editor-selection-bg)',
    color: 'var(--chat-editor-selection-color)',
  },
  '.cm-content ::selection': {
    backgroundColor: 'var(--chat-editor-selection-bg)',
    color: 'var(--chat-editor-selection-color)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--chat-editor-accent-color, #4a9eff)',
    borderLeftWidth: '2px',
  },
};

function isTouchLikeDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: none), (pointer: coarse)').matches)
  );
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TopComposerTag({
  tag,
  content,
  tooltip,
  onActivate,
  onRemove,
}: {
  tag: WebShellComposerTag;
  content: ReactNode;
  tooltip: ReactNode | null | undefined;
  onActivate?: (anchorRect: DOMRectReadOnly) => void;
  onRemove?: () => void;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const portalRoot = useWebShellPortalRoot();
  const hasTooltip = tooltip !== undefined && tooltip !== null;
  const tagContent = (
    <span
      className={styles.tagContent}
      data-web-shell-composer-tag-trigger
      role={onActivate ? 'button' : undefined}
      tabIndex={onActivate || hasTooltip ? 0 : undefined}
      onClick={(event) => {
        if (!onActivate) return;
        event.stopPropagation();
        onActivate(
          anchorRef.current?.getBoundingClientRect() ??
            event.currentTarget.getBoundingClientRect(),
        );
      }}
      onKeyDown={(event) => {
        if (!onActivate) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onActivate(
          anchorRef.current?.getBoundingClientRect() ??
            event.currentTarget.getBoundingClientRect(),
        );
      }}
    >
      {content}
    </span>
  );
  const tagElement = (
    <span ref={anchorRef} className={styles.tag} data-web-shell-composer-tag>
      {hasTooltip ? (
        <TooltipPrimitive.Trigger asChild>
          {tagContent}
        </TooltipPrimitive.Trigger>
      ) : (
        tagContent
      )}
      {onRemove && (
        <button
          type="button"
          className={styles.tagRemove}
          aria-label={`Remove ${getComposerTagDisplay(tag)}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation();
              return;
            }
            if (event.key !== 'Backspace' && event.key !== 'Delete') return;
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );

  if (!hasTooltip) return tagElement;

  return (
    <TooltipPrimitive.Root disableHoverableContent={false}>
      {tagElement}
      <TooltipPrimitive.Portal container={portalRoot ?? undefined}>
        <TooltipPrimitive.Content
          className={styles.tagTooltip}
          data-web-shell-composer-tag-tooltip
          sideOffset={6}
          collisionPadding={8}
          avoidCollisions
        >
          {tooltip}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

function SendIcon() {
  return (
    <svg
      className={styles.sendIcon}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M10 15.5v-11M5.5 9 10 4.5 14.5 9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon() {
  return <span className={styles.stopIcon} aria-hidden="true" />;
}

function LoadingIcon() {
  return <span className={styles.loadingIcon} aria-hidden="true" />;
}

function QuickActionsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {[7, 12, 17].flatMap((y) =>
        [7, 12, 17].map((x) => (
          <circle
            key={`${x}-${y}`}
            cx={x}
            cy={y}
            r="1.35"
            fill="currentColor"
          />
        )),
      )}
    </svg>
  );
}

function attachComposerGlow(glowRootEl: HTMLElement, inputEl: HTMLElement) {
  let glowRaf: number | undefined;
  let pulseRaf: number | undefined;
  let pulseDecayTimer: number | undefined;
  let typingTimer: number | undefined;
  let glowCurrent = 0;
  let pulseCurrent = 0;

  const apply = (on: number, pulse: number) => {
    glowRootEl.style.setProperty('--dac-glow-on', on.toFixed(4));
    glowRootEl.style.setProperty('--dac-glow-pulse', pulse.toFixed(4));
  };

  const animateGlow = (target: number) => {
    if (glowRaf !== undefined) window.cancelAnimationFrame(glowRaf);
    const start = glowCurrent;
    const diff = target - start;
    if (Math.abs(diff) < 0.001) {
      glowCurrent = target;
      apply(target, pulseCurrent);
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - t0) / 220, 1);
      glowCurrent = start + diff * (1 - (1 - t) ** 2);
      apply(glowCurrent, pulseCurrent);
      glowRaf = t < 1 ? window.requestAnimationFrame(tick) : undefined;
    };
    glowRaf = window.requestAnimationFrame(tick);
  };

  const animatePulseDecay = () => {
    if (pulseRaf !== undefined) window.cancelAnimationFrame(pulseRaf);
    const start = pulseCurrent;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - t0) / 300, 1);
      pulseCurrent = start * (1 - t);
      apply(glowCurrent, pulseCurrent);
      pulseRaf = t < 1 ? window.requestAnimationFrame(tick) : undefined;
    };
    pulseRaf = window.requestAnimationFrame(tick);
  };

  const setTyping = (on: boolean) => {
    if (on) glowRootEl.setAttribute('data-dac-typing', '');
    else glowRootEl.removeAttribute('data-dac-typing');
  };

  const onFocus = () => animateGlow(1);
  const onBlur = () => {
    animateGlow(0);
    setTyping(false);
    if (typingTimer !== undefined) window.clearTimeout(typingTimer);
  };
  const onKeydown = () => {
    if (pulseRaf !== undefined) window.cancelAnimationFrame(pulseRaf);
    if (pulseDecayTimer !== undefined) window.clearTimeout(pulseDecayTimer);
    pulseCurrent = 1;
    apply(glowCurrent, 1);
    pulseDecayTimer = window.setTimeout(animatePulseDecay, 100);
    setTyping(true);
    if (typingTimer !== undefined) window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => setTyping(false), 650);
  };

  inputEl.addEventListener('focus', onFocus);
  inputEl.addEventListener('blur', onBlur);
  inputEl.addEventListener('keydown', onKeydown);
  if (document.activeElement === inputEl) animateGlow(1);

  return () => {
    if (glowRaf !== undefined) window.cancelAnimationFrame(glowRaf);
    if (pulseRaf !== undefined) window.cancelAnimationFrame(pulseRaf);
    if (pulseDecayTimer !== undefined) window.clearTimeout(pulseDecayTimer);
    if (typingTimer !== undefined) window.clearTimeout(typingTimer);
    inputEl.removeEventListener('focus', onFocus);
    inputEl.removeEventListener('blur', onBlur);
    inputEl.removeEventListener('keydown', onKeydown);
    apply(0, 0);
    setTyping(false);
  };
}

function WidthModeIcon({ mode }: { mode: '1000' | 'wide' }) {
  if (mode === 'wide') {
    return (
      <svg viewBox="0 0 1024 1024" aria-hidden="true">
        <path
          d="M550.012 486.537a8.16 8.16 0 0 1 8.17-8.17h305.36l-111.88-111.89c-3.19-3.19-3.19-8.4 0-11.59l25.08-25.08c3.19-3.19 8.4-3.19 11.59 0l168.61 168.6c3.19 3.19 3.19 8.4 0 11.59l-164.47 168.67c-3.19 3.19-8.4 3.19-11.59 0l-25.61-25.61c-3.19-3.19-3.19-8.4 0-11.59l106.58-110.78-303.62 0.11c-4.52 0-8.23-3.71-8.23-8.23v-36.03z"
          fill="currentColor"
          transform="translate(-483.41 0)"
        />
        <path
          d="M473.532 524.327a8.16 8.16 0 0 1-8.17 8.17h-305.36l111.88 111.88c3.19 3.19 3.19 8.4 0 11.59l-25.09 25.09c-3.19 3.19-8.4 3.19-11.59 0l-168.6-168.61c-3.19-3.19-3.19-8.4 0-11.59l164.47-168.67c3.19-3.19 8.4-3.19 11.59 0l25.61 25.61c3.19 3.19 3.19 8.4 0 11.59l-106.59 110.78 303.62-0.11c4.52 0 8.23 3.71 8.23 8.23v36.04z"
          fill="currentColor"
          transform="translate(483.41 0)"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true">
      <path
        d="M473.532 524.327a8.16 8.16 0 0 1-8.17 8.17h-305.36l111.88 111.88c3.19 3.19 3.19 8.4 0 11.59l-25.09 25.09c-3.19 3.19-8.4 3.19-11.59 0l-168.6-168.61c-3.19-3.19-3.19-8.4 0-11.59l164.47-168.67c3.19-3.19 8.4-3.19 11.59 0l25.61 25.61c3.19 3.19 3.19 8.4 0 11.59l-106.59 110.78 303.62-0.11c4.52 0 8.23 3.71 8.23 8.23v36.04zM550.012 486.537a8.16 8.16 0 0 1 8.17-8.17h305.36l-111.88-111.89c-3.19-3.19-3.19-8.4 0-11.59l25.08-25.08c3.19-3.19 8.4-3.19 11.59 0l168.61 168.6c3.19 3.19 3.19 8.4 0 11.59l-164.47 168.67c-3.19 3.19-8.4 3.19-11.59 0l-25.61-25.61c-3.19-3.19-3.19-8.4 0-11.59l106.58-110.78-303.62 0.11c-4.52 0-8.23-3.71-8.23-8.23v-36.03z"
        fill="currentColor"
      />
    </svg>
  );
}

const CONTEXT_RING_RADIUS = 6;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;

// The arc is visually capped at 100%; the numeric label keeps reporting
// real overflow.
function ContextUsageRing({ pct }: { pct: number }) {
  const capped = Math.min(pct, 100);
  const level = getContextUsageLevel(pct);
  const valueClass =
    level === 'error'
      ? `${styles.contextRingValue} ${styles.contextRingValueError}`
      : level === 'warning'
        ? `${styles.contextRingValue} ${styles.contextRingValueWarning}`
        : styles.contextRingValue;
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r={CONTEXT_RING_RADIUS}
        fill="none"
        strokeWidth="2.5"
        className={styles.contextRingTrack}
      />
      <circle
        cx="8"
        cy="8"
        r={CONTEXT_RING_RADIUS}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
        strokeDashoffset={CONTEXT_RING_CIRCUMFERENCE * (1 - capped / 100)}
        transform="rotate(-90 8 8)"
        className={valueClass}
      />
    </svg>
  );
}

function ModelIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3.5 19.4 7.8v8.4L12 20.5l-7.4-4.3V7.8L12 3.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="m8.2 9.7 3.8 2.2 3.8-2.2M12 11.9v4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface DropdownItem extends ToolbarDropdownItem {
  description?: string;
  icon?: ReactNode;
}

interface QuickActionItem {
  id: string;
  label: string;
  action:
    | {
        type: 'run';
        command: string;
      }
    | {
        type: 'insert';
        text: string;
      }
    | {
        type: 'shell';
      }
    | {
        type: 'key';
        item: QuickKeyItem;
      };
}

function getQuickActionCommandName(action: QuickActionItem): string | null {
  const text =
    action.action.type === 'run'
      ? action.action.command
      : action.action.type === 'insert'
        ? action.action.text
        : '';
  const match = text.trimStart().match(/^\/([^\s]+)/);
  return match?.[1] ?? null;
}

interface QuickKeyItem {
  id: string;
  label: string;
  descriptionKey: string;
  event: KeyboardEventInit & { key: string };
}

const QUICK_KEY_ITEMS: QuickKeyItem[] = [
  {
    id: 'tab',
    label: 'Tab',
    descriptionKey: 'quickKeys.tab',
    event: { key: 'Tab', code: 'Tab' },
  },
  {
    id: 'escape',
    label: 'Esc',
    descriptionKey: 'quickKeys.escape',
    event: { key: 'Escape', code: 'Escape' },
  },
  {
    id: 'arrow-up',
    label: '↑',
    descriptionKey: 'quickKeys.history',
    event: { key: 'ArrowUp', code: 'ArrowUp' },
  },
  {
    id: 'arrow-down',
    label: '↓',
    descriptionKey: 'quickKeys.history',
    event: { key: 'ArrowDown', code: 'ArrowDown' },
  },
  {
    id: 'arrow-left',
    label: '←',
    descriptionKey: 'quickKeys.cursor',
    event: { key: 'ArrowLeft', code: 'ArrowLeft' },
  },
  {
    id: 'arrow-right',
    label: '→',
    descriptionKey: 'quickKeys.cursor',
    event: { key: 'ArrowRight', code: 'ArrowRight' },
  },
];

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="m3 8.3 3.1 3.1L13 4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function getModeLabel(modeId: string, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    plan: t('mode.label.plan'),
    default: t('mode.label.default'),
    'auto-edit': t('mode.label.auto-edit'),
    auto: t('mode.label.auto'),
    yolo: t('mode.label.yolo'),
  };
  return labels[modeId] ?? modeId;
}

function getModeListLabel(modeId: string, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    plan: t('mode.listLabel.plan'),
    default: t('mode.listLabel.default'),
    'auto-edit': t('mode.listLabel.auto-edit'),
    auto: t('mode.listLabel.auto'),
    yolo: t('mode.listLabel.yolo'),
  };
  return labels[modeId] ?? getModeLabel(modeId, t);
}

function ToolbarPopover({
  open,
  items,
  activeId,
  onOpenChange,
  onSelect,
  trigger,
  tooltip,
  showCheck = false,
  searchable = false,
  searchLabel,
  noResultsLabel,
  header,
  submenu,
  compact = false,
}: {
  open: boolean;
  items: DropdownItem[];
  activeId: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  trigger: ReactNode;
  tooltip?: ReactNode;
  showCheck?: boolean;
  searchable?: boolean;
  searchLabel?: string;
  noResultsLabel?: (query: string) => string;
  header?: ReactNode;
  submenu?: {
    triggerLabel: string;
    triggerAriaLabel: string;
    sectionLabel: string;
  };
  compact?: boolean;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [collisionBoundary, setCollisionBoundary] =
    useState<HTMLElement | null>(null);
  const selectionRef = useRef(false);
  const handoffRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuTriggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const returningFromSubmenuRef = useRef(false);
  const hasRichItems = items.some((item) => item.description || item.icon);
  const visibleItems = searchable
    ? filterToolbarDropdownItems(items, searchQuery)
    : items;

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setSubmenuOpen(false);
      returningFromSubmenuRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (open && submenuOpen) {
      searchInputRef.current?.focus();
      return;
    }
    if (open && returningFromSubmenuRef.current) {
      returningFromSubmenuRef.current = false;
      submenuTriggerRef.current?.focus();
    }
  }, [open, submenuOpen]);

  const hasCheckItems = hasRichItems || showCheck;
  const dropdownItems = (
    <div
      className={`${styles.dropdownList} ${
        hasRichItems
          ? styles.dropdownRich
          : showCheck
            ? styles.dropdownCheck
            : ''
      } ${searchable ? styles.dropdownListConstrained : ''}`}
    >
      {visibleItems.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`${styles.dropdownItem} ${
            item.id === activeId ? styles.dropdownItemActive : ''
          }`}
          title={item.label}
          onClick={() => {
            selectionRef.current = true;
            onSelect(item.id);
          }}
        >
          {hasCheckItems ? (
            <>
              {hasRichItems && (
                <span className={styles.dropdownItemIcon}>{item.icon}</span>
              )}
              <span className={styles.dropdownItemContent}>
                <span className={styles.dropdownItemLabel}>{item.label}</span>
                {item.description && (
                  <span className={styles.dropdownItemDesc}>
                    {item.description}
                  </span>
                )}
              </span>
              <span className={styles.dropdownItemCheck}>
                {item.id === activeId ? <CheckIcon /> : null}
              </span>
            </>
          ) : (
            item.label
          )}
        </button>
      ))}
      {visibleItems.length === 0 && noResultsLabel && (
        <div className={styles.dropdownEmpty} role="status">
          {noResultsLabel(searchQuery)}
        </div>
      )}
    </div>
  );
  const searchableItems = (
    <>
      {searchable && (
        <Input
          ref={searchInputRef}
          type="search"
          value={searchQuery}
          aria-label={searchLabel}
          placeholder={searchLabel}
          autoComplete="off"
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (!submenu || event.key !== 'ArrowLeft' || searchQuery) return;
            event.preventDefault();
            returningFromSubmenuRef.current = true;
            setSubmenuOpen(false);
          }}
        />
      )}
      {dropdownItems}
    </>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          selectionRef.current = false;
          handoffRef.current = false;
          setCollisionBoundary(
            triggerRef.current?.closest<HTMLElement>('[data-web-shell-root]') ??
              null,
          );
        }
        onOpenChange(nextOpen);
      }}
    >
      {tooltip ? (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger ref={triggerRef} asChild>
                {trigger}
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{tooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <PopoverTrigger ref={triggerRef} asChild>
          {trigger}
        </PopoverTrigger>
      )}
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={8}
        collisionBoundary={collisionBoundary ?? undefined}
        data-web-shell-toolbar-popover
        data-web-shell-compact-overlay={compact ? '' : undefined}
        data-web-shell-reasoning-popover={submenu ? '' : undefined}
        onClick={(event) => event.stopPropagation()}
        onOpenAutoFocus={(event) => {
          if (!submenu) return;
          event.preventDefault();
          submenuTriggerRef.current?.focus();
        }}
        onPointerDownOutside={(event) => {
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest('[data-web-shell-toolbar-popover-trigger]')
          ) {
            handoffRef.current = true;
          }
        }}
        onCloseAutoFocus={(event) => {
          if (handoffRef.current) {
            event.preventDefault();
            handoffRef.current = false;
            return;
          }
          if (
            document.activeElement instanceof HTMLElement &&
            document.activeElement.closest('[data-web-shell-toolbar-popover]')
          ) {
            event.preventDefault();
            return;
          }
          if (!selectionRef.current) return;
          event.preventDefault();
          selectionRef.current = false;
        }}
      >
        {submenu ? (
          <>
            {header}
            <div className={styles.dropdownSubmenuSection}>
              <div className={styles.reasoningSectionTitle}>
                {submenu.sectionLabel}
              </div>
              <Popover
                open={submenuOpen}
                onOpenChange={(nextOpen) => {
                  setSubmenuOpen(nextOpen);
                  if (!nextOpen) setSearchQuery('');
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    ref={submenuTriggerRef}
                    className={`${styles.dropdownItem} ${styles.dropdownSubmenuTrigger}`}
                    data-web-shell-model-submenu-trigger
                    aria-haspopup="dialog"
                    aria-expanded={submenuOpen}
                    aria-label={submenu.triggerAriaLabel}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowRight') return;
                      event.preventDefault();
                      setSubmenuOpen(true);
                    }}
                  >
                    <span title={submenu.triggerLabel}>
                      {submenu.triggerLabel}
                    </span>
                    <ChevronRightIcon aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="right"
                  align="end"
                  alignOffset={-10}
                  sideOffset={15}
                  collisionPadding={8}
                  collisionBoundary={collisionBoundary ?? undefined}
                  data-web-shell-toolbar-popover
                  data-web-shell-model-submenu
                  onClick={(event) => event.stopPropagation()}
                >
                  {searchableItems}
                </PopoverContent>
              </Popover>
            </div>
          </>
        ) : (
          <>
            {header}
            {searchableItems}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ModelReasoningControls({
  reasoning,
  onSelect,
}: {
  reasoning: DaemonReasoningControls;
  onSelect?: (value: ReasoningSelection) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const hasEffortOptions = reasoning.efforts.length > 0;
  const select = async (value: ReasoningSelection) => {
    if (busy || !onSelect) return;
    setBusy(true);
    try {
      await onSelect(value);
    } catch {
      // The owning surface reports action errors.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.reasoningOptions} data-web-shell-model-reasoning>
      <div className={styles.reasoningSectionTitle}>
        {t('reasoning.options')}
      </div>
      <div className={styles.reasoningThinkingRow}>
        <span>{t('reasoning.thinking')}</span>
        <Switch
          checked={reasoning.enabled}
          disabled={busy || !onSelect || reasoning.canDisable === false}
          aria-label={t('reasoning.thinking')}
          data-web-shell-thinking-toggle
          onCheckedChange={(enabled) =>
            void select(enabled ? 'default' : 'none')
          }
        />
      </div>
      {hasEffortOptions ? (
        <>
          <div className={styles.reasoningDivider} />
          <div className={styles.reasoningSectionTitle}>
            {t('reasoning.effort')}
          </div>
          {reasoning.efforts.map((effort) => (
            <button
              key={effort}
              type="button"
              className={styles.reasoningEffortRow}
              aria-pressed={reasoning.effort === effort}
              data-web-shell-effort={effort}
              disabled={!reasoning.enabled || busy || !onSelect}
              onClick={() => void select(effort)}
            >
              <span>{t(`reasoning.effort.${effort}`)}</span>
              <span className={styles.dropdownItemCheck}>
                {reasoning.effort === effort ? <CheckIcon /> : null}
              </span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}

function SlashCommandPanel({
  menu,
  anchorRef,
  panelRef,
  detailRef,
  compact,
  onClose,
  onSelect,
  onAccept,
}: {
  menu: SlashMenuState;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  detailRef: RefObject<HTMLDivElement | null>;
  compact?: boolean;
  onClose: () => void;
  onSelect: (index: number) => boolean;
  onAccept: (index?: number) => boolean;
}) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hoverAnchorRef = useRef<HTMLButtonElement>(null);
  const [collisionBoundary, setCollisionBoundary] =
    useState<HTMLElement | null>(null);
  const [hoverDetail, setHoverDetail] = useState<{
    label: string;
    detail: string;
    side: 'top' | 'right' | 'bottom' | 'left';
  } | null>(null);

  useEffect(() => {
    itemRefs.current[menu.selectedIndex]?.scrollIntoView({
      block: 'nearest',
    });
  }, [menu.items, menu.selectedIndex]);

  useEffect(() => {
    setHoverDetail(null);
  }, [menu.items]);

  useLayoutEffect(() => {
    setCollisionBoundary(
      anchorRef.current?.closest<HTMLElement>('[data-web-shell-root]') ?? null,
    );
  }, [anchorRef]);

  useEffect(() => {
    const preserveImeEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        (!event.isComposing && event.keyCode !== 229)
      ) {
        return;
      }
      Object.defineProperty(event, 'key', {
        configurable: true,
        value: 'Process',
      });
      window.addEventListener(
        'keydown',
        (currentEvent) => {
          if (currentEvent === event) Reflect.deleteProperty(event, 'key');
        },
        { once: true },
      );
    };
    window.addEventListener('keydown', preserveImeEscape, { capture: true });
    return () => {
      window.removeEventListener('keydown', preserveImeEscape, {
        capture: true,
      });
    };
  }, []);

  const rowPlans = planSlashSectionRows(menu.items, menu.kind);

  return (
    <>
      <Popover
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <PopoverAnchor
          virtualRef={
            anchorRef as RefObject<{ getBoundingClientRect(): DOMRect }>
          }
        />
        <PopoverContent
          ref={panelRef}
          side="top"
          align="start"
          alignOffset={compact ? 0 : 16}
          sideOffset={compact ? 6 : 8}
          avoidCollisions={compact}
          collisionPadding={compact ? 8 : 12}
          collisionBoundary={collisionBoundary ?? undefined}
          className="duration-0 data-open:animate-none data-closed:animate-none"
          role="listbox"
          data-web-shell-slash-menu
          data-web-shell-compact-overlay={compact ? '' : undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            const target = event.target;
            if (
              target instanceof Node &&
              (anchorRef.current?.contains(target) ||
                detailRef.current?.contains(target))
            ) {
              event.preventDefault();
            }
          }}
          onMouseDown={(event) => event.preventDefault()}
          onMouseLeave={(event) => {
            const nextTarget = event.relatedTarget;
            if (
              nextTarget instanceof Node &&
              detailRef.current?.contains(nextTarget)
            ) {
              return;
            }
            setHoverDetail(null);
          }}
        >
          <div className={styles.slashPanel}>
            <div className={styles.slashPanelBody}>
              <div
                className={styles.slashList}
                onScroll={() => setHoverDetail(null)}
              >
                {menu.items.map((item, index) => {
                  const plan = rowPlans[index];
                  return (
                    <div
                      key={`${item.id}:${index}`}
                      className={styles.slashEntry}
                    >
                      {plan.showHeader && (
                        <>
                          {plan.showDivider && (
                            <div className={styles.slashSection} />
                          )}
                          <div className={styles.slashSectionHeader}>
                            <span>{item.section}</span>
                            {plan.count > 0 ? (
                              <span className={styles.slashSectionCount}>
                                {plan.count}
                              </span>
                            ) : null}
                          </div>
                        </>
                      )}
                      <button
                        ref={(node) => {
                          itemRefs.current[index] = node;
                        }}
                        type="button"
                        role="option"
                        aria-selected={index === menu.selectedIndex}
                        data-has-description={item.detail ? '' : undefined}
                        className={`${styles.slashItem} ${
                          index === menu.selectedIndex
                            ? styles.slashItemActive
                            : ''
                        }`}
                        onMouseEnter={(event) => {
                          onSelect(index);
                          if (!item.detail || compact) {
                            setHoverDetail(null);
                            return;
                          }
                          hoverAnchorRef.current = event.currentTarget;
                          const rowRect =
                            event.currentTarget.getBoundingClientRect();
                          const boundaryRect =
                            collisionBoundary?.getBoundingClientRect();
                          const left = boundaryRect?.left ?? 0;
                          const right =
                            boundaryRect?.right ?? window.innerWidth;
                          const top = boundaryRect?.top ?? 0;
                          const bottom =
                            boundaryRect?.bottom ?? window.innerHeight;
                          const detailWidth = Math.min(320, right - left - 24);
                          const side =
                            right - rowRect.right >= detailWidth + 8
                              ? 'right'
                              : rowRect.left - left >= detailWidth + 8
                                ? 'left'
                                : rowRect.top - top >= bottom - rowRect.bottom
                                  ? 'top'
                                  : 'bottom';
                          setHoverDetail({
                            label: item.label,
                            detail: item.detail,
                            side,
                          });
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onAccept(index);
                        }}
                      >
                        <span className={styles.slashCommand}>
                          {item.label}
                          {item.argumentHint && (
                            <span className={styles.slashArgumentHint}>
                              {' '}
                              {item.argumentHint}
                            </span>
                          )}
                        </span>
                        {item.detail && (
                          <span className={styles.slashDescription}>
                            {item.detail}
                          </span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <Popover
        open={!compact && Boolean(hoverDetail)}
        onOpenChange={(open) => {
          if (!open) setHoverDetail(null);
        }}
      >
        <PopoverAnchor
          virtualRef={
            hoverAnchorRef as RefObject<{ getBoundingClientRect(): DOMRect }>
          }
        />
        {hoverDetail && (
          <PopoverContent
            ref={detailRef}
            side={hoverDetail.side}
            align="start"
            sideOffset={8}
            collisionPadding={12}
            collisionBoundary={collisionBoundary ?? undefined}
            className="duration-0 data-open:animate-none data-closed:animate-none"
            data-web-shell-slash-detail
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onMouseLeave={(event) => {
              const nextTarget = event.relatedTarget;
              if (
                nextTarget instanceof Node &&
                panelRef.current?.contains(nextTarget)
              ) {
                return;
              }
              setHoverDetail(null);
            }}
          >
            <div className={styles.slashDetail}>
              <div className={styles.slashDetailCommand}>
                {hoverDetail.label}
              </div>
              <div className={styles.slashDetailText}>{hoverDetail.detail}</div>
            </div>
          </PopoverContent>
        )}
      </Popover>
    </>
  );
}

function QuickActionsPanel({
  actions,
  onRun,
  onPressKey,
  showKeyHints = true,
}: {
  actions: readonly QuickActionItem[];
  onRun: (action: QuickActionItem) => void;
  onPressKey: (item: QuickKeyItem) => void;
  // The keyboard shortcut grid is pointless without a hardware keyboard, so
  // the mobile textarea backend hides it.
  showKeyHints?: boolean;
}) {
  const { t } = useI18n();

  return (
    <div
      className={styles.quickActionsPanel}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className={styles.quickActionsHeader}>{t('quickActions.title')}</div>
      <div className={styles.quickActionsLayout}>
        <div className={styles.quickActionsGrid}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={styles.quickAction}
              onClick={() => onRun(action)}
            >
              <span className={styles.quickActionLabel}>{action.label}</span>
            </button>
          ))}
        </div>
        {showKeyHints && (
          <div className={styles.quickKeysGrid}>
            {QUICK_KEY_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={styles.quickKey}
                title={t(item.descriptionKey)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPressKey(item)}
              >
                <span className={styles.quickKeyLabel}>{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const ChatEditor = memo(
  forwardRef<EditorHandle, ChatEditorProps>(function ChatEditor(props, ref) {
    const {
      onSubmit,
      onInputTextChange,
      onAttachmentsChange,
      onCycleMode,
      cycleModeOnTab = false,
      onToggleShortcuts,
      onCancel,
      isRunning = false,
      isPreparing = false,
      cancelArmed = false,
      disabled = false,
      placeholderText = 'Type a message...',
      commands,
      skills = [],
      slashCommandCategoryOrder,
      autoSubmitSlashCommands = false,
      queuedMessages = [],
      onPopQueuedMessages,
      currentMode = 'default',
      sessionWorkflowEnabled = false,
      currentModel = '',
      gitBranch,
      gitWorktree,
      gitCwd,
      gitModeIntent,
      onGitModeIntentChange,
      gitStatus,
      onOpenGitDiff,
      onOpenCommit,
      workspaceName,
      workspaceTitle,
      workspaceColor,
      chatWidthMode = '1000',
      showChatWidthToggle = true,
      chatWidthToggleMin,
      visibleToolbarActions,
      tokenCount = 0,
      contextWindow = 0,
      contextUsageAlwaysVisible = false,
      onShowContextUsage,
      availableModels = [],
      onSelectMode,
      onSelectModel,
      reasoning,
      onSelectReasoningEffort,
      workspaces,
      selectedWorkspaceCwd,
      noWorkspaceSupported = false,
      noWorkspaceSelected = false,
      workspaceSelectionDisabled = false,
      onSelectWorkspace,
      onSelectNoWorkspace,
      scratchWorkspaceSupported = false,
      existingFolderWorkspaceSupported = false,
      workspaceMutationBusy = false,
      onCreateScratchWorkspace,
      onOpenExistingWorkspace,
      atWorkspaceCwd,
      composerScopeKey,
      workspaceFeaturesEnabled = true,
      onChatWidthModeChange,
      onFocusFooter,
      dialogOpen = false,
      followupState,
      onAcceptFollowup,
      onDismissFollowup,
      sessionId,
      sessionName,
      composerInput,
      composerInputVersion,
      builtinAtProviders,
      atProviders,
      composerTagIcons,
      voiceTarget,
      voiceStatusRevision,
      onImageIngestionNotice,
      onImagePreview,
      onAttachmentPreview,
      compactOverlays = false,
    } = props;

    const {
      renderComposerToolbarStart: ToolbarStart,
      renderComposerToolbarEnd: ToolbarEnd,
      renderComposerToolbarRight: ToolbarRight,
      renderComposerTag,
      renderComposerTagTooltip,
      onComposerTagClick,
      parseUserMessageContent,
      builtinAtProviders: contextBuiltinAtProviders,
      atProviders: contextAtProviders,
      fileUploadEnabled,
      fileUploadDirectory,
    } = useWebShellCustomization();
    // At-mention provider props win when set (main composer). Split-view
    // ChatPane omits them and falls back to the App-level customization
    // context. (Unlike the providers, file upload control comes ONLY from
    // the customization context — no prop override exists.)
    const resolvedBuiltinAtProviders =
      builtinAtProviders ?? contextBuiltinAtProviders;
    const resolvedAtProviders = atProviders ?? contextAtProviders;

    // File-upload picker. The @ panel's "Upload file" item reports the browsed
    // directory; we click a hidden <input type="file"> so the browser treats it
    // as part of the user gesture, then upload into that directory.
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const uploadPickerTargetRef = useRef('.');
    const uploadPickerTargetKeyRef = useRef('');
    const uploadPickerRestoreRef = useRef<(() => void) | undefined>(undefined);

    // Resolve the upload target BEFORE useComposerCore so the @ panel's upload
    // item can be capability-gated (hidden on daemons without the feature).
    const uploadWorkspace = useOptionalWorkspace();
    const uploadTarget = useMemo(() => {
      if (!uploadWorkspace || !workspaceFeaturesEnabled) return undefined;
      // The host prop can force-disable upload even when the daemon advertises
      // the capability; it does NOT bypass the capability check. Both must
      // allow: `fileUploadEnabled === false` short-circuits, otherwise the
      // `workspace_file_upload` capability is still required.
      if (fileUploadEnabled === false) return undefined;
      const features = uploadWorkspace.capabilities?.features ?? [];
      if (!features.includes('workspace_file_upload')) return undefined;
      if (atWorkspaceCwd) {
        if (!features.includes('workspace_qualified_rest_core'))
          return undefined;
        // The selected workspace must be present exactly once and trusted.
        const matches = (uploadWorkspace.capabilities?.workspaces ?? []).filter(
          (w) => w.cwd === atWorkspaceCwd,
        );
        if (matches.length !== 1 || matches[0].trusted === false)
          return undefined;
        return {
          client: uploadWorkspace.client.workspaceByCwd(atWorkspaceCwd),
          targetKey: atWorkspaceCwd,
        };
      }
      const primaryMatches = (
        uploadWorkspace.capabilities?.workspaces ?? []
      ).filter((workspace) => workspace.primary);
      if (primaryMatches.length !== 1 || primaryMatches[0].trusted !== true)
        return undefined;
      return { client: uploadWorkspace.client, targetKey: '<primary>' };
    }, [
      uploadWorkspace,
      atWorkspaceCwd,
      fileUploadEnabled,
      workspaceFeaturesEnabled,
    ]);
    const uploadEnabled = uploadTarget !== undefined;
    const maxUploadBytes =
      uploadWorkspace?.capabilities?.limits?.maxWorkspaceFileUploadBytes ??
      50 * 1024 * 1024;
    const uploadTargetKey = `${sessionId ?? '<no-session>'}:${
      uploadTarget?.targetKey ?? '<none>'
    }`;
    const [pendingDropFiles, setPendingDropFiles] = useState<File[] | null>(
      null,
    );
    useLayoutEffect(() => {
      setPendingDropFiles(null);
    }, [disabled, uploadTargetKey]);

    // -- File upload ----------------------------------------------------------
    // The hook's cancel/reset granularity includes the session: ChatEditor is
    // shared across sessions (a switch swaps the doc in the same EditorView),
    // so an upload that survives a same-workspace session switch would append
    // its @file reference to the other session's draft.
    const fileUpload = useFileUpload({
      client: uploadTarget?.client,
      maxBytes: maxUploadBytes,
      targetKey: uploadTargetKey,
    });

    const triggerFilePicker = useCallback(
      (targetDir: string, restoreQuery?: () => void) => {
        uploadPickerTargetRef.current = targetDir;
        uploadPickerTargetKeyRef.current = uploadTargetKey;
        uploadPickerRestoreRef.current = restoreQuery;
        fileInputRef.current?.click();
      },
      [uploadTargetKey],
    );

    // A pending picker restore belongs to the CURRENT target's draft. Flush
    // it before a target change (session switch, capability flip) persists or
    // replaces the doc: afterwards the editor holds another draft, and the
    // layout effect runs before the composer's passive session-swap effect
    // saves the outgoing draft. Also covers the picker being torn down while
    // the OS dialog is open — no cancel/change event will ever arrive.
    useLayoutEffect(() => {
      const restore = uploadPickerRestoreRef.current;
      uploadPickerRestoreRef.current = undefined;
      restore?.();
    }, [uploadTargetKey]);

    const handleComposerTagClick = useCallback(
      (info: Parameters<NonNullable<typeof onComposerTagClick>>[0]) => {
        if (isPreviewableFileComposerTag(info.tag)) {
          onAttachmentPreview?.({
            name: info.tag.value.split(/[\\/]/).pop() ?? info.tag.value,
            workspacePath: info.tag.value,
          });
        }
        onComposerTagClick?.(info);
      },
      [onAttachmentPreview, onComposerTagClick],
    );

    const core = useComposerCore({
      onSubmit,
      onInputTextChange,
      onCycleMode,
      cycleModeOnTab,
      onToggleShortcuts,
      disabled,
      fileDragEnabled: workspaceFeaturesEnabled && fileUploadEnabled !== false,
      placeholderText,
      commands,
      skills,
      slashCommandCategoryOrder,
      autoSubmitSlashCommands,
      queuedMessages,
      onPopQueuedMessages,
      currentMode,
      onFocusFooter,
      dialogOpen: dialogOpen || pendingDropFiles !== null,
      followupState,
      onAcceptFollowup,
      onDismissFollowup,
      sessionId,
      sessionName,
      composerInput,
      composerInputVersion,
      builtinAtProviders: resolvedBuiltinAtProviders,
      atProviders: resolvedAtProviders,
      atWorkspaceCwd,
      composerScopeKey,
      disableLegacyHistoryFallback: composerScopeKey === 'standalone',
      attachmentsEnabled: workspaceFeaturesEnabled,
      workspaceFeaturesEnabled,
      composerTagIcons,
      parseUserMessageContent,
      renderComposerTag,
      renderComposerTagTooltip,
      onComposerTagClick,
      onFileTagClick: handleComposerTagClick,
      onImageIngestionNotice,
      onFileUploadRequest: uploadEnabled ? triggerFilePicker : undefined,
      workspaceUploadBusy: fileUpload.isBusy,
      editorTheme: CHAT_EDITOR_THEME,
    });

    const { t } = useI18n();

    useImperativeHandle(ref, () => core.handle, [core.handle]);

    const addComposerTags = core.addTags;
    const clearImageDragState = core.clearImageDragState;
    const focusComposer = core.focus;
    const ingestFiles = core.ingestFiles;
    const insertUploadReference = useCallback(
      (path: string) => {
        const serialized = fileReferenceInsertText(path).trim();
        addComposerTags(
          [
            {
              id: `file:${serialized}`,
              kind: 'file',
              value: path,
              serialized,
            },
          ],
          { placement: 'inline', position: 'end' },
        );
      },
      [addComposerTags],
    );
    const uploadStatusText = (upload: FileUploadItem): string => {
      switch (upload.status) {
        case 'pending':
          return t('composer.upload.pending');
        case 'uploading':
          return `${t('composer.upload.uploading')} ${Math.round(
            upload.progress * 100,
          )}%`;
        case 'done':
          return upload.resultPath !== undefined &&
            upload.resultPath !== upload.targetPath
            ? `${t('composer.upload.renamed')} ${upload.resultPath}`
            : t('composer.upload.done');
        case 'error':
          return (
            upload.error ??
            (upload.errorCode === 'tooLarge'
              ? t('composer.upload.error.tooLarge', {
                  limit: `${Math.round(maxUploadBytes / (1024 * 1024))} MiB`,
                })
              : upload.errorCode === 'noDaemon'
                ? t('composer.upload.error.noDaemon')
                : upload.errorCode === 'tooManyFiles'
                  ? t('composer.upload.error.tooManyFiles', {
                      count: upload.skippedCount ?? 0,
                    })
                  : t('composer.upload.error'))
          );
      }
    };
    const [uploadDragActive, setUploadDragActive] = useState(false);
    const uploadDragDepthRef = useRef(0);
    const handleUploadDragEnter = useCallback(
      (event: ReactDragEvent<HTMLDivElement>) => {
        if (
          !uploadEnabled ||
          disabled ||
          !event.dataTransfer.types.includes('Files')
        )
          return;
        event.preventDefault();
        uploadDragDepthRef.current += 1;
        setUploadDragActive(true);
      },
      [uploadEnabled, disabled],
    );
    const handleUploadDragOver = useCallback(
      (event: ReactDragEvent<HTMLDivElement>) => {
        if (
          !uploadEnabled ||
          disabled ||
          !event.dataTransfer.types.includes('Files')
        )
          return;
        event.preventDefault();
      },
      [uploadEnabled, disabled],
    );
    const handleUploadDragLeave = useCallback(() => {
      if (uploadDragDepthRef.current === 0) return;
      uploadDragDepthRef.current = Math.max(0, uploadDragDepthRef.current - 1);
      if (uploadDragDepthRef.current === 0) setUploadDragActive(false);
    }, []);
    const clearUploadDragState = useCallback(() => {
      uploadDragDepthRef.current = 0;
      setUploadDragActive(false);
    }, []);
    // Shell regions outside the drop-handling surface (e.g. the upload
    // strip) must still cancel file drags; an uncancelled drop navigates
    // the tab to the file, tearing down the SPA mid-turn.
    const cancelShellFileDrag = useCallback(
      (event: ReactDragEvent<HTMLDivElement>) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      },
      [],
    );
    // `uploadFiles` is a stable callback from the hook; depend on it (not the
    // freshly-created `fileUpload` object) so these handlers are not rebuilt
    // on every render.
    const uploadFiles = fileUpload.uploadFiles;
    const handleUploadDrop = useCallback(
      (event: ReactDragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes('Files')) {
          core.imageTransferHandlers.onDropCapture(event);
          return;
        }
        const files = collectDroppedFiles(event.dataTransfer);
        uploadDragDepthRef.current = 0;
        setUploadDragActive(false);
        if (pendingDropFiles !== null) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (disabled) {
          // Cancel the drop itself; otherwise the browser navigates the tab
          // to the dropped file, tearing down the Web Shell SPA mid-turn.
          event.preventDefault();
          return;
        }
        if (fileUploadEnabled === false) {
          // Host force-disables file drag-in entirely: cancel the drop so
          // the browser cannot navigate to the file, but ingest nothing on
          // any lane (the image lane is gated off too).
          event.preventDefault();
          return;
        }
        if (!uploadEnabled || files.length === 0) {
          core.imageTransferHandlers.onDropCapture(event);
          return;
        }
        clearImageDragState();
        event.preventDefault();
        event.stopPropagation();
        setPendingDropFiles(files);
      },
      [
        core.imageTransferHandlers,
        clearImageDragState,
        disabled,
        fileUploadEnabled,
        pendingDropFiles,
        uploadEnabled,
      ],
    );
    const referenceDroppedFiles = useCallback(() => {
      if (!pendingDropFiles) return;
      ingestFiles(pendingDropFiles);
      setPendingDropFiles(null);
    }, [ingestFiles, pendingDropFiles]);
    const uploadDroppedFiles = useCallback(() => {
      if (!pendingDropFiles) return;
      uploadFiles(
        pendingDropFiles,
        fileUploadDirectory ?? '.',
        insertUploadReference,
      );
      setPendingDropFiles(null);
    }, [
      fileUploadDirectory,
      insertUploadReference,
      pendingDropFiles,
      uploadFiles,
    ]);
    // -- Composer add menu (`+`) ---------------------------------------------
    const showAddMenuAction = visibleToolbarActions?.includes('addMenu');
    const getAddMenuWorkspaceActions = useCallback(
      () => core.workspaceActionsRef.current,
      [core.workspaceActionsRef],
    );
    const handleAddMenuFiles = useCallback(
      (files: File[], destination: 'attach' | 'upload') => {
        if (destination === 'upload') {
          if (!uploadEnabled) return;
          uploadFiles(files, fileUploadDirectory ?? '.', insertUploadReference);
        } else {
          ingestFiles(files);
        }
        focusComposer();
      },
      [
        fileUploadDirectory,
        focusComposer,
        ingestFiles,
        insertUploadReference,
        uploadEnabled,
        uploadFiles,
      ],
    );
    const handleAddMenuInsertReference = useCallback(
      (tag: WebShellComposerTag) => {
        addComposerTags([tag], { placement: 'inline', position: 'end' });
        const view = core.viewRef.current;
        if (view) {
          view.dispatch({
            selection: { anchor: view.state.doc.length },
            scrollIntoView: true,
          });
        }
        focusComposer();
      },
      [addComposerTags, core.viewRef, focusComposer],
    );
    const handleAddMenuPrependSkill = useCallback(
      (invocation: string) => {
        const view = core.viewRef.current;
        const spec = computePrependSkillTransaction(
          view ? view.state.doc.toString() : core.getText(),
          invocation,
        );
        if (!spec) return focusComposer();
        if (view) {
          view.dispatch(spec);
          view.focus();
        } else {
          core.mobileComposer?.textareaRef.current?.setSelectionRange(0, 0);
          core.insertText(spec.changes.insert);
        }
      },
      [core, focusComposer],
    );
    const handleUploadPickerChange = useCallback(
      (event: ReactChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        const targetDir = uploadPickerTargetRef.current;
        const capturedKey = uploadPickerTargetKeyRef.current;
        const restore = uploadPickerRestoreRef.current;
        uploadPickerRestoreRef.current = undefined;
        event.target.value = '';
        // Only upload if the target workspace is unchanged since the picker
        // opened; otherwise a stale directory path would land in the newly
        // selected workspace (the hook's generation cancel only clears items
        // already queued, not this fresh call).
        if (
          files.length > 0 &&
          capturedKey !== '' &&
          capturedKey === uploadTargetKey
        ) {
          const queued = uploadFiles(files, targetDir, insertUploadReference);
          if (queued === 0) {
            // Every chosen file was rejected locally (e.g. all oversized):
            // the picker closed without any upload, so give the query back.
            restore?.();
          }
        } else {
          // The @ panel deleted the mention query before opening the picker.
          // A blocked or empty selection must give it back, like the native
          // cancel path does, instead of silently eating the typed text.
          restore?.();
        }
      },
      [uploadFiles, insertUploadReference, uploadTargetKey],
    );
    useEffect(() => {
      // React only wires `cancel` on <dialog>; the file input needs a native
      // listener. `cancel` does not bubble, so delegation cannot see it.
      const input = fileInputRef.current;
      if (!uploadEnabled || !input) return;
      const onCancel = () => {
        const restore = uploadPickerRestoreRef.current;
        uploadPickerRestoreRef.current = undefined;
        restore?.();
      };
      input.addEventListener('cancel', onCancel);
      return () => input.removeEventListener('cancel', onCancel);
    }, [uploadEnabled]);

    useEffect(() => {
      if (!uploadDragActive) return;
      window.addEventListener('dragend', clearUploadDragState);
      window.addEventListener('blur', clearUploadDragState);
      return () => {
        window.removeEventListener('dragend', clearUploadDragState);
        window.removeEventListener('blur', clearUploadDragState);
      };
    }, [clearUploadDragState, uploadDragActive]);
    useEffect(() => {
      if (disabled) clearUploadDragState();
    }, [clearUploadDragState, disabled]);

    useEffect(() => {
      onAttachmentsChange?.(core.hasAttachments);
    }, [core.hasAttachments, onAttachmentsChange]);

    const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
    const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
    const [quickActionsOpen, setQuickActionsOpen] = useState(false);
    const [branchPickerOpen, setBranchPickerOpen] = useState(false);
    const [showQuickActions, setShowQuickActions] = useState(isTouchLikeDevice);
    const containerRef = useRef<HTMLDivElement>(null);
    const slashPanelRef = useRef<HTMLDivElement>(null);
    const slashDetailRef = useRef<HTMLDivElement>(null);
    const atPanelRef = useRef<HTMLDivElement>(null);
    const toolbarRef = useRef<HTMLDivElement>(null);
    const toolbarLeadingRef = useRef<HTMLDivElement>(null);
    const toolbarRightRef = useRef<HTMLDivElement>(null);
    const toolbarStartRef = useRef<HTMLDivElement>(null);
    const toolbarEndRef = useRef<HTMLDivElement>(null);
    const toolbarRightCustomRef = useRef<HTMLDivElement>(null);
    const toolbarMeasurementsRef = useRef<HTMLDivElement>(null);
    const [widthToggleFits, setWidthToggleFits] = useState(false);
    const [voiceActive, setVoiceActive] = useState(false);
    const [toolbarLabelVisibility, setToolbarLabelVisibility] = useState({
      workspaceSelect: false,
      workspace: false,
      gitBranch: false,
      mode: false,
      model: false,
    });
    const toolbarLabelVisibilityRef = useRef(toolbarLabelVisibility);
    toolbarLabelVisibilityRef.current = toolbarLabelVisibility;
    const [lastConfirmedModelLabel, setLastConfirmedModelLabel] = useState('');
    const slashMenu = core.slashMenu;
    const closeSlashMenu = core.closeSlashMenu;
    const atMenu = core.atMenu;
    const closeAtMenu = core.closeAtMenu;
    const hasSlashMenu = Boolean(slashMenu);
    const hasAtMenu = Boolean(atMenu);
    const editorViewRef = core.viewRef;

    useEffect(() => {
      if (typeof window === 'undefined' || !window.matchMedia) return;
      const media = window.matchMedia('(hover: none), (pointer: coarse)');
      const update = () => setShowQuickActions(isTouchLikeDevice());
      update();
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }, []);

    useEffect(() => {
      if (!showQuickActions) setQuickActionsOpen(false);
    }, [showQuickActions]);

    useEffect(() => {
      if (!hasSlashMenu && !hasAtMenu) return;
      const onPointerOutside = (event: Event) => {
        const target = event.target;
        const container = containerRef.current;
        if (
          target instanceof Node &&
          container &&
          !container.contains(target) &&
          !slashPanelRef.current?.contains(target) &&
          !slashDetailRef.current?.contains(target) &&
          !atPanelRef.current?.contains(target)
        ) {
          closeSlashMenu();
          closeAtMenu();
        }
      };
      window.addEventListener('mousedown', onPointerOutside);
      window.addEventListener('touchstart', onPointerOutside);
      return () => {
        window.removeEventListener('mousedown', onPointerOutside);
        window.removeEventListener('touchstart', onPointerOutside);
      };
    }, [hasAtMenu, hasSlashMenu, closeAtMenu, closeSlashMenu]);

    // editorViewRef is stable for the component's lifetime, so this effect
    // runs once and the glow stays attached to the initial contentDOM; it
    // re-attaches only if the view ref itself is replaced (CodeMirror
    // recreates contentDOM on view swap, which is uncommon).
    useEffect(() => {
      const glowRoot = containerRef.current;
      const inputEl = editorViewRef.current?.contentDOM;
      if (!glowRoot || !inputEl) return undefined;
      return attachComposerGlow(glowRoot, inputEl);
    }, [editorViewRef]);

    useEffect(() => {
      const container = containerRef.current;
      const minWidth = chatWidthToggleMin;
      if (!container || minWidth === undefined) {
        setWidthToggleFits(false);
        return;
      }

      const update = () => {
        setWidthToggleFits(
          container.getBoundingClientRect().width >= minWidth - 50,
        );
      };
      update();

      const resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(container);
      return () => resizeObserver.disconnect();
    }, [chatWidthToggleMin]);

    const modeItems = useMemo<DropdownItem[]>(
      () =>
        DAEMON_APPROVAL_MODES.map((id) => ({
          id,
          label:
            id === 'plan' && sessionWorkflowEnabled
              ? t('mode.listLabel.planReview')
              : getModeListLabel(id, t),
          description: t(
            id === 'plan' && sessionWorkflowEnabled
              ? 'mode.desc.planReview'
              : `mode.desc.${id}`,
          ),
          icon: <ModeIcon mode={id} />,
        })),
      [sessionWorkflowEnabled, t],
    );
    const visibleActionSet = useMemo(() => {
      if (!visibleToolbarActions) return null;
      const activeActions = visibleToolbarActions.filter((action) =>
        ACTIVE_TOOLBAR_ACTION_SET.has(action),
      );
      return new Set(activeActions);
    }, [visibleToolbarActions]);
    const showToolbarAction = (action: ComposerToolbarAction) => {
      if (!visibleActionSet) return true;
      return visibleActionSet.has(action);
    };
    const showModeAction = showToolbarAction('approvalMode');
    const showModelAction = showToolbarAction('model');
    const showCommandAction = showToolbarAction('commands');
    const commandNames = useMemo(
      () =>
        new Set(commands.map((command) => command.name.replace(/^\/+/, ''))),
      [commands],
    );
    const hasCommand = useCallback(
      (name: string) => commandNames.has(name),
      [commandNames],
    );
    const quickActions = useMemo(
      () =>
        (
          [
            {
              id: 'new',
              label: t('quickActions.new'),
              action: { type: 'run', command: '/new' },
            },
            {
              id: 'resume',
              label: t('quickActions.resume'),
              action: { type: 'run', command: '/resume' },
            },
            {
              id: 'delete',
              label: t('quickActions.delete'),
              action: { type: 'run', command: '/delete' },
            },
            {
              id: 'branch',
              label: t('quickActions.branch'),
              action: { type: 'run', command: '/branch' },
            },
            {
              id: 'rewind',
              label: t('quickActions.rewind'),
              action: { type: 'run', command: '/rewind' },
            },
            {
              id: 'history-search',
              label: t('quickActions.historyQuestion'),
              action: {
                type: 'key',
                item: {
                  id: 'ctrl-r',
                  label: 'Ctrl+R',
                  descriptionKey: 'quickKeys.searchHistory',
                  event: { key: 'r', code: 'KeyR', ctrlKey: true },
                },
              },
            },
            {
              id: 'recap',
              label: t('quickActions.recap'),
              action: { type: 'run', command: '/recap' },
            },
            {
              id: 'stats',
              label: t('quickActions.stats'),
              action: { type: 'run', command: '/stats' },
            },
            {
              id: 'context',
              label: t('quickActions.context'),
              action: { type: 'run', command: '/context' },
            },
            {
              id: 'status',
              label: t('quickActions.status'),
              action: { type: 'run', command: '/status' },
            },
            {
              id: 'skills',
              label: t('quickActions.skills'),
              action: { type: 'run', command: '/skills detail' },
            },
            {
              id: 'tools',
              label: t('quickActions.tools'),
              action: { type: 'run', command: '/tools desc' },
            },
            {
              id: 'agents',
              label: t('quickActions.agents'),
              action: { type: 'run', command: '/agents' },
            },
            {
              id: 'mcp',
              label: t('quickActions.mcp'),
              action: { type: 'run', command: '/mcp' },
            },
            {
              id: 'memory',
              label: t('quickActions.memory'),
              action: { type: 'run', command: '/memory' },
            },
            {
              id: 'theme',
              label: t('quickActions.theme'),
              action: { type: 'run', command: '/theme' },
            },
            {
              id: 'shell',
              label: core.shellMode
                ? t('quickActions.exitShellMode')
                : t('quickActions.shellMode'),
              action: { type: 'shell' },
            },
            {
              id: 'goal',
              label: t('quickActions.setGoal'),
              action: { type: 'insert', text: '/goal ' },
            },
          ] satisfies QuickActionItem[]
        ).filter((action) => {
          const commandName = getQuickActionCommandName(action);
          return !commandName || hasCommand(commandName);
        }),
      [core.shellMode, hasCommand, t],
    );

    const modelItems = useMemo<DropdownItem[]>(
      () =>
        availableModels.map((m) => ({
          id: m.id,
          label: getModelDisplayName(m.label || m.id),
          searchText: `${m.label ?? ''}\n${m.id}`,
        })),
      [availableModels],
    );

    const handleModeSelect = useCallback(
      (modeId: string) => {
        onSelectMode?.(modeId);
        setModeDropdownOpen(false);
        core.focus();
      },
      [onSelectMode, core],
    );

    const handleModelSelect = useCallback(
      (modelId: string) => {
        onSelectModel?.(modelId);
        setModelDropdownOpen(false);
        core.focus();
      },
      [onSelectModel, core],
    );
    const dispatchComposerKey = useCallback(
      (event: QuickKeyItem['event']) => {
        if (core.mobileComposer) {
          // No CodeMirror to dispatch into. History search is the one key
          // action with a non-keyboard equivalent; the rest are hidden on
          // the textarea backend.
          if (event.ctrlKey && event.key === 'r') {
            core.searchState.openHistorySearch();
          }
          return;
        }
        const view = core.viewRef.current;
        if (!view) return;
        view.focus();
        view.contentDOM.dispatchEvent(
          new KeyboardEvent('keydown', {
            ...event,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      [core],
    );
    const runQuickAction = useCallback(
      (action: QuickActionItem) => {
        setQuickActionsOpen(false);
        setModeDropdownOpen(false);
        setModelDropdownOpen(false);
        core.closeSlashMenu();
        core.closeAtMenu();
        if (action.action.type === 'insert') {
          core.insertText(action.action.text, { mode: 'replace' });
          return;
        }
        if (action.action.type === 'shell') {
          core.toggleShellMode();
          return;
        }
        if (action.action.type === 'key') {
          dispatchComposerKey(action.action.item.event);
          return;
        }
        onSubmit(action.action.command);
      },
      [core, dispatchComposerKey, onSubmit],
    );
    const pressQuickKey = useCallback(
      (item: QuickKeyItem) => {
        dispatchComposerKey(item.event);
        if (item.id === 'ctrl-r') {
          setQuickActionsOpen(false);
        }
      },
      [dispatchComposerKey],
    );

    const {
      searchMode,
      searchQuery,
      searchMatches,
      searchActiveIndex,
      searchInputRef,
      searchUiRef,
      closeSearch,
      restoreSearchMatch,
      handleSearchKeyDown,
      handleSearchInput,
      handleSearchCompositionEnd,
    } = core.searchState;

    const renderComposerTagContent = (tag: WebShellComposerTag) => {
      const custom = renderComposerTag?.({
        tag,
        placement: 'composer',
        readonly: false,
      });
      if (custom !== undefined && custom !== null) {
        return custom;
      }
      const rawTagLabel = getComposerTagLabel(tag);
      const tagValue = getComposerTagValue(tag);
      const tagLabel = tag.kind ? '' : rawTagLabel;
      const iconUrl =
        tag.icon ?? getComposerTagIconUrl(tag.kind, composerTagIcons);
      const safeIconUrl =
        iconUrl &&
        (isBuiltinComposerTagIconUrl(iconUrl) || isSafeImageSrc(iconUrl))
          ? iconUrl
          : undefined;
      if (!tagLabel && !tagValue) {
        return <span className={styles.tagLabel}>{tag.id}</span>;
      }
      return (
        <>
          {safeIconUrl && (
            <span
              className={styles.tagIcon}
              style={cssUrlVar('--composer-tag-icon-url', safeIconUrl)}
              aria-hidden="true"
            />
          )}
          {tagLabel && <span className={styles.tagLabel}>{tagLabel}</span>}
          {tagValue && <span className={styles.tagValue}>{tagValue}</span>}
        </>
      );
    };

    // Mode display label
    const modeLabel =
      currentMode === 'plan' && sessionWorkflowEnabled
        ? t('mode.label.planReview')
        : getModeLabel(currentMode, t);

    const currentModelLabel = currentModel
      ? (availableModels.find((model) => model.id === currentModel)?.label ??
        (currentModel.startsWith('qwen-route:')
          ? ''
          : getModelDisplayName(currentModel)))
      : '';
    const { modelLabel, modelLabelReady } = resolveToolbarModelLabel({
      currentModelLabel,
      lastConfirmedModelLabel,
    });
    const showReasoningOptions = Boolean(reasoning);
    const reasoningEffortLabel = reasoning
      ? reasoning.efforts.length > 0
        ? reasoning.effort !== 'none' && reasoning.effort !== 'default'
          ? t(`reasoning.effort.${reasoning.effort}`)
          : t('reasoning.thinking')
        : t('reasoning.thinking')
      : '';
    const modelChipLabel = showReasoningOptions
      ? `${modelLabel} · ${
          reasoning?.enabled ? reasoningEffortLabel : t('reasoning.thinkingOff')
        }`
      : modelLabel;
    const normalizedModelChipLabel = modelChipLabel.endsWith(' · ')
      ? modelLabel
      : modelChipLabel;
    const selectedWorkspace = noWorkspaceSelected
      ? undefined
      : workspaces?.find((entry) =>
          selectedWorkspaceCwd
            ? entry.cwd === selectedWorkspaceCwd
            : entry.primary,
        );
    const selectedWorkspaceLabel = selectedWorkspace?.label ?? '';
    const workspaceSelectVisible = Boolean(
      workspaces &&
        onSelectWorkspace &&
        (workspaces.length > 1 ||
          noWorkspaceSupported ||
          scratchWorkspaceSupported ||
          existingFolderWorkspaceSupported),
    );
    const workspaceIndicatorVisible = Boolean(
      workspaceName && showToolbarAction('workspace'),
    );
    const gitBranchVisible = Boolean(
      gitBranch && showToolbarAction('gitBranch'),
    );

    useLayoutEffect(() => {
      if (currentModelLabel && currentModelLabel !== lastConfirmedModelLabel) {
        setLastConfirmedModelLabel(currentModelLabel);
      }
    }, [currentModelLabel, lastConfirmedModelLabel]);

    const showWorkspaceSelectLabel = toolbarLabelVisibility.workspaceSelect;
    const showWorkspaceLabel = toolbarLabelVisibility.workspace;
    const showGitBranchLabel = toolbarLabelVisibility.gitBranch;
    const showModeLabel = toolbarLabelVisibility.mode;
    const showModelLabel = toolbarLabelVisibility.model;
    const showCancelButton = isRunning && !core.hasContent;
    const composerPreparing = isPreparing || core.pendingImageBatchCount > 0;
    const mobileVoiceActive = showQuickActions && voiceActive;

    useEffect(() => {
      if (mobileVoiceActive) setQuickActionsOpen(false);
    }, [mobileVoiceActive]);

    useLayoutEffect(() => {
      const toolbar = toolbarRef.current;
      const toolbarLeading = toolbarLeadingRef.current;
      const toolbarRight = toolbarRightRef.current;
      const measurements = toolbarMeasurementsRef.current;
      if (!toolbar || !toolbarLeading || !toolbarRight || !measurements) {
        return undefined;
      }

      const update = () => {
        const currentVisibility = toolbarLabelVisibilityRef.current;
        const expansionWidth = (id: string) => {
          const collapsed = measurements.querySelector<HTMLElement>(
            `[data-toolbar-measure="${id}:collapsed"]`,
          );
          const expanded = measurements.querySelector<HTMLElement>(
            `[data-toolbar-measure="${id}:expanded"]`,
          );
          return Math.max(
            0,
            Math.ceil(expanded?.getBoundingClientRect().width ?? 0) -
              Math.ceil(collapsed?.getBoundingClientRect().width ?? 0),
          );
        };
        const items = [
          ...(workspaceSelectVisible
            ? [
                {
                  id: 'workspaceSelect',
                  expansionWidth: expansionWidth('workspaceSelect'),
                },
              ]
            : []),
          ...(workspaceIndicatorVisible
            ? [
                {
                  id: 'workspace',
                  expansionWidth: expansionWidth('workspace'),
                },
              ]
            : []),
          ...(gitBranchVisible
            ? [
                {
                  id: 'gitBranch',
                  expansionWidth: expansionWidth('gitBranch'),
                },
              ]
            : []),
          ...(showModeAction
            ? [
                {
                  id: 'mode',
                  expansionWidth: expansionWidth('mode'),
                },
              ]
            : []),
          ...(showModelAction
            ? [
                {
                  id: 'model',
                  expansionWidth: expansionWidth('model'),
                  ready: modelLabelReady,
                },
              ]
            : []),
        ];
        const currentExpansionWidth = items.reduce(
          (total, item) =>
            total +
            (currentVisibility[item.id as keyof typeof currentVisibility]
              ? item.expansionWidth
              : 0),
          0,
        );
        const currentLeadingWidth = toolbarLeading.scrollWidth;
        const gap = Math.ceil(
          Number.parseFloat(getComputedStyle(toolbar).columnGap) || 0,
        );
        const availableWidth = getToolbarExpansionBudget({
          toolbarWidth: Math.floor(toolbar.getBoundingClientRect().width),
          leadingWidth: currentLeadingWidth,
          rightWidth: Math.ceil(toolbarRight.getBoundingClientRect().width),
          currentExpansionWidth,
          gap,
        });
        const itemVisibility = getToolbarItemVisibilityWithHysteresis({
          availableWidth,
          items,
          currentVisibility,
          // Aggregate scrollWidth can differ from the sum of individually
          // rounded replicas by one pixel per item. Apply that slack only when
          // expanding so a collapsed/expanded pair cannot form a two-cycle.
          expansionMargin: items.length,
        });
        const next = {
          workspaceSelect: itemVisibility.workspaceSelect ?? false,
          workspace: itemVisibility.workspace ?? false,
          gitBranch: itemVisibility.gitBranch ?? false,
          mode: itemVisibility.mode ?? false,
          model: itemVisibility.model ?? false,
        };
        const unchanged = Object.keys(next).every(
          (key) =>
            currentVisibility[key as keyof typeof currentVisibility] ===
            next[key as keyof typeof next],
        );
        if (unchanged) return;
        toolbarLabelVisibilityRef.current = next;
        setToolbarLabelVisibility(next);
      };

      update();
      const resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(toolbar);
      resizeObserver.observe(toolbarRight);
      for (const child of measurements.children) {
        resizeObserver.observe(child);
      }
      const customToolbarRoots = [
        toolbarStartRef.current,
        toolbarEndRef.current,
        toolbarRightCustomRef.current,
      ].filter((element): element is HTMLDivElement => element !== null);
      const observeCustomToolbarContent = () => {
        for (const root of customToolbarRoots) {
          resizeObserver.observe(root);
          for (const child of root.children) {
            resizeObserver.observe(child);
          }
        }
      };
      observeCustomToolbarContent();
      const mutationObserver = new MutationObserver(() => {
        observeCustomToolbarContent();
        update();
      });
      for (const root of customToolbarRoots) {
        mutationObserver.observe(root, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
      }
      return () => {
        mutationObserver.disconnect();
        resizeObserver.disconnect();
      };
    }, [
      ToolbarEnd,
      ToolbarRight,
      ToolbarStart,
      disabled,
      gitBranch,
      gitBranchVisible,
      isRunning,
      modelLabelReady,
      modeLabel,
      normalizedModelChipLabel,
      sessionName,
      showAddMenuAction,
      showModelAction,
      showModeAction,
      workspaceIndicatorVisible,
      workspaceName,
      workspaceSelectVisible,
      selectedWorkspaceLabel,
    ]);

    return (
      <div
        className={`${styles.editorShell} ${
          modeDropdownOpen || modelDropdownOpen
            ? styles.editorShellDropdownOpen
            : ''
        }`}
        data-composer
        data-web-shell-composer
        data-web-shell-compact-composer={compactOverlays ? '' : undefined}
        onDragOver={cancelShellFileDrag}
        onDrop={cancelShellFileDrag}
      >
        {fileUpload.uploads.length > 0 && (
          <div className={styles.uploadStrip} data-web-shell-upload-strip>
            {/* One live region per strip, fed only by terminal transitions:
                per-row regions would announce every >=2% progress tick. */}
            <div className={styles.srOnly} role="status" aria-live="polite">
              {fileUpload.uploads
                .filter(
                  (upload) =>
                    upload.status === 'done' || upload.status === 'error',
                )
                .map(
                  (upload) =>
                    `${upload.file.name}: ${uploadStatusText(upload)}`,
                )
                .join(' \u2014 ')}
            </div>
            {fileUpload.uploads.map((upload) => {
              const busy =
                upload.status === 'pending' || upload.status === 'uploading';
              const previewable =
                Boolean(onAttachmentPreview) &&
                upload.status === 'done' &&
                Boolean(upload.resultPath);
              return (
                <div
                  key={upload.id}
                  className={styles.uploadRow}
                  data-status={upload.status}
                  data-previewable={previewable || undefined}
                >
                  <button
                    type="button"
                    className={styles.uploadRowPreview}
                    disabled={!previewable}
                    onClick={() =>
                      onAttachmentPreview?.({
                        name: upload.file.name,
                        workspacePath: upload.resultPath!,
                      })
                    }
                  >
                    {busy ? (
                      <LoaderCircleIcon
                        className={styles.uploadRowSpinner}
                        aria-hidden="true"
                      />
                    ) : (
                      <UploadIcon aria-hidden="true" />
                    )}
                    <span className={styles.uploadRowName}>
                      {upload.file.name}
                    </span>
                    <span className={styles.uploadRowStatus}>
                      {uploadStatusText(upload)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.uploadRowAction}
                    aria-label={
                      busy
                        ? t('composer.upload.cancel')
                        : t('composer.upload.dismiss')
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      fileUpload.removeUpload(upload.id);
                    }}
                  >
                    <XIcon aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div
          ref={containerRef}
          className={styles.container}
          data-web-shell-composer-surface
          data-upload-drag-active={uploadDragActive || undefined}
          data-image-drag-active={
            (core.imageDragActive && !uploadDragActive) || undefined
          }
          aria-busy={core.pendingImageBatchCount > 0 || undefined}
          {...core.imageTransferHandlers}
          onDragEnter={handleUploadDragEnter}
          onDragOver={handleUploadDragOver}
          onDragLeave={handleUploadDragLeave}
          onDropCapture={handleUploadDrop}
          // Legacy marker from the pre-#8098 glow implementation; no CSS or
          // script consumes it today, kept as-is to stay faithful to the
          // restored original.
          data-dac-glow
          onClick={() => {
            setModeDropdownOpen(false);
            setModelDropdownOpen(false);
            setQuickActionsOpen(false);
            core.focus();
          }}
        >
          <div className={styles.dacAura} aria-hidden="true" />
          <div className={styles.dacHalo} aria-hidden="true" />
          {uploadEnabled && (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className={styles.hiddenUploadInput}
              data-web-shell-upload-input
              onChange={handleUploadPickerChange}
              tabIndex={-1}
              aria-hidden="true"
            />
          )}
          {searchMode && (
            <div
              ref={searchUiRef}
              className={styles.searchPanel}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className={styles.searchBar}>
                <span className={styles.searchLabel}>
                  {t('editor.searchLabel')}
                </span>
                <input
                  ref={searchInputRef}
                  className={styles.searchInput}
                  data-web-shell-composer-history-search
                  value={searchQuery}
                  onChange={handleSearchInput}
                  onCompositionEnd={handleSearchCompositionEnd}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t('editor.searchPlaceholder')}
                />
              </div>
              {searchMatches.length > 0 && (
                <div className={styles.searchResults}>
                  {searchMatches.map((match, matchIndex) => {
                    return (
                      <button
                        key={`${match}-${matchIndex}`}
                        type="button"
                        className={`${styles.searchResult} ${
                          matchIndex === searchActiveIndex
                            ? styles.searchResultActive
                            : ''
                        }`}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          if (restoreSearchMatch) {
                            restoreSearchMatch(match);
                          } else {
                            core.replaceEditorText(match);
                          }
                          closeSearch(false);
                        }}
                      >
                        <span className={styles.searchResultMarker}>
                          {matchIndex === searchActiveIndex ? '›' : ''}
                        </span>
                        <span className={styles.searchResultText}>{match}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {searchMatches.length === 0 && (
                <div className={styles.searchEmpty}>
                  {t('editor.noHistory')}
                </div>
              )}
            </div>
          )}
          <div className={styles.content} data-web-shell-composer-content>
            {core.pastedImages.length > 0 && (
              <div className={styles.images} data-web-shell-composer-images>
                {core.pastedImages.map((img, i) => {
                  const src = `data:${img.media_type};base64,${img.data}`;
                  return (
                    <div key={i} className={styles.imageThumb}>
                      <img
                        src={src}
                        alt=""
                        onClick={
                          onImagePreview ? () => onImagePreview(src) : undefined
                        }
                      />
                      <button
                        type="button"
                        className={styles.imageRemove}
                        disabled={disabled}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (disabled) return;
                          core.removeImage(i);
                        }}
                        aria-label="Remove image"
                      >
                        <svg
                          width="8"
                          height="8"
                          viewBox="0 0 10 10"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M2 2l6 6M8 2l-6 6"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {(core.composerTags.length > 0 || core.pastedFiles.length > 0) && (
              <div
                className={styles.attachments}
                data-web-shell-composer-attachments
              >
                {core.composerTags.length > 0 && (
                  <TooltipPrimitive.Provider
                    delayDuration={0}
                    disableHoverableContent={false}
                  >
                    <div className={styles.tags}>
                      {core.composerTags.map((tag) => {
                        const tagInfo = {
                          tag,
                          placement: 'composer' as const,
                          readonly: false,
                        };
                        let tooltip: ReactNode | null | undefined;
                        try {
                          tooltip = renderComposerTagTooltip?.(tagInfo);
                        } catch (error) {
                          console.warn(
                            '[WebShell] composer tag tooltip render failed',
                            error,
                          );
                        }
                        return (
                          <TopComposerTag
                            key={tag.id}
                            tag={tag}
                            content={renderComposerTagContent(tag)}
                            tooltip={tooltip}
                            onActivate={
                              onComposerTagClick ||
                              (isPreviewableFileComposerTag(tag) &&
                                onAttachmentPreview)
                                ? (anchorRect) =>
                                    handleComposerTagClick({
                                      ...tagInfo,
                                      anchorRect,
                                    })
                                : undefined
                            }
                            onRemove={
                              tag.removable !== false
                                ? () => {
                                    core.removeTopTag(tag.id);
                                    core.viewRef.current?.focus();
                                  }
                                : undefined
                            }
                          />
                        );
                      })}
                    </div>
                  </TooltipPrimitive.Provider>
                )}
                {core.pastedFiles.length > 0 && (
                  <div className={styles.files}>
                    {core.pastedFiles.map((file, i) => (
                      <div
                        key={`${file.name}-${i}`}
                        className={`${styles.fileChip}${
                          onAttachmentPreview
                            ? ` ${styles.fileChipPreviewable}`
                            : ''
                        }`}
                      >
                        <button
                          type="button"
                          className={styles.fileChipPreview}
                          disabled={!onAttachmentPreview}
                          onClick={() =>
                            onAttachmentPreview?.({
                              name: file.name,
                              mimeType: file.media_type,
                              ...(file.data ? { data: file.data } : {}),
                              ...(file.text !== undefined
                                ? { text: file.text }
                                : {}),
                            })
                          }
                        >
                          <FileTypeIcon
                            name={file.name}
                            mimeType={file.media_type}
                            size={14}
                            className={styles.fileChipIcon}
                            aria-hidden="true"
                          />
                          <span className={styles.fileChipName}>
                            {file.name}
                          </span>
                        </button>
                        <button
                          type="button"
                          className={styles.fileChipRemove}
                          disabled={disabled}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (disabled) return;
                            core.removeFile(i);
                          }}
                          aria-label={`Remove ${file.name}`}
                        >
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 10 10"
                            fill="none"
                            aria-hidden="true"
                          >
                            <path
                              d="M2 2l6 6M8 2l-6 6"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {uploadDragActive && (
              <div
                className={styles.uploadDropOverlay}
                data-web-shell-upload-drop-overlay
              >
                <UploadIcon aria-hidden="true" />
                <span>{t('composer.upload.drop')}</span>
              </div>
            )}
            {core.slashMenu && (
              <SlashCommandPanel
                menu={core.slashMenu}
                anchorRef={containerRef}
                panelRef={slashPanelRef}
                detailRef={slashDetailRef}
                compact={compactOverlays}
                onClose={core.closeSlashMenu}
                onSelect={core.selectSlashCompletion}
                onAccept={(index) => core.acceptSlashCompletion(index, true)}
              />
            )}
            {core.atMenu && (
              <AtMentionPanel
                menu={core.atMenu}
                anchorRef={containerRef}
                panelRef={atPanelRef}
                compact={compactOverlays}
                onSelect={core.selectAtCompletion}
                onAccept={core.acceptAtCompletion}
                onBack={() => {
                  const result = core.backAtCategories();
                  if (result === 'categories') {
                    window.setTimeout(() => core.focus(), 0);
                  }
                  return Boolean(result);
                }}
                onSearch={core.updateAtSearch}
                onSelectTab={core.selectAtTab}
              />
            )}
            <div className={styles.editorArea}>
              {core.shellMode && (
                <span className={styles.shellPrefix} aria-hidden="true">
                  !
                </span>
              )}
              {core.mobileComposer ? (
                // Touch devices get a plain textarea instead of CodeMirror:
                // mobile virtual keyboards and IMEs interact poorly with the
                // contenteditable editor (#5958). Enter inserts a newline
                // natively; submission goes through the Send button.
                <textarea
                  ref={core.mobileComposer.textareaRef}
                  className={styles.mobileTextarea}
                  value={core.mobileComposer.value}
                  onChange={core.mobileComposer.onChange}
                  onBlur={core.mobileComposer.onBlur}
                  placeholder={core.mobileComposer.placeholder}
                  disabled={core.disabled}
                  rows={1}
                  enterKeyHint="enter"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  data-web-shell-composer-editor
                />
              ) : (
                <div ref={core.containerRef} data-web-shell-composer-editor />
              )}
            </div>
            <div
              ref={toolbarRef}
              className={styles.toolbar}
              data-mobile-voice-active={mobileVoiceActive || undefined}
            >
              <div
                ref={toolbarLeadingRef}
                className={styles.toolbarLeading}
                data-web-shell-toolbar-leading
              >
                {ToolbarStart && (
                  <div ref={toolbarStartRef} className={styles.toolbarStart}>
                    <ToolbarStart
                      disabled={disabled}
                      isRunning={isRunning}
                      currentMode={currentMode}
                      currentModel={currentModel}
                      sessionName={sessionName}
                    />
                  </div>
                )}
                <div className={styles.toolbarLeft}>
                  {showAddMenuAction && (
                    <AddMenu
                      key={JSON.stringify([
                        sessionId,
                        atWorkspaceCwd,
                        Boolean(disabled),
                      ])}
                      disabled={disabled}
                      availabilityKey={JSON.stringify([
                        fileUploadEnabled === false,
                        uploadEnabled,
                        Boolean(
                          core.workspaceActionsRef.current?.globWorkspace ??
                            core.workspaceActionsRef.current?.listDirectory,
                        ),
                        Boolean(
                          core.workspaceActionsRef.current
                            ?.loadExtensionsStatus,
                        ),
                        Boolean(
                          core.workspaceActionsRef.current?.loadMcpStatus,
                        ),
                        Boolean(skills?.length),
                      ])}
                      addFileAvailable={
                        workspaceFeaturesEnabled && fileUploadEnabled !== false
                      }
                      uploadAvailable={uploadEnabled}
                      onAddFiles={handleAddMenuFiles}
                      onFilePickerCancel={focusComposer}
                      onInsertReference={handleAddMenuInsertReference}
                      onPrependSkill={handleAddMenuPrependSkill}
                      getWorkspaceActions={getAddMenuWorkspaceActions}
                      skills={skills ?? []}
                    />
                  )}
                  {workspaceSelectVisible &&
                    workspaces &&
                    onSelectWorkspace && (
                      <WorkspaceSelector
                        workspaces={workspaces}
                        selectedWorkspaceCwd={selectedWorkspaceCwd}
                        noWorkspaceSupported={noWorkspaceSupported}
                        noWorkspaceSelected={noWorkspaceSelected}
                        disabled={workspaceSelectionDisabled}
                        busy={workspaceMutationBusy}
                        scratchSupported={scratchWorkspaceSupported}
                        existingFolderSupported={
                          existingFolderWorkspaceSupported
                        }
                        className={`${styles.toolBtn} ${styles.workspaceSelectTrigger} ${
                          showWorkspaceSelectLabel
                            ? ''
                            : styles.workspaceSelectTriggerCompact
                        }`}
                        onSelectWorkspace={onSelectWorkspace}
                        onSelectNoWorkspace={onSelectNoWorkspace}
                        onCreateScratch={onCreateScratchWorkspace ?? (() => {})}
                        onOpenExistingFolder={
                          onOpenExistingWorkspace ?? (() => {})
                        }
                      />
                    )}
                  {workspaceIndicatorVisible && workspaceName && (
                    <WorkspaceIndicator
                      name={workspaceName}
                      title={workspaceTitle ?? workspaceName}
                      color={workspaceColor}
                      compact={!showWorkspaceLabel}
                      ariaLabel={t('workspace.paneLabel', {
                        name: workspaceName,
                      })}
                    />
                  )}
                  {gitBranchVisible &&
                    gitBranch &&
                    (gitModeIntent && onGitModeIntentChange ? (
                      <GitModePopover
                        branch={gitBranch}
                        compact={!showGitBranchLabel}
                        intent={gitModeIntent}
                        onIntentChange={onGitModeIntentChange}
                      />
                    ) : (
                      <BranchPickerPopover
                        open={branchPickerOpen}
                        onOpenChange={setBranchPickerOpen}
                        workspaceCwd={selectedWorkspace?.cwd ?? ''}
                        gitCwd={gitCwd}
                        status={gitStatus}
                        onOpenDiff={onOpenGitDiff}
                        onOpenCommit={onOpenCommit}
                      >
                        <button
                          type="button"
                          className={styles.gitBranchChipButton}
                          aria-label={gitBranchAriaLabel(
                            gitBranch,
                            gitStatus,
                            t,
                          )}
                        >
                          <GitBranchIndicator
                            branch={gitBranch}
                            status={gitStatus}
                            compact={!showGitBranchLabel}
                            worktree={gitWorktree}
                          />
                        </button>
                      </BranchPickerPopover>
                    ))}
                  {showModeAction && (
                    <div
                      className={`${styles.dropdownWrapper} ${
                        showModeLabel ? '' : styles.dropdownWrapperCompact
                      }`}
                    >
                      <ToolbarPopover
                        compact={compactOverlays}
                        open={modeDropdownOpen}
                        items={modeItems}
                        activeId={currentMode}
                        onOpenChange={(open) => {
                          setModeDropdownOpen(open);
                          if (open) setModelDropdownOpen(false);
                        }}
                        onSelect={handleModeSelect}
                        tooltip={modeLabel}
                        trigger={
                          <button
                            className={`${styles.toolBtn} ${styles.modeToolBtn} ${
                              showModeLabel ? '' : styles.toolBtnCompact
                            }`}
                            data-web-shell-mode-button
                            data-web-shell-toolbar-popover-trigger
                            onClick={(e) => {
                              e.stopPropagation();
                              core.closeSlashMenu();
                              core.closeAtMenu();
                              setQuickActionsOpen(false);
                            }}
                            aria-label={t('status.mode')}
                          >
                            <span className={styles.toolBtnModeIcon}>
                              <ModeIcon mode={currentMode} />
                            </span>
                            {showModeLabel && (
                              <span className={styles.toolBtnText}>
                                {modeLabel}
                              </span>
                            )}
                            <span className={styles.toolBtnArrow}>
                              <ChevronDownIcon />
                            </span>
                          </button>
                        }
                      />
                    </div>
                  )}
                  {showModelAction && (
                    <div
                      className={`${styles.dropdownWrapper} ${
                        showModelLabel ? '' : styles.dropdownWrapperCompact
                      }`}
                    >
                      <ToolbarPopover
                        compact={compactOverlays}
                        open={modelDropdownOpen}
                        items={modelItems}
                        activeId={currentModel}
                        onOpenChange={(open) => {
                          setModelDropdownOpen(open);
                          if (open) setModeDropdownOpen(false);
                        }}
                        onSelect={handleModelSelect}
                        tooltip={modelLabel}
                        showCheck
                        searchable
                        searchLabel={t('common.search')}
                        noResultsLabel={(query) =>
                          t('model.noMatch', { query })
                        }
                        submenu={
                          showReasoningOptions
                            ? {
                                triggerLabel: modelLabel,
                                triggerAriaLabel: `${t('model.select')}: ${modelLabel}`,
                                sectionLabel: t('model.section'),
                              }
                            : undefined
                        }
                        header={
                          showReasoningOptions && reasoning ? (
                            <ModelReasoningControls
                              reasoning={reasoning}
                              onSelect={onSelectReasoningEffort}
                            />
                          ) : undefined
                        }
                        trigger={
                          <button
                            className={`${styles.toolBtn} ${styles.modelToolBtn} ${
                              showModelLabel ? '' : styles.toolBtnCompact
                            }`}
                            data-web-shell-model-button
                            data-web-shell-toolbar-popover-trigger
                            onClick={(e) => {
                              e.stopPropagation();
                              core.closeSlashMenu();
                              core.closeAtMenu();
                              setQuickActionsOpen(false);
                            }}
                            aria-label={`${t('model.select')}: ${normalizedModelChipLabel}`}
                            title={normalizedModelChipLabel}
                          >
                            <span className={styles.toolBtnModelIcon}>
                              <ModelIcon />
                            </span>
                            {showModelLabel && (
                              <span className={styles.toolBtnText}>
                                {normalizedModelChipLabel}
                              </span>
                            )}
                            <span className={styles.toolBtnArrow}>
                              <ChevronDownIcon />
                            </span>
                          </button>
                        }
                      />
                    </div>
                  )}
                  {ToolbarEnd && (
                    <div ref={toolbarEndRef} className={styles.toolbarEnd}>
                      <ToolbarEnd
                        disabled={disabled}
                        isRunning={isRunning}
                        currentMode={currentMode}
                        currentModel={currentModel}
                        sessionName={sessionName}
                      />
                    </div>
                  )}
                </div>
              </div>
              <div ref={toolbarRightRef} className={styles.toolbarRight}>
                {showQuickActions && quickActions.length > 0 && (
                  <button
                    className={`${styles.toolBtn} ${styles.quickActionsBtn}`}
                    data-hide-during-mobile-voice
                    onClick={(e) => {
                      e.stopPropagation();
                      core.closeSlashMenu();
                      core.closeAtMenu();
                      setModeDropdownOpen(false);
                      setModelDropdownOpen(false);
                      setQuickActionsOpen((value) => !value);
                    }}
                    aria-expanded={quickActionsOpen}
                    aria-label={t('quickActions.open')}
                    title={t('quickActions.open')}
                    data-tooltip={t('quickActions.open')}
                  >
                    <span className={styles.toolBtnIcon}>
                      <QuickActionsIcon />
                    </span>
                  </button>
                )}
                {ToolbarRight && (
                  <div
                    ref={toolbarRightCustomRef}
                    className={styles.toolbarRightCustom}
                    data-hide-during-mobile-voice
                  >
                    <ToolbarRight
                      disabled={disabled}
                      isRunning={isRunning}
                      currentMode={currentMode}
                      currentModel={currentModel}
                      sessionName={sessionName}
                    />
                  </div>
                )}
                {showChatWidthToggle &&
                  widthToggleFits &&
                  showToolbarAction('widthMode') && (
                    <button
                      className={`${styles.toolBtn} ${styles.widthModeBtn}`}
                      data-hide-during-mobile-voice
                      onClick={(e) => {
                        e.stopPropagation();
                        onChatWidthModeChange?.(
                          chatWidthMode === 'wide' ? '1000' : 'wide',
                        );
                      }}
                      disabled={!onChatWidthModeChange}
                      aria-label={
                        chatWidthMode === 'wide'
                          ? t('settings.option.ui.chatWidth.1000')
                          : t('settings.option.ui.chatWidth.wide')
                      }
                      title={
                        chatWidthMode === 'wide'
                          ? t('settings.option.ui.chatWidth.1000')
                          : t('settings.option.ui.chatWidth.wide')
                      }
                      data-tooltip={
                        chatWidthMode === 'wide'
                          ? t('settings.option.ui.chatWidth.1000')
                          : t('settings.option.ui.chatWidth.wide')
                      }
                    >
                      <span className={styles.toolBtnIcon}>
                        <WidthModeIcon mode={chatWidthMode} />
                      </span>
                    </button>
                  )}
                {showToolbarAction('contextUsage') &&
                  (contextUsageAlwaysVisible ||
                    (contextWindow > 0 && tokenCount > 0)) && (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            className={`${styles.toolBtn} ${styles.contextUsageBtn}`}
                            data-hide-during-mobile-voice
                            data-web-shell-context-usage
                            onClick={(e) => {
                              e.stopPropagation();
                              onShowContextUsage?.();
                            }}
                            disabled={!onShowContextUsage}
                            aria-label={
                              contextWindow > 0 && tokenCount > 0
                                ? t('status.contextUsed', {
                                    pct: (
                                      (tokenCount / contextWindow) *
                                      100
                                    ).toFixed(1),
                                  })
                                : t('contextUsage.title')
                            }
                          >
                            <span className={styles.toolBtnIcon}>
                              <ContextUsageRing
                                pct={
                                  contextWindow > 0
                                    ? (tokenCount / contextWindow) * 100
                                    : 0
                                }
                              />
                            </span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {contextWindow > 0 && tokenCount > 0
                            ? formatContextUsageDetail(
                                tokenCount,
                                contextWindow,
                              )
                            : t('contextUsage.title')}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                {showCommandAction && (
                  <button
                    type="button"
                    className={`${styles.toolBtn} ${styles.toolBtnCompact}`}
                    data-web-shell-command-button
                    aria-label={t('help.shortcut.commandMenu')}
                    title={t('help.shortcut.commandMenu')}
                    disabled={disabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!core.openSlashMenu()) {
                        core.insertText('/');
                        core.focus();
                      }
                    }}
                  >
                    <span className={styles.toolBtnIcon}>
                      <SlashIcon />
                    </span>
                  </button>
                )}
                {showToolbarAction('voice') && (
                  <>
                    <LiveVoiceButton />
                    <VoiceButton
                      disabled={disabled}
                      onActiveChange={setVoiceActive}
                      target={voiceTarget}
                      statusRevision={voiceStatusRevision}
                      onInsert={(text) => {
                        const existing = core.getText();
                        const sep =
                          existing && !/\s$/.test(existing) ? ' ' : '';
                        core.insertText(`${sep}${text} `);
                        core.focus();
                      }}
                    />
                  </>
                )}
                <button
                  className={
                    composerPreparing || showCancelButton
                      ? `${styles.sendBtn} ${styles.sendBtnRunning}${
                          cancelArmed ? ` ${styles.sendBtnArmed}` : ''
                        }`
                      : styles.sendBtn
                  }
                  disabled={
                    composerPreparing
                      ? true
                      : showCancelButton
                        ? !onCancel
                        : !core.canSubmit
                  }
                  data-web-shell-composer-submit
                  onClick={(e) => {
                    e.stopPropagation();
                    if (composerPreparing) {
                      return;
                    }
                    if (showCancelButton) {
                      onCancel?.();
                      return;
                    }
                    core.submitText();
                  }}
                  aria-label={
                    composerPreparing
                      ? t('common.loading')
                      : showCancelButton
                        ? cancelArmed
                          ? t('stream.cancelArmed')
                          : t('stream.cancel')
                        : t('editor.send')
                  }
                  title={
                    isRunning && cancelArmed
                      ? t('stream.cancelArmed')
                      : undefined
                  }
                >
                  {composerPreparing ? (
                    <LoadingIcon />
                  ) : showCancelButton ? (
                    cancelArmed ? (
                      <span className={styles.escLabel} aria-hidden="true">
                        Esc
                      </span>
                    ) : (
                      <StopIcon />
                    )
                  ) : (
                    <SendIcon />
                  )}
                </button>
                <span
                  role="status"
                  aria-live="polite"
                  className={styles.srOnly}
                >
                  {isRunning && cancelArmed ? t('stream.cancelArmed') : ''}
                </span>
              </div>
            </div>
            <div
              ref={toolbarMeasurementsRef}
              className={styles.toolbarMeasurements}
              aria-hidden="true"
            >
              {workspaceSelectVisible && selectedWorkspace && (
                <>
                  <span
                    data-toolbar-measure="workspaceSelect:collapsed"
                    className={`${styles.toolBtn} ${styles.workspaceSelectTrigger} ${styles.workspaceSelectTriggerCompact}`}
                  >
                    <FolderClosedIcon size={16} strokeWidth={1.2} />
                    <span className={styles.toolBtnText}>
                      {selectedWorkspaceLabel}
                    </span>
                    <span className={styles.toolBtnArrow}>
                      <ChevronDownIcon />
                    </span>
                  </span>
                  <span
                    data-toolbar-measure="workspaceSelect:expanded"
                    className={`${styles.toolBtn} ${styles.workspaceSelectTrigger}`}
                  >
                    <FolderClosedIcon size={16} strokeWidth={1.2} />
                    <span className={styles.toolBtnText}>
                      {selectedWorkspaceLabel}
                    </span>
                    <span className={styles.toolBtnArrow}>
                      <ChevronDownIcon />
                    </span>
                  </span>
                </>
              )}
              {workspaceIndicatorVisible && workspaceName && (
                <>
                  <span
                    data-toolbar-measure="workspace:collapsed"
                    className={`${styles.workspaceChip} ${styles.workspaceChipCompact}`}
                  >
                    <span className={styles.workspaceChipIcon} />
                    <span className={styles.workspaceChipText}>
                      {workspaceName}
                    </span>
                  </span>
                  <span
                    data-toolbar-measure="workspace:expanded"
                    className={styles.workspaceChip}
                  >
                    <span className={styles.workspaceChipIcon} />
                    <span className={styles.workspaceChipText}>
                      {workspaceName}
                    </span>
                  </span>
                </>
              )}
              {gitBranchVisible && gitBranch && (
                <>
                  <span
                    data-toolbar-measure="gitBranch:collapsed"
                    className={`${styles.gitBranchChip} ${styles.gitBranchChipCompact}`}
                  >
                    <GitBranchChipContent
                      branch={gitBranch}
                      status={gitStatus}
                      compact
                      worktree={gitWorktree}
                    />
                  </span>
                  <span
                    data-toolbar-measure="gitBranch:expanded"
                    className={styles.gitBranchChip}
                  >
                    <GitBranchChipContent
                      branch={gitBranch}
                      status={gitStatus}
                      compact={false}
                      worktree={gitWorktree}
                    />
                  </span>
                </>
              )}
              <span
                data-toolbar-measure="mode:collapsed"
                className={`${styles.toolBtn} ${styles.modeToolBtn} ${styles.toolBtnCompact}`}
              >
                <span className={styles.toolBtnModeIcon}>
                  <ModeIcon mode={currentMode} />
                </span>
                <span className={styles.toolBtnText}>{modeLabel}</span>
                <span className={styles.toolBtnArrow}>
                  <ChevronDownIcon />
                </span>
              </span>
              <span
                data-toolbar-measure="mode:expanded"
                className={`${styles.toolBtn} ${styles.modeToolBtn}`}
              >
                <span className={styles.toolBtnModeIcon}>
                  <ModeIcon mode={currentMode} />
                </span>
                <span className={styles.toolBtnText}>{modeLabel}</span>
                <span className={styles.toolBtnArrow}>
                  <ChevronDownIcon />
                </span>
              </span>
              <span
                data-toolbar-measure="model:collapsed"
                className={`${styles.toolBtn} ${styles.modelToolBtn} ${styles.toolBtnCompact}`}
              >
                <span className={styles.toolBtnModelIcon}>
                  <ModelIcon />
                </span>
                <span className={styles.toolBtnText}>
                  {normalizedModelChipLabel}
                </span>
                <span className={styles.toolBtnArrow}>
                  <ChevronDownIcon />
                </span>
              </span>
              <span
                data-toolbar-measure="model:expanded"
                className={`${styles.toolBtn} ${styles.modelToolBtn}`}
              >
                <span className={styles.toolBtnModelIcon}>
                  <ModelIcon />
                </span>
                <span className={styles.toolBtnText}>
                  {normalizedModelChipLabel}
                </span>
                <span className={styles.toolBtnArrow}>
                  <ChevronDownIcon />
                </span>
              </span>
            </div>
          </div>
        </div>
        {showQuickActions && quickActionsOpen && quickActions.length > 0 && (
          <QuickActionsPanel
            actions={quickActions}
            onRun={runQuickAction}
            onPressKey={pressQuickKey}
            showKeyHints={!core.mobileComposer}
          />
        )}
        <Dialog
          open={pendingDropFiles !== null}
          onOpenChange={(open) => {
            if (!open) setPendingDropFiles(null);
          }}
        >
          <DialogContent
            data-web-shell-drop-choice-dialog
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              core.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {t('composer.dropChoice.title', {
                  count: pendingDropFiles?.length ?? 0,
                })}
              </DialogTitle>
              <DialogDescription>
                {t('composer.dropChoice.description')}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-32 overflow-auto rounded-lg border bg-background/70 px-3 py-2 text-xs">
              {pendingDropFiles
                ?.slice(0, MAX_DROP_DIALOG_ROWS)
                .map((file, index) => (
                  <div
                    key={`${file.name}:${file.size}:${index}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="min-w-0 truncate">{file.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatAttachmentSize(file.size)}
                    </span>
                  </div>
                ))}
              {(pendingDropFiles?.length ?? 0) > MAX_DROP_DIALOG_ROWS && (
                <div className="pt-1 text-muted-foreground">
                  {t('composer.dropChoice.moreFiles', {
                    count:
                      (pendingDropFiles?.length ?? 0) - MAX_DROP_DIALOG_ROWS,
                  })}
                </div>
              )}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" data-drop-action="cancel">
                  {t('composer.dropChoice.cancel')}
                </Button>
              </DialogClose>
              <Button
                variant="outline"
                data-drop-action="upload"
                onClick={uploadDroppedFiles}
              >
                {t('composer.dropChoice.upload')}
              </Button>
              <Button
                data-drop-action="reference"
                onClick={referenceDroppedFiles}
              >
                {t('composer.dropChoice.reference')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }),
);
