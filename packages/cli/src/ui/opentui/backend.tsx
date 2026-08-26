/* eslint-disable react/no-unknown-property, default-case */
/** @jsxImportSource @opentui/react */
/**
 * qwen-code × OpenTUI POC — chat app demonstrating:
 *  1. streaming markdown via opentui incremental parser (<markdown streaming>)
 *  2. scrollbox viewport replacing qwen-code VP mode (sticky bottom)
 *  3. mouse-first interactions: click to expand/collapse, wheel scroll,
 *     drag-select + auto copy (native-terminal-like)
 *  4. flicker-free rendering (cell diff + DEC 2026, handled by the renderer)
 */
import { MouseButton, decodePasteBytes } from '@opentui/core';
import type {
  MouseEvent,
  PasteEvent,
  ScrollBoxRenderable,
} from '@opentui/core';
import { findUrlAtRow, readBufferRow } from './link-click.js';
import { renderDiffBody, type DiffLine } from './diff-render.js';
import { C, SYNTAX, applyThemeMode, applyOpenTuiTheme } from './theme.js';
import { detectInitialThemeMode } from './theme-auto.js';
import { getActiveOpenTuiTheme } from './theme-parity.js';
import { AUTO_THEME_NAME, themeManager } from '../themes/theme-manager.js';
import {
  selectionProps,
  toolCardDescription,
  toolCardName,
  toolCardSummarySuffix,
  toolCardText,
  toolStatusMeta,
  tailWindow,
  maxHistoryItemRows,
  hiddenLinesLabel,
  TodoRows,
  AnsiRows,
} from './messages.js';
import { CompressionNotice, compactionView } from './session-compaction.js';
import { OpenTuiInputPrompt } from './input-prompt.js';
import {
  useKeyboard,
  usePaste,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { copyText } from './clipboard.js';
import { buildScenario, TOKEN_INTERVAL_MS } from './stream-script.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import {
  describeGoalCard,
  describeLegacyGoalCard,
  foldLiveEvent,
  settleOpenTools,
  type GoalCardColor,
  type LiveHistoryItem,
  type LiveImageItem,
  type LiveRetryItem,
  type LiveThinkingItem,
  type LiveToolItem,
} from './live-session-model.js';
import { assistantMarkdownForRender } from './markdown-heal.js';
import { batchTextEvents } from './text-batcher.js';
import { formatDuration } from '../utils/displayUtils.js';

/** Maps a goal card's semantic palette slot onto the theme colors. */
const GOAL_CARD_COLORS: Record<GoalCardColor, string> = {
  secondary: C.dim,
  accent: C.accent,
  warning: C.yellow,
  error: C.red,
  success: C.green,
};
import {
  Logger,
  MessageSenderType,
  ToolConfirmationOutcome,
  openBrowserSecurely,
  type ApprovalMode,
  type Config,
  type ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { normalizePastedText } from './input-prompt-model.js';
import {
  MAX_DISPLAYED_QUEUED_MESSAGES,
  summarizeQueuedPrompt,
} from './queue-summary.js';
import {
  findProviderByCredentials,
  resolveMetadataKey,
  tildeifyPath,
  shortenPath,
  uiTelemetryService,
} from '@qwen-code/qwen-code-core';
import { fmtTokens } from '../components/stats-helpers.js';
import { shortAsciiLogo } from '../components/AsciiArt.js';
import {
  getAsciiArtWidth,
  getCachedStringWidth,
  truncateToWidth,
} from '../utils/textUtils.js';
import { ICON } from '../constants.js';
import {
  getOrderedStickyTodos,
  getStickyTodoMaxVisibleItemsForMode,
  getStickyTodosRenderKey,
  STICKY_TODO_MAX_VISIBLE_ITEMS,
} from '../utils/todoSnapshot.js';
import {
  pickAsciiArtTier,
  resolveCustomBanner,
} from '../utils/customBanner.js';
import {
  getTipHistory,
  selectTip,
  tipRegistry,
  type TipContext,
} from '../../services/tips/index.js';
import { getStickyTodosFromLiveItems } from './sticky-todos.js';
import type { TodoItem } from '../components/TodoDisplay.js';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import type { Part, PartListUnion } from '@google/genai';
import {
  livePromptEvents,
  nextApprovalMode,
  nextLivePromptId,
  selectAutoApprovals,
  type WaitingCallInfo,
} from './live-session.js';
import { resumeEventsFromConfig } from './resume-session.js';
import { isSlashCommandInput } from './slash-dispatch.js';
import type { RemoteInputWatcher } from '../../remoteInput/RemoteInputWatcher.js';
import {
  createOpenTuiSlashDispatcher,
  type OpenTuiSlashDispatcher,
} from './commands-dispatch.js';
import { OpenTuiSlashGateway, type SlashSettlement } from './slash-gateway.js';
import {
  createBackendCommandHost,
  projectCommandItem,
  resolveDispatchOutcome,
  type BackendAction,
  type MountedDialog,
} from './command-bridge.js';
import type { ShellConfirmationResolution } from './commands-context.js';
import { clientToolEvents } from './client-tool-run.js';
import {
  isRewindableTurn,
  type RestoreOption,
  type RewindTurn,
} from './session-rewind.js';
import { rewindApiCutPoint } from './session-rewind-model.js';
import { OpenTuiDialogMount } from './dialog-mount.js';
import { OpenTuiFolderTrustGate } from './folder-trust-gate.js';
import { loadSettings, type LoadedSettings } from '../../config/settings.js';
import type { ExtensionRefreshState } from '../../config/extension-refresh-state.js';
import type { SlashCommand } from '../commands/types.js';
import type { RecentSlashCommand } from '../hooks/useSlashCompletion.js';
import {
  createExitGuard,
  exitGuardHint,
  type ExitGuard,
} from './exit-guard.js';
import { exitSession, EXIT_CODE_INTERRUPT } from './exit-lifecycle.js';
import {
  setupUpdateNotifications,
  type UpdateNotificationHandle,
} from './post-render.js';
import { injectCapturedInput } from './early-input.js';
import { useGitBranchName } from '../hooks/useGitBranchName.js';
import { buildQuitFarewellForConfig } from './quit-farewell.js';
import { useAttentionNotifications } from '../hooks/useAttentionNotifications.js';
import {
  isProgressBarSupported,
  TERMINAL_PROGRESS_SEQUENCES,
} from '../hooks/useTerminalProgress.js';
import { buildTerminalNotification } from '../hooks/useTerminalNotification.js';
import { StreamingState, type HistoryItemWithoutId } from '../types.js';
import { sendNotification } from '../../services/notificationService.js';
import { useOpenTuiFocus } from './use-opentui-focus.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let spinnerTick = 0;
const nextSpinner = () => SPINNER[spinnerTick++ % SPINNER.length];

/** One-line truncated preview of the tool-call args JSON. */
const argsPreview = (args: string) => {
  const line = args.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

/**
 * Original status-line `formatPercent` parity: one decimal place, no
 * trailing `.0` (so `5%`, not `5.0%`).
 */
const formatPercentUsed = (pct: number): string => {
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : String(rounded);
};

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** Clipboard image file → genai inlineData part (null when unreadable). */
function readImagePart(p: string): Part | null {
  try {
    const data = readFileSync(p).toString('base64');
    return {
      inlineData: {
        mimeType: IMAGE_MIME[nodePath.extname(p).toLowerCase()] ?? 'image/png',
        data,
      },
    };
  } catch {
    return null;
  }
}

const EXT_TO_LANG: Record<string, string> = {
  html: 'html',
  htm: 'html',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  css: 'css',
  json: 'json',
  md: 'markdown',
  py: 'python',
  sh: 'bash',
};

function filetypeFromArgs(title: string, args?: string): string {
  if (title === 'write_file' || title === 'read_file') {
    try {
      const a = JSON.parse(args ?? '{}') as Record<string, unknown>;
      const p = (a['file_path'] ?? a['path']) as string | undefined;
      if (p) {
        const ext = p.split('.').pop()?.toLowerCase() ?? '';
        if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
      }
    } catch {
      /* fall through */
    }
  }
  return 'txt';
}

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

function ToolCard(props: {
  item: LiveToolItem;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { item, expanded, onToggle } = props;
  const [hover, setHover] = useState(false);
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();

  // ink ToolStatusIndicator parity: pending `o`, executing `⊷`, success `✓`,
  // confirming `?`, canceled `-` (struck through), error `x`.
  const meta = toolStatusMeta(item);
  const suffix = toolCardSummarySuffix(item.done, item.summary);
  const confirmLabel =
    item.confirm === 'pending'
      ? ' · awaiting approval…'
      : item.confirm === 'rejected'
        ? ' · rejected'
        : '';
  // Original tool-card parity: `{glyph} {DisplayName} {description}` — the
  // display name comes from the shared map (`run_shell_command` → `Shell`)
  // and the description from the invocation args (`echo X (Echo X)`). Live
  // events carry no description string, so scripted/demo titles fall back.
  const displayName = toolCardName(item.tool);
  // Real invocation description first (live sessions: the scheduler's
  // getDescription rides the tool-description event, ink mapToDisplay
  // parity); the args reconstruction only covers scripted/demo streams.
  const realDescription = item.description
    ? toolCardText(item.description)
    : '';
  const argsDescription = realDescription
    ? ''
    : toolCardDescription(item.tool, item.args);
  let fallbackDescription =
    item.title && item.title !== item.tool && item.title !== displayName
      ? item.title
      : '';
  // Scripted/demo titles embed the tool verb ("Read packages/…"); drop the
  // leading name so the card does not read "Read Read packages/…".
  for (const prefix of [`${displayName} `, `${item.tool} `]) {
    if (fallbackDescription.startsWith(prefix)) {
      fallbackDescription = fallbackDescription.slice(prefix.length);
      break;
    }
  }
  const description = `${argsDescription || fallbackDescription}${suffix}`;
  // FileDiff results render as colored gutter+diff lines (ink
  // DiffResultRenderer parity), always visible like the original — not
  // gated behind the click-to-expand output block.
  const diffLines = useMemo(
    () => (item.diff ? renderDiffBody(item.diff.fileDiff) : null),
    [item.diff],
  );
  // ink static history caps one item at staticAreaMaxItemHeight rows, tail
  // first (MaxSizedBox); an uncapped mega-diff would dominate the viewport.
  const diffWindow = useMemo(
    () =>
      diffLines ? tailWindow(diffLines, maxHistoryItemRows(height)) : null,
    [diffLines, height],
  );
  return (
    <box flexDirection="column">
      <box
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={(e) => {
          if (e.button === MouseButton.LEFT) {
            const sel = renderer.getSelection();
            if (!sel?.getSelectedText()) onToggle(item.id);
          }
        }}
        paddingLeft={1}
        backgroundColor={hover ? C.hover : undefined}
      >
        <box flexDirection="row">
          <text fg={meta.color}>{meta.glyph} </text>
          <text fg={C.text} attributes={1 | (meta.strikethrough ? 128 : 0)}>
            {displayName}
          </text>
          {(description || confirmLabel) && (
            <text fg={C.dim}>{` ${description}`}</text>
          )}
          {confirmLabel && <text fg={C.yellow}>{confirmLabel}</text>}
        </box>
      </box>
      {diffWindow && (
        <box paddingLeft={3} flexDirection="column">
          {diffWindow.hiddenCount > 0 && (
            <text fg={C.dim}>{hiddenLinesLabel(diffWindow.hiddenCount)}</text>
          )}
          {diffWindow.visible.map((spans, i) => (
            <box key={`${i}`} flexDirection="row">
              {spans.map((span, j) => (
                <text key={`${j}`} fg={span.color}>
                  {span.text}
                </text>
              ))}
            </box>
          ))}
        </box>
      )}
      {expanded && item.args && item.title !== 'write_file' && (
        <box paddingLeft={3}>
          <text fg={C.dim}>{argsPreview(item.args)}</text>
        </box>
      )}
      {(expanded || item.title === 'write_file') && item.output.length > 0 && (
        <box paddingLeft={3} marginTop={0} flexDirection="row">
          {item.title === 'write_file' && (
            <box flexDirection="column" paddingRight={1}>
              {item.output.split('\n').map((_, i) => (
                <text key={i} fg={C.dim}>
                  {String(i + 1)}
                </text>
              ))}
            </box>
          )}
          <box flexGrow={1}>
            <code
              content={item.output}
              filetype={filetypeFromArgs(item.title, item.args)}
              syntaxStyle={SYNTAX}
              fg={C.text}
            />
          </box>
        </box>
      )}
      {/* TodoWrite result renders the status-icon list always (ink
       * ToolMessage resultDisplay parity), not gated behind expand. */}
      {item.todos && item.todos.length > 0 && (
        <box paddingLeft={3}>
          <TodoRows todos={item.todos} />
        </box>
      )}
      {/* Live shell output renders the styled token grid always (ink
       * AnsiOutputText parity). */}
      {item.ansi && item.ansi.grid.length > 0 && (
        <box paddingLeft={3}>
          <AnsiRows
            grid={item.ansi.grid}
            maxWidth={width - 6}
            totalLines={item.ansi.totalLines}
            totalBytes={item.ansi.totalBytes}
          />
        </box>
      )}
    </box>
  );
}

function TaskCard(props: {
  item: Extract<LiveHistoryItem, { kind: 'task' }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { item, expanded, onToggle } = props;
  const [hover, setHover] = useState(false);
  const renderer = useRenderer();
  const icon = !item.done ? nextSpinner() : '✓';
  const iconColor = !item.done ? C.accent : C.green;
  const suffix = item.done && item.stats ? ` · ${item.stats}` : '';
  const live =
    !item.done && item.progress.length > 0
      ? item.progress[item.progress.length - 1]
      : undefined;

  return (
    <box flexDirection="column">
      <box
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={(e) => {
          if (e.button === MouseButton.LEFT) {
            const sel = renderer.getSelection();
            if (!sel?.getSelectedText()) onToggle(item.id);
          }
        }}
        paddingLeft={1}
        backgroundColor={hover ? C.hover : undefined}
      >
        <text fg={iconColor}>{icon} </text>
        <text fg={C.text}>Task — {item.description}</text>
        <text fg={C.dim}>
          {suffix}
          {item.done
            ? expanded
              ? ' · click to collapse'
              : ' · click to expand'
            : ''}
        </text>
      </box>
      {!item.done && live && (
        <box paddingLeft={3}>
          <text fg={C.dim}>{live}</text>
        </box>
      )}
      {expanded && item.progress.length > 0 && (
        <box paddingLeft={3} flexDirection="column">
          {item.progress.map((p, i) => (
            <text key={i} fg={C.dim}>
              {p}
            </text>
          ))}
        </box>
      )}
    </box>
  );
}

function AssistantMessage(props: {
  item: Extract<LiveHistoryItem, { kind: 'assistant' }>;
}) {
  const { item } = props;
  return (
    <box paddingLeft={1} marginTop={1} flexDirection="row">
      <text fg={C.accent}>◆ </text>
      <box flexGrow={1} flexDirection="column">
        <markdown
          content={assistantMarkdownForRender(item.text, item.streaming)}
          streaming={item.streaming}
          syntaxStyle={SYNTAX}
          fg={C.text}
          bg={C.bg}
        />
      </box>
    </box>
  );
}

/** Inline model image (content part inlineData); terminals without a
 *  graphics protocol simply leave the box empty (onError swallowed). */
function ImageItem(props: { item: LiveImageItem }) {
  const { item } = props;
  const source = useMemo(
    () => new Uint8Array(Buffer.from(item.data, 'base64')),
    [item.data],
  );
  return (
    <box paddingLeft={1} marginTop={1}>
      <image source={source} width={64} height={18} onError={() => {}} />
    </box>
  );
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

/** Original-style header banner. Stable: depends only on config/width, so it
 *  does not re-render on streaming; resize re-renders without flicker via the
 *  erase-free painter. */
// Original witty loading phrases (i18n WITTY_LOADING_PHRASES, en subset).
const WITTY_LOADING_PHRASES = [
  "I'm Feeling Lucky",
  'Shipping awesomeness... ',
  'Reticulating splines...',
  'Consulting the digital spirits...',
  'Warming up the AI hamsters...',
  'Generating witty retort...',
  'Polishing the algorithms...',
  'Brewing fresh bytes...',
  'Engaging cognitive processors...',
  'Untangling neural nets...',
  'Compiling brilliance...',
  'Crafting a response worthy of your patience...',
];

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Self-contained spinner: owns its 120ms frame timer so the high-frequency
 * tick re-renders ONLY this 1-cell component, not the whole transcript tree
 * (native-perf / no duplicate full-tree rendering).
 */
function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const spin = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(spin);
  }, []);
  return (
    <box width={2}>
      <text fg={C.dim}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</text>
    </box>
  );
}

const LOGO_GRADIENT = ['#4796E4', '#847ACE', '#C3677F'];
function lerpHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return (
    '#' +
    pa
      .map((v, i) =>
        Math.round(v + (pb[i] - v) * t)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
function gradientAt(stops: string[], t: number): string {
  if (stops.length === 0) return C.accent;
  if (stops.length === 1) return stops[0];
  const seg = Math.min(stops.length - 1, Math.floor(t * (stops.length - 1)));
  const lt = t * (stops.length - 1) - seg;
  return lerpHex(stops[seg], stops[seg + 1], lt);
}
/** ASCII logo with the original horizontal gradient (themes GradientColors). */
function GradientLogo({ logo }: { logo: string }) {
  const lines = logo.replace(/^\n/, '').split('\n');
  const w = Math.max(...lines.map((l) => [...l].length), 1);
  return (
    <box flexDirection="column" flexShrink={0}>
      {lines.map((line, li) => (
        <box key={li} flexDirection="row">
          {[...line].map((ch, ci) => (
            <text key={ci} fg={gradientAt(LOGO_GRADIENT, ci / w)}>
              {ch}
            </text>
          ))}
        </box>
      ))}
    </box>
  );
}

function approvalModeLabel(mode: string): string {
  switch (mode) {
    case 'yolo':
      return 'YOLO';
    case 'auto-edit':
    case 'accepting-edits':
      return 'Auto-edit';
    case 'auto':
      return 'Auto';
    case 'plan':
      return 'Plan';
    default:
      return 'Default';
  }
}

// Faithful port of the original ink Header (components/Header.tsx): a
// single-border info panel with 4 lines — title(+version), blank spacer,
// auth|model(+hint), directory. Same data sources as the original, including
// the AppHeader custom-banner resolution (hideBanner / customAsciiArt /
// customBannerTitle / customBannerSubtitle).
function buildBanner(
  config: Config | undefined,
  settings: LoadedSettings,
  width: number,
) {
  let versionLabel = '';
  try {
    const cliPkg = nodePath.join(
      nodePath.dirname(process.argv[1]),
      '..',
      'package.json',
    );
    const v = (JSON.parse(readFileSync(cliPkg, 'utf8')) as { version?: string })
      .version;
    versionLabel = v ? (/^\d/.test(v) ? `v${v}` : v) : '';
  } catch {
    versionLabel = '';
  }
  const cfg = config as unknown as
    | {
        getContentGeneratorConfig?: () =>
          | { authType?: string; baseUrl?: string; apiKeyEnvKey?: string }
          | undefined;
        getModelDisplayName?: () => string;
        getTargetDir?: () => string;
      }
    | undefined;
  const cg = cfg?.getContentGeneratorConfig?.();
  const model = cfg?.getModelDisplayName?.() ?? 'qwen';
  const targetDir = cfg?.getTargetDir?.() ?? process.cwd();
  // auth label (mirrors AppHeader.getAuthDisplayType)
  let authLabel = '';
  try {
    if (cg?.authType) {
      const matched = findProviderByCredentials(cg.baseUrl, cg.apiKeyEnvKey);
      authLabel =
        (matched && resolveMetadataKey(matched) && matched.label) ||
        (cg.authType === 'qwen-oauth' ? 'Qwen OAuth' : 'API Key');
    }
  } catch {
    authLabel = '';
  }
  const authModelText = authLabel ? `${authLabel} | ${model}` : model;
  const hint = ' (/model to change)';

  // Responsive layout mirroring Header.tsx: two-column (ASCII logo + info
  // panel) when wide, single-column info panel when narrow. The outer
  // marginX=2 puts the border in the original's third column.
  const custom = resolveCustomBanner(settings);
  const containerMarginX = 2;
  const logoGap = 2;
  const infoPanelChromeWidth = 2 + 1 * 2; // border(2) + paddingX(1*2)
  const minInfoPanelWidth = 40 + infoPanelChromeWidth;
  const available = Math.max(0, width - containerMarginX * 2);
  // ink Header parity: a fitting custom tier wins; custom art that fits
  // nowhere hides the logo column (no silent fallback to the bundled logo —
  // that would undo a white-label deployment on narrow terminals); no
  // custom art falls through to the bundled shortAsciiLogo.
  const hasCustomArt = Boolean(custom.asciiArt.small || custom.asciiArt.large);
  const customTier = pickAsciiArtTier(
    custom.asciiArt.small,
    custom.asciiArt.large,
    available,
    logoGap,
    minInfoPanelWidth,
    getAsciiArtWidth,
  );
  const displayLogo = customTier ?? (hasCustomArt ? '' : shortAsciiLogo);
  const logoWidth = getAsciiArtWidth(displayLogo);
  const showLogo =
    displayLogo !== '' && available >= logoWidth + logoGap + minInfoPanelWidth;
  const maxInfoPanelWidth = 60;
  const infoPanelWidth = showLogo
    ? Math.min(available - logoWidth - logoGap, maxInfoPanelWidth)
    : available;
  const maxPathLength = Math.max(0, infoPanelWidth - infoPanelChromeWidth);
  const infoPanelContentWidth = Math.max(
    0,
    infoPanelWidth - infoPanelChromeWidth,
  );
  const showModelHint =
    infoPanelContentWidth > 0 &&
    getCachedStringWidth(authModelText + hint) <= infoPanelContentWidth;
  const shortenedPath = shortenPath(
    tildeifyPath(targetDir),
    Math.max(3, maxPathLength),
  );
  const displayPath =
    maxPathLength <= 0
      ? ''
      : shortenedPath.length > maxPathLength
        ? shortenedPath.slice(0, maxPathLength)
        : shortenedPath;

  const infoPanel = (
    <box
      flexDirection="column"
      borderStyle="single"
      paddingX={1}
      width={infoPanelWidth}
      flexGrow={showLogo ? 0 : 1}
    >
      <box flexDirection="row">
        <text fg={C.accent} attributes={1}>
          {custom.title ?? '>_ Qwen Code'}
        </text>
        <text fg={C.dim}>{` (${versionLabel})`}</text>
      </box>
      {/* Subtitle (when set) replaces the blank spacer row so the auth
       * line keeps its vertical position (ink Header parity). */}
      {custom.subtitle ? (
        <text fg={C.dim}>{custom.subtitle}</text>
      ) : (
        <text> </text>
      )}
      <box flexDirection="row">
        <text fg={C.dim}>{authModelText}</text>
        {showModelHint && <text fg={C.dim}>{hint}</text>}
      </box>
      <text fg={C.dim}>{displayPath}</text>
    </box>
  );

  if (!showLogo) {
    return (
      <box
        marginLeft={containerMarginX}
        marginRight={containerMarginX}
        flexShrink={0}
      >
        {infoPanel}
      </box>
    );
  }
  return (
    <box
      flexDirection="row"
      alignItems="center"
      marginLeft={containerMarginX}
      marginRight={containerMarginX}
      flexShrink={0}
    >
      <GradientLogo logo={displayLogo} />
      <box width={logoGap} />
      {infoPanel}
    </box>
  );
}

// Cap the confirmation body (diff/command/plan) so a long payload can't
// push the option list off-screen.
const CONFIRM_BODY_MAX_LINES = 12;

// Must exceed @opentui/core's CLICK_REPEAT_INTERVAL_MS (500ms) so a
// copy-triggered selection clear cannot split a double-click into a fresh
// click sequence (see copyActiveSelection).
const SELECTION_CLEAR_DELAY_MS = 600;

/**
 * Select a startup tip (ink Tips.pickStartupTip parity). Called once per
 * session via useMemo([]) — recordShown writes to disk.
 */
function pickStartupTip(): string {
  const history = getTipHistory();
  const context: TipContext = {
    lastPromptTokenCount: 0,
    contextWindowSize: 0,
    sessionPromptCount: 0,
    sessionCount: history.sessionCount,
    platform: process.platform,
  };
  const tip = selectTip('startup', context, tipRegistry, history);
  if (tip) {
    history.recordShown(tip.id, 0);
    return tip.content;
  }
  return 'Type / to see all available commands.';
}

/** ink Tips parity: marginX 2, secondary-colored "Tips: {tip}" line. */
function Tips() {
  const selectedTip = useMemo(() => pickStartupTip(), []);
  return (
    <box marginLeft={2} marginRight={2}>
      <text fg={C.dim}>{`Tips: ${selectedTip}`}</text>
    </box>
  );
}

/** ink StickyTodoList clampVisibleTodoCount parity. */
function clampVisibleTodoCount(value: number): number {
  if (!Number.isFinite(value)) {
    return STICKY_TODO_MAX_VISIBLE_ITEMS;
  }
  return Math.max(
    1,
    Math.min(STICKY_TODO_MAX_VISIBLE_ITEMS, Math.floor(value)),
  );
}

/** Ink StickyTodoList STATUS_ICONS (status column is width 2 here). */
const STICKY_TODO_ICONS = {
  pending: ICON.CIRCLE_EMPTY,
  in_progress: ICON.CIRCLE_LEFT_HALF,
  completed: ICON.CIRCLE_FILLED,
} as const;

/**
 * ink StickyTodoList parity: numbered open-todo panel above the composer.
 * C has no border token, so the round border takes the dim color (the ink
 * theme's border.default is a low-contrast gray in both default themes).
 */
const StickyTodoListOpInternal = ({
  todos,
  width,
  maxVisibleItems = STICKY_TODO_MAX_VISIBLE_ITEMS,
}: {
  todos: TodoItem[];
  width: number;
  maxVisibleItems?: number;
}) => {
  const orderedOpenTodos = getOrderedStickyTodos(todos).filter(
    (todo) => todo.status !== 'completed',
  );
  const todoNumberById = new Map(
    todos.map((todo, index) => [todo.id, `${index + 1}.`] as const),
  );

  if (orderedOpenTodos.length === 0) {
    return null;
  }

  const visibleTodoCount = clampVisibleTodoCount(maxVisibleItems);
  const visibleTodos = orderedOpenTodos.slice(0, visibleTodoCount);
  const hiddenTodoCount = orderedOpenTodos.length - visibleTodos.length;
  const numberColumnWidth =
    Math.max(
      ...visibleTodos.map(
        (todo, index) =>
          (todoNumberById.get(todo.id) ?? `${index + 1}.`).length,
      ),
    ) + 1;
  // 6 = 2 (status icon column) + 2 (border columns) + 2 (paddingX columns).
  const contentColumnWidth = Math.max(1, width - numberColumnWidth - 6);

  return (
    <box
      marginLeft={2}
      marginRight={2}
      width={width}
      flexDirection="column"
      borderStyle="rounded"
      borderColor={C.dim}
      paddingX={1}
    >
      <text fg={C.dim} attributes={1}>
        {'Current tasks'}
      </text>
      {visibleTodos.map((todo, index) => {
        const todoNumber = todoNumberById.get(todo.id) ?? `${index + 1}.`;
        const itemColor = todo.status === 'in_progress' ? C.green : C.text;
        return (
          <box key={todo.id} flexDirection="row" height={1}>
            <box width={numberColumnWidth}>
              <text fg={C.dim}>{todoNumber}</text>
            </box>
            <box width={2}>
              <text fg={itemColor}>{STICKY_TODO_ICONS[todo.status]}</text>
            </box>
            <box width={contentColumnWidth}>
              <text
                fg={itemColor}
                attributes={todo.status === 'completed' ? 128 : 0}
              >
                {truncateToWidth(todo.content, contentColumnWidth)}
              </text>
            </box>
          </box>
        );
      })}
      {hiddenTodoCount > 0 && (
        <box flexDirection="row" height={1}>
          <box width={numberColumnWidth} />
          <box width={2} />
          <box width={contentColumnWidth}>
            <text fg={C.dim}>{`... and ${hiddenTodoCount} more`}</text>
          </box>
        </box>
      )}
    </box>
  );
};

const StickyTodoListOp = memo(
  StickyTodoListOpInternal,
  (previousProps, nextProps) =>
    previousProps.width === nextProps.width &&
    previousProps.maxVisibleItems === nextProps.maxVisibleItems &&
    getStickyTodosRenderKey(previousProps.todos) ===
      getStickyTodosRenderKey(nextProps.todos),
);

// One rendered confirmation body line = a row of colored spans, so a dim
// line-number gutter can sit next to normally colored content.
type ConfirmBodyLine = DiffLine;

function App({
  events,
  config,
  settings: settingsProp,
  initialCapturedInput,
  remoteInputWatcher,
  extensionRefreshState,
}: {
  events?: AsyncIterable<OpenTuiStreamEvent>;
  config?: Config;
  settings?: LoadedSettings;
  /** Keystrokes captured during startup, injected into the composer. */
  initialCapturedInput?: string;
  remoteInputWatcher?: RemoteInputWatcher;
  /** Shared extension-refresh bus (ink extensionRefreshState parity). */
  extensionRefreshState?: ExtensionRefreshState;
}) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  // The directory this session operates on. `config.getTargetDir()` (not
  // `process.cwd()`) so worktree/--cd sessions show the right path.
  const targetDir = useMemo(
    () => config?.getTargetDir() ?? process.cwd(),
    [config],
  );
  // Cached git branch (useGitBranchName parity): reads .git directly with a
  // watcher + poll instead of a synchronous `git` subprocess on every render.
  const gitBranch = useGitBranchName(targetDir);
  const [items, setItems] = useState<LiveHistoryItem[]>([]);
  // Live pending command item (spinner rows): rendered after the transcript,
  // never committed to it (ink pendingHistoryItems parity, R1-20).
  const [pendingCommandItem, setPendingCommandItem] =
    useState<HistoryItemWithoutId | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [streaming, setStreaming] = useState(false);
  const [loadingPhrase, setLoadingPhrase] = useState(WITTY_LOADING_PHRASES[0]);
  // Live retry countdown: re-render every second while a retry item's delay
  // is still elapsing (ink startRetryCountdown parity).
  const activeRetryId = items.find(
    (it): it is LiveRetryItem =>
      it.kind === 'retry' && Date.now() - it.startedAt < it.delayMs,
  )?.id;
  const [, setRetryTick] = useState(0);
  useEffect(() => {
    if (!activeRetryId) return;
    const timer = setInterval(() => setRetryTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [activeRetryId]);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!streaming) return;
    setElapsed(0);
    setLoadingPhrase(
      WITTY_LOADING_PHRASES[
        Math.floor(Math.random() * WITTY_LOADING_PHRASES.length)
      ],
    );
    const tick = setInterval(() => setElapsed((s) => s + 1), 1000);
    const phrase = setInterval(
      () =>
        setLoadingPhrase(
          WITTY_LOADING_PHRASES[
            Math.floor(Math.random() * WITTY_LOADING_PHRASES.length)
          ],
        ),
      15000,
    );
    return () => {
      clearInterval(tick);
      clearInterval(phrase);
    };
  }, [streaming]);
  const [_toast, setToast] = useState<string | null>(null);
  const [, setThemeTick] = useState(0);
  const [dialog, setDialog] = useState<MountedDialog | null>(null);
  // Two-press exit confirmation (ink useDoublePress parity). The hint is the
  // footer warning shown while a confirmation window is armed.
  const [exitHint, setExitHint] = useState<string | null>(null);
  const exitGuardRef = useRef<ExitGuard | null>(null);
  if (!exitGuardRef.current) {
    exitGuardRef.current = createExitGuard({
      onWindowExpired: () => setExitHint(null),
    });
  }
  // Update-check notification surfaced in the footer (post-render prefetch
  // consumption surface; previously went nowhere in the OpenTUI tree).
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const [commands, setCommands] = useState<readonly SlashCommand[]>([]);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode | undefined>(
    () => config?.getApprovalMode(),
  );
  // Propagate the UI approval mode into the core config so the scheduler
  // actually honours it (YOLO/AUTO auto-execute; DEFAULT asks). Without this
  // the core kept the persisted mode and tools were skipped.
  useEffect(() => {
    if (!approvalMode || !config) return;
    try {
      (
        config as { setApprovalMode?: (m: ApprovalMode) => void }
      ).setApprovalMode?.(approvalMode);
    } catch {
      /* elevated-mode guard */
    }
  }, [approvalMode, config]);
  // A slash command is running (dispatcher.setIsProcessing parity); gates Esc
  // to dispatcher.cancel() and concurrent command submission.
  const [commandProcessing, setCommandProcessing] = useState(false);
  const commandProcessingRef = useRef(false);
  // Recency feed for /-completion ranking (dispatcher.recentCommandList,
  // copied on the processing=false edge after a command updates it).
  const [recentSlashCommands, setRecentSlashCommands] = useState<
    ReadonlyMap<string, RecentSlashCommand>
  >(() => new Map());

  // Folder-trust startup gate (#56): undecided workspaces show the trust
  // prompt before anything else (ink DialogManager priority parity). While
  // open it suppresses the composer, like ink's dialogsVisible.
  const [folderTrustGateOpen, setFolderTrustGateOpen] = useState(false);

  // The real settings stack, feeding the command services and the
  // settings/theme/permissions dialogs. The entry passes its loaded settings
  // through so window title / prefetches / dialogs share one instance; fall
  // back to loading here when the backend is mounted without them (demo).
  const settings = useMemo(
    () =>
      settingsProp ?? loadSettings(config?.getWorkingDir() ?? process.cwd()),
    [settingsProp, config],
  );

  // Theme resolution — the settings `ui.theme` face (ink parity):
  //  - QWEN_THEME=light|dark env override wins (opentui escape hatch for
  //    terminals where OSC 10/11 detection fails);
  //  - ui.theme = 'auto' → light/dark auto-adaptation (COLORFGBG → OSC 10/11
  //    probe → macOS appearance → dark) plus live `theme_mode` switching;
  //  - ui.theme = named/custom theme → that theme's mapped palette, fixed —
  //    no probing, no live switching (the ink behavior);
  //  - ui.theme unset → fixed dark (ink parity: the ThemeManager default is
  //    Qwen Dark and never probes), not the adaptive light/dark chain.
  const themeAutoRef = useRef(false);
  const applyThemePreference = useCallback(
    (themeName: string | undefined) => {
      const envTheme = process.env['QWEN_THEME'];
      if (envTheme === 'light' || envTheme === 'dark') {
        themeAutoRef.current = false;
        applyThemeMode(envTheme);
        setThemeTick((t) => t + 1);
        return;
      }
      if (themeName === AUTO_THEME_NAME) {
        themeAutoRef.current = true;
        void detectInitialThemeMode(renderer, 1000).then((mode) => {
          // A named-theme selection may have landed while the probe ran.
          if (!themeAutoRef.current) return;
          applyThemeMode(mode);
          setThemeTick((t) => t + 1);
        });
        return;
      }
      themeAutoRef.current = false;
      if (settings.merged.ui?.customThemes) {
        themeManager.loadCustomThemes(settings.merged.ui.customThemes);
      }
      // Unset and unknown names fall back to the manager's active theme —
      // Qwen Dark before anything else has set it (the ink default).
      if (themeName) {
        themeManager.setActiveTheme(themeName);
      }
      applyOpenTuiTheme(getActiveOpenTuiTheme());
      setThemeTick((t) => t + 1);
    },
    [renderer, settings],
  );

  // Live light/dark updates (OSC 10/11 + mode 2031) — only while the
  // adaptive strategy is active.
  useEffect(() => {
    const onMode = (mode: 'dark' | 'light') => {
      if (!themeAutoRef.current) return;
      applyThemeMode(mode);
      setThemeTick((t) => t + 1);
    };
    renderer.on('theme_mode', onMode);
    applyThemePreference(settings.merged.ui?.theme);
    return () => {
      renderer.off('theme_mode', onMode);
    };
  }, [renderer, settings, applyThemePreference]);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueRef = useRef<OpenTuiStreamEvent[]>([]);
  const liveAbortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const startLiveTurnRef = useRef<
    ((content: PartListUnion, opts?: object) => void) | null
  >(null);
  const submitTextRef = useRef<
    ((raw: string, imagePaths?: string[]) => void) | null
  >(null);
  const composerHandle = useRef<{
    getText: () => string;
    setText: (t: string) => void;
  } | null>(null);
  const queuedPromptsRef = useRef<string[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<string[]>([]);
  // Submissions made while a turn is in flight queue up (original
  // useMessageQueue semantics) instead of aborting the live stream.
  const enqueuePrompt = useCallback((t: string) => {
    queuedPromptsRef.current = [...queuedPromptsRef.current, t];
    setQueuedPrompts(queuedPromptsRef.current);
  }, []);
  const popAllQueued = useCallback((): string | null => {
    if (queuedPromptsRef.current.length === 0) return null;
    const all = queuedPromptsRef.current.join('\n\n');
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
    return all;
  }, []);
  const reverseSearchRef = useRef<number>(-1);
  const reverseQueryRef = useRef<string>('');
  // Tool approval dialog (ink ToolConfirmationMessage parity): body +
  // question + radio options resolving to a ToolConfirmationOutcome.
  const [confirmReq, setConfirmReq] = useState<{
    question: string;
    body: ConfirmBodyLine[];
    options: Array<{ label: string; outcome: ToolConfirmationOutcome }>;
    resolve: (outcome: ToolConfirmationOutcome) => void;
  } | null>(null);
  const [confirmSel, setConfirmSel] = useState(0);
  // Waiting (awaiting_approval) scheduler calls by callId — consumed by the
  // approval-mode switch auto-approve path (handleApprovalModeChange parity).
  const pendingApprovalsRef = useRef(new Map<string, WaitingCallInfo>());
  // callId owning the currently visible confirm/question dialog.
  const approvalDialogCallIdRef = useRef<string | null>(null);
  // ask_user_question dialog (scheduler awaiting_approval parity).
  const [questionReq, setQuestionReq] = useState<{
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect?: boolean;
    }>;
    resolve: (answers: Record<string, string> | null) => void;
  } | null>(null);
  const [qNav, setQNav] = useState({
    q: 0,
    opt: 0,
    other: false,
    otherText: '',
    multi: [] as number[],
  });
  const qAnswersRef = useRef<Record<string, string>>({});

  // Streaming phase for the status bar / spinner / border (F1.1).

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Copy the active selection and clear it (opencode Selection.copy parity;
  // shared by copy-on-select, ctrl+c and ctrl+y).
  // The clear is deferred past the framework's 500ms click-repeat window
  // (@opentui/core #1407): clearSelection() also resets the renderer's
  // multi-click counter, so clearing on release would break a double-click
  // -> triple-click sequence mid-stream. The isDragging guard leaves an
  // already-started next selection untouched when the timer fires.
  const copyActiveSelection = useCallback(async (): Promise<boolean> => {
    const text = renderer.getSelection()?.getSelectedText();
    if (!text) return false;
    const ok = await copyText(text);
    setToast(
      ok
        ? `✓ Copied ${text.length} chars to clipboard`
        : '⚠ Clipboard write failed',
    );
    setTimeout(() => setToast(null), 1500);
    setTimeout(() => {
      const selection = renderer.getSelection();
      if (selection && !selection.isDragging) renderer.clearSelection();
    }, SELECTION_CLEAR_DELAY_MS);
    return true;
  }, [renderer]);

  // copy-on-select: drag text, release → clipboard (like a native terminal).
  // Double/triple-click word/line selection is the framework's since
  // @opentui/core 0.5.7 (#1407): the renderer counts left presses itself and
  // passes word/line behavior into local selection, so release still copies
  // through the handler below.
  useSelectionHandler(async (selection) => {
    if (!selection.getSelectedText()) return;
    await copyActiveSelection();
  });

  const applyEvent = useCallback((ev: OpenTuiStreamEvent) => {
    setItems((prev) => foldLiveEvent(prev, ev));
    // NB: `done` fires once per model-stream segment — including segments that
    // end in a tool call while the turn is still running — so it must not
    // clear `streaming`; turn-level clears live in startLiveTurn's finally,
    // the scripted/resume drain, and the Esc/interrupt handlers.
  }, []);

  // Click-to-open links (audit gap #54): the framework renders markdown
  // links as `label (url)` text and never emits OSC 8, while `useMouse`
  // captures the pointer — so terminal-native cmd+click reaches US and we
  // open the URL under the cursor. SGR mouse reports no meta bit, hence a
  // plain left click on a URL cell triggers this; clicks elsewhere (and
  // clicks during an active drag-select) fall through untouched.
  const handleLinkClick = useCallback(
    (e: MouseEvent) => {
      if (e.button !== MouseButton.LEFT) return;
      if (renderer.getSelection()?.getSelectedText()) return;
      const row = readBufferRow(renderer.currentRenderBuffer, e.y);
      const hit = findUrlAtRow(row, e.x);
      if (!hit) return;
      void openBrowserSecurely(hit.url).catch(() => {
        applyEvent({
          type: 'text',
          delta: `Could not open link: ${hit.url}`,
        });
      });
    },
    [renderer, applyEvent],
  );

  // "Enter to steer": plain queued prompts leave the queue at the next tool
  // boundary and ride with the tool results as user content; slash entries
  // stay queued for turn-end routing through the command stack.
  const drainSteering = useCallback((): string[] => {
    const plain = queuedPromptsRef.current.filter(
      (t) => !isSlashCommandInput(t),
    );
    if (plain.length === 0) return [];
    queuedPromptsRef.current = queuedPromptsRef.current.filter((t) =>
      isSlashCommandInput(t),
    );
    setQueuedPrompts([...queuedPromptsRef.current]);
    for (const t of plain) applyEvent({ type: 'user', text: t });
    return plain;
  }, [applyEvent]);

  const startStream = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    queueRef.current = buildScenario();
    setStreaming(true);
    timerRef.current = setInterval(() => {
      const ev = queueRef.current.shift();
      if (!ev) return;
      applyEvent(ev);
    }, TOKEN_INTERVAL_MS);
  }, [applyEvent]);

  // ── real command stack (R2): dispatcher + host over the live history ────
  const streamingRef = useRef(false);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  // ── host-provided session surfaces (audit 01 G-10/G-12/G-21, 05 G-08) ──
  const sessionStartRef = useRef<Date>(new Date());
  const promptCountRef = useRef(0);
  const loggerRef = useRef<Logger | null>(null);
  const [sessionName, setSessionNameState] = useState<string | null>(null);
  const [debugMessage, setDebugMessageState] = useState<string | null>(null);
  const [mdFileCount, setMdFileCount] = useState(0);
  const [diskHistory, setDiskHistory] = useState<string[]>([]);
  // Real confirmation dialogs for confirm_action / confirm_shell_commands
  // command flows (/init overwrite, /cd untrusted dir, extension commands).
  const [actionConfirmReq, setActionConfirmReq] = useState<{
    prompt: string;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const [shellConfirmReq, setShellConfirmReq] = useState<{
    commands: string[];
    resolve: (resolution: ShellConfirmationResolution) => void;
  } | null>(null);
  const [shellConfirmSel, setShellConfirmSel] = useState(0);

  // Attention notifications (ink useAttentionNotifications parity):
  // waiting-for-approval and long-task-complete notifications fire only
  // when the terminal is unfocused, routed through the shared
  // sendNotification service. Focus comes from the renderer's native
  // FOCUS/BLUR events (mode 1004 enabled by the hook); a terminal without
  // focus reporting stays "focused" and notifications degrade to never
  // firing — the same degradation ink's useFocus has.
  const isFocused = useOpenTuiFocus(renderer);
  // Raw stdout writes for OSC notification sequences (ink AppContainer
  // parity — bypasses the render pipeline so binary sequences stay intact).
  const terminal = useMemo(
    () => buildTerminalNotification((data) => process.stdout.write(data)),
    [],
  );
  const streamingState =
    confirmReq || questionReq || actionConfirmReq || shellConfirmReq
      ? StreamingState.WaitingForConfirmation
      : streaming
        ? StreamingState.Responding
        : StreamingState.Idle;
  // Bridge the waiting scheduler calls into the shared hook's minimal
  // view. The ref is written before the confirm/question state updates, so
  // by the re-render it already reflects the new waiting set; the dialog
  // states are memo deps precisely to re-run on that re-render.
  const pendingToolCalls = useMemo(
    () => {
      const waiting = [...pendingApprovalsRef.current.values()];
      return waiting.length > 0
        ? waiting.map((call) => ({
            status: 'awaiting_approval',
            request: { name: call.name },
          }))
        : undefined;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dialog states are the re-render triggers for the ref read above
    [confirmReq, questionReq, actionConfirmReq, shellConfirmReq],
  );
  useAttentionNotifications({
    isFocused,
    streamingState,
    elapsedTime: elapsed,
    settings,
    config,
    terminal,
    pendingToolCalls,
  });

  // P-notif: terminal-bell when a workflow run finishes (completed /
  // failed), so a long run ending is noticed without watching the
  // /workflows dialog. User-initiated cancels are intentionally not
  // notified (the registry omits them). Ink AppContainer parity.
  const workflowBellEnabled =
    (settings.merged.general?.terminalBell as boolean) ?? true;
  useEffect(() => {
    const registry = config?.getWorkflowRunRegistry?.();
    // Optional call: production always has `setNotificationCallback`, but
    // partial registry mocks in tests may omit it — no-op rather than throw.
    if (!registry?.setNotificationCallback) return;
    registry.setNotificationCallback((entry) => {
      const name = entry.meta?.name ?? entry.runId;
      const verb = entry.status === 'failed' ? 'failed' : 'completed';
      sendNotification(
        { message: `Workflow '${name}' ${verb}`, title: 'Qwen Code' },
        terminal,
        workflowBellEnabled,
      );
    });
    return () => registry.setNotificationCallback(undefined);
  }, [config, terminal, workflowBellEnabled]);

  // OSC 9;4 tab-progress parity (ink useTerminalProgress): an indeterminate
  // spinner while tools execute, cleared on idle and on process exit.
  const hasExecutingTool = items.some((it) => it.kind === 'tool' && !it.done);
  useEffect(() => {
    if (!isProgressBarSupported()) return;
    const write = (seq: string) => {
      try {
        process.stdout.write(seq);
      } catch {
        // Best-effort (EPIPE during teardown).
      }
    };
    if (streamingState === StreamingState.Responding && hasExecutingTool) {
      write(TERMINAL_PROGRESS_SEQUENCES.indeterminate);
    } else if (streamingState === StreamingState.Idle) {
      write(TERMINAL_PROGRESS_SEQUENCES.clear);
    }
  }, [streamingState, hasExecutingTool]);
  useEffect(() => {
    if (!isProgressBarSupported()) return;
    const clearOnExit = () => {
      try {
        process.stdout.write(TERMINAL_PROGRESS_SEQUENCES.clear);
      } catch {
        // Exit-time best effort.
      }
    };
    process.on('exit', clearOnExit);
    return () => {
      process.removeListener('exit', clearOnExit);
    };
  }, []);

  // Disk-backed input history (ink AppContainer getPreviousUserMessages):
  // one Logger per live config, merged with the current session below.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    const logger = new Logger(config.getSessionId(), config.storage);
    void logger
      .initialize()
      .then(() => {
        if (cancelled) return;
        loggerRef.current = logger;
        return logger.getPreviousUserMessages();
      })
      .then((messages) => {
        if (!cancelled && messages) setDiskHistory(messages);
      })
      .catch(() => {
        /* no project log yet */
      });
    return () => {
      cancelled = true;
    };
  }, [config]);

  const dispatcherRef = useRef<OpenTuiSlashDispatcher | null>(null);
  const gatewayRef = useRef<OpenTuiSlashGateway | null>(null);
  if (!gatewayRef.current) gatewayRef.current = new OpenTuiSlashGateway();
  const gateway = gatewayRef.current;
  const host = useMemo(
    () =>
      createBackendCommandHost(
        {
          applyEvent,
          clearItems: () => setItems([]),
          isIdle: () => !streamingRef.current,
          setProcessing: (processing) => {
            commandProcessingRef.current = processing;
            setCommandProcessing(processing);
            // The dispatcher records recency before executing, so the
            // false edge always observes the updated map.
            if (!processing) {
              setRecentSlashCommands(
                new Map(dispatcherRef.current?.recentCommandList ?? []),
              );
            }
          },
          reloadCommands: () =>
            void dispatcherRef.current
              ?.loadCommands()
              .then(() => setCommands(dispatcherRef.current?.commands ?? [])),
          // Single-commit transcript replacement (resume/branch UI swap).
          resetTranscript: (events) =>
            setItems(
              events.reduce<LiveHistoryItem[]>(
                (acc, ev) => foldLiveEvent(acc, ev),
                [],
              ),
            ),
          startNewSession: () => {
            sessionStartRef.current = new Date();
            promptCountRef.current = 0;
            setSessionNameState(null);
            setDebugMessageState(null);
          },
          setSessionName: (name) => setSessionNameState(name),
          setDebugMessage: (message) => setDebugMessageState(message || null),
          setPendingItem: (item) => setPendingCommandItem(item),
          setGeminiMdFileCount: (count) => setMdFileCount(count),
          getSessionStats: () => ({
            sessionId: config?.getSessionId?.() ?? '',
            sessionStartTime: sessionStartRef.current,
            metrics: uiTelemetryService.getMetrics(),
            lastPromptTokenCount: uiTelemetryService.getLastPromptTokenCount(),
            promptCount: promptCountRef.current,
          }),
          presentShellConfirmation: (commands) =>
            new Promise<ShellConfirmationResolution>((resolve) => {
              setShellConfirmSel(0);
              setShellConfirmReq({ commands: [...commands], resolve });
            }),
          presentActionConfirmation: (promptText) =>
            new Promise<boolean>((resolve) => {
              setActionConfirmReq({ prompt: promptText, resolve });
            }),
        },
        { config: config ?? null, settings },
      ),
    [applyEvent, config, settings],
  );

  // Pending command item as a render-only history row: projected and folded
  // into the same shape the transcript renders, but appended at render time
  // so spinner ticks never commit to the transcript (ink pendingHistoryItems
  // parity, R1-20).
  const pendingLiveItem = useMemo<LiveHistoryItem | null>(() => {
    if (!pendingCommandItem) return null;
    const ev = projectCommandItem(pendingCommandItem, {
      config: config ?? null,
      settings,
    });
    if (!ev) return null;
    return foldLiveEvent([], ev)[0] ?? null;
  }, [pendingCommandItem, config, settings]);

  useEffect(() => {
    let cancelled = false;
    createOpenTuiSlashDispatcher(host, {
      config: config ?? null,
      settings,
      // Shared extension-refresh bus (startInteractiveUI options): the
      // dispatcher subscribes so /reload-plugins and disk-driven reload
      // notices reach the same instance the extension file watcher uses.
      extensionRefreshState,
      // Real logger once initialized (cross-session prompt history).
      get logger() {
        return loggerRef.current;
      },
    })
      .then((dispatcher) => {
        if (cancelled) {
          // Cleanup already ran: detach the just-created dispatcher so its
          // extension-refresh subscriptions don't outlive the effect.
          dispatcher.dispose();
          return;
        }
        dispatcherRef.current = dispatcher;
        gateway.attach(dispatcher);
        setCommands(dispatcher.commands);
      })
      .catch((err) => {
        if (cancelled) return;
        // Surface the failure (and let the gateway reject later slash input)
        // instead of letting '/help' fall through to the model.
        gateway.failInit(err);
        applyEvent({
          type: 'text',
          delta: `[command stack] initialization failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        applyEvent({ type: 'done' });
      });
    return () => {
      cancelled = true;
      dispatcherRef.current?.dispose();
    };
  }, [host, config, settings, gateway, applyEvent, extensionRefreshState]);

  // Real event source (P1d seam) if provided; scripted demo only when there is
  // no live config (qwen2-demo). With a live config, replay the resumed
  // session (--resume / --continue) through resume-session and then wait for
  // real input so qwen2 behaves like the real interactive CLI.
  useEffect(() => {
    if (config && !events) {
      const replay = resumeEventsFromConfig(config);
      if (replay && replay.length > 0) {
        // --resume/--continue (audit 05 G-01): fold the whole transcript in
        // ONE commit. Bursting hundreds of setItems inside the mount effect
        // dropped every item on the concurrent root; the demo/live paths
        // deliver across frames/ticks and were never affected.
        setItems(
          replay.reduce<LiveHistoryItem[]>(
            (acc, ev) => foldLiveEvent(acc, ev),
            [],
          ),
        );
        setStreaming(false);
      }
      return; // live mode: wait for user input
    }
    setItems(
      foldLiveEvent([], {
        type: 'user',
        text: '分析 VP 模式的渲染性能问题，给出优化建议',
      }),
    );
    if (events) {
      let cancelled = false;
      (async () => {
        for await (const ev of events) {
          if (cancelled) break;
          applyEvent(ev);
        }
        if (!cancelled) {
          setStreaming(false);
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    const t = setTimeout(startStream, 400);
    return () => {
      clearTimeout(t);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [events, config, startStream, applyEvent]);

  // -i/--prompt-interactive (AppContainer initialPrompt parity, simplified):
  // with a question and a live config, auto-submit once after the first
  // frame through the normal submit pipeline.
  const initialPromptSubmittedRef = useRef(false);
  useEffect(() => {
    if (!config || initialPromptSubmittedRef.current) return;
    const question = config.getQuestion();
    if (!question) return;
    initialPromptSubmittedRef.current = true;
    const t = setTimeout(() => submitTextRef.current?.(question), 0);
    return () => clearTimeout(t);
  }, [config]);

  // Early-input injection (startInteractiveUI initialCapturedInput parity):
  // keystrokes captured during startup are placed into the composer once it
  // attaches, instead of being dropped on the floor.
  useEffect(() => {
    if (!initialCapturedInput) return;
    return injectCapturedInput(
      () => composerHandle.current,
      initialCapturedInput,
    );
  }, [initialCapturedInput]);

  // Update-check notification consumption surface (post-render prefetch
  // parity): surface startup update notices in the footer. Notices arriving
  // mid-turn are deferred and flushed when the turn settles.
  const updateIsIdleRef = useRef({ current: true });
  const updateHandleRef = useRef<UpdateNotificationHandle | null>(null);
  useEffect(() => {
    const handle = setupUpdateNotifications((item) => {
      const text = 'text' in item ? String(item.text) : '';
      if (text) setUpdateNotice(text);
    }, updateIsIdleRef.current);
    updateHandleRef.current = handle;
    return () => {
      handle.dispose();
      updateHandleRef.current = null;
    };
  }, []);
  useEffect(() => {
    const idle = !(streaming || commandProcessing);
    updateIsIdleRef.current.current = idle;
    if (idle) updateHandleRef.current?.flush();
  }, [streaming, commandProcessing]);

  // Dispose the exit-guard timer on unmount.
  useEffect(() => () => exitGuardRef.current?.dispose(), []);

  // Approval-mode switch (Shift+Tab / dialog): cycling includes PLAN (core
  // approval-mode.ts order), and switching into YOLO/AUTO_EDIT auto-confirms
  // still-waiting calls with ProceedOnce (useGeminiStream
  // handleApprovalModeChange parity).
  const switchApprovalMode = (next: ApprovalMode) => {
    setApprovalMode(next);
    const approved = selectAutoApprovals(next, [
      ...pendingApprovalsRef.current.values(),
    ]);
    if (approved.length === 0) return;
    let dialogOwnerApproved = false;
    for (const call of approved) {
      pendingApprovalsRef.current.delete(call.callId);
      if (approvalDialogCallIdRef.current === call.callId) {
        dialogOwnerApproved = true;
      }
      void call.confirmationDetails
        .onConfirm(ToolConfirmationOutcome.ProceedOnce)
        .catch(() => {});
    }
    if (dialogOwnerApproved) {
      approvalDialogCallIdRef.current = null;
      setConfirmReq(null);
      setQuestionReq(null);
      // Pop the next queued call the mode switch left un-approved.
      const next = pendingApprovalsRef.current.keys().next();
      if (!next.done) presentApprovalDialogRef.current(next.value);
    }
  };

  // Graceful quit: abort any in-flight turn, signal the client to skip
  // background memory work, then drain the shared exit-cleanup chain (chat
  // recording flush, config.shutdown(), usage persist, farewell echo) before
  // exiting. Replaces the old `renderer.destroy()+process.exit(0)` shortcut
  // that skipped every cleanup step.
  const quitOpenTui = useCallback(
    (code: number) => {
      liveAbortRef.current?.abort();
      liveAbortRef.current = null;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      try {
        config?.getGeminiClient()?.requestShutdown();
      } catch {
        // Best-effort: shutting down the client must not block exit.
      }
      void exitSession(code);
    },
    [config],
  );

  // Two-press exit guard (ink handleExit parity). The first press closes an
  // open dialog, cancels an in-flight turn, or clears input; only a bare idle
  // prompt arms the confirmation window. A second press inside the window
  // quits through the cleanup drain. Ctrl+D with content is a no-op (ink).
  const handleExitGuardKey = (exitKey: 'ctrl-c' | 'ctrl-d') => {
    const composerText = composerHandle.current?.getText() ?? '';
    // ink Ctrl+D parity: a non-empty buffer is a hard no-op, checked before
    // anything else — it never closes a dialog, cancels a stream, or exits,
    // so unsent input is never destroyed by a stray Ctrl+D.
    if (exitKey === 'ctrl-d' && composerText.length > 0) {
      return;
    }
    if (questionReq) {
      qAnswersRef.current = {};
      setQuestionReq(null);
      questionReq.resolve(null);
      return;
    }
    if (confirmReq) {
      // Clear the dialog state before resolving: the resolve chain may pop
      // the next queued approval (R1-15) and its setConfirmReq must win over
      // this null in the batch.
      setConfirmReq(null);
      confirmReq.resolve(ToolConfirmationOutcome.Cancel);
      return;
    }
    if (dialog) {
      setDialog(null);
      return;
    }
    if (streamingRef.current || commandProcessingRef.current) {
      // Cancel the in-flight work first; the next press can then arm exit.
      if (commandProcessingRef.current) {
        gateway.cancel();
      } else {
        // Abort WITHOUT dropping the ref: the turn's finally owns the
        // cleanup (ownership guard, R1-17) — nulling here would orphan it,
        // leaving stale pending approvals and an undrained prompt queue.
        liveAbortRef.current?.abort();
        setItems((prev) => settleOpenTools(prev, 'interrupted'));
        setStreaming(false);
      }
      return;
    }
    if (exitKey === 'ctrl-c' && composerText.length > 0) {
      // Clear the buffer first (CLEAR_INPUT parity); exit needs a bare prompt.
      composerHandle.current?.setText('');
      return;
    }
    const guard = exitGuardRef.current;
    if (!guard) return;
    if (guard.press(exitKey) === 'exit') {
      setExitHint(null);
      quitOpenTui(EXIT_CODE_INTERRUPT);
      return;
    }
    setExitHint(exitGuardHint(exitKey));
  };

  // Bracketed pastes for the ask-user "Other" free-text field. The composer's
  // own paste handler bails while a dialog owns input, so without this the
  // pasted bytes reach no one (ink parity: its paste key inserts verbatim).
  usePaste((event: PasteEvent) => {
    if (!questionReq || !qNav.other) return;
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (!text) return;
    event.preventDefault();
    setQNav((n) => ({ ...n, otherText: n.otherText + text }));
  });

  useKeyboard((key) => {
    // Selection keys win ahead of normal bindings (opencode keymap.intercept
    // parity): escape dismisses a selection, ctrl+c copies it instead of
    // interrupting, ctrl+y copies explicitly and otherwise falls through.
    if (key.name === 'escape' && renderer.getSelection()) {
      renderer.clearSelection();
      return;
    }
    if (key.name === 'c' && key.ctrl) {
      if (renderer.getSelection()?.getSelectedText()) {
        void copyActiveSelection();
        return;
      }
      // A selection without text is dismissed, then ctrl+c keeps its normal
      // interrupt/exit meaning.
      if (renderer.getSelection()) renderer.clearSelection();
      handleExitGuardKey('ctrl-c');
      return;
    }
    if (key.name === 'y' && key.ctrl) {
      if (renderer.getSelection()?.getSelectedText()) {
        void copyActiveSelection();
        return;
      }
    }
    if (key.name === 'd' && key.ctrl) {
      handleExitGuardKey('ctrl-d');
      return;
    }
    if (questionReq) {
      const q = questionReq.questions[qNav.q];
      const optCount = (q?.options.length ?? 0) + 1; // + "Other"
      const submitAnswer = (answer: string) => {
        const answers = { ...qAnswersRef.current, [String(qNav.q)]: answer };
        if (qNav.q + 1 < questionReq.questions.length) {
          qAnswersRef.current = answers;
          setQNav({
            q: qNav.q + 1,
            opt: 0,
            other: false,
            otherText: '',
            multi: [],
          });
        } else {
          qAnswersRef.current = {};
          setQuestionReq(null);
          questionReq.resolve(answers);
        }
      };
      if (qNav.other) {
        if (key.name === 'escape') {
          setQNav((n) => ({ ...n, other: false }));
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          const answer = qNav.otherText.trim();
          if (answer) submitAnswer(answer);
          return;
        }
        if (key.name === 'backspace' || key.name === 'delete') {
          setQNav((n) => ({ ...n, otherText: n.otherText.slice(0, -1) }));
          return;
        }
        if (isPrintableKeyInput(key)) {
          setQNav((n) => ({ ...n, otherText: n.otherText + key.sequence }));
        }
        return;
      }
      if (key.name === 'up') {
        setQNav((n) => ({ ...n, opt: (n.opt + optCount - 1) % optCount }));
        return;
      }
      if (key.name === 'down') {
        setQNav((n) => ({ ...n, opt: (n.opt + 1) % optCount }));
        return;
      }
      if (key.name === 'escape') {
        qAnswersRef.current = {};
        setQuestionReq(null);
        questionReq.resolve(null);
        return;
      }
      if (key.name === 'space' && q?.multiSelect && qNav.opt < optCount - 1) {
        setQNav((n) => ({
          ...n,
          multi: n.multi.includes(n.opt)
            ? n.multi.filter((i) => i !== n.opt)
            : [...n.multi, n.opt],
        }));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (qNav.opt === optCount - 1) {
          setQNav((n) => ({ ...n, other: true, otherText: '' }));
          return;
        }
        if (q?.multiSelect) {
          submitAnswer(
            [...new Set([...qNav.multi, qNav.opt])]
              .sort((a, b) => a - b)
              .map((i) => q.options[i]?.label ?? '')
              .join(', '),
          );
        } else {
          submitAnswer(q?.options[qNav.opt]?.label ?? '');
        }
        return;
      }
      return; // dialog open: swallow everything else
    }
    if (confirmReq) {
      // Original RadioButtonSelect parity: ↑↓ + Enter + digit keys select
      // directly; y/n/esc kept as shortcuts from the old bare y/n prompt.
      const opts = confirmReq.options;
      const resolveWith = (outcome: ToolConfirmationOutcome) => {
        // Clear before resolving so a queued approval popped by the settle
        // chain (R1-15) is not overwritten by this null in the batch.
        setConfirmReq(null);
        confirmReq.resolve(outcome);
      };
      if (key.name === 'up') {
        setConfirmSel((s) => (s + opts.length - 1) % opts.length);
      } else if (key.name === 'down') {
        setConfirmSel((s) => (s + 1) % opts.length);
      } else if (key.name === 'return' || key.name === 'enter') {
        const opt = opts[confirmSel] ?? opts[0];
        if (opt) resolveWith(opt.outcome);
      } else if (key.name && /^[1-9]$/.test(key.name)) {
        const opt = opts[parseInt(key.name, 10) - 1];
        if (opt) resolveWith(opt.outcome);
      } else if (key.name === 'y') {
        const allow = opts.find(
          (o) => o.outcome !== ToolConfirmationOutcome.Cancel,
        );
        if (allow) resolveWith(allow.outcome);
      } else if (key.name === 'n' || key.name === 'escape') {
        resolveWith(ToolConfirmationOutcome.Cancel);
      }
      return;
    }
    if (actionConfirmReq) {
      // confirm_action parity (ConsentPrompt): Yes / No.
      if (key.name === 'y') {
        actionConfirmReq.resolve(true);
        setActionConfirmReq(null);
      } else if (key.name === 'n' || key.name === 'escape') {
        actionConfirmReq.resolve(false);
        setActionConfirmReq(null);
      }
      return;
    }
    if (shellConfirmReq) {
      // confirm_shell_commands parity (ShellConfirmationDialog): once /
      // always / cancel. y/a/n shortcuts + ↑↓ and Enter.
      const options = [
        ToolConfirmationOutcome.ProceedOnce,
        ToolConfirmationOutcome.ProceedAlways,
        ToolConfirmationOutcome.Cancel,
      ];
      const resolveWith = (outcome: ToolConfirmationOutcome) => {
        shellConfirmReq.resolve(
          outcome === ToolConfirmationOutcome.Cancel
            ? { outcome }
            : { outcome, approvedCommands: shellConfirmReq.commands },
        );
        setShellConfirmReq(null);
      };
      if (key.name === 'y') {
        resolveWith(ToolConfirmationOutcome.ProceedOnce);
        return;
      }
      if (key.name === 'a') {
        resolveWith(ToolConfirmationOutcome.ProceedAlways);
        return;
      }
      if (key.name === 'n' || key.name === 'escape') {
        resolveWith(ToolConfirmationOutcome.Cancel);
        return;
      }
      if (key.name === 'up') {
        setShellConfirmSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.name === 'down') {
        setShellConfirmSel((s) => Math.min(options.length - 1, s + 1));
        return;
      }
      if (key.name === 'return') {
        resolveWith(options[shellConfirmSel] ?? ToolConfirmationOutcome.Cancel);
      }
      return;
    }
    if (key.name === 'l' && key.ctrl) {
      // clear transcript (mirrors original Ctrl+L)
      setItems([]);
      return;
    }
    if (key.name === 'r' && key.ctrl) {
      // incremental reverse search over submitted prompts -> composer
      if (reverseSearchRef.current === -1)
        reverseQueryRef.current = (
          composerHandle.current?.getText() ?? ''
        ).trim();
      const q = reverseQueryRef.current;
      const start =
        reverseSearchRef.current === -1
          ? userPrompts.length - 1
          : reverseSearchRef.current - 1;
      for (let i = start; i >= 0; i--) {
        if (!q || (userPrompts[i] ?? '').includes(q)) {
          composerHandle.current?.setText(userPrompts[i] ?? '');
          reverseSearchRef.current = i;
          break;
        }
      }
      return;
    }
    if (key.name === 'q' && key.ctrl) {
      // queue the current composer text for after the in-flight turn
      const t = (composerHandle.current?.getText() ?? '').trim();
      if (t) {
        enqueuePrompt(t);
        composerHandle.current?.setText('');
        setToast(`⏸ queued: ${t.slice(0, 24)}`);
        setTimeout(() => setToast(null), 1200);
      }
      return;
    }
    if (key.name === 'y' && key.ctrl) {
      // ink parity: during a rate-limit countdown, Ctrl+Y skips the delay so
      // the in-flight generator retries immediately (retryLastPrompt's
      // skipRetryDelay branch) — no abort/re-submit needed.
      const activeRetry = [...items]
        .reverse()
        .find(
          (it): it is LiveRetryItem =>
            it.kind === 'retry' && Date.now() - it.startedAt < it.delayMs,
        );
      if (activeRetry) {
        activeRetry.skipDelay?.();
        setItems((prev) =>
          foldLiveEvent(prev, { type: 'retry-countdown-clear' }),
        );
        return;
      }
      // retry last user prompt (mirrors original Ctrl+Y)
      const lastUser = [...items].reverse().find((i) => i.kind === 'user');
      if (lastUser && lastUser.kind === 'user')
        startLiveTurnRef.current?.(lastUser.text);
      return;
    }
    {
      const sb = scrollRef.current;
      if (sb) {
        if (key.name === 'up' && key.shift) {
          sb.scrollBy(-1);
          return;
        }
        if (key.name === 'down' && key.shift) {
          sb.scrollBy(1);
          return;
        }
        if (key.name === 'pageup') {
          sb.scrollBy(-10);
          return;
        }
        if (key.name === 'pagedown') {
          sb.scrollBy(10);
          return;
        }
        if (key.name === 'home' && key.ctrl) {
          sb.scrollTop = 0;
          return;
        }
        if (key.name === 'end' && key.ctrl) {
          sb.scrollBy(100000);
          return;
        }
      }
    }
    if (key.name === 'o' && key.ctrl) {
      // toggle the most recent expandable item (thinking/tool/task)
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (
          it.kind === 'thinking' ||
          it.kind === 'tool' ||
          it.kind === 'task'
        ) {
          toggle(it.id);
          break;
        }
      }
      return;
    }
    if (key.name === 't' && (key.ctrl || key.meta)) {
      // Ctrl+T tool descriptions / Alt+T thinking: toggle last tool or thinking
      const wantTool = key.ctrl;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (wantTool ? it.kind === 'tool' : it.kind === 'thinking') {
          toggle(it.id);
          break;
        }
      }
      return;
    }
    if (key.name === 'tab' && key.shift) {
      // cycle approval mode (mirrors original Shift+Tab; includes PLAN)
      switchApprovalMode(nextApprovalMode(approvalMode));
      return;
    }
    if (key.name === 'escape' && streaming) {
      // interrupt: abort the live stream (AbortSignal into sendMessageStream)
      // and stop the scripted demo timer. The ref stays: the turn's finally
      // owns the rest of the cleanup (ownership guard, R1-17).
      liveAbortRef.current?.abort();
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      queueRef.current = [];
      setItems((prev) => settleOpenTools(prev, 'interrupted'));
      setStreaming(false);
      setToast('✗ Interrupted');
      setTimeout(() => setToast(null), 1200);
    }
  });

  // Cross-session input history (ink AppContainer getPreviousUserMessages):
  // current-session prompts (newest first) + disk history (newest first),
  // deduped newest-wins, then flipped oldest-first for the ↑/Ctrl+R walk.
  const userPrompts = useMemo(() => {
    const current = items
      .filter((i) => i.kind === 'user')
      .map((i) => (i.kind === 'user' ? i.text : ''));
    const combined = [...[...current].reverse(), ...diskHistory];
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const message of combined) {
      if (!message || seen.has(message)) continue;
      seen.add(message);
      deduped.push(message);
    }
    return deduped.reverse();
  }, [items, diskHistory]);

  // ink ToolConfirmationMessage parity: per-type question + body + radio
  // options ("Yes, allow once" / "Always allow ..." / "No, suggest changes
  // (esc)") instead of the old bare y/n prompt.
  const buildToolConfirmDialog = useCallback(
    (
      details: ToolCallConfirmationDetails,
    ): {
      question: string;
      body: ConfirmBodyLine[];
      options: Array<{ label: string; outcome: ToolConfirmationOutcome }>;
    } => {
      const showAlways =
        (config?.isTrustedFolder() ?? false) &&
        !('hideAlwaysAllow' in details && details.hideAlwaysAllow === true);
      const plainLines = (text: string, color: string): ConfirmBodyLine[] =>
        text.split('\n').map((line) => [{ text: line, color }]);
      const blankLine = (): ConfirmBodyLine => [{ text: ' ', color: C.dim }];
      const capBody = (lines: ConfirmBodyLine[]): ConfirmBodyLine[] =>
        lines.length > CONFIRM_BODY_MAX_LINES
          ? [
              ...lines.slice(0, CONFIRM_BODY_MAX_LINES),
              [
                {
                  text: `… ${lines.length - CONFIRM_BODY_MAX_LINES} more lines`,
                  color: C.dim,
                },
              ],
            ]
          : lines;
      const alwaysOptions = showAlways
        ? [
            {
              label: 'Always allow in this project',
              outcome: ToolConfirmationOutcome.ProceedAlwaysProject,
            },
            {
              label: 'Always allow for this user',
              outcome: ToolConfirmationOutcome.ProceedAlwaysUser,
            },
          ]
        : [];
      const options: Array<{
        label: string;
        outcome: ToolConfirmationOutcome;
      }> = [];
      let question: string;
      let body: ConfirmBodyLine[];
      let cancelLabel = 'No, suggest changes (esc)';
      switch (details.type) {
        case 'edit': {
          question = 'Apply this change?';
          // ink parity: warnings above the diff; the file name already shows
          // in the tool-call header, so the body is the diff itself.
          const warnings = details.warnings ?? [];
          body = warnings.map((warning) => [
            { text: `⚠ ${warning}`, color: C.yellow },
          ]);
          if (warnings.length > 0) body.push(blankLine());
          body.push(...capBody(renderDiffBody(details.fileDiff)));
          options.push({
            label: 'Yes, allow once',
            outcome: ToolConfirmationOutcome.ProceedOnce,
          });
          if (showAlways)
            options.push({
              label: 'Yes, allow always',
              outcome: ToolConfirmationOutcome.ProceedAlways,
            });
          break;
        }
        case 'exec': {
          question = `Allow execution of: '${details.rootCommand}'?`;
          body = capBody(plainLines(details.command, C.purple));
          const warnings = details.warnings ?? [];
          if (warnings.length > 0) {
            body.push(blankLine());
            for (const warning of warnings)
              body.push([{ text: `⚠ ${warning}`, color: C.yellow }]);
          }
          options.push(
            {
              label: 'Yes, allow once',
              outcome: ToolConfirmationOutcome.ProceedOnce,
            },
            ...alwaysOptions,
          );
          break;
        }
        case 'info': {
          question = 'Do you want to proceed?';
          body = capBody(plainLines(details.prompt, C.purple));
          const urls = details.urls ?? [];
          if (
            urls.length > 0 &&
            !(urls.length === 1 && urls[0] === details.prompt)
          ) {
            body.push([{ text: 'URLs to fetch:', color: C.text }]);
            for (const url of urls)
              body.push([{ text: ` - ${url}`, color: C.purple }]);
          }
          options.push(
            {
              label: 'Yes, allow once',
              outcome: ToolConfirmationOutcome.ProceedOnce,
            },
            ...alwaysOptions,
          );
          break;
        }
        case 'mcp':
          question = `Allow execution of MCP tool "${details.toolName}" from server "${details.serverName}"?`;
          body = [
            [{ text: `MCP Server: ${details.serverName}`, color: C.purple }],
            [{ text: `Tool: ${details.toolName}`, color: C.purple }],
          ];
          options.push(
            {
              label: 'Yes, allow once',
              outcome: ToolConfirmationOutcome.ProceedOnce,
            },
            ...alwaysOptions,
          );
          break;
        case 'plan':
          question = details.title;
          body = capBody(plainLines(details.plan, C.text));
          cancelLabel = 'No, keep planning (esc)';
          options.push(
            {
              label: `Yes, restore previous mode (${details.prePlanMode ?? 'default'})`,
              outcome: ToolConfirmationOutcome.RestorePrevious,
            },
            {
              label: 'Yes, and auto-accept edits',
              outcome: ToolConfirmationOutcome.ProceedAlways,
            },
            {
              label: 'Yes, and manually approve edits',
              outcome: ToolConfirmationOutcome.ProceedOnce,
            },
          );
          break;
        default:
          // ask_user_question renders as the question dialog upstream of
          // this builder; anything unexpected gets a bare allow/deny.
          question = details.title || 'Do you want to proceed?';
          body = [];
          options.push({
            label: 'Yes, allow once',
            outcome: ToolConfirmationOutcome.ProceedOnce,
          });
      }
      options.push({
        label: cancelLabel,
        outcome: ToolConfirmationOutcome.Cancel,
      });
      // Auto Mode classifier-unavailable fallback (ink parity): warning
      // banner above the body + a "switch to Default" option inserted just
      // before Cancel.
      if (details.autoModeFallback) {
        body = [
          [{ text: `⚠ ${details.autoModeFallback.message}`, color: C.yellow }],
          blankLine(),
          ...body,
        ];
        const cancelIndex = options.findIndex(
          (o) => o.outcome === ToolConfirmationOutcome.Cancel,
        );
        options.splice(cancelIndex === -1 ? options.length : cancelIndex, 0, {
          label: 'Switch to Default Mode and allow once (recommended)',
          outcome: ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
        });
      }
      return { question, body, options };
    },
    [config],
  );

  // One confirm/question dialog at a time (R1-15): a scheduling pass can
  // park several calls in awaiting_approval; extras queue in
  // pendingApprovalsRef and each settled dialog pops the next one instead of
  // overwriting the open dialog (stranding its resolve).
  const presentApprovalDialogRef = useRef<(callId: string) => void>(() => {});
  const presentApprovalDialog = useCallback(
    (callId: string) => {
      const waiting = pendingApprovalsRef.current.get(callId);
      if (!waiting) return;
      const { confirmationDetails } = waiting;
      const settleWaitingCall = () => {
        pendingApprovalsRef.current.delete(callId);
        if (approvalDialogCallIdRef.current === callId) {
          approvalDialogCallIdRef.current = null;
          const next = pendingApprovalsRef.current.keys().next();
          if (!next.done) presentApprovalDialogRef.current(next.value);
        }
      };
      approvalDialogCallIdRef.current = callId;
      if (confirmationDetails.type === 'ask_user_question') {
        const details = confirmationDetails;
        qAnswersRef.current = {};
        setQNav({
          q: 0,
          opt: 0,
          other: false,
          otherText: '',
          multi: [],
        });
        setQuestionReq({
          questions: details.questions,
          resolve: (answers) => {
            settleWaitingCall();
            void details.onConfirm(
              answers
                ? ToolConfirmationOutcome.ProceedOnce
                : ToolConfirmationOutcome.Cancel,
              answers ? { answers } : undefined,
            );
          },
        });
      } else {
        setConfirmSel(0);
        setConfirmReq({
          ...buildToolConfirmDialog(confirmationDetails),
          resolve: (outcome) => {
            settleWaitingCall();
            void confirmationDetails.onConfirm(outcome);
          },
        });
      }
    },
    [buildToolConfirmDialog],
  );
  presentApprovalDialogRef.current = presentApprovalDialog;

  // Scheduler awaiting_approval parity, shared by the live turn and the
  // client-initiated command tools (/restore, /setup-github).
  const handleSchedulerWaitingCall = useCallback(
    (call: {
      name: string;
      confirmationDetails: ToolCallConfirmationDetails;
    }) => {
      const { confirmationDetails } = call;
      if (confirmationDetails.type === 'ask_user_question') {
        const details = confirmationDetails;
        qAnswersRef.current = {};
        setQNav({
          q: 0,
          opt: 0,
          other: false,
          otherText: '',
          multi: [],
        });
        setQuestionReq({
          questions: details.questions,
          resolve: (answers) => {
            void details.onConfirm(
              answers
                ? ToolConfirmationOutcome.ProceedOnce
                : ToolConfirmationOutcome.Cancel,
              answers ? { answers } : undefined,
            );
          },
        });
      } else {
        setConfirmSel(0);
        setConfirmReq({
          ...buildToolConfirmDialog(confirmationDetails),
          resolve: (outcome) => {
            void confirmationDetails.onConfirm(outcome);
          },
        });
      }
    },
    [buildToolConfirmDialog],
  );

  const startLiveTurn = useCallback(
    (
      content: PartListUnion,
      options?: {
        modelOverride?: string;
        onComplete?: () => Promise<void>;
        refreshContextFilesOnWrite?: boolean;
        /** Turn key minted by the submitter; shared with the user item. */
        promptId?: string;
      },
    ) => {
      if (!config) return;
      // Live client wiring: submit to the real agent loop; Esc aborts via the
      // AbortController whose signal reaches client.sendMessageStream.
      liveAbortRef.current?.abort();
      const controller = new AbortController();
      liveAbortRef.current = controller;
      // Taking ownership invalidates the aborted turn's outstanding
      // approvals — they can no longer resolve into this turn.
      pendingApprovalsRef.current.clear();
      setStreaming(true);
      (async () => {
        try {
          for await (const ev of batchTextEvents(
            livePromptEvents(config, content, controller.signal, {
              ...(options?.modelOverride
                ? { modelOverride: options.modelOverride }
                : {}),
              ...(options?.refreshContextFilesOnWrite
                ? { refreshContextFilesOnWrite: true }
                : {}),
              ...(options?.promptId ? { promptId: options.promptId } : {}),
              drainSteering,
              onWaitingCall: ({ callId, name, confirmationDetails }) => {
                pendingApprovalsRef.current.set(callId, {
                  callId,
                  name,
                  confirmationDetails,
                });
                // One dialog at a time (R1-15): queue behind the open one;
                // settling it pops this call next.
                if (approvalDialogCallIdRef.current !== null) return;
                presentApprovalDialog(callId);
              },
            }),
          ))
            applyEvent(ev);
          // Turn end: the generator only returns when the whole agent loop
          // (model + tool batches) is done, so settle tool cards and drop
          // the streaming state HERE — the core `finished` event arrives
          // before tool execution and no longer maps to `done` (premature
          // "✗ skipped" fix).
          applyEvent({ type: 'done' });
          // The turn completed: fire the submit_prompt callback (e.g. skill
          // completion hooks). ink logs failures to the debug logger.
          if (options?.onComplete) {
            void options.onComplete().catch(() => {});
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            applyEvent({
              type: 'text',
              delta: `\n[live error] ${String(err)}`,
            });
          }
          setItems((prev) =>
            settleOpenTools(
              prev,
              controller.signal.aborted ? 'interrupted' : 'error',
            ),
          );
          applyEvent({ type: 'done' });
        } finally {
          // Ownership guard (R1-17): when this turn was aborted in favor of a
          // replacement (Ctrl+Y, queued submit), the new turn already owns
          // liveAbortRef — its microtask-later unwind must not clear the new
          // turn's streaming state or drain the queue from under it.
          if (liveAbortRef.current === controller) {
            liveAbortRef.current = null;
            pendingApprovalsRef.current.clear();
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            setStreaming(false);
            const next = queuedPromptsRef.current.shift();
            setQueuedPrompts([...queuedPromptsRef.current]);
            if (next) setTimeout(() => submitTextRef.current?.(next), 50);
          }
        }
      })();
    },
    [config, applyEvent, drainSteering, presentApprovalDialog],
  );
  startLiveTurnRef.current = startLiveTurn;

  /** Prompt logger (disk history feed) + telemetry prompt count. */
  const logSubmittedPrompt = useCallback((text: string) => {
    promptCountRef.current += 1;
    try {
      loggerRef.current?.logMessage(MessageSenderType.USER, text);
    } catch {
      /* best-effort history */
    }
  }, []);

  /** One-shot client-initiated tool run (schedule_tool: /restore, …). */
  const scheduleClientTool = useCallback(
    (toolName: string, toolArgs: Record<string, unknown>) => {
      if (!config) {
        applyEvent({
          type: 'text',
          delta:
            'Tool scheduling requires a live client, which is not available in demo mode.',
        });
        applyEvent({ type: 'done' });
        return;
      }
      liveAbortRef.current?.abort();
      const controller = new AbortController();
      liveAbortRef.current = controller;
      // Taking ownership invalidates the aborted turn's outstanding
      // approvals — they can no longer resolve into this turn (same guard
      // as startLiveTurn, R1-17).
      pendingApprovalsRef.current.clear();
      setStreaming(true);
      void (async () => {
        try {
          for await (const ev of batchTextEvents(
            clientToolEvents(config, toolName, toolArgs, controller.signal, {
              onWaitingCall: ({ name, confirmationDetails }) =>
                handleSchedulerWaitingCall({ name, confirmationDetails }),
            }),
          )) {
            applyEvent(ev);
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            applyEvent({
              type: 'text',
              delta: `\n[tool error] ${String(err)}`,
            });
          }
          setItems((prev) =>
            settleOpenTools(
              prev,
              controller.signal.aborted ? 'interrupted' : 'error',
            ),
          );
          applyEvent({ type: 'done' });
        } finally {
          // Same ownership guard as startLiveTurn's finally (R1-17).
          if (liveAbortRef.current === controller) {
            liveAbortRef.current = null;
            setStreaming(false);
          }
        }
      })();
    },
    [config, applyEvent, handleSchedulerWaitingCall],
  );

  // ── /rewind (audit 01 G-8 / 05 G-07): data + confirm handler ────────────
  const rewindTurns = useMemo<RewindTurn[]>(
    () =>
      items
        .filter((i) => i.kind === 'user')
        .map((i) =>
          i.kind === 'user'
            ? {
                id: i.id,
                text: i.text,
                promptId: i.promptId,
                sentToModel: i.sentToModel,
              }
            : { id: i.id, text: '' },
        ),
    [items],
  );

  const handleRewind = useCallback(
    async (turn: RewindTurn, option: RestoreOption) => {
      if (!config || option === 'cancel') return;
      try {
        const needsConversation =
          option === 'conversation' || option === 'both';
        // Validate the conversation cut point before touching anything
        // (ink parity): a rewind whose API-history cut point cannot be
        // located positionally (e.g. the turn was compressed) must fail
        // closed instead of restoring files against a conversation that
        // then stays intact.
        const rewindClient = needsConversation
          ? config.getGeminiClient?.()
          : undefined;
        const rewindable = rewindTurns.filter((t) => isRewindableTurn(t));
        const rewindIndex = rewindable.findIndex((t) => t.id === turn.id);
        let rewindCut = -1;
        if (needsConversation) {
          const apiHistory = rewindClient?.getHistoryShallow?.() ?? [];
          rewindCut = rewindApiCutPoint(apiHistory, rewindIndex + 1);
          if (rewindClient && rewindCut < 0) {
            applyEvent({
              type: 'text',
              delta:
                'Cannot rewind conversation: the target turn could not be located in the model history (it may have been compressed). Nothing was rewound.',
            });
            applyEvent({ type: 'done' });
            return;
          }
        }
        // File restore first ('both' validated the conversation above).
        let hasRestoreFailure = false;
        if (option === 'code' || option === 'both') {
          const fileHistoryService = config.getFileHistoryService?.();
          if (fileHistoryService && turn.promptId) {
            const result = await fileHistoryService.rewind(
              turn.promptId,
              option === 'both',
            );
            hasRestoreFailure = result.filesFailed.length > 0;
            applyEvent({
              type: 'text',
              delta:
                result.filesChanged.length > 0
                  ? `Restored ${result.filesChanged.length} file(s).`
                  : 'No files needed to be restored.',
            });
          } else {
            hasRestoreFailure = true;
            applyEvent({
              type: 'text',
              delta:
                'Cannot restore files: this turn predates file checkpointing in the OpenTUI renderer.',
            });
          }
          if (option === 'code') {
            applyEvent({ type: 'done' });
            return;
          }
        }
        if (!needsConversation || (option === 'both' && hasRestoreFailure)) {
          applyEvent({ type: 'done' });
          return;
        }
        // Conversation rewind: the cut point was validated above; truncate
        // the transcript and the API history together so the UI and the
        // model never desync silently.
        const turnItemIndex = items.findIndex((i) => i.id === turn.id);
        setItems((prev) => {
          const idx = prev.findIndex((p) => p.id === turn.id);
          return idx >= 0 ? prev.slice(0, idx) : prev;
        });
        if (rewindCut >= 0) rewindClient?.truncateHistory(rewindCut);
        // Re-root the recording chain (best-effort) so resume skips the
        // abandoned branch, then pre-populate the composer like ink.
        try {
          const snapshots = config
            .getFileHistoryService?.()
            ?.getSnapshots()
            .slice(0, Math.max(0, rewindIndex) + 1);
          config
            .getChatRecordingService()
            ?.rewindRecording(
              Math.max(0, rewindIndex),
              { truncatedCount: Math.max(0, turnItemIndex) },
              snapshots,
            );
        } catch {
          /* recording rewind is best-effort */
        }
        composerHandle.current?.setText(turn.text);
        applyEvent({
          type: 'text',
          delta:
            'Conversation rewound. Edit your prompt and press Enter to continue.',
        });
        applyEvent({ type: 'done' });
      } catch (err) {
        applyEvent({
          type: 'text',
          delta: `Rewind failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        applyEvent({ type: 'done' });
      }
    },
    [config, items, rewindTurns, applyEvent],
  );

  const rewindData = useMemo(
    () =>
      config
        ? {
            turns: rewindTurns,
            fileCheckpointingEnabled:
              config.getFileCheckpointingEnabled?.() ?? false,
            getDiffStats: (promptId: string) =>
              config.getFileHistoryService?.()?.getDiffStats(promptId),
            onRewind: handleRewind,
          }
        : undefined,
    [config, rewindTurns, handleRewind],
  );

  const applySlashAction = useCallback(
    (action: BackendAction) => {
      switch (action.kind) {
        case 'passthrough':
          return;
        case 'handled':
          // Command output already reached the history through the host; close
          // the streaming text block it produced.
          applyEvent({ type: 'done' });
          return;
        case 'dialog':
          if (action.resolution.kind === 'mount') {
            setDialog(action.resolution.dialog);
          } else {
            applyEvent({ type: 'text', delta: action.resolution.message });
            applyEvent({ type: 'done' });
          }
          return;
        case 'submit': {
          if (
            typeof action.content === 'string' &&
            action.content.trim().length === 0
          ) {
            applyEvent({ type: 'done' });
            return;
          }
          if (!config) {
            applyEvent({
              type: 'text',
              delta:
                'Model submission requires a live client, which is not available in demo mode.',
            });
            applyEvent({ type: 'done' });
            return;
          }
          startLiveTurn(action.content, {
            ...(action.modelOverride
              ? { modelOverride: action.modelOverride }
              : {}),
            ...(action.onComplete ? { onComplete: action.onComplete } : {}),
            ...(action.refreshContextFilesOnWrite
              ? { refreshContextFilesOnWrite: true }
              : {}),
          });
          return;
        }
        case 'schedule_tool':
          scheduleClientTool(action.toolName, action.toolArgs);
          return;
        case 'quit': {
          // Render the farewell (goodbye + real session wall time + resume
          // hint) into the transcript, mirroring ink's QuittingDisplay, then
          // quit through the cleanup drain. The exit cleanup echoes the same
          // farewell to stdout so it survives the renderer teardown.
          const farewell = config
            ? buildQuitFarewellForConfig(
                config,
                userPrompts.length > 0,
                uiTelemetryService.getSessionStartTime(),
              )
            : null;
          if (farewell) {
            applyEvent({ type: 'text', delta: farewell.join('\n') });
          }
          applyEvent({ type: 'done' });
          quitOpenTui(0);
          return;
        }
        case 'unsupported':
          applyEvent({ type: 'text', delta: action.message });
          applyEvent({ type: 'done' });
          return;
      }
    },
    [
      applyEvent,
      config,
      quitOpenTui,
      startLiveTurn,
      userPrompts,
      scheduleClientTool,
    ],
  );

  const submitText = useCallback(
    (raw: string, imagePaths?: string[]) => {
      reverseSearchRef.current = -1;
      void (async () => {
        const text = raw.trim();
        if (!text) return;
        // A turn is in flight: queue instead of aborting it (original
        // useMessageQueue semantics; drained when the turn settles).
        // Commands that opted in (canRunDuringStreaming, e.g. /help
        // /status /settings) still run immediately while the model streams
        // — ink AppContainer parity. A running command keeps queueing
        // (ink's fast path only applies to Responding, not isProcessing).
        const streamingFastPath =
          streamingRef.current &&
          !commandProcessingRef.current &&
          isSlashCommandInput(text) &&
          gateway.canRunDuringStreaming(text);
        if (
          (streamingRef.current || commandProcessingRef.current) &&
          !streamingFastPath
        ) {
          enqueuePrompt(text);
          return;
        }
        // Slash commands run through the real command stack behind the
        // gateway: queued until the dispatcher is ready, rejected while one
        // is already running, never silently misrouted to the model.
        if (isSlashCommandInput(text)) {
          let settlement: SlashSettlement;
          try {
            settlement = await gateway.dispatch(text);
          } catch (err) {
            applyEvent({
              type: 'text',
              delta: `[command error] ${err instanceof Error ? err.message : String(err)}`,
            });
            applyEvent({ type: 'done' });
            return;
          }
          if (settlement.kind === 'rejected') {
            applyEvent({ type: 'text', delta: settlement.reason });
            applyEvent({ type: 'done' });
            return;
          }
          const action = resolveDispatchOutcome(settlement.outcome);
          if (action.kind !== 'passthrough') {
            applySlashAction(action);
            return;
          }
        }
        const imageParts = (imagePaths ?? [])
          .map(readImagePart)
          .filter((p): p is Part => p !== null);
        // Mint the turn's promptId up front so the echoed user item and the
        // model request share the key file checkpoints are recorded under
        // (ink parity: user items carry promptId for /rewind).
        const promptId = config ? nextLivePromptId(config) : undefined;
        applyEvent({
          type: 'user',
          text: imageParts.length > 0 ? `${text} 📎${imageParts.length}` : text,
          promptId,
        });
        if (config) {
          // Disk history feed (ink logs submitted prompts via the Logger).
          logSubmittedPrompt(text);
          startLiveTurn(
            imageParts.length > 0 ? [{ text }, ...imageParts] : text,
            promptId ? { promptId } : undefined,
          );
          return;
        }
        startStream(); // scripted: every submission replays the scenario
      })();
    },
    [
      applyEvent,
      applySlashAction,
      config,
      gateway,
      startLiveTurn,
      startStream,
      enqueuePrompt,
      logSubmittedPrompt,
    ],
  );
  submitTextRef.current = submitText;

  // Remote input (--input-file): route external `submit` commands into the
  // same path as typed prompts. confirmation_response is not wired yet — it
  // needs a DualOutputBridge on this renderer first; until then
  // startInteractiveUI routes --json-fd/--json-file launches to ink.
  useEffect(() => {
    if (!remoteInputWatcher) return;
    remoteInputWatcher.setSubmitFn((text: string) => {
      submitTextRef.current?.(text);
      return true;
    });
    return () => remoteInputWatcher.setSubmitFn(() => false);
  }, [remoteInputWatcher]);

  useEffect(() => {
    if (remoteInputWatcher && !streaming && !commandProcessing) {
      remoteInputWatcher.notifyIdle();
    }
  }, [remoteInputWatcher, streaming, commandProcessing]);

  // ink AppHeader parity: screen-reader mode and ui.hideBanner suppress the
  // banner; ui.hideTips or screen-reader mode suppresses the tips line.
  const screenReaderMode = config?.getScreenReader() ?? false;
  const showBanner = !screenReaderMode && !settings.merged.ui?.hideBanner;
  const showTips = !(settings.merged.ui?.hideTips || screenReaderMode);
  // resolveCustomBanner may read art files, so the banner JSX is memoized on
  // its inputs (ink AppHeader resolves once per settings identity).
  const banner = useMemo(
    () => (showBanner ? buildBanner(config, settings, width) : null),
    [showBanner, config, settings, width],
  );

  // Sticky-todo panel state (ink AppContainer/DefaultAppLayout parity).
  // `streaming` ≙ StreamingState.Responding; slash-command processing is not
  // a model response and does not surface the panel. The snapshot array
  // reference is stable across unrelated fold events, and the memo'd panel
  // compares via getStickyTodosRenderKey, so unrelated items do not re-render it.
  const stickyTodos = useMemo(
    () => getStickyTodosFromLiveItems(items),
    [items],
  );
  const shouldShowStickyTodos = stickyTodos !== null && !dialog && streaming;
  const stickyTodoWidth = Math.min(Math.min(width - 4, 100), 64);
  const stickyTodoMaxVisibleItems = getStickyTodoMaxVisibleItemsForMode(
    height,
    false,
  );

  // footer (mirrors original Footer): project · git · model + approval mode
  const footerProject = nodePath.basename(targetDir);
  const footerBranch = gitBranch ?? '';
  const fm = (
    config as unknown as { getModel?: () => unknown } | undefined
  )?.getModel?.();
  const footerModel =
    typeof fm === 'string'
      ? fm
      : ((fm as { id?: string } | undefined)?.id ?? '');
  const promptTokenCount = uiTelemetryService.getLastPromptTokenCount();
  const contextWindowSize = (
    config as {
      getContentGeneratorConfig?: () => { contextWindowSize?: number };
    }
  )?.getContentGeneratorConfig?.()?.contextWindowSize;
  // Original status-line parity: the context indicator only appears once
  // tokens have been used (`… · 1.0m Context 4.5% used`), never bare.
  const contextPct =
    contextWindowSize && promptTokenCount > 0
      ? Math.min(
          100,
          Math.round((promptTokenCount / contextWindowSize) * 1000) / 10,
        )
      : null;
  const contextLabel =
    contextWindowSize && contextPct != null
      ? ` · ${fmtTokens(contextWindowSize)} Context ${formatPercentUsed(contextPct)} used`
      : '';
  const footerLine1 =
    `\u279c ${footerProject}` +
    (sessionName ? ` · ${sessionName}` : '') +
    (footerBranch ? ` · git:(${footerBranch})` : '') +
    (footerModel ? ` · ${footerModel}` : '') +
    contextLabel +
    (mdFileCount > 0
      ? ` · ${mdFileCount} context file${mdFileCount === 1 ? '' : 's'}`
      : '');
  const modeName = approvalModeLabel(String(approvalMode ?? ''));
  const modeColor =
    modeName === 'YOLO'
      ? C.red
      : modeName === 'AUTO'
        ? C.green
        : modeName === 'PLAN'
          ? C.accent
          : C.dim;

  return (
    <box flexDirection="column" width={width} height="100%">
      {/* flow layout: banner/Tips/messages/input/footer scroll together,
          top-aligned when empty (banner scrolls away on long sessions) */}
      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        minHeight={0}
        stickyScroll={true}
        stickyStart="bottom"
        verticalScrollbarOptions={{ visible: false }}
        onMouseUp={(e) => {
          handleLinkClick(e);
        }}
      >
        {banner}
        {showTips && <Tips />}
        {(pendingLiveItem ? [...items, pendingLiveItem] : items).map((item) => {
          switch (item.kind) {
            case 'user':
              return (
                <box
                  key={item.id}
                  flexDirection="row"
                  paddingLeft={1}
                  marginTop={1}
                >
                  <box flexDirection="row">
                    <text fg={C.accent} attributes={1} {...selectionProps()}>
                      {'> '}
                    </text>
                    <text fg={C.accent} attributes={1} {...selectionProps()}>
                      {item.text}
                    </text>
                  </box>
                </box>
              );
            case 'thinking': {
              // mirror original ThinkingMessage: icon + label(+duration) + hint
              const th = item as LiveThinkingItem;
              const completedLabel =
                th.durationMs == null
                  ? null
                  : th.durationMs < 1000
                    ? 'Thought briefly'
                    : `Thought for ${formatDuration(th.durationMs)}`;
              const label = !th.done
                ? `Thinking…${elapsed ? ` (${elapsed}s)` : ''}`
                : (completedLabel ?? 'Thought');
              const hint = !th.done
                ? ''
                : expanded.has(item.id)
                  ? ' (ctrl+o to collapse)'
                  : ' (click or ctrl+o to expand)';
              return (
                <box
                  key={item.id}
                  flexDirection="column"
                  paddingLeft={1}
                  paddingRight={2}
                  marginTop={1}
                >
                  <box
                    onMouseUp={(e) => {
                      if (e.button === MouseButton.LEFT) {
                        const sel = renderer.getSelection();
                        if (!sel?.getSelectedText()) toggle(item.id);
                      }
                    }}
                  >
                    <text fg={C.dim} {...selectionProps()}>
                      {`${th.done ? '∴' : '∵'} ${label}${hint}`}
                    </text>
                  </box>
                  {expanded.has(item.id) && item.text.length > 0 && (
                    <box paddingLeft={2} paddingRight={2} marginTop={1}>
                      <text fg={C.dim} {...selectionProps()}>
                        {item.text}
                      </text>
                    </box>
                  )}
                </box>
              );
            }
            case 'assistant':
              return <AssistantMessage key={item.id} item={item} />;
            case 'tool':
              return (
                <ToolCard
                  key={item.id}
                  item={item}
                  expanded={expanded.has(item.id)}
                  onToggle={toggle}
                />
              );
            case 'task':
              return (
                <TaskCard
                  key={item.id}
                  item={item}
                  expanded={expanded.has(item.id)}
                  onToggle={toggle}
                />
              );
            case 'compaction':
              return (
                <box key={item.id} paddingLeft={1} marginTop={1}>
                  <CompressionNotice view={compactionView(item.compression)} />
                </box>
              );
            case 'info':
              // ink InfoMessage parity: `●` prefix + primary-colored text
              // (StatusMessage reserves a 2-cell prefix column; no top margin).
              return (
                <box key={item.id} flexDirection="row" paddingLeft={1}>
                  <box width={2} flexShrink={0}>
                    <text fg={C.text} {...selectionProps()}>
                      {ICON.CIRCLE_FILLED}
                    </text>
                  </box>
                  <box flexGrow={1} flexDirection="column">
                    {item.text.split('\n').map((line, i) => (
                      <text key={i} fg={C.text} {...selectionProps()}>
                        {line}
                      </text>
                    ))}
                  </box>
                </box>
              );
            case 'error': {
              // ink ErrorMessage parity: `✕` prefix + error-colored text with
              // the retry hint inline (secondary color) on the last line.
              const lines = item.text.split('\n');
              return (
                <box key={item.id} flexDirection="row" paddingLeft={1}>
                  <box width={2} flexShrink={0}>
                    <text fg={C.red} {...selectionProps()}>
                      ✕
                    </text>
                  </box>
                  <box flexGrow={1} flexDirection="column">
                    {lines.map((line, i) => (
                      <text key={i} fg={C.red} {...selectionProps()}>
                        {line}
                        {item.hint && i === lines.length - 1 ? (
                          <span fg={C.dim}> ({item.hint})</span>
                        ) : null}
                      </text>
                    ))}
                  </box>
                </box>
              );
            }
            case 'warning':
              // ink user_prompt_submit_blocked parity: no prefix, the whole
              // block in the warning color.
              return (
                <box key={item.id} paddingLeft={1} flexDirection="column">
                  {item.text.split('\n').map((line, i) => (
                    <text key={i} fg={C.yellow} {...selectionProps()}>
                      {line}
                    </text>
                  ))}
                </box>
              );
            case 'retry': {
              // ink startRetryCountdown drives two pending rows, both updated
              // every second until the delay elapses: the retry error line
              // (short-format countdown hint inline, ink pendingRetryErrorItem)
              // and the `↻` countdown line (ink RetryCountdownMessage).
              const remainingMs = Math.max(
                0,
                item.delayMs - (Date.now() - item.startedAt),
              );
              const remainingSec = Math.ceil(remainingMs / 1000);
              return (
                <box key={item.id} flexDirection="column" paddingLeft={1}>
                  <box flexDirection="row">
                    <box width={2} flexShrink={0}>
                      <text fg={C.red} {...selectionProps()}>
                        ✕
                      </text>
                    </box>
                    <box flexGrow={1}>
                      <text fg={C.red} {...selectionProps()}>
                        {item.message ??
                          'Rate limit exceeded. Please wait and try again.'}
                        <span fg={C.dim}>
                          {' '}
                          (Retrying in {remainingSec}s… (attempt {item.attempt}/
                          {item.maxRetries}))
                        </span>
                      </text>
                    </box>
                  </box>
                  <box flexDirection="row">
                    <box width={2} flexShrink={0}>
                      <text fg={C.dim} {...selectionProps()}>
                        ↻
                      </text>
                    </box>
                    <box flexGrow={1}>
                      <text fg={C.dim} {...selectionProps()}>
                        Retrying in {remainingSec} seconds… (attempt{' '}
                        {item.attempt}/{item.maxRetries})
                      </text>
                    </box>
                  </box>
                </box>
              );
            }
            case 'stop-hook':
              // ink stop_hook_system_message parity: `⎿ Stop says:` header +
              // indented markdown body.
              return (
                <box key={item.id} paddingLeft={1} flexDirection="column">
                  <text fg={C.text} {...selectionProps()}>
                    {' ⎿ Stop says:'}
                  </text>
                  <box paddingLeft={4}>
                    <markdown
                      content={item.message}
                      syntaxStyle={SYNTAX}
                      fg={C.text}
                      bg={C.bg}
                    />
                  </box>
                </box>
              );
            case 'goal': {
              // ink GoalStatusMessage parity: v2 snapshots render through
              // GoalStateCard; /goal command items render the legacy kind
              // form (checking / six-card lifecycle).
              if (item.legacy) {
                const legacy = describeLegacyGoalCard(item.legacy);
                if (legacy.state === 'hidden') return null;
                if (legacy.state === 'checking') {
                  return (
                    <box key={item.id} flexDirection="row" paddingLeft={1}>
                      <box width={2} flexShrink={0}>
                        <text fg={C.dim} {...selectionProps()}>
                          {ICON.CIRCLE_EMPTY}
                        </text>
                      </box>
                      <box flexGrow={1} flexDirection="column">
                        <text fg={C.dim} {...selectionProps()}>
                          {legacy.title}
                        </text>
                        <text fg={C.dim} {...selectionProps()}>
                          Goal: {legacy.condition}
                        </text>
                        {legacy.judgeReason ? (
                          <text fg={C.dim} {...selectionProps()}>
                            Judge: {legacy.judgeReason}
                          </text>
                        ) : null}
                      </box>
                    </box>
                  );
                }
                const legacyColor = GOAL_CARD_COLORS[legacy.color];
                return (
                  <box key={item.id} flexDirection="row" paddingLeft={1}>
                    <box width={2} flexShrink={0}>
                      <text fg={legacyColor} {...selectionProps()}>
                        {legacy.icon}
                      </text>
                    </box>
                    <box flexGrow={1} flexDirection="column">
                      <text fg={legacyColor} {...selectionProps()}>
                        {legacy.title}
                        {legacy.subtitle ? (
                          <span fg={C.dim}> · {legacy.subtitle}</span>
                        ) : null}
                      </text>
                      <box flexDirection="row">
                        <box flexShrink={0} marginRight={1}>
                          <text fg={C.dim} {...selectionProps()}>
                            Goal:
                          </text>
                        </box>
                        <box flexGrow={1}>
                          <text fg={C.text} {...selectionProps()}>
                            {legacy.condition}
                          </text>
                        </box>
                      </box>
                      {legacy.lastCheck ? (
                        <text fg={C.dim} {...selectionProps()}>
                          Last check: {legacy.lastCheck}
                        </text>
                      ) : null}
                    </box>
                  </box>
                );
              }
              const view = describeGoalCard(item.snapshot, item.cause);
              if (view.state === 'hidden') return null;
              if (view.state === 'cleared') {
                return (
                  <box key={item.id} flexDirection="row" paddingLeft={1}>
                    <box width={2} flexShrink={0}>
                      <text fg={C.dim} {...selectionProps()}>
                        {ICON.CIRCLE_EMPTY}
                      </text>
                    </box>
                    <text fg={C.dim} {...selectionProps()}>
                      Goal cleared
                    </text>
                  </box>
                );
              }
              const goalColor = GOAL_CARD_COLORS[view.color];
              return (
                <box key={item.id} flexDirection="row" paddingLeft={1}>
                  <box width={2} flexShrink={0}>
                    <text fg={goalColor} {...selectionProps()}>
                      {view.icon}
                    </text>
                  </box>
                  <box flexGrow={1} flexDirection="column">
                    <text fg={goalColor} {...selectionProps()}>
                      {view.title}
                      {view.subtitle ? (
                        <span fg={C.dim}> · {view.subtitle}</span>
                      ) : null}
                    </text>
                    <box flexDirection="row">
                      <box flexShrink={0} marginRight={1}>
                        <text fg={C.dim} {...selectionProps()}>
                          Goal:
                        </text>
                      </box>
                      <box flexGrow={1}>
                        <text fg={C.text} {...selectionProps()}>
                          {view.objective}
                        </text>
                      </box>
                    </box>
                    {view.reason ? (
                      <text fg={C.dim} {...selectionProps()}>
                        Reason: {view.reason}
                      </text>
                    ) : null}
                  </box>
                </box>
              );
            }
            case 'image':
              return <ImageItem key={item.id} item={item} />;
          }
        })}
        <box height={1} />
        {/* loading indicator above input while model responds (original) */}
        {(streaming || commandProcessing) && (
          <box paddingLeft={1} paddingRight={1} flexDirection="row">
            <Spinner />
            <text fg={C.dim}>
              {`${loadingPhrase} (${elapsed}s · Esc to cancel)`}
            </text>
          </box>
        )}
        {/* prompt (flows after messages; top-aligned when empty) */}
        <box flexDirection="column">
          {questionReq && (
            <box
              flexDirection="column"
              border
              borderColor={C.accent}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
            >
              <text fg={C.accent} attributes={1}>
                {`[${qNav.q + 1}/${questionReq.questions.length}] ${
                  questionReq.questions[qNav.q]?.header ?? ''
                }`}
              </text>
              <text fg={C.text}>
                {questionReq.questions[qNav.q]?.question ?? ''}
              </text>
              {(questionReq.questions[qNav.q]?.options ?? []).map((o, i) => (
                <box key={o.label} flexDirection="column">
                  <text fg={!qNav.other && qNav.opt === i ? C.accent : C.dim}>
                    {`${!qNav.other && qNav.opt === i ? '> ' : '  '}${
                      questionReq.questions[qNav.q]?.multiSelect
                        ? `[${qNav.multi.includes(i) ? 'x' : ' '}] `
                        : ''
                    }${o.label}`}
                  </text>
                  <text fg={C.dim}>{`   ${o.description}`}</text>
                </box>
              ))}
              <text
                fg={
                  !qNav.other &&
                  qNav.opt ===
                    (questionReq.questions[qNav.q]?.options.length ?? 0)
                    ? C.accent
                    : C.dim
                }
              >
                {`${
                  !qNav.other &&
                  qNav.opt ===
                    (questionReq.questions[qNav.q]?.options.length ?? 0)
                    ? '> '
                    : '  '
                }Other…`}
              </text>
              {qNav.other && <text fg={C.text}>{`> ${qNav.otherText}▌`}</text>}
              <text fg={C.dim}>
                {questionReq.questions[qNav.q]?.multiSelect
                  ? '↑↓ move · space toggle · enter confirm · esc cancel'
                  : '↑↓ move · enter select · esc cancel'}
              </text>
            </box>
          )}
          {confirmReq && (
            // ink ToolConfirmationMessage parity: no border — body, blank
            // line, question, blank line, then numbered radio options with
            // the selected row in success green.
            <box flexDirection="column" paddingLeft={1} marginTop={1}>
              {confirmReq.body.map((spans, i) => (
                <box key={`${i}`} flexDirection="row">
                  {spans.map((span, j) => (
                    <text key={`${j}`} fg={span.color}>
                      {span.text}
                    </text>
                  ))}
                </box>
              ))}
              <text> </text>
              <text fg={C.text}>{confirmReq.question}</text>
              <text> </text>
              {confirmReq.options.map((o, i) => (
                <text key={o.label} fg={confirmSel === i ? C.green : C.text}>
                  {`${confirmSel === i ? '›' : ' '} ${i + 1}. ${o.label}`}
                </text>
              ))}
            </box>
          )}
          {actionConfirmReq && (
            <box
              flexDirection="column"
              border
              borderColor={C.yellow}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
            >
              <text fg={C.text}>{actionConfirmReq.prompt}</text>
              <text fg={C.dim}>{'press y to confirm · n / esc to cancel'}</text>
            </box>
          )}
          {shellConfirmReq && (
            <box
              flexDirection="column"
              border
              borderColor={C.yellow}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
            >
              <text fg={C.yellow} attributes={1}>
                {'Shell Command Execution'}
              </text>
              <text fg={C.text}>
                {'A custom command wants to run the following shell commands:'}
              </text>
              {shellConfirmReq.commands.map((command) => (
                <text key={command} fg={C.accent}>{`  ${command}`}</text>
              ))}
              {['Yes, allow once', 'Always allow in this session', 'No'].map(
                (label, i) => (
                  <text
                    key={label}
                    fg={shellConfirmSel === i ? C.accent : C.dim}
                  >
                    {`${shellConfirmSel === i ? '> ' : '  '}${label}`}
                  </text>
                ),
              )}
              <text fg={C.dim}>
                {'y once · a always · n / esc cancel · ↑↓ + enter to choose'}
              </text>
            </box>
          )}
          {queuedPrompts.length > 0 && (
            <box flexDirection="column" marginTop={1} paddingLeft={2}>
              {queuedPrompts
                .slice(0, MAX_DISPLAYED_QUEUED_MESSAGES)
                .map((m, i) => (
                  <text key={`${i}-${m}`} fg={C.dim}>
                    {summarizeQueuedPrompt(m, width - 8)}
                  </text>
                ))}
              {queuedPrompts.length > MAX_DISPLAYED_QUEUED_MESSAGES && (
                <text
                  fg={C.dim}
                >{`... (+${queuedPrompts.length - MAX_DISPLAYED_QUEUED_MESSAGES} more)`}</text>
              )}
              <text fg={C.dim} attributes={2}>
                {'Ctrl+Q to queue · ↑ to edit queued messages'}
              </text>
            </box>
          )}
          {shouldShowStickyTodos && (
            <StickyTodoListOp
              todos={stickyTodos!}
              width={stickyTodoWidth}
              maxVisibleItems={stickyTodoMaxVisibleItems}
            />
          )}
          <OpenTuiInputPrompt
            onSubmit={submitText}
            userMessages={userPrompts}
            config={config}
            approvalMode={approvalMode}
            streaming={streaming || commandProcessing}
            queueLength={queuedPrompts.length}
            onPopQueue={popAllQueued}
            onInterrupt={() => {
              if (commandProcessingRef.current) {
                gateway.cancel();
                return;
              }
              // Keep the ref so the turn's finally performs the cleanup
              // (ownership guard, R1-17).
              liveAbortRef.current?.abort();
              setStreaming(false);
            }}
            placeholder="Type your message or @path/to/file"
            recentSlashCommands={recentSlashCommands}
            focus={
              !dialog &&
              !folderTrustGateOpen &&
              !questionReq &&
              !confirmReq &&
              !actionConfirmReq &&
              !shellConfirmReq
            }
            composerHandle={composerHandle}
          />
        </box>
        {/* footer */}
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          {exitHint && <text fg={C.yellow}>{exitHint}</text>}
          {updateNotice && <text fg={C.dim}>{updateNotice}</text>}
          <text fg={C.dim}>{footerLine1}</text>
          {debugMessage && <text fg={C.dim}>{debugMessage}</text>}
          <box flexDirection="row">
            {(streaming || commandProcessing) && (
              <text fg={C.dim}>{'Enter to steer · Ctrl+Q to queue · '}</text>
            )}
            <text fg={modeColor}>{`${modeName} mode`}</text>
            <text fg={C.dim}>{' (shift + tab to cycle)'}</text>
            {queuedPrompts.length > 0 && (
              <text fg={C.dim}>{` · ⏳ ${queuedPrompts.length} queued`}</text>
            )}
          </box>
        </box>
      </scrollbox>

      {/* folder-trust startup gate (#56): highest dialog priority (ink
          DialogManager parity — ahead of MCP approvals and every command
          dialog, since it decides whether tool confirmations can offer
          "always allow" at all) */}
      <OpenTuiFolderTrustGate
        settings={settings}
        onOpenChange={setFolderTrustGateOpen}
      />

      {/* active dialog (help/theme/settings/model/permissions/…) */}
      {dialog && (
        <OpenTuiDialogMount
          dialog={dialog}
          config={config}
          settings={settings}
          commands={commands}
          onClose={() => setDialog(null)}
          onNavigate={setDialog}
          onThemeChanged={applyThemePreference}
          notify={(text) => {
            applyEvent({ type: 'text', delta: text });
            applyEvent({ type: 'done' });
          }}
          onApprovalModeChanged={switchApprovalMode}
          onResume={(sessionId) => void host.handleResume(sessionId)}
          rewind={rewindData}
          onFillInput={(text) => composerHandle.current?.setText(text)}
        />
      )}
    </box>
  );
}

export { App };
