/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase-2 Slice-3 ground-truth capture for REPLAY (NOT a CI test — needs a real
 * `qwen serve` + a reachable model). The terminal↔mobile pick-up handoff replays a
 * session's history on attach; this records what the 0.17.x daemon actually emits
 * so the `useDaemonStream` replay wiring is built against real frames, not guesses
 * (the 0.17-vs-0.18 trap that bit `turn_complete` / `user_message_chunk`).
 *
 * It seeds a session with two short turns (client A), then captures TWO replay
 * paths the way the TUI would use them:
 *   - RING replay: a SECOND client attaches to the SAME live session (single-scope
 *     reuse) and subscribes with `lastEventId: 0` — what a re-launched TUI sees.
 *   - TRANSCRIPT replay: `DaemonSessionClient.load(...)` (HistoryReplayer). Logged
 *     best-effort — if `load` rejects on a live session, THAT is the finding.
 *
 * For each, we record every frame's `type`, `id`, `originatorClientId`, and
 * `sessionUpdate` kind — the exact facts the reducer/hook design needs: are there
 * `turn_complete` / `replay_complete` boundaries? what `originatorClientId` do
 * replayed user messages carry (must not be dropped as our self-echo)? do ids
 * increase monotonically?
 *
 * Usage (attach to a running daemon — preferred, avoids `spawn qwen` issues):
 *   CAPTURE_ATTACH_URL=http://127.0.0.1:4180 CAPTURE_ATTACH_TOKEN=<token> \
 *     npx tsx scripts/capture-replay-frames.mts
 * Or spawn a throwaway daemon (set CAPTURE_QWEN_BIN if `qwen` isn't on PATH):
 *   npx tsx scripts/capture-replay-frames.mts
 *
 * Env: CAPTURE_PROMPT1 / CAPTURE_PROMPT2 (the two seeding turns),
 *      CAPTURE_OUT_RING (default /tmp/replay-ring.json),
 *      CAPTURE_OUT_TRANSCRIPT (default /tmp/replay-transcript.json),
 *      CAPTURE_PORT (spawn port, default 4196).
 * SAFE: any permission_request is DECLINED (nothing executes).
 */
import { writeFileSync } from 'node:fs';
import { startDaemon } from '../src/daemonSupervisor.js';
import { DaemonSessionClient } from '@qwen-code/sdk';

const OUT_RING = process.env['CAPTURE_OUT_RING'] ?? '/tmp/replay-ring.json';
const OUT_TRANSCRIPT =
  process.env['CAPTURE_OUT_TRANSCRIPT'] ?? '/tmp/replay-transcript.json';
const PROMPT1 =
  process.env['CAPTURE_PROMPT1'] ??
  'Reply with exactly the word PONG and nothing else.';
const PROMPT2 =
  process.env['CAPTURE_PROMPT2'] ??
  'Reply with exactly the word PING and nothing else.';

interface CapturedFrame {
  type: string;
  id?: number;
  originatorClientId?: string;
  sessionUpdate?: string;
  data: unknown;
}

function short(v: unknown, n = 200): string {
  try {
    const s = JSON.stringify(v);
    return s && s.length > n ? s.slice(0, n) + '…' : (s ?? String(v));
  } catch {
    return String(v);
  }
}

function suKind(data: unknown): string | undefined {
  return (data as { update?: { sessionUpdate?: string } })?.update
    ?.sessionUpdate;
}

function summarize(label: string, frames: CapturedFrame[]): void {
  const counts: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  for (const f of frames) {
    counts[f.type] = (counts[f.type] ?? 0) + 1;
    if (f.sessionUpdate) kinds[f.sessionUpdate] = (kinds[f.sessionUpdate] ?? 0) + 1;
  }
  const ids = frames.map((f) => f.id).filter((i): i is number => i != null);
  console.error(`\n=== ${label}: ${frames.length} frames ===`);
  console.error(`  types: ${JSON.stringify(counts)}`);
  console.error(`  session_update kinds: ${JSON.stringify(kinds)}`);
  console.error(
    `  ids: ${ids.length ? `${ids[0]}..${ids[ids.length - 1]} (monotonic=${ids.every((v, i) => i === 0 || v >= ids[i - 1])})` : 'none'}`,
  );
  const oc = new Set(frames.map((f) => f.originatorClientId ?? '∅'));
  console.error(`  originatorClientIds: ${JSON.stringify([...oc])}`);
}

// --- daemon: attach to a running one, or spawn a throwaway ---
const ATTACH_URL = process.env['CAPTURE_ATTACH_URL'];
const handle = ATTACH_URL
  ? await startDaemon({
      attach: {
        url: ATTACH_URL,
        token: process.env['CAPTURE_ATTACH_TOKEN'] ?? '',
      },
      readyTimeoutMs: 15000,
    })
  : await startDaemon({
      qwenBin: process.env['CAPTURE_QWEN_BIN'] ?? 'qwen',
      port: Number(process.env['CAPTURE_PORT'] ?? 4196),
      readyTimeoutMs: 15000,
    });
console.error(
  ATTACH_URL
    ? `[replay] attached to daemon at ${ATTACH_URL}`
    : `[replay] spawned daemon`,
);

/** Subscribe and collect frames until `idleMs` of quiet (or `hardCapMs`). */
async function collect(
  sc: InstanceType<typeof DaemonSessionClient>,
  label: string,
  opts: { lastEventId?: number; idleMs?: number; hardCapMs?: number } = {},
): Promise<CapturedFrame[]> {
  const frames: CapturedFrame[] = [];
  const ac = new AbortController();
  let lastAt = Date.now();
  const consumer = (async () => {
    for await (const ev of sc.events({
      signal: ac.signal,
      ...(opts.lastEventId !== undefined ? { lastEventId: opts.lastEventId } : {}),
    })) {
      lastAt = Date.now();
      const oc = (ev as { originatorClientId?: string }).originatorClientId;
      frames.push({
        type: ev.type,
        id: ev.id,
        originatorClientId: oc,
        sessionUpdate: suKind(ev.data),
        data: ev.data,
      });
      console.error(
        `[${label}] #${ev.id ?? '∅'} ${ev.type}${suKind(ev.data) ? '/' + suKind(ev.data) : ''} oc=${oc ?? '∅'} ${short(ev.data, 120)}`,
      );
      if (ev.type === 'permission_request') {
        const reqId = (ev.data as { requestId?: string })?.requestId;
        if (reqId) {
          await sc
            .respondToSessionPermission(reqId, {
              outcome: { outcome: 'cancelled' },
            })
            .catch(() => {});
        }
      }
    }
  })().catch((e) => console.error(`[${label}] events ended:`, e?.message ?? e));

  const idleMs = opts.idleMs ?? 3000;
  const hardCap = Date.now() + (opts.hardCapMs ?? 30_000);
  // Give the subscription a beat to receive the replay burst.
  await new Promise((r) => setTimeout(r, 500));
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    if (Date.now() - lastAt > idleMs) break;
    if (Date.now() > hardCap) break;
  }
  ac.abort();
  await consumer;
  return frames;
}

try {
  // 1. Seed a session with two turns (client A).
  const a = await DaemonSessionClient.createOrAttach(handle.daemon, {});
  console.error(
    `[replay] seeding session ${a.sessionId} (clientA=${a.clientId})`,
  );
  // A background consumer keeps A's stream drained + declines any permission.
  const aAbort = new AbortController();
  void (async () => {
    for await (const ev of a.events({ signal: aAbort.signal })) {
      if (ev.type === 'permission_request') {
        const reqId = (ev.data as { requestId?: string })?.requestId;
        if (reqId)
          await a
            .respondToSessionPermission(reqId, {
              outcome: { outcome: 'cancelled' },
            })
            .catch(() => {});
      }
    }
  })().catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  for (const text of [PROMPT1, PROMPT2]) {
    console.error(`[replay] prompt: ${text}`);
    await a
      .prompt({ prompt: [{ type: 'text', text }] })
      .catch((e) => console.error('[replay] prompt threw:', e?.message ?? e));
  }
  await new Promise((r) => setTimeout(r, 800));
  aAbort.abort();

  // 2. RING replay: a fresh client attaches (single-scope reuse) + lastEventId:0.
  const b = await DaemonSessionClient.createOrAttach(handle.daemon, {});
  console.error(
    `[replay] RING client B=${b.clientId} session=${b.sessionId} (sameAsA=${b.sessionId === a.sessionId})`,
  );
  const ringFrames = await collect(b, 'ring', { lastEventId: 0 });
  writeFileSync(OUT_RING, JSON.stringify(ringFrames, null, 2));
  await b.close().catch(() => {});

  // 3. TRANSCRIPT replay: load() (HistoryReplayer). Best-effort — a rejection on a
  //    live session is itself the finding.
  let transcriptFrames: CapturedFrame[] = [];
  try {
    const c = await DaemonSessionClient.load(handle.daemon, a.sessionId);
    console.error(
      `[replay] TRANSCRIPT client C=${c.clientId} session=${c.sessionId}`,
    );
    transcriptFrames = await collect(c, 'transcript', { lastEventId: 0 });
    writeFileSync(OUT_TRANSCRIPT, JSON.stringify(transcriptFrames, null, 2));
    await c.close().catch(() => {});
  } catch (e) {
    console.error(
      `[replay] load() failed (this is a finding — transcript path may need resume() or differs on a live session): ${(e as Error)?.message ?? e}`,
    );
    writeFileSync(
      OUT_TRANSCRIPT,
      JSON.stringify({ loadError: String((e as Error)?.message ?? e) }, null, 2),
    );
  }

  await a.close().catch(() => {});

  summarize('RING REPLAY', ringFrames);
  if (transcriptFrames.length) summarize('TRANSCRIPT REPLAY', transcriptFrames);
  console.error(`\n[replay] wrote ${OUT_RING} and ${OUT_TRANSCRIPT}`);
} finally {
  await handle.stop();
}
process.exit(0);
