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
import { C, SYNTAX, applyThemeMode } from './theme.js';
import { detectInitialThemeMode } from './theme-auto.js';
import { selectionProps } from './messages.js';
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
  type LiveThinkingItem,
  type LiveToolItem,
} from './live-session-model.js';
import { formatDuration } from '../utils/displayUtils.js';
import {
  ApprovalMode,
  Logger,
  MessageSenderType,
  ToolConfirmationOutcome,
  type Config,
  type ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import { isPrintableKeyInput } from './input-prompt-key.js';
import {
  findProviderByCredentials,
  resolveMetadataKey,
  tildeifyPath,
  shortenPath,
  uiTelemetryService,
} from '@qwen-code/qwen-code-core';
import { fmtTokens } from '../components/stats-helpers.js';
import type { ScrollBoxRenderable } from '@opentui/core';
import { shortAsciiLogo } from '../components/AsciiArt.js';
import { getAsciiArtWidth } from '../utils/textUtils.js';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { execSync } from 'node:child_process';
import type { Part, PartListUnion } from '@google/genai';
import { livePromptEvents } from './live-session.js';
import { resumeEventsFromConfig } from './resume-session.js';
import { isSlashCommandInput } from './slash-dispatch.js';
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
import { OpenTuiDialogMount } from './dialog-mount.js';
import { loadSettings } from '../../config/settings.js';
import type { SlashCommand } from '../commands/types.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let spinnerTick = 0;
const nextSpinner = () => SPINNER[spinnerTick++ % SPINNER.length];

/** One-line truncated preview of the tool-call args JSON. */
const argsPreview = (args: string) => {
  const line = args.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
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

const toolDisplayName = (name: string) =>
  name
    .split(/[_-]/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');

function toolDescription(name: string, args: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(args);
  } catch {
    return '';
  }
  const path = (a['file_path'] ?? a['path'] ?? a['filePath']) as
    | string
    | undefined;
  const cmd = (a['command'] ?? a['cmd']) as string | undefined;
  const base = (p?: string) => (p ? nodePath.basename(p) : '');
  switch (name) {
    case 'write_file':
      return path ? `Writing to ${base(path)}` : '';
    case 'read_file':
      return path ? `Reading ${base(path)}` : '';
    case 'list_directory':
      return path ? `Listing ${path}` : 'Listing .';
    case 'run_shell_command':
      return cmd ? argsPreview(cmd) : '';
    default:
      return '';
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
  const suffix = item.done && item.summary ? ` · ${item.summary}` : '';
  const confirmLabel =
    item.confirm === 'pending'
      ? ' · awaiting approval…'
      : item.confirm === 'rejected'
        ? ' · rejected'
        : '';
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
            {toolDisplayName(item.title)}
          </text>
          <text fg={C.dim}>
            {` ${toolDescription(item.title, item.args ?? '')}${suffix}`}
          </text>
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
  // panel) when wide, single-column info panel when narrow.
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
      <box marginLeft={1} marginRight={1} flexShrink={0}>
        {infoPanel}
      </box>
    );
  }
  return (
    <box
      flexDirection="row"
      alignItems="center"
      marginLeft={1}
      marginRight={1}
      flexShrink={0}
    >
      <GradientLogo />
      <box width={logoGap} />
      {infoPanel}
    </box>
  );
}

function App({
  events,
  config,
}: {
  events?: AsyncIterable<OpenTuiStreamEvent>;
  config?: Config;
}) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
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

  // The real settings stack (the opentui entry only receives `config`),
  // feeding the command services and the settings/theme/permissions dialogs.
  const settings = useMemo(
    () => loadSettings(config?.getWorkingDir() ?? process.cwd()),
    [config],
  );

  // Live light/dark theme switching (OSC 10/11 + mode 2031 updates).
  useEffect(() => {
    const onMode = (mode: 'dark' | 'light') => {
      applyThemeMode(mode);
      setThemeTick((t) => t + 1);
    };
    renderer.on('theme_mode', onMode);
    // Env override wins (QWEN_THEME=light|dark) for terminals where OSC 10/11
    // detection fails; otherwise initial detection.
    const envTheme = process.env['QWEN_THEME'];
    if (envTheme === 'light' || envTheme === 'dark') {
      onMode(envTheme);
    } else {
      // Ink parity chain (COLORFGBG → OSC 10/11 probe → macOS appearance →
      // dark) so terminals that never answer the OSC probe (Warp) still get
      // the right palette instead of staying dark-on-light.
      void detectInitialThemeMode(renderer, 1000).then(onMode);
    }
    return () => {
      renderer.off('theme_mode', onMode);
    };
  }, [renderer]);

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
  const approvalModeRef = useRef(approvalMode);
  useEffect(() => {
    approvalModeRef.current = approvalMode;
  }, [approvalMode]);
  const [confirmReq, setConfirmReq] = useState<{
    names: string;
    resolve: (b: boolean) => void;
  } | null>(null);
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

  // copy-on-select: drag text, release → clipboard (like a native terminal)
  useSelectionHandler(async (selection) => {
    const text = selection.getSelectedText();
    if (!text) return;
    const ok = await copyText(text);
    setToast(
      ok
        ? `✓ Copied ${text.length} chars to clipboard`
        : '⚠ Clipboard write failed',
    );
    setTimeout(() => setToast(null), 1500);
    renderer.clearSelection();
  });

  const applyEvent = useCallback((ev: OpenTuiStreamEvent) => {
    setItems((prev) => foldLiveEvent(prev, ev));
    if (ev.type === 'done') {
      setStreaming(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  }, []);

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

  useKeyboard((key) => {
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
      if (key.name === 'y') {
        confirmReq.resolve(true);
        setConfirmReq(null);
      } else if (key.name === 'n' || key.name === 'escape') {
        confirmReq.resolve(false);
        setConfirmReq(null);
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
    if (key.name === 'c' && key.ctrl) {
      renderer.destroy();
      setTimeout(() => process.exit(0), 100);
      return;
    }
    if (key.name === 'd' && key.ctrl) {
      renderer.destroy();
      setTimeout(() => process.exit(0), 100);
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
      // cycle approval mode (mirrors original Shift+Tab)
      const order = [
        ApprovalMode.DEFAULT,
        ApprovalMode.AUTO_EDIT,
        ApprovalMode.AUTO,
        ApprovalMode.YOLO,
      ];
      const idx = order.indexOf(approvalMode ?? ApprovalMode.DEFAULT);
      setApprovalMode(order[(idx + 1) % order.length]);
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

  // Scheduler awaiting_approval parity, shared by the live turn and the
  // client-initiated command tools (/restore, /setup-github).
  const handleSchedulerWaitingCall = useCallback(
    (call: {
      name: string;
      confirmationDetails: ToolCallConfirmationDetails;
    }) => {
      const { name, confirmationDetails } = call;
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
        setConfirmReq({
          names: `${name} needs approval`,
          resolve: (ok) => {
            void confirmationDetails.onConfirm(
              ok
                ? ToolConfirmationOutcome.ProceedOnce
                : ToolConfirmationOutcome.Cancel,
            );
          },
        });
      }
    },
    [],
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
              ...(approvalModeRef.current === ApprovalMode.DEFAULT
                ? {
                    confirmBatch: (reqs: Array<{ name: string }>) =>
                      new Promise<boolean>((resolve) => {
                        setConfirmReq({
                          names: reqs.map((r) => r.name).join(', '),
                          resolve,
                        });
                      }),
                  }
                : {}),
              drainSteering,
              onWaitingCall: handleSchedulerWaitingCall,
            },
          ))
            applyEvent(ev);
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
        } finally {
          if (liveAbortRef.current === controller) liveAbortRef.current = null;
          setStreaming(false);
          const next = queuedPromptsRef.current.shift();
          setQueuedPrompts([...queuedPromptsRef.current]);
          if (next) setTimeout(() => submitTextRef.current?.(next), 50);
        }
      })();
    },
    [config, applyEvent, drainSteering, handleSchedulerWaitingCall],
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
          // Render the farewell (session summary + resume hint) before
          // tearing down (audit 01 G-17); the user-echo item is skipped —
          // the invocation already echoed.
          for (const message of action.messages) {
            if (message.type === 'user') continue;
            const event = projectCommandItem(message, {
              config,
              stats: host.sessionStats,
              extensionsUpdateState: host.extensionsUpdateState,
            });
            if (event) applyEvent(event);
          }
          applyEvent({ type: 'done' });
          renderer.destroy();
          setTimeout(() => process.exit(0), 400);
          return;
        }
        case 'unsupported':
          applyEvent({ type: 'text', delta: action.message });
          applyEvent({ type: 'done' });
          return;
      }
    },
    [applyEvent, config, renderer, startLiveTurn, scheduleClientTool, host],
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

  const banner = buildBanner(config, width);

  // footer (mirrors original Footer): project · git · model + approval mode
  const footerProject = nodePath.basename(process.cwd());
  let footerBranch = '';
  try {
    footerBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    footerBranch = '';
  }
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
  const contextPct =
    contextWindowSize && promptTokenCount > 0
      ? ((promptTokenCount / contextWindowSize) * 100).toFixed(1)
      : null;
  const footerLine1 =
    `→ ${footerProject}` +
    (sessionName ? ` · ${sessionName}` : '') +
    (footerBranch ? ` · git:(${footerBranch})` : '') +
    (footerModel ? ` · ${footerModel}` : '') +
    (contextWindowSize ? ` · ${fmtTokens(contextWindowSize)} Context` : '') +
    (contextPct ? ` ${contextPct}% used` : '') +
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
            <box
              flexDirection="column"
              border
              borderColor={C.yellow}
              paddingLeft={1}
              paddingRight={1}
              marginTop={1}
            >
              <text fg={C.yellow} attributes={1}>
                {`Approve tool: ${confirmReq.names}?`}
              </text>
              <text fg={C.dim}>{'press y to approve · n / esc to cancel'}</text>
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
              {queuedPrompts.slice(0, 3).map((m, i) => (
                <text key={`${i}-${m}`} fg={C.dim}>
                  {m.replace(/\s+/g, ' ')}
                </text>
              ))}
              {queuedPrompts.length > 3 && (
                <text
                  fg={C.dim}
                >{`... (+${queuedPrompts.length - 3} more)`}</text>
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
              !dialog && !questionReq && !actionConfirmReq && !shellConfirmReq
            }
            composerHandle={composerHandle}
          />
        </box>
        {/* footer */}
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
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
          {contextPct != null && (
            <text fg={C.dim}>{`${contextPct}% used`}</text>
          )}
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
          notify={(text) => {
            applyEvent({ type: 'text', delta: text });
            applyEvent({ type: 'done' });
          }}
          onApprovalModeChanged={setApprovalMode}
          onResume={(sessionId) => void host.handleResume(sessionId)}
          rewind={rewindData}
        />
      )}
    </box>
  );
}

export { App };
