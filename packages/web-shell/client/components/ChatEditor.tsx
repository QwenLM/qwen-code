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
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/webui/daemon-react-sdk';
import type { CommandInfo } from '../adapters/types';
import type { UseDaemonFollowupSuggestionReturn } from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonSessionGroupPresetColor } from '@qwen-code/sdk/daemon';
import type { CommandDisplayCategoryOrder } from '../utils/commandDisplay';
import type { SkillInfo } from '../completions/slashCompletion';
import { useI18n } from '../i18n';
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
import { cssUrlVar } from '../utils/cssUrlVar';
import { getComposerTagIconUrl } from '../utils/composerTag';
import { isSafeImageSrc } from './messages/Markdown';
import { ModeIcon } from './ModeIcon';
import { planSlashSectionRows } from '../utils/slashSectionPlan';
import { getModelDisplayName } from '../utils/modelDisplay';
import { VoiceButton } from '../voice/VoiceButton';
import { GitBranchIndicator } from './GitBranchIndicator';
import { WorkspaceIndicator } from './WorkspaceIndicator';
import { ChevronDownIcon, FolderClosedIcon } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from './ui/popover';
import { Input } from './ui/input';
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

export type ComposerToolbarAction =
  | 'approvalMode'
  | 'gitBranch'
  | 'model'
  | 'commands'
  | 'files'
  | 'widthMode'
  | 'voice'
  | 'workspace';

const ACTIVE_TOOLBAR_ACTIONS = [
  'approvalMode',
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
    commitAccepted?: import('../hooks/useComposerCore').ComposerSubmitCommit,
    metadata?: ComposerSubmitMetadata,
  ) => boolean | void;
  onCycleMode?: () => void;
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
  queuedMessages?: string[];
  onPopQueuedMessages?: () => boolean;
  onClearQueuedMessages?: () => boolean;
  currentMode?: string;
  currentModel?: string;
  gitBranch?: string;
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
  availableModels?: Array<{ id: string; label?: string }>;
  onSelectMode?: (mode: string) => void;
  onSelectModel?: (model: string) => void;
  workspaces?: Array<{
    id: string;
    cwd: string;
    label: string;
    primary: boolean;
  }>;
  selectedWorkspaceCwd?: string;
  workspaceSelectionDisabled?: boolean;
  onSelectWorkspace?: (workspaceCwd: string | undefined) => void;
  atWorkspaceCwd?: string;
  onChatWidthModeChange?: (mode: '1000' | 'wide') => void;
  onFocusFooter?: () => boolean;
  dialogOpen?: boolean;
  followupState?: UseDaemonFollowupSuggestionReturn['followupState'];
  onAcceptFollowup?: UseDaemonFollowupSuggestionReturn['onAcceptFollowup'];
  onDismissFollowup?: UseDaemonFollowupSuggestionReturn['onDismissFollowup'];
  sessionName?: string;
  composerInput?: WebShellComposerInput;
  composerInputVersion?: number;
  builtinAtProviders?: WebShellBuiltinAtProvidersConfig;
  atProviders?: readonly WebShellAtProvider[];
  composerTagIcons?: WebShellComposerTagIconMap;
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
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [collisionBoundary, setCollisionBoundary] =
    useState<HTMLElement | null>(null);
  const selectionRef = useRef(false);
  const handoffRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hasRichItems = items.some((item) => item.description || item.icon);
  const visibleItems = searchable
    ? filterToolbarDropdownItems(items, searchQuery)
    : items;

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
    }
  }, [open]);

  const hasCheckItems = hasRichItems || showCheck;

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
        onClick={(event) => event.stopPropagation()}
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
        {searchable && (
          <Input
            type="search"
            value={searchQuery}
            aria-label={searchLabel}
            placeholder={searchLabel}
            autoComplete="off"
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        )}
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
                    <span className={styles.dropdownItemLabel}>
                      {item.label}
                    </span>
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
      </PopoverContent>
    </Popover>
  );
}

function SlashCommandPanel({
  menu,
  anchorRef,
  panelRef,
  detailRef,
  onClose,
  onSelect,
  onAccept,
}: {
  menu: SlashMenuState;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  detailRef: RefObject<HTMLDivElement | null>;
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
  const maxLabelLength = Math.max(
    ...menu.items.map((item) => Array.from(item.label).length),
    0,
  );
  const maxDetailLength = Math.max(
    ...menu.items.map((item) => Array.from(item.detail ?? '').length),
    0,
  );
  const hasDetailColumn = maxDetailLength > 0;
  const panelStyle = {
    '--slash-command-col': `${Math.min(
      Math.max(maxLabelLength + 1, 10),
      24,
    )}ch`,
    '--slash-desc-col': hasDetailColumn
      ? `${Math.min(Math.max(maxDetailLength + 1, 18), 36)}ch`
      : '0px',
    '--slash-column-gap': hasDetailColumn ? '2ch' : '0px',
  } as CSSProperties;

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
          alignOffset={16}
          sideOffset={8}
          collisionPadding={12}
          collisionBoundary={collisionBoundary ?? undefined}
          role="listbox"
          data-web-shell-slash-menu
          style={panelStyle}
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
                          if (!item.detail) {
                            setHoverDetail(null);
                            return;
                          }
                          hoverAnchorRef.current = event.currentTarget;
                          setHoverDetail({
                            label: item.label,
                            detail: item.detail,
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
        open={Boolean(hoverDetail)}
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
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            collisionBoundary={collisionBoundary ?? undefined}
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
}: {
  actions: readonly QuickActionItem[];
  onRun: (action: QuickActionItem) => void;
  onPressKey: (item: QuickKeyItem) => void;
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
      </div>
    </div>
  );
}

export const ChatEditor = memo(
  forwardRef<EditorHandle, ChatEditorProps>(function ChatEditor(props, ref) {
    const {
      onSubmit,
      onCycleMode,
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
      queuedMessages = [],
      onPopQueuedMessages,
      currentMode = 'default',
      currentModel = '',
      gitBranch,
      workspaceName,
      workspaceTitle,
      workspaceColor,
      chatWidthMode = '1000',
      showChatWidthToggle = true,
      chatWidthToggleMin,
      visibleToolbarActions,
      availableModels = [],
      onSelectMode,
      onSelectModel,
      workspaces,
      selectedWorkspaceCwd,
      workspaceSelectionDisabled = false,
      onSelectWorkspace,
      atWorkspaceCwd,
      onChatWidthModeChange,
      onFocusFooter,
      dialogOpen = false,
      followupState,
      onAcceptFollowup,
      onDismissFollowup,
      sessionName,
      composerInput,
      composerInputVersion,
      builtinAtProviders,
      atProviders,
      composerTagIcons,
    } = props;

    const {
      renderComposerToolbarStart: ToolbarStart,
      renderComposerToolbarEnd: ToolbarEnd,
      renderComposerToolbarRight: ToolbarRight,
      renderComposerTag,
      renderComposerTagTooltip,
      onComposerTagClick,
    } = useWebShellCustomization();

    const core = useComposerCore({
      onSubmit,
      onCycleMode,
      onToggleShortcuts,
      disabled,
      placeholderText,
      commands,
      skills,
      slashCommandCategoryOrder,
      queuedMessages,
      onPopQueuedMessages,
      currentMode,
      onFocusFooter,
      dialogOpen,
      followupState,
      onAcceptFollowup,
      onDismissFollowup,
      sessionName,
      composerInput,
      composerInputVersion,
      builtinAtProviders,
      atProviders,
      atWorkspaceCwd,
      composerTagIcons,
      renderComposerTag,
      renderComposerTagTooltip,
      onComposerTagClick,
      editorTheme: CHAT_EDITOR_THEME,
    });

    const { t } = useI18n();

    useImperativeHandle(ref, () => core.handle, [core.handle]);

    const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
    const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
    const [quickActionsOpen, setQuickActionsOpen] = useState(false);
    const [workspaceTooltipOpen, setWorkspaceTooltipOpen] = useState(false);
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
    const workspaceSelectTriggerRef = useRef<HTMLButtonElement>(null);
    const suppressWorkspaceTooltipRef = useRef(false);
    const workspaceSelectPointerInsideRef = useRef(false);
    const [widthToggleFits, setWidthToggleFits] = useState(false);
    const [toolbarLabelVisibility, setToolbarLabelVisibility] = useState({
      workspaceSelect: false,
      workspace: false,
      gitBranch: false,
      mode: false,
      model: false,
    });
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
          label: getModeListLabel(id, t),
          description: t(`mode.desc.${id}`),
          icon: <ModeIcon mode={id} />,
        })),
      [t],
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
        iconUrl && isSafeImageSrc(iconUrl) ? iconUrl : undefined;
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
    const modeLabel = getModeLabel(currentMode, t);

    const currentModelLabel = currentModel
      ? getModelDisplayName(currentModel)
      : '';
    const { modelLabel, modelLabelReady } = resolveToolbarModelLabel({
      currentModelLabel,
      lastConfirmedModelLabel,
    });
    const selectedWorkspace = workspaces?.find((entry) =>
      selectedWorkspaceCwd ? entry.cwd === selectedWorkspaceCwd : entry.primary,
    );
    const selectedWorkspaceLabel = selectedWorkspace
      ? `${selectedWorkspace.label}${
          selectedWorkspace.primary ? ` · ${t('sidebar.workspacePrimary')}` : ''
        }`
      : '';
    const workspaceSelectVisible = Boolean(
      workspaces && workspaces.length > 1 && onSelectWorkspace,
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

    useLayoutEffect(() => {
      const toolbar = toolbarRef.current;
      const toolbarLeading = toolbarLeadingRef.current;
      const toolbarRight = toolbarRightRef.current;
      const measurements = toolbarMeasurementsRef.current;
      if (!toolbar || !toolbarLeading || !toolbarRight || !measurements) {
        return undefined;
      }

      const update = () => {
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
            (toolbarLabelVisibility[
              item.id as keyof typeof toolbarLabelVisibility
            ]
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
          currentVisibility: toolbarLabelVisibility,
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
        setToolbarLabelVisibility((current) => {
          const unchanged = Object.keys(next).every(
            (key) =>
              current[key as keyof typeof current] ===
              next[key as keyof typeof next],
          );
          return unchanged ? current : next;
        });
      };

      update();
      const resizeObserver = new ResizeObserver(update);
      resizeObserver.observe(toolbar);
      resizeObserver.observe(toolbarLeading);
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
      modelLabel,
      modelLabelReady,
      modeLabel,
      sessionName,
      showModelAction,
      showModeAction,
      toolbarLabelVisibility,
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
      >
        <div
          ref={containerRef}
          className={styles.container}
          data-web-shell-composer-surface
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
                          core.replaceEditorText(match);
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
          <div className={styles.content}>
            {(core.composerTags.length > 0 || core.pastedImages.length > 0) && (
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
                              onComposerTagClick
                                ? (anchorRect) =>
                                    onComposerTagClick({
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
                {core.pastedImages.length > 0 && (
                  <div className={styles.images}>
                    {core.pastedImages.map((img, i) => (
                      <div key={i} className={styles.imageThumb}>
                        <img
                          src={`data:${img.media_type};base64,${img.data}`}
                          alt=""
                        />
                        <button
                          className={styles.imageRemove}
                          onClick={(e) => {
                            e.stopPropagation();
                            core.removeImage(i);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {core.slashMenu && (
              <SlashCommandPanel
                menu={core.slashMenu}
                anchorRef={containerRef}
                panelRef={slashPanelRef}
                detailRef={slashDetailRef}
                onClose={core.closeSlashMenu}
                onSelect={core.selectSlashCompletion}
                onAccept={core.acceptSlashCompletion}
              />
            )}
            {core.atMenu && (
              <AtMentionPanel
                menu={core.atMenu}
                anchorRef={containerRef}
                panelRef={atPanelRef}
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
              <div ref={core.containerRef} data-web-shell-composer-editor />
            </div>
            <div ref={toolbarRef} className={styles.toolbar}>
              <div ref={toolbarLeadingRef} className={styles.toolbarLeading}>
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
                  {workspaceSelectVisible &&
                    workspaces &&
                    onSelectWorkspace && (
                      <Select
                        value={selectedWorkspace?.id}
                        disabled={workspaceSelectionDisabled}
                        onValueChange={(value) => {
                          const nextWorkspace = workspaces.find(
                            (entry) => entry.id === value,
                          );
                          if (!nextWorkspace) return;
                          onSelectWorkspace(
                            nextWorkspace.primary
                              ? undefined
                              : nextWorkspace.cwd,
                          );
                          suppressWorkspaceTooltipRef.current = true;
                          setWorkspaceTooltipOpen(false);
                          requestAnimationFrame(() => {
                            workspaceSelectTriggerRef.current?.blur();
                          });
                        }}
                      >
                        <TooltipProvider delayDuration={300}>
                          <Tooltip
                            open={workspaceTooltipOpen}
                            onOpenChange={(open) => {
                              if (
                                open &&
                                (suppressWorkspaceTooltipRef.current ||
                                  !workspaceSelectPointerInsideRef.current)
                              ) {
                                return;
                              }
                              setWorkspaceTooltipOpen(open);
                            }}
                          >
                            <TooltipTrigger asChild>
                              <span
                                className={`${styles.workspaceSelectTooltipTrigger} ${
                                  showWorkspaceSelectLabel
                                    ? ''
                                    : styles.workspaceSelectTooltipTriggerCompact
                                }`}
                                onPointerEnter={() => {
                                  workspaceSelectPointerInsideRef.current = true;
                                }}
                                onPointerLeave={() => {
                                  workspaceSelectPointerInsideRef.current = false;
                                  suppressWorkspaceTooltipRef.current = false;
                                }}
                                onBlur={() => {
                                  if (
                                    !workspaceSelectPointerInsideRef.current
                                  ) {
                                    suppressWorkspaceTooltipRef.current = false;
                                  }
                                }}
                              >
                                <SelectTrigger
                                  ref={workspaceSelectTriggerRef}
                                  size="sm"
                                  className={`${styles.toolBtn} ${styles.workspaceSelectTrigger} ${
                                    showWorkspaceSelectLabel
                                      ? ''
                                      : styles.workspaceSelectTriggerCompact
                                  }`}
                                  aria-label={t('sidebar.workspaceSelectLabel')}
                                >
                                  <FolderClosedIcon
                                    size={16}
                                    strokeWidth={1.2}
                                  />
                                  <SelectValue />
                                </SelectTrigger>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              {selectedWorkspaceLabel}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                        <SelectContent position="popper" align="start">
                          <SelectGroup>
                            {workspaces.map((entry) => (
                              <SelectItem key={entry.id} value={entry.id}>
                                {entry.label}
                                {entry.primary
                                  ? ` · ${t('sidebar.workspacePrimary')}`
                                  : ''}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
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
                  {gitBranchVisible && gitBranch && (
                    <GitBranchIndicator
                      branch={gitBranch}
                      compact={!showGitBranchLabel}
                      ariaLabel={t('git.currentBranch', { branch: gitBranch })}
                    />
                  )}
                  {showModeAction && (
                    <div
                      className={`${styles.dropdownWrapper} ${
                        showModeLabel ? '' : styles.dropdownWrapperCompact
                      }`}
                    >
                      <ToolbarPopover
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
                            aria-label={t('model.select')}
                          >
                            <span className={styles.toolBtnModelIcon}>
                              <ModelIcon />
                            </span>
                            {showModelLabel && (
                              <span className={styles.toolBtnText}>
                                {modelLabel}
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
                {showToolbarAction('voice') && (
                  <VoiceButton
                    disabled={disabled}
                    onInsert={(text) => {
                      const existing = core.getText();
                      const sep = existing && !/\s$/.test(existing) ? ' ' : '';
                      core.insertText(`${sep}${text} `);
                      core.focus();
                    }}
                  />
                )}
                <button
                  className={
                    isPreparing || showCancelButton
                      ? `${styles.sendBtn} ${styles.sendBtnRunning}${
                          cancelArmed ? ` ${styles.sendBtnArmed}` : ''
                        }`
                      : styles.sendBtn
                  }
                  disabled={
                    isPreparing
                      ? true
                      : showCancelButton
                        ? !onCancel
                        : core.disabled || !core.hasContent
                  }
                  data-web-shell-composer-submit
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isPreparing) {
                      return;
                    }
                    if (showCancelButton) {
                      onCancel?.();
                      return;
                    }
                    core.submitText();
                  }}
                  aria-label={
                    isPreparing
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
                  {isPreparing ? (
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
                    <span className={styles.gitBranchIcon} />
                    <span className={styles.gitBranchText}>{gitBranch}</span>
                  </span>
                  <span
                    data-toolbar-measure="gitBranch:expanded"
                    className={styles.gitBranchChip}
                  >
                    <span className={styles.gitBranchIcon} />
                    <span className={styles.gitBranchText}>{gitBranch}</span>
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
                <span className={styles.toolBtnText}>{modelLabel}</span>
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
                <span className={styles.toolBtnText}>{modelLabel}</span>
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
          />
        )}
      </div>
    );
  }),
);
