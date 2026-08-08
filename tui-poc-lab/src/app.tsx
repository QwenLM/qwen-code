/**
 * qwen-code × OpenTUI POC — chat app demonstrating:
 *  1. streaming markdown via opentui incremental parser (<markdown streaming>)
 *  2. scrollbox viewport replacing qwen-code VP mode (sticky bottom)
 *  3. mouse-first interactions: click to expand/collapse, wheel scroll,
 *     drag-select + auto copy (native-terminal-like)
 *  4. flicker-free rendering (cell diff + DEC 2026, handled by the renderer)
 */
import { MouseButton } from "@opentui/core";
import { C, SYNTAX, applyThemeMode } from "./theme";
import {
  useKeyboard,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditBufferRenderable } from "@opentui/core";
import { copyText } from "./clipboard";
import { buildScenario, TOKEN_INTERVAL_MS, type StreamEvent } from "./stream-script";

// ---------------------------------------------------------------------------
// state model
// ---------------------------------------------------------------------------

type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string; done: boolean }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      tool: string;
      title: string;
      output: string;
      done: boolean;
      success?: boolean;
      summary?: string;
    }
  | {
      kind: "task";
      id: string;
      name: string;
      description: string;
      progress: string[];
      done: boolean;
      stats?: string;
    };


const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let spinnerTick = 0;
const nextSpinner = () => SPINNER[spinnerTick++ % SPINNER.length];

let uid = 0;
const nid = (p: string) => `${p}${++uid}`;

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

function ThinkingBlock(props: {
  item: Extract<ChatItem, { kind: "thinking" }>;
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
  item: Extract<ChatItem, { kind: "tool" }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { item, expanded, onToggle } = props;
  const [hover, setHover] = useState(false);
  const renderer = useRenderer();

  const icon = !item.done ? nextSpinner() : item.success ? "✓" : "✗";
  const iconColor = !item.done ? C.accent : item.success ? C.green : C.red;
  const suffix = item.done && item.summary ? ` · ${item.summary}` : "";
  const hint = item.done ? (expanded ? " · click to collapse" : " · click to expand") : "";

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
      </box>
      {expanded && item.output.length > 0 && (
        <box paddingLeft={3} marginTop={0}>
          <code content={item.output} filetype="txt" syntaxStyle={SYNTAX} fg={C.dim} />
        </box>
      )}
    </box>
  );
}

function TaskCard(props: {
  item: Extract<ChatItem, { kind: "task" }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { item, expanded, onToggle } = props;
  const [hover, setHover] = useState(false);
  const renderer = useRenderer();
  const icon = !item.done ? nextSpinner() : "✓";
  const iconColor = !item.done ? C.accent : C.green;
  const suffix = item.done && item.stats ? ` · ${item.stats}` : "";
  const live = !item.done && item.progress.length > 0 ? item.progress[item.progress.length - 1] : undefined;

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
          {item.done ? (expanded ? " · click to collapse" : " · click to expand") : ""}
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

function AssistantMessage(props: { item: Extract<ChatItem, { kind: "assistant" }> }) {
  const { item } = props;
  return (
    <box paddingLeft={1} marginTop={0}>
      <markdown content={item.text} streaming={item.streaming} syntaxStyle={SYNTAX} fg={C.text} />
    </box>
  );
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

function App() {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [streaming, setStreaming] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [, setThemeTick] = useState(0);

  // Live light/dark theme switching (OSC 10/11 + mode 2031 updates).
  useEffect(() => {
    const onMode = (mode: "dark" | "light") => {
      applyThemeMode(mode);
      setThemeTick((t) => t + 1);
    };
    renderer.on("theme_mode", onMode);
    return () => {
      renderer.off("theme_mode", onMode);
    };
  }, [renderer]);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueRef = useRef<StreamEvent[]>([]);
  const promptRef = useRef<EditBufferRenderable | null>(null);

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
    setToast(ok ? `✓ Copied ${text.length} chars to clipboard` : "⚠ Clipboard write failed");
    setTimeout(() => setToast(null), 1500);
    renderer.clearSelection();
  });

  const applyEvent = useCallback((ev: StreamEvent) => {
    setItems((prev) => {
      const items = [...prev];
      const last = items[items.length - 1];
      switch (ev.type) {
        case "thinking": {
          if (last?.kind === "thinking" && !last.done) {
            items[items.length - 1] = { ...last, text: last.text + ev.delta };
          } else {
            items.push({ kind: "thinking", id: nid("th"), text: ev.delta, done: false });
          }
          return items;
        }
        case "thinking-end": {
          if (last?.kind === "thinking") items[items.length - 1] = { ...last, done: true };
          return items;
        }
        case "text": {
          if (last?.kind === "assistant" && last.streaming) {
            items[items.length - 1] = { ...last, text: last.text + ev.delta };
          } else {
            items.push({ kind: "assistant", id: nid("as"), text: ev.delta, streaming: true });
          }
          return items;
        }
        case "tool-start":
          if (last?.kind === "assistant" && last.streaming)
            items[items.length - 1] = { ...last, streaming: false };
          items.push({ kind: "tool", id: ev.id, tool: ev.tool, title: ev.title, output: "", done: false });
          return items;
        case "tool-output": {
          const i = items.findIndex((it) => it.kind === "tool" && it.id === ev.id);
          if (i >= 0 && items[i].kind === "tool") {
            const t = items[i] as Extract<ChatItem, { kind: "tool" }>;
            items[i] = { ...t, output: t.output + ev.delta };
          }
          return items;
        }
        case "tool-end": {
          const i = items.findIndex((it) => it.kind === "tool" && it.id === ev.id);
          if (i >= 0 && items[i].kind === "tool") {
            const t = items[i] as Extract<ChatItem, { kind: "tool" }>;
            items[i] = { ...t, done: true, success: ev.success, summary: ev.summary };
          }
          return items;
        }
        case "task-start":
          if (last?.kind === "assistant" && last.streaming)
            items[items.length - 1] = { ...last, streaming: false };
          items.push({ kind: "task", id: ev.id, name: ev.name, description: ev.description, progress: [], done: false });
          return items;
        case "task-progress": {
          const i = items.findIndex((it) => it.kind === "task" && it.id === ev.id);
          if (i >= 0 && items[i].kind === "task") {
            const t = items[i] as Extract<ChatItem, { kind: "task" }>;
            items[i] = { ...t, progress: [...t.progress.slice(-2), ev.line] };
          }
          return items;
        }
        case "task-end": {
          const i = items.findIndex((it) => it.kind === "task" && it.id === ev.id);
          if (i >= 0 && items[i].kind === "task") {
            const t = items[i] as Extract<ChatItem, { kind: "task" }>;
            items[i] = { ...t, done: true, stats: `${ev.tools} tools · ${ev.seconds}s · ${ev.tokens} tokens` };
          }
          return items;
        }
        case "done": {
          if (last?.kind === "assistant" && last.streaming)
            items[items.length - 1] = { ...last, streaming: false };
          return items;
        }
      }
    });
    if (ev.type === "done") {
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

  // auto-start the scripted conversation
  useEffect(() => {
    setItems([{ kind: "user", id: nid("u"), text: "分析 VP 模式的渲染性能问题，给出优化建议" }]);
    const t = setTimeout(startStream, 400);
    return () => {
      clearTimeout(t);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startStream]);

  useKeyboard((key) => {
    if (key.name === "c" && key.ctrl) {
      renderer.destroy();
      setTimeout(() => process.exit(0), 100);
      return;
    }
    if (key.name === "escape" && streaming) {
      // interrupt the stream
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      queueRef.current = [];
      setStreaming(false);
      setToast("✗ Interrupted");
      setTimeout(() => setToast(null), 1200);
    }
  });

  const onSubmit = useCallback(() => {
    const el = promptRef.current;
    const text = (el?.plainText ?? "").trim();
    el?.clear();
    el?.requestRender();
    if (!text) return;
    setItems((prev) => [...prev, { kind: "user", id: nid("u"), text }]);
    startStream(); // scripted: every submission replays the scenario
  }, [startStream]);

  return (
    <box flexDirection="column" width={width} height="100%">
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
            case "user":
              return (
                <box key={item.id} flexDirection="row" paddingLeft={1} marginTop={1}>
                  <text fg={C.green} attributes={1}>
                    ❯{" "}
                  </text>
                  <text fg={C.text} attributes={1}>
                    {item.text}
                  </text>
                </box>
              );
            case "thinking":
              return (
                <ThinkingBlock
                  key={item.id}
                  item={item}
                  expanded={expanded.has(item.id)}
                  onToggle={toggle}
                />
              );
            case "assistant":
              return <AssistantMessage key={item.id} item={item} />;
            case "tool":
              return (
                <ToolCard
                  key={item.id}
                  item={item}
                  expanded={expanded.has(item.id)}
                  onToggle={toggle}
                />
              );
            case "task":
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

      {/* status bar */}
      <box paddingLeft={1} paddingRight={1}>
        <text fg={C.dim}>
          {streaming
            ? `${nextSpinner()} streaming… (Esc interrupt · Ctrl+C quit)`
            : `ready · click cards to expand · drag text to copy · wheel to scroll (Ctrl+C quit)`}
          {toast ? `   ${toast}` : ""}
        </text>
      </box>

      {/* prompt */}
      <box borderStyle="single" borderColor={streaming ? C.yellow : C.accent} marginLeft={1} marginRight={1}>
        <textarea
          ref={(el: EditBufferRenderable | null) => {
            promptRef.current = el;
          }}
          focused
          onSubmit={onSubmit}
          placeholder="Ask anything… (Enter submits — replays the scripted scenario)"
          placeholderColor={C.dim}
          flexGrow={1}
          height={3}
        />
      </box>
    </box>
  );
}

export { App };
