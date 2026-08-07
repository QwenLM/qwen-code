/**
 * A/B reference: the SAME scripted conversation rendered with ink 7.0.3,
 * reproducing qwen-code's write pattern (eraseLines + full-frame rewrite,
 * 30fps throttle). Run this side-by-side with `bun src/main.tsx` (opentui)
 * on Warp / Tabby / PowerShell to compare flicker directly.
 *
 * Run:  bun src-ink/ink-demo.tsx
 */
import { Box, render, Text } from "ink";
import React, { useEffect, useState } from "react";
import { buildScenario, TOKEN_INTERVAL_MS, type StreamEvent } from "./../src/stream-script";

type Item = { id: number; text: string; dim?: boolean };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const queue: StreamEvent[] = buildScenario();
    setStreaming(true);
    let id = 0;
    const timer = setInterval(() => {
      const ev = queue.shift();
      if (!ev) return;
      setTick((t) => t + 1);
      setItems((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        const appendToLast = (s: string) => {
          if (last) next[next.length - 1] = { ...last, text: last.text + s };
          else next.push({ id: id++, text: s });
        };
        switch (ev.type) {
          case "thinking":
          case "text":
          case "tool-output":
            appendToLast(ev.delta);
            break;
          case "thinking-end":
            break;
          case "tool-start":
            next.push({ id: id++, text: `● ${ev.title}\n`, dim: true });
            break;
          case "tool-end":
            break;
          case "task-start":
            next.push({ id: id++, text: `◆ Task — ${ev.description}\n`, dim: true });
            break;
          case "task-progress":
            appendToLast(`  ${ev.line}\n`);
            break;
          case "task-end":
            break;
          case "done":
            setStreaming(false);
            clearInterval(timer);
            break;
        }
        return next;
      });
    }, TOKEN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box flexDirection="column">
      <Text color="green">❯ 分析 VP 模式的渲染性能问题，给出优化建议</Text>
      {items.map((item) => (
        <Text key={item.id} color={item.dim ? "gray" : undefined} wrap="wrap">
          {item.text}
        </Text>
      ))}
      <Text color={streaming ? "cyan" : "gray"}>
        {streaming ? `${SPINNER[tick % SPINNER.length]} streaming… (Ctrl+C quits)` : "done · Ctrl+C quits"}
      </Text>
    </Box>
  );
}

render(<App />, { exitOnCtrlC: true });
