/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase-2 ground-truth capture (NOT a CI test — needs a real `qwen serve` + a
 * reachable model). Spawns a daemon, attaches a session, drives ONE text turn,
 * and records the real `events()` frame sequence so the `useDaemonStream`
 * projection can be built against actual shapes/ordering, not guesses.
 *
 *   npx tsx scripts/capture-daemon-frames.mts
 *   CAPTURE_PROMPT="List the files here using your tools" \
 *     CAPTURE_OUT=/tmp/daemon-tool-frames.json npx tsx scripts/capture-daemon-frames.mts
 *
 * To capture a REAL `permission_request` (the approval slice's ground truth),
 * force a GATING approval mode and prompt for a non-read tool — reads are
 * auto-approved, writes/shell gate in `default`/`plan`:
 *   CAPTURE_APPROVAL_MODE=default \
 *     CAPTURE_PROMPT="Create a file named hello.txt containing the word hi" \
 *     CAPTURE_OUT=/tmp/daemon-perm-frames.json npx tsx scripts/capture-daemon-frames.mts
 *
 * If a `qwen serve` is ALREADY running (e.g. the daemon a --attach-daemon TUI
 * connects to), attach to it instead of spawning — avoids `spawn qwen` PATH /
 * permission problems and captures against the exact daemon you're using:
 *   CAPTURE_ATTACH_URL=http://127.0.0.1:<port> CAPTURE_ATTACH_TOKEN=<token> \
 *     CAPTURE_APPROVAL_MODE=default CAPTURE_PROMPT="…a write/shell task…" \
 *     CAPTURE_OUT=/tmp/daemon-perm-frames.json npx tsx scripts/capture-daemon-frames.mts
 * (When spawning, set CAPTURE_QWEN_BIN to the fork's bin if a bare `qwen` isn't
 * on PATH / executable.)
 *
 * Writes the full frame log to $CAPTURE_OUT (default /tmp/daemon-frames.json)
 * and prints a type histogram. SAFE: any `permission_request` is immediately
 * DECLINED (`outcome: { outcome: 'cancelled' }`), so a tool the model proposes
 * never executes — we only capture the request shape.
 */
import { writeFileSync } from 'node:fs';
import { startDaemon } from '../src/daemonSupervisor.js';
import {
  DaemonSessionClient,
  DAEMON_APPROVAL_MODES,
  type DaemonApprovalMode,
} from '@qwen-code/sdk';

const PORT = Number(process.env['CAPTURE_PORT'] ?? 4195);
const OUT = process.env['CAPTURE_OUT'] ?? '/tmp/daemon-frames.json';
const PROMPT_TEXT =
  process.env['CAPTURE_PROMPT'] ??
  'Reply with exactly the word PONG and nothing else.';
const captured: Array<{
  type: string;
  id?: number;
  originatorClientId?: string;
  data: unknown;
}> = [];

function short(v: unknown, n = 240): string {
  try {
    const s = JSON.stringify(v);
    return s && s.length > n ? s.slice(0, n) + '…' : (s ?? String(v));
  } catch {
    return String(v);
  }
}

// Two ways to get a daemon:
//  - ATTACH to an already-running one (set CAPTURE_ATTACH_URL [+ _TOKEN]); the
//    capture creates its own fresh session and never touches the daemon's
//    lifecycle. Use this when a `qwen serve` is already up (e.g. the one your
//    --attach-daemon TUI connects to) — it sidesteps `spawn qwen` PATH/permission
//    issues entirely.
//  - SPAWN a throwaway daemon (default). The launcher is `qwen` on PATH unless
//    CAPTURE_QWEN_BIN points at the right executable (e.g. an absolute path to
//    the fork's bin when a bare `qwen` isn't on PATH / not executable).
const ATTACH_URL = process.env['CAPTURE_ATTACH_URL'];
const handle = ATTACH_URL
  ? await startDaemon({
      attach: { url: ATTACH_URL, token: process.env['CAPTURE_ATTACH_TOKEN'] ?? '' },
      readyTimeoutMs: 15000,
    })
  : await startDaemon({
      qwenBin: process.env['CAPTURE_QWEN_BIN'] ?? 'qwen',
      port: PORT,
      readyTimeoutMs: 15000,
    });
console.error(
  ATTACH_URL
    ? `[capture] attached to daemon at ${ATTACH_URL}`
    : `[capture] daemon healthy on :${PORT}`,
);

const sc = await DaemonSessionClient.createOrAttach(handle.daemon, {});
console.error(
  `[capture] session ${sc.sessionId} attached=${sc.attached} cwd=${sc.workspaceCwd}`,
);
console.error(`[capture] OUR clientId = ${sc.clientId}`);

// Optionally force a gating approval mode so a non-read tool produces a real
// `permission_request` to capture. `default`/`plan` are non-privileged, so the
// daemon's trust-folder gate accepts them even in an untrusted workspace.
const APPROVAL_MODE = process.env['CAPTURE_APPROVAL_MODE'];
if (APPROVAL_MODE) {
  if (!(DAEMON_APPROVAL_MODES as readonly string[]).includes(APPROVAL_MODE)) {
    console.error(
      `[capture] ignoring CAPTURE_APPROVAL_MODE='${APPROVAL_MODE}' — not one of ${DAEMON_APPROVAL_MODES.join(', ')}`,
    );
  } else {
    try {
      const res = await handle.daemon.setSessionApprovalMode(
        sc.sessionId,
        APPROVAL_MODE as DaemonApprovalMode,
        { clientId: sc.clientId },
      );
      console.error(
        `[capture] approval mode -> ${short(res)} (requested ${APPROVAL_MODE})`,
      );
    } catch (e) {
      console.error(
        `[capture] setSessionApprovalMode failed: ${(e as Error)?.message ?? e}`,
      );
    }
  }
}

const ac = new AbortController();
let lastFrameAt = Date.now();
let sawAgentFrame = false;
const consumer = (async () => {
  for await (const ev of sc.events({ signal: ac.signal })) {
    const oc = (ev as { originatorClientId?: string }).originatorClientId;
    captured.push({
      type: ev.type,
      id: ev.id,
      originatorClientId: oc,
      data: ev.data,
    });
    lastFrameAt = Date.now();
    const kind = (ev.data as { update?: { sessionUpdate?: string } })?.update
      ?.sessionUpdate;
    if (
      ev.type === 'session_update' &&
      (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
    ) {
      sawAgentFrame = true;
    }
    // SAFETY: decline any tool the model proposes so nothing ever executes —
    // we only want to capture the request shape.
    if (ev.type === 'permission_request') {
      const reqId = (ev.data as { requestId?: string })?.requestId;
      console.error(`[capture] DECLINING permission_request ${reqId}`);
      if (reqId) {
        await sc
          .respondToSessionPermission(reqId, {
            outcome: { outcome: 'cancelled' },
          })
          .catch((e) =>
            console.error('[capture] decline failed:', (e as Error)?.message),
          );
      }
      sawAgentFrame = true; // a tool turn counts as agent activity for idle-exit
    }
    const upd = ev.type === 'session_update' ? ` sessionUpdate=${kind}` : '';
    console.error(`[frame] ${ev.type}${upd} oc=${oc ?? '∅'} ${short(ev.data)}`);
  }
})().catch((e) => console.error('[capture] events ended:', e?.message ?? e));

// Let the SSE subscription establish before prompting.
await new Promise((r) => setTimeout(r, 600));

console.error('[capture] sending prompt…');
try {
  const res = await sc.prompt({
    prompt: [{ type: 'text', text: PROMPT_TEXT }],
  });
  console.error('[capture] prompt() resolved:', short(res, 300));
} catch (e) {
  console.error('[capture] prompt() threw:', (e as Error)?.message ?? e);
}

// Drain: wait up to 60s for the turn, but stop 4s after the last frame once
// agent output has begun (idle-based early exit so we don't truncate the turn).
const HARD_CAP = Date.now() + 60_000;
for (;;) {
  await new Promise((r) => setTimeout(r, 500));
  const idleMs = Date.now() - lastFrameAt;
  if (sawAgentFrame && idleMs > 4000) {
    console.error('[capture] turn idle after agent output — stopping');
    break;
  }
  if (Date.now() > HARD_CAP) {
    console.error('[capture] hard cap reached — stopping');
    break;
  }
}
ac.abort();
await consumer;
await sc.close().catch(() => {});
await handle.stop();

const counts: Record<string, number> = {};
const updKinds: Record<string, number> = {};
for (const f of captured) {
  counts[f.type] = (counts[f.type] ?? 0) + 1;
  if (f.type === 'session_update') {
    const k =
      (f.data as { update?: { sessionUpdate?: string } })?.update
        ?.sessionUpdate ?? '(none)';
    updKinds[k] = (updKinds[k] ?? 0) + 1;
  }
}
console.error('\n=== FRAME TYPE COUNTS ===', JSON.stringify(counts));
console.error('=== session_update kinds ===', JSON.stringify(updKinds));
writeFileSync(OUT, JSON.stringify(captured, null, 2));
console.error(`=== wrote ${captured.length} frames to ${OUT} ===`);
process.exit(0);
