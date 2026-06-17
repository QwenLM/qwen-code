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
 *
 * Writes the full frame log to /tmp/daemon-frames.json and prints a type
 * histogram. Safe: the prompt asks only for a word; if the model calls a tool,
 * we never vote, so nothing executes — we just capture the permission_request.
 */
import { writeFileSync } from 'node:fs';
import { startDaemon } from '../src/daemonSupervisor.js';
import { DaemonSessionClient } from '@qwen-code/sdk';

const PORT = 4195;
const captured: Array<{ type: string; id?: number; data: unknown }> = [];

function short(v: unknown, n = 240): string {
  try {
    const s = JSON.stringify(v);
    return s && s.length > n ? s.slice(0, n) + '…' : (s ?? String(v));
  } catch {
    return String(v);
  }
}

const handle = await startDaemon({ port: PORT, readyTimeoutMs: 15000 });
console.error(`[capture] daemon healthy on :${PORT}`);

const sc = await DaemonSessionClient.createOrAttach(handle.daemon, {});
console.error(
  `[capture] session ${sc.sessionId} attached=${sc.attached} cwd=${sc.workspaceCwd}`,
);
console.error(`[capture] OUR clientId = ${sc.clientId}`);

const ac = new AbortController();
let lastFrameAt = Date.now();
let sawAgentFrame = false;
const consumer = (async () => {
  for await (const ev of sc.events({ signal: ac.signal })) {
    captured.push({ type: ev.type, id: ev.id, data: ev.data });
    lastFrameAt = Date.now();
    const kind = (ev.data as { update?: { sessionUpdate?: string } })?.update
      ?.sessionUpdate;
    if (
      ev.type === 'session_update' &&
      (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
    ) {
      sawAgentFrame = true;
    }
    const upd = ev.type === 'session_update' ? ` sessionUpdate=${kind}` : '';
    const oc = (ev as { originatorClientId?: string }).originatorClientId;
    console.error(
      `[frame] ${ev.type}${upd} oc=${oc ?? '∅'} ${short(ev.data)}`,
    );
  }
})().catch((e) => console.error('[capture] events ended:', e?.message ?? e));

// Let the SSE subscription establish before prompting.
await new Promise((r) => setTimeout(r, 600));

console.error('[capture] sending prompt…');
try {
  const res = await sc.prompt({
    prompt: [
      { type: 'text', text: 'Reply with exactly the word PONG and nothing else.' },
    ],
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
writeFileSync('/tmp/daemon-frames.json', JSON.stringify(captured, null, 2));
console.error(`=== wrote ${captured.length} frames to /tmp/daemon-frames.json ===`);
process.exit(0);
