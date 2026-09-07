/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * Offline no-flicker harness: mounts a representative streaming transcript on
 * a real CLI renderer so a PTY capture can measure the actual emitted byte
 * stream (full-screen clears, DEC 2026 balance). Needs no model credentials,
 * so it runs on fork PRs where secrets.QWEN_API_KEY is unavailable — the
 * live-model equivalent drives `packages/cli/dist/index.js` with
 * QWEN_TUI_RENDERER=opentui (opentui-noflicker.scenario.json). Exits cleanly
 * on its own — the runner treats timed-out captures as failures.
 *
 * Lives under packages/cli (like the other opentui parity scripts) so bun
 * resolves @opentui/* from the workspace's node_modules.
 *
 * Run with: bun packages/cli/scripts/opentui-demo-harness.tsx
 */
import { useEffect, useState } from 'react';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

const DEMO_RUN_MS = 20000;
const CHUNK_DELAY_MS = 80;

// Scripted "model reply": streamed in line chunks at a chat-like cadence,
// with a fenced code block and a dim status line so the capture exercises
// more than one style of frame update.
const SCRIPT = [
  'The OpenTUI renderer keeps a virtual scrollbox as the single',
  'viewport: ink patch mode and the <Static> escape hatch are',
  'retired on this path.',
  '',
  'Cell-level diffing means a streaming reply only repaints the',
  'cells that changed — never the whole screen:',
  '',
  '```',
  'while (incoming) {',
  '  const cells = diff(prevFrame, nextFrame);',
  '  write(coalesce(cells)); // zero erase sequences',
  '}',
  '```',
  '',
  'DEC 2026 synchronized output frames the update so the terminal',
  'never shows a half-painted screen, and the byte stream stays',
  'balanced: one begin, one end, every time.',
  '',
  'Mouse selection, wheel scrolling and caret placement are',
  'first-class: hover highlights, drag selects, copy on release.',
  '',
  'This stream is scripted; it exists so the no-flicker gate can',
  'measure the renderer without model credentials.',
];

function DemoStream() {
  const [sent, setSent] = useState(1);
  useEffect(() => {
    const timer = setInterval(() => {
      setSent((n) => (n >= SCRIPT.length ? n : n + 1));
    }, CHUNK_DELAY_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <box flexDirection="column" padding={1}>
      {SCRIPT.slice(0, sent).map((line, index) => (
        <text key={index}>{line}</text>
      ))}
      <box marginTop={1}>
        <text fg="#808080">
          {sent >= SCRIPT.length ? 'Ready.' : 'Streaming…'}
        </text>
      </box>
    </box>
  );
}

// Same renderer construction the product entry uses (start-opentui-ui.tsx):
// no Ctrl-C exit (the harness stops itself), mouse enabled.
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
});
createRoot(renderer).render(<DemoStream />);
setTimeout(() => process.exit(0), DEMO_RUN_MS);
