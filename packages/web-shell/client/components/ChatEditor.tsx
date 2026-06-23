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
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/webui/daemon-react-sdk';
import type { CommandInfo } from '../adapters/types';
import type { UseDaemonFollowupSuggestionReturn } from '@qwen-code/webui/daemon-react-sdk';
import type { CommandDisplayCategoryOrder } from '../utils/commandDisplay';
import type { SkillInfo } from '../completions/slashCompletion';
import { useI18n } from '../i18n';
import {
  useWebShellCustomization,
  type WebShellComposerInput,
  type WebShellComposerTag,
} from '../customization';
import {
  useComposerCore,
  type EditorHandle,
  type SlashMenuState,
  getComposerTagDisplay,
  getComposerTagLabel,
  getComposerTagValue,
} from '../hooks/useComposerCore';
import { ModeIcon } from './ModeIcon';
import styles from './ChatEditor.module.css';

export type ComposerToolbarAction =
  | 'approvalMode'
  | 'model'
  | 'commands'
  | 'files'
  | 'widthMode';

interface ChatEditorProps {
  onSubmit: (
    text: string,
    images?: import('../adapters/promptTypes').PromptImage[],
  ) => boolean | void;
  onCycleMode?: () => void;
  onToggleShortcuts?: () => void;
  onCancel?: () => void;
  isRunning?: boolean;
  disabled?: boolean;
  placeholderText?: string;
  commands: CommandInfo[];
  skills?: SkillInfo[];
  slashCommandCategoryOrder?: CommandDisplayCategoryOrder;
  queuedMessages?: string[];
  onPopQueuedMessages?: () => string | null;
  onClearQueuedMessages?: () => boolean;
  currentMode?: string;
  currentModel?: string;
  chatWidthMode?: '1000' | 'wide';
  showChatWidthToggle?: boolean;
  chatWidthToggleMin?: number;
  visibleToolbarActions?: readonly ComposerToolbarAction[];
  availableModels?: Array<{ id: string; label?: string }>;
  onSelectMode?: (mode: string) => void;
  onSelectModel?: (model: string) => void;
  onChatWidthModeChange?: (mode: '1000' | 'wide') => void;
  onFocusFooter?: () => boolean;
  dialogOpen?: boolean;
  followupState?: UseDaemonFollowupSuggestionReturn['followupState'];
  onAcceptFollowup?: UseDaemonFollowupSuggestionReturn['onAcceptFollowup'];
  onDismissFollowup?: UseDaemonFollowupSuggestionReturn['onDismissFollowup'];
  sessionName?: string;
  composerInput?: WebShellComposerInput;
  composerInputVersion?: number;
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
    color: 'var(--text-primary, #e0e0e0)',
    caretColor: 'var(--accent-color, #4a9eff)',
    fontSize: '14px',
    lineHeight: '1.6',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-placeholder': {
    color: 'var(--text-dimmed, #666)',
  },
  '.cm-followup-ghost': {
    color: 'var(--text-dimmed, #666)',
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
    borderLeftColor: 'var(--accent-color, #4a9eff)',
    borderLeftWidth: '2px',
  },
};

const SLASH_PANEL_THEME_VARS = [
  '--accent-color',
  '--bg-primary',
  '--bg-tertiary',
  '--border-color',
  '--font-mono',
  '--font-sans',
  '--text-primary',
  '--text-secondary',
] as const;

function SendIcon() {
  return (
    <svg
      className={styles.sendIcon}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M1 1L15 8L1 15V9.5L10 8L1 6.5V1Z" fill="currentColor" />
    </svg>
  );
}

function StopIcon() {
  return <span className={styles.stopIcon} aria-hidden="true" />;
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

function ChevronDownIcon() {
  return <span className={styles.chevronDown} aria-hidden="true" />;
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

interface DropdownItem {
  id: string;
  label: string;
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

function ToolbarDropdown({
  open,
  items,
  activeId,
  onClose,
  onSelect,
  anchorRef,
  showCheck = false,
}: {
  open: boolean;
  items: DropdownItem[];
  activeId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  showCheck?: boolean;
}) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerOutside = (event: Event) => {
      if (event instanceof MouseEvent && event.button !== 0) return;
      if (event.defaultPrevented) return;
      const dropdown = dropdownRef.current;
      const anchor = anchorRef.current;
      const target = event.target;
      if (
        dropdown &&
        target instanceof Node &&
        !dropdown.contains(target) &&
        anchor &&
        !anchor.contains(target)
      ) {
        onClose();
      }
    };
    window.addEventListener('mousedown', onPointerOutside);
    return () => window.removeEventListener('mousedown', onPointerOutside);
  }, [open, onClose, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [open, onClose]);

  if (!open) return null;

  const hasRichItems = items.some((item) => item.description || item.icon);
  const hasCheckItems = hasRichItems || showCheck;

  return (
    <div
      ref={dropdownRef}
      className={`${styles.dropdown} ${
        hasRichItems
          ? styles.dropdownRich
          : showCheck
            ? styles.dropdownCheck
            : ''
      }`}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`${styles.dropdownItem} ${
            item.id === activeId ? styles.dropdownItemActive : ''
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
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
    </div>
  );
}

function SlashCommandPanel({
  menu,
  anchorRef,
  panelRef,
  onSelect,
  onAccept,
}: {
  menu: SlashMenuState;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  onSelect: (index: number) => boolean;
  onAccept: (index?: number) => boolean;
}) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [anchorRect, setAnchorRect] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
  const [themeVars, setThemeVars] = useState<CSSProperties>({});
  const [hoverDetail, setHoverDetail] = useState<{
    label: string;
    detail: string;
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    itemRefs.current[menu.selectedIndex]?.scrollIntoView({
      block: 'nearest',
    });
  }, [menu.items, menu.selectedIndex]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return undefined;

    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const computedStyle = getComputedStyle(anchor);
      const nextThemeVars = Object.fromEntries(
        SLASH_PANEL_THEME_VARS.map((name) => [
          name,
          computedStyle.getPropertyValue(name),
        ]),
      ) as CSSProperties;
      setAnchorRect({
        left: Math.max(12, Math.min(rect.left + 16, window.innerWidth - 252)),
        bottom: window.innerHeight - rect.top + 8,
        width: rect.width,
      });
      setThemeVars(nextThemeVars);
    };

    update();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(anchor);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef, menu.items]);

  useEffect(() => {
    setHoverDetail(null);
  }, [menu.items]);

  const measureText = (text: string) => Array.from(text).length;
  const maxLabelLength = Math.max(
    ...menu.items.map((item) => measureText(item.label)),
    0,
  );
  const maxDetailLength = Math.max(
    ...menu.items.map((item) => measureText(item.detail ?? '')),
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

  let lastSection: string | undefined;

  if (!anchorRect) return null;

  const positionedPanelStyle = {
    ...panelStyle,
    ...themeVars,
    left: anchorRect.left,
    bottom: anchorRect.bottom,
    '--slash-anchor-width': `${anchorRect.width}px`,
  } as CSSProperties;

  return createPortal(
    <div ref={panelRef} className={styles.slashPortalLayer} style={themeVars}>
      <div
        className={styles.slashPanel}
        style={positionedPanelStyle}
        role="listbox"
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
        <div className={styles.slashPanelBody}>
          <div
            className={styles.slashList}
            onScroll={() => setHoverDetail(null)}
          >
            {menu.items.map((item, index) => {
              const section = item.section;
              const showSection =
                menu.kind === 'command' &&
                index > 0 &&
                section !== undefined &&
                section !== lastSection;
              lastSection = section ?? lastSection;
              return (
                <div key={`${item.id}:${index}`} className={styles.slashEntry}>
                  {showSection && <div className={styles.slashSection} />}
                  <button
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    type="button"
                    role="option"
                    aria-selected={index === menu.selectedIndex}
                    className={`${styles.slashItem} ${
                      index === menu.selectedIndex ? styles.slashItemActive : ''
                    }`}
                    onMouseEnter={(event) => {
                      onSelect(index);
                      if (!item.detail) {
                        setHoverDetail(null);
                        return;
                      }
                      const row = event.currentTarget;
                      const gap = 8;
                      const detailMaxHeight = 180;
                      const rowRect = row.getBoundingClientRect();
                      const detailWidth = 320;
                      const left = Math.min(
                        rowRect.left + Math.min(220, rowRect.width * 0.34),
                        window.innerWidth - detailWidth - 12,
                      );
                      const spaceBelow =
                        window.innerHeight - rowRect.bottom - gap - 12;
                      const spaceAbove = rowRect.top - gap - 12;
                      const showBelow =
                        spaceBelow >= 96 || spaceBelow >= spaceAbove;
                      const maxHeight = Math.max(
                        72,
                        Math.min(
                          detailMaxHeight,
                          showBelow ? spaceBelow : spaceAbove,
                        ),
                      );
                      setHoverDetail({
                        label: item.label,
                        detail: item.detail,
                        left: Math.max(12, left),
                        ...(showBelow
                          ? { top: rowRect.bottom + gap }
                          : {
                              bottom: window.innerHeight - rowRect.top + gap,
                            }),
                        maxHeight,
                      });
                    }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onAccept(index);
                    }}
                  >
                    <span className={styles.slashCommand}>{item.label}</span>
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
      {hoverDetail && (
        <div
          ref={detailRef}
          className={styles.slashDetail}
          style={{
            ...themeVars,
            left: hoverDetail.left,
            top: hoverDetail.top,
            bottom: hoverDetail.bottom,
            maxHeight: hoverDetail.maxHeight,
          }}
        >
          <div className={styles.slashDetailCommand}>{hoverDetail.label}</div>
          <div className={styles.slashDetailText}>{hoverDetail.detail}</div>
        </div>
      )}
    </div>,
    document.body,
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
      disabled = false,
      placeholderText = 'Type a message...',
      commands,
      skills = [],
      slashCommandCategoryOrder,
      queuedMessages = [],
      onPopQueuedMessages,
      onClearQueuedMessages,
      currentMode = 'default',
      currentModel = '',
      chatWidthMode = '1000',
      showChatWidthToggle = true,
      chatWidthToggleMin,
      visibleToolbarActions,
      availableModels = [],
      onSelectMode,
      onSelectModel,
      onChatWidthModeChange,
      onFocusFooter,
      dialogOpen = false,
      followupState,
      onAcceptFollowup,
      onDismissFollowup,
      sessionName,
      composerInput,
      composerInputVersion,
    } = props;

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
      onClearQueuedMessages,
      currentMode,
      onFocusFooter,
      dialogOpen,
      followupState,
      onAcceptFollowup,
      onDismissFollowup,
      sessionName,
      composerInput,
      composerInputVersion,
      editorTheme: CHAT_EDITOR_THEME,
    });

    const { t } = useI18n();
    const {
      renderComposerToolbarStart: ToolbarStart,
      renderComposerToolbarEnd: ToolbarEnd,
    } = useWebShellCustomization();

    useImperativeHandle(ref, () => core.handle, [core.handle]);

    const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
    const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
    const [quickActionsOpen, setQuickActionsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const slashPanelRef = useRef<HTMLDivElement>(null);
    const modeBtnRef = useRef<HTMLButtonElement>(null);
    const modelBtnRef = useRef<HTMLButtonElement>(null);
    const [widthToggleFits, setWidthToggleFits] = useState(false);
    const slashMenu = core.slashMenu;
    const closeSlashMenu = core.closeSlashMenu;
    const editorViewRef = core.viewRef;

    useEffect(() => {
      if (!slashMenu) return;
      const onPointerOutside = (event: Event) => {
        const target = event.target;
        const container = containerRef.current;
        if (
          target instanceof Node &&
          container &&
          !container.contains(target) &&
          !slashPanelRef.current?.contains(target)
        ) {
          closeSlashMenu();
        }
      };
      window.addEventListener('mousedown', onPointerOutside);
      window.addEventListener('touchstart', onPointerOutside);
      return () => {
        window.removeEventListener('mousedown', onPointerOutside);
        window.removeEventListener('touchstart', onPointerOutside);
      };
    }, [slashMenu, closeSlashMenu]);

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
          label: getModeLabel(id, t),
          description: t(`mode.desc.${id}`),
          icon: <ModeIcon mode={id} />,
        })),
      [t],
    );
    const visibleActionSet = useMemo(
      () => (visibleToolbarActions ? new Set(visibleToolbarActions) : null),
      [visibleToolbarActions],
    );
    const showToolbarAction = (action: ComposerToolbarAction) => {
      if (!visibleActionSet) return true;
      return visibleActionSet.has(action);
    };
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
              id: 'extensions',
              label: t('quickActions.extensions'),
              action: { type: 'run', command: '/extensions manage' },
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
          label: m.label || m.id,
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
      const tagLabel = getComposerTagLabel(tag);
      const tagValue = getComposerTagValue(tag);
      if (!tagLabel && !tagValue) {
        return <span className={styles.tagLabel}>{tag.id}</span>;
      }
      return (
        <>
          {tagLabel && <span className={styles.tagLabel}>{tagLabel}</span>}
          {tagValue && <span className={styles.tagValue}>{tagValue}</span>}
        </>
      );
    };

    // Mode display label
    const modeLabel = getModeLabel(currentMode, t);

    // Model display label
    const modelLabel = currentModel;

    return (
      <div className={styles.editorShell}>
        <div
          ref={containerRef}
          className={styles.container}
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
            {core.composerTags.length > 0 && (
              <div className={styles.tags}>
                {core.composerTags.map((tag) => (
                  <span key={tag.id} className={styles.tag}>
                    {renderComposerTagContent(tag)}
                    {tag.removable !== false && (
                      <button
                        type="button"
                        className={styles.tagRemove}
                        aria-label={`Remove ${getComposerTagDisplay(tag)}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.stopPropagation();
                          core.removeTopTag(tag.id);
                          core.viewRef.current?.focus();
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.key !== 'Backspace' &&
                            event.key !== 'Delete'
                          ) {
                            return;
                          }
                          event.preventDefault();
                          core.removeTopTag(tag.id);
                          core.viewRef.current?.focus();
                        }}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
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
            {core.slashMenu && (
              <SlashCommandPanel
                menu={core.slashMenu}
                anchorRef={containerRef}
                panelRef={slashPanelRef}
                onSelect={core.selectSlashCompletion}
                onAccept={core.acceptSlashCompletion}
              />
            )}
            <div className={styles.editorArea}>
              {core.shellMode && (
                <span className={styles.shellPrefix} aria-hidden="true">
                  !
                </span>
              )}
              <div ref={core.containerRef} />
            </div>
            <div className={styles.toolbar}>
              <div className={styles.toolbarLeading}>
                {ToolbarStart && (
                  <div className={styles.toolbarStart}>
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
                  {showToolbarAction('approvalMode') && (
                    <div className={styles.dropdownWrapper}>
                      <ToolbarDropdown
                        open={modeDropdownOpen}
                        items={modeItems}
                        activeId={currentMode}
                        onClose={() => setModeDropdownOpen(false)}
                        onSelect={handleModeSelect}
                        anchorRef={modeBtnRef}
                      />
                      <button
                        ref={modeBtnRef}
                        className={styles.toolBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          core.closeSlashMenu();
                          setQuickActionsOpen(false);
                          setModeDropdownOpen((v) => !v);
                          setModelDropdownOpen(false);
                        }}
                        aria-label={t('status.mode')}
                      >
                        <span className={styles.toolBtnModeIcon}>
                          <ModeIcon mode={currentMode} />
                        </span>
                        <span className={styles.toolBtnText}>{modeLabel}</span>
                        <span className={styles.toolBtnArrow}>
                          <ChevronDownIcon />
                        </span>
                      </button>
                    </div>
                  )}
                  {showToolbarAction('model') && (
                    <div className={styles.dropdownWrapper}>
                      <ToolbarDropdown
                        open={modelDropdownOpen}
                        items={modelItems}
                        activeId={currentModel}
                        onClose={() => setModelDropdownOpen(false)}
                        onSelect={handleModelSelect}
                        anchorRef={modelBtnRef}
                        showCheck
                      />
                      <button
                        ref={modelBtnRef}
                        className={styles.toolBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          core.closeSlashMenu();
                          setQuickActionsOpen(false);
                          setModelDropdownOpen((v) => !v);
                          setModeDropdownOpen(false);
                        }}
                        aria-label={t('model.select')}
                      >
                        <span className={styles.toolBtnModelIcon}>
                          <ModelIcon />
                        </span>
                        <span className={styles.toolBtnText}>{modelLabel}</span>
                        <span className={styles.toolBtnArrow}>
                          <ChevronDownIcon />
                        </span>
                      </button>
                    </div>
                  )}
                  {ToolbarEnd && (
                    <div className={styles.toolbarEnd}>
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
              <div className={styles.toolbarRight}>
                {showToolbarAction('commands') && (
                  <button
                    className={styles.toolBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setQuickActionsOpen(false);
                      core.insertText('/');
                    }}
                    aria-label={t('editor.hintCommands')}
                    title={t('editor.hintCommands')}
                    data-tooltip={t('editor.hintCommands')}
                  >
                    <span className={styles.toolBtnIcon}>/</span>
                  </button>
                )}
                {showToolbarAction('files') && (
                  <button
                    className={styles.toolBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setQuickActionsOpen(false);
                      core.insertText('@');
                    }}
                    aria-label={t('editor.hintFiles')}
                    title={t('editor.hintFiles')}
                    data-tooltip={t('editor.hintFiles')}
                  >
                    <span className={styles.toolBtnIcon}>@</span>
                  </button>
                )}
                {quickActions.length > 0 && (
                  <button
                    className={`${styles.toolBtn} ${styles.quickActionsBtn}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      core.closeSlashMenu();
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
                <button
                  className={
                    isRunning
                      ? `${styles.sendBtn} ${styles.sendBtnRunning}`
                      : styles.sendBtn
                  }
                  disabled={
                    isRunning ? !onCancel : core.disabled || !core.hasContent
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isRunning) {
                      onCancel?.();
                      return;
                    }
                    core.submitText();
                  }}
                  aria-label={isRunning ? t('stream.cancel') : t('editor.send')}
                >
                  {isRunning ? <StopIcon /> : <SendIcon />}
                </button>
              </div>
            </div>
          </div>
        </div>
        {quickActionsOpen && quickActions.length > 0 && (
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
