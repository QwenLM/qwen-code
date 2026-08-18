/** @jsxImportSource @opentui/react */
/**
 * Offline no-flicker harness: mounts the REAL OpenTUI backend (`App` with no
 * config → scripted demo stream) on a real CLI renderer so a PTY capture can
 * measure the actual emitted byte stream (full-screen clears, DEC 2026
 * balance). Needs no model credentials, so it runs on fork PRs where
 * secrets.QWEN_API_KEY is unavailable. Exits cleanly on its own — the runner
 * treats timed-out captures as failures.
 *
 * Lives under packages/cli (like the other opentui parity scripts) so bun
 * resolves @opentui/* from the workspace's node_modules.
 *
 * Run with: bun packages/cli/scripts/opentui-demo-harness.tsx
 */
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from '../src/ui/opentui/backend.js';

const DEMO_RUN_MS = 20000;

const renderer = await createCliRenderer({
  targetFps: 60,
  useKittyKeyboard: {},
  useMouse: true,
  exitOnCtrlC: false,
  externalOutputMode: 'passthrough',
  autoFocus: true,
});
createRoot(renderer).render(<App />);
setTimeout(() => process.exit(0), DEMO_RUN_MS);
