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
  livePhase,
  settleOpenTools,
  type LiveHistoryItem,
  type LivePhase,
  type LiveToolItem,
} from './live-session-model.js';
import type { ApprovalMode, Config } from '@qwen-code/qwen-code-core';
import {
  findProviderByCredentials,
  resolveMetadataKey,
  tildeifyPath,
} from '@qwen-code/qwen-code-core';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import type { PartListUnion } from '@google/genai';
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
  resolveDispatchOutcome,
  type BackendAction,
  type MountedDialog,
} from './command-bridge.js';
import { OpenTuiDialogMount } from './dialog-mount.js';
import { loadSettings } from '../../config/settings.js';
import type { SlashCommand } from '../commands/types.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let spinnerTick = 0;
const nextSpinner = () => SPINNER[spinnerTick++ % SPINNER.length];

const PHASE_LABEL: Record<LivePhase, string> = {
  idle: '',
  thinking: 'thinking',
  tool: 'running tool',
  approving: 'awaiting approval',
  responding: 'responding',
};

/** One-line truncated preview of the tool-call args JSON. */
const argsPreview = (args: string) => {
  const line = args.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

function ThinkingBlock(props: {
  item: Extract<LiveHistoryItem, { kind: 'thinking' }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { item, expanded, onToggle } = props;
  const [hover, setHover] = useState(false);
  const renderer = useRenderer();
  const label = !item.done
    ? `∵ Thinking…`
    : expanded
      ? `∴ Thought (${item.text.length} chars) · click to collapse`
      : `∴ Thought (${item.text.length} chars) · click to expand`;
  return (
    <box flexDirection="column" marginTop={0}>
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
        <text fg={C.purple} attributes={1}>
          {label}
        </text>
      </box>
      {expanded && item.text.length > 0 && (
        <box paddingLeft={3} marginTop={0}>
          <text fg={C.dim}>{item.text}</text>
        </box>
      )}
    </box>
  );
}

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
  const hint = item.done
    ? expanded
      ? ' · click to collapse'
      : ' · click to expand'
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
        <text fg={iconColor}>{icon} </text>
        <text fg={item.done ? C.dim : C.text}>
          {item.title}
          {suffix}
          {hint}
        </text>
        {confirmLabel && <text fg={C.yellow}>{confirmLabel}</text>}
      </box>
      {item.args && (
        <box paddingLeft={3}>
          <text fg={C.dim}>{argsPreview(item.args)}</text>
        </box>
      )}
      {expanded && item.output.length > 0 && (
        <box paddingLeft={3} marginTop={0}>
          <code
            content={item.output}
            filetype="txt"
            syntaxStyle={SYNTAX}
            fg={C.dim}
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
    <box paddingLeft={1} marginTop={0}>
      <markdown
        content={item.text}
        streaming={item.streaming}
        syntaxStyle={SYNTAX}
        fg={C.text}
      />
    </box>
  );
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

/** Original-style header banner. Stable: depends only on config/width, so it
 *  does not re-render on streaming; resize re-renders without flicker via the
 *  erase-free painter. */
// Faithful port of the original ink Header (components/Header.tsx): a
// single-border info panel with 4 lines — title(+version), blank spacer,
// auth|model(+hint), directory. Same data sources as the original.
function buildBanner(config: Config | undefined, _width: number) {
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
  const path = tildeifyPath(targetDir);
  return (
    <box
      flexDirection="column"
      borderStyle="single"
      marginLeft={1}
      marginRight={1}
      flexShrink={0}
    >
      <text fg={C.accent}>{`>_ Qwen Code (${versionLabel})`}</text>
      <text> </text>
      <text fg={C.dim}>{authModelText + hint}</text>
      <text fg={C.dim}>{path}</text>
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
  const [toast, setToast] = useState<string | null>(null);
  const [, setThemeTick] = useState(0);
  const [dialog, setDialog] = useState<MountedDialog | null>(null);
  const [commands, setCommands] = useState<readonly SlashCommand[]>([]);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode | undefined>(
    () => config?.getApprovalMode(),
  );
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
      renderer
        .waitForThemeMode(1000)
        .then((m) => {
          if (m) onMode(m);
        })
        .catch(() => {});
    }
    return () => {
      renderer.off('theme_mode', onMode);
    };
  }, [renderer]);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueRef = useRef<OpenTuiStreamEvent[]>([]);
  const liveAbortRef = useRef<AbortController | null>(null);

  // Streaming phase for the status bar / spinner / border (F1.1).
  const phase = livePhase(items, streaming);

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

  const dispatcherRef = useRef<OpenTuiSlashDispatcher | null>(null);
  const gatewayRef = useRef<OpenTuiSlashGateway | null>(null);
  if (!gatewayRef.current) gatewayRef.current = new OpenTuiSlashGateway();
  const gateway = gatewayRef.current;
  const host = useMemo(
    () =>
      createBackendCommandHost({
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
      }),
    [applyEvent],
  );

  useEffect(() => {
    let cancelled = false;
    createOpenTuiSlashDispatcher(host, {
      config: config ?? null,
      settings,
      logger: null,
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
      if (replay) for (const ev of replay) applyEvent(ev);
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
    if (key.name === 'c' && key.ctrl) {
      renderer.destroy();
      setTimeout(() => process.exit(0), 100);
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

  const userPrompts = items
    .filter((i) => i.kind === 'user')
    .map((i) => (i.kind === 'user' ? i.text : ''));

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
            options?.modelOverride
              ? { modelOverride: options.modelOverride }
              : undefined,
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
        }
      })();
    },
    [config, applyEvent],
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
        case 'quit':
          applyEvent({ type: 'done' });
          renderer.destroy();
          setTimeout(() => process.exit(0), 100);
          return;
        case 'unsupported':
          applyEvent({ type: 'text', delta: action.message });
          applyEvent({ type: 'done' });
          return;
      }
    },
    [applyEvent, config, renderer, startLiveTurn],
  );

  const submitText = useCallback(
    (raw: string) => {
      void (async () => {
        const text = raw.trim();
        if (!text) return;
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
        applyEvent({ type: 'user', text });
        if (config) {
          startLiveTurn(text);
          return;
        }
        startStream(); // scripted: every submission replays the scenario
      })();
    },
    [applyEvent, applySlashAction, config, gateway, startLiveTurn, startStream],
  );

  const banner = buildBanner(config, width);

  return (
    <box flexDirection="column" width={width} height="100%">
      {banner}
      {/* chat viewport — replaces qwen-code VP mode */}
      <scrollbox
        flexGrow={1}
        minHeight={0}
        stickyScroll={true}
        stickyStart="bottom"
        verticalScrollbarOptions={{ visible: true }}
        marginTop={0}
      >
        <box height={1} />
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
                  <text fg={C.green} attributes={1}>
                    ❯{' '}
                  </text>
                  <text fg={C.text} attributes={1}>
                    {item.text}
                  </text>
                </box>
              );
            case 'thinking':
              return (
                <ThinkingBlock
                  key={item.id}
                  item={item}
                  expanded={expanded.has(item.id)}
                  onToggle={toggle}
                />
              );
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
        />
      )}

      {/* status bar */}
      <box paddingLeft={1} paddingRight={1}>
        <text fg={C.dim}>
          {streaming
            ? `${nextSpinner()} streaming… (${PHASE_LABEL[phase]}) (Esc interrupt · Ctrl+C quit)`
            : commandProcessing
              ? `${nextSpinner()} running command… (Esc cancel · Ctrl+C quit)`
              : `ready · click cards to expand · drag text to copy · wheel to scroll (Ctrl+C quit)`}
          {toast ? `   ${toast}` : ''}
        </text>
      </box>

      {/* prompt */}
      <box
        borderStyle="single"
        borderColor={streaming ? C.yellow : C.accent}
        marginLeft={1}
        marginRight={1}
      >
        <OpenTuiInputPrompt
          onSubmit={submitText}
          userMessages={userPrompts}
          config={config}
          approvalMode={approvalMode}
          streaming={streaming || commandProcessing}
          onInterrupt={() => {
            // Esc while a slash command runs cancels it (dispatcher.cancel);
            // otherwise it interrupts the live model turn.
            if (commandProcessingRef.current) {
              gateway.cancel();
              return;
            }
            liveAbortRef.current?.abort();
            liveAbortRef.current = null;
            setStreaming(false);
          }}
          placeholder="Ask anything… (Enter submits, Shift+Enter for newline)"
          focus={!dialog}
        />
      </box>
    </box>
  );
}

export { App };
