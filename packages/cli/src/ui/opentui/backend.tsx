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
import { MouseButton } from '@opentui/core';
import type { MouseEvent, ScrollBoxRenderable } from '@opentui/core';
import { findUrlAtRow, readBufferRow } from './link-click.js';
import { MultiClickSelectionController } from './multi-click-select.js';
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
} from './messages.js';
import { OpenTuiInputPrompt } from './input-prompt.js';
import {
  useKeyboard,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from './clipboard.js';
import { buildScenario, TOKEN_INTERVAL_MS } from './stream-script.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import {
  foldLiveEvent,
  settleOpenTools,
  type LiveHistoryItem,
  type LiveImageItem,
  type LiveThinkingItem,
  type LiveToolItem,
} from './live-session-model.js';
import { formatDuration } from '../utils/displayUtils.js';
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
import { getAsciiArtWidth } from '../utils/textUtils.js';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import type { Part, PartListUnion } from '@google/genai';
import {
  livePromptEvents,
  nextApprovalMode,
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
import { OpenTuiDialogMount } from './dialog-mount.js';
import { loadSettings, type LoadedSettings } from '../../config/settings.js';
import type { SlashCommand } from '../commands/types.js';
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

  const pendingApproval = item.confirm === 'pending';
  const icon = !item.done
    ? pendingApproval
      ? '⏸'
      : nextSpinner()
    : item.success
      ? '✓'
      : '✗';
  const iconColor = !item.done
    ? pendingApproval
      ? C.yellow
      : C.accent
    : item.success
      ? C.green
      : C.red;
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
  const argsDescription = toolCardDescription(item.tool, item.args);
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
          <text fg={iconColor}>{icon} </text>
          <text fg={C.text} attributes={1}>
            {displayName}
          </text>
          {(description || confirmLabel) && (
            <text fg={C.dim}>{` ${description}`}</text>
          )}
          {confirmLabel && <text fg={C.yellow}>{confirmLabel}</text>}
        </box>
      </box>
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
  const isError = item.text.startsWith('[error]');
  return (
    <box paddingLeft={1} marginTop={1} flexDirection="row">
      <text fg={isError ? C.red : C.accent}>{isError ? '✗ ' : '◆ '}</text>
      <box flexGrow={1} flexDirection="column">
        <markdown
          content={item.text}
          streaming={item.streaming}
          syntaxStyle={SYNTAX}
          fg={isError ? C.red : C.text}
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
function GradientLogo() {
  const lines = shortAsciiLogo.replace(/^\n/, '').split('\n');
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
// auth|model(+hint), directory. Same data sources as the original.
function buildBanner(config: Config | undefined, width: number) {
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
  const authLine = authModelText + hint;

  // Responsive layout mirroring Header.tsx: two-column (ASCII logo + info
  // panel) when wide, single-column info panel when narrow. The outer
  // marginX=2 puts the border in the original's third column.
  const containerMarginX = 2;
  const logoGap = 2;
  const infoPanelChromeWidth = 2 + 1 * 2; // border(2) + paddingX(1*2)
  const minInfoPanelWidth = 40 + infoPanelChromeWidth;
  const available = Math.max(0, width - containerMarginX * 2);
  const logoWidth = getAsciiArtWidth(shortAsciiLogo);
  const showLogo = available >= logoWidth + logoGap + minInfoPanelWidth;
  const maxInfoPanelWidth = 60;
  const infoPanelWidth = showLogo
    ? Math.min(available - logoWidth - logoGap, maxInfoPanelWidth)
    : available;
  const maxPathLength = Math.max(0, infoPanelWidth - infoPanelChromeWidth);
  const displayPath = shortenPath(
    tildeifyPath(targetDir),
    Math.max(3, maxPathLength),
  );

  const infoPanel = (
    <box
      flexDirection="column"
      borderStyle="single"
      paddingX={1}
      width={infoPanelWidth}
      flexGrow={showLogo ? 0 : 1}
    >
      <text fg={C.accent}>{`>_ Qwen Code (${versionLabel})`}</text>
      <text> </text>
      <text fg={C.dim}>{authLine}</text>
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
      <GradientLogo />
      <box width={logoGap} />
      {infoPanel}
    </box>
  );
}

// Cap the confirmation body (diff/command/plan) so a long payload can't
// push the option list off-screen.
const CONFIRM_BODY_MAX_LINES = 12;

// One rendered confirmation body line = a row of colored spans, so a dim
// line-number gutter can sit next to normally colored content.
type ConfirmBodyLine = DiffLine;

function App({
  events,
  config,
  settings: settingsProp,
  initialCapturedInput,
  remoteInputWatcher,
}: {
  events?: AsyncIterable<OpenTuiStreamEvent>;
  config?: Config;
  settings?: LoadedSettings;
  /** Keystrokes captured during startup, injected into the composer. */
  initialCapturedInput?: string;
  remoteInputWatcher?: RemoteInputWatcher;
}) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [streaming, setStreaming] = useState(false);
  const [loadingPhrase, setLoadingPhrase] = useState(WITTY_LOADING_PHRASES[0]);
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
    renderer.clearSelection();
    return true;
  }, [renderer]);

  // copy-on-select: drag text, release → clipboard (like a native terminal)
  useSelectionHandler(async (selection) => {
    if (!selection.getSelectedText()) return;
    await copyActiveSelection();
  });

  // Double/triple-click word/line selection (ink parity): the framework's
  // selection state machine is char-drag only; on the 2nd/3rd click this
  // rewrites its just-started point selection to the word/line span, and
  // release still copies through the handler above.
  const multiClickSelection = useMemo(
    () =>
      new MultiClickSelectionController(
        () => renderer.currentRenderBuffer,
        renderer,
      ),
    [renderer],
  );

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

  useEffect(() => {
    let cancelled = false;
    createOpenTuiSlashDispatcher(host, {
      config: config ?? null,
      settings,
      // Real logger once initialized (cross-session prompt history).
      get logger() {
        return loggerRef.current;
      },
    })
      .then((dispatcher) => {
        if (cancelled) return;
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
    };
  }, [host, config, settings, gateway, applyEvent]);

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
      confirmReq.resolve(ToolConfirmationOutcome.Cancel);
      setConfirmReq(null);
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
        liveAbortRef.current?.abort();
        liveAbortRef.current = null;
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
        confirmReq.resolve(outcome);
        setConfirmReq(null);
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
      // and stop the scripted demo timer.
      liveAbortRef.current?.abort();
      liveAbortRef.current = null;
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
      },
    ) => {
      if (!config) return;
      // Live client wiring: submit to the real agent loop; Esc aborts via the
      // AbortController whose signal reaches client.sendMessageStream.
      liveAbortRef.current?.abort();
      const controller = new AbortController();
      liveAbortRef.current = controller;
      setStreaming(true);
      (async () => {
        try {
          for await (const ev of livePromptEvents(
            config,
            content,
            controller.signal,
            {
              ...(options?.modelOverride
                ? { modelOverride: options.modelOverride }
                : {}),
              drainSteering,
              onWaitingCall: ({ callId, name, confirmationDetails }) => {
                pendingApprovalsRef.current.set(callId, {
                  callId,
                  name,
                  confirmationDetails,
                });
                approvalDialogCallIdRef.current = callId;
                const settleWaitingCall = () => {
                  pendingApprovalsRef.current.delete(callId);
                  if (approvalDialogCallIdRef.current === callId) {
                    approvalDialogCallIdRef.current = null;
                  }
                };
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
            },
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
          if (liveAbortRef.current === controller) liveAbortRef.current = null;
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
      })();
    },
    [config, applyEvent, drainSteering, buildToolConfirmDialog],
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
      setStreaming(true);
      void (async () => {
        try {
          for await (const ev of clientToolEvents(
            config,
            toolName,
            toolArgs,
            controller.signal,
            {
              onWaitingCall: ({ name, confirmationDetails }) =>
                handleSchedulerWaitingCall({ name, confirmationDetails }),
            },
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
          if (liveAbortRef.current === controller) liveAbortRef.current = null;
          setStreaming(false);
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
        .map((i) => ({ id: i.id, text: i.kind === 'user' ? i.text : '' })),
    [items],
  );

  const handleRewind = useCallback(
    async (turn: RewindTurn, option: RestoreOption) => {
      if (!config || option === 'cancel') return;
      try {
        const needsConversation =
          option === 'conversation' || option === 'both';
        // File restore first ('both' validates conversation below).
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
        // Conversation rewind: truncate the transcript before the turn.
        const turnItemIndex = items.findIndex((i) => i.id === turn.id);
        setItems((prev) => {
          const idx = prev.findIndex((p) => p.id === turn.id);
          return idx >= 0 ? prev.slice(0, idx) : prev;
        });
        // Truncate the API history at the user content matching this turn
        // (N-th occurrence — duplicate prompts stay unambiguous).
        const rewindable = rewindTurns.filter((t) => isRewindableTurn(t));
        const rewindIndex = rewindable.findIndex((t) => t.id === turn.id);
        const client = config.getGeminiClient?.();
        const apiHistory = client?.getHistoryShallow?.() ?? [];
        const occurrence = rewindIndex + 1;
        let seen = 0;
        let cut = -1;
        apiHistory.forEach((content, idx) => {
          if (content.role !== 'user' || cut >= 0) return;
          const text = (content.parts ?? [])
            .map((p) => (typeof p.text === 'string' ? p.text : ''))
            .join('');
          if (text.trim() === turn.text.trim()) {
            seen += 1;
            if (seen === occurrence) cut = idx;
          }
        });
        if (cut >= 0) client?.truncateHistory(cut);
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
        if (streamingRef.current || commandProcessingRef.current) {
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
        applyEvent({
          type: 'user',
          text: imageParts.length > 0 ? `${text} 📎${imageParts.length}` : text,
        });
        if (config) {
          // Disk history feed (ink logs submitted prompts via the Logger).
          logSubmittedPrompt(text);
          startLiveTurn(
            imageParts.length > 0 ? [{ text }, ...imageParts] : text,
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
  // needs a DualOutputBridge on this renderer first.
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

  const banner = buildBanner(config, width);

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
        onMouseUp={handleLinkClick}
        onMouseDown={(e) => multiClickSelection.handleMouseDown(e)}
      >
        {banner}
        <box paddingLeft={1} paddingRight={1}>
          <text fg={C.dim}>
            {
              'Tips: Try /insight to generate personalized insights from your chat history.'
            }
          </text>
        </box>
        {items.map((item) => {
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
              liveAbortRef.current?.abort();
              liveAbortRef.current = null;
              setStreaming(false);
            }}
            placeholder="Type your message or @path/to/file"
            focus={
              !dialog &&
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
