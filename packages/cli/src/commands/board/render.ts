/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendering for the board panel and the one-shot listings.
 *
 * The ordering is the design: what needs a human first, then what is blocked,
 * then work in flight. A panel that leads with "3 agents working" is a process
 * monitor; this one leads with what will not move until someone acts.
 */

import type { BoardTaskRecord } from '@qwen-code/qwen-code-core';
import type { AskRecord, DecisionRecord } from '@qwen-code/qwen-code-core';

export interface BoardSnapshot {
  board: string;
  tasks: BoardTaskRecord[];
  asks: AskRecord[];
  decisions: DecisionRecord[];
}

/**
 * Pairs of participants each waiting on an answer from the other.
 *
 * This is the one thing a cross-session view can see that no participant can
 * see about itself: from inside, A is simply waiting, and so is B. On the board
 * both are `open` asks pointing at each other, so the cycle is visible as data
 * rather than inferred from two stalled sessions.
 *
 * Only the two-party case. Longer cycles exist but are rare enough that
 * reporting them costs more confusion than it saves, and the pair is what a
 * person can act on immediately.
 */
export function findDeadlocks(asks: AskRecord[]): Array<[string, string]> {
  const open = asks.filter((a) => a.state === 'open');
  const waiting = new Set(open.map((a) => `${a.from}\u0000${a.to}`));
  const found: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const ask of open) {
    if (!waiting.has(`${ask.to}\u0000${ask.from}`)) continue;
    const key = [ask.from, ask.to].sort().join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    found.push([ask.from, ask.to]);
  }
  return found;
}

/** "4m" / "2h" / "3d" — compact enough to sit in a narrow pane. */
export function age(since: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value.slice(0, width)
    : value + ' '.repeat(width - value.length);
}

export function renderBoard(snapshot: BoardSnapshot, now = Date.now()): string {
  const lines: string[] = [];
  const openDecisions = snapshot.decisions.filter((d) => d.state === 'open');
  const openAsks = snapshot.asks.filter((a) => a.state === 'open');
  const live = snapshot.tasks.filter((t) => t.status !== 'completed');

  const participants = new Set<string>();
  for (const t of snapshot.tasks) if (t.owner) participants.add(t.owner);
  for (const a of snapshot.asks) {
    participants.add(a.from);
    participants.add(a.to);
  }

  lines.push(
    `board: ${snapshot.board}   ${participants.size} participant${
      participants.size === 1 ? '' : 's'
    }`,
  );
  lines.push('─'.repeat(46));

  // Needs a human. First because nothing else unblocks it.
  for (const d of openDecisions) {
    const about = d.about ? ` (${d.about})` : '';
    lines.push(`⚠ ${pad(d.id, 5)} ${d.kind}${about}  ${age(d.createdAt, now)}`);
    lines.push(`      ${d.question}`);
  }

  // Mutual waits, before the asks themselves: a pair that cannot resolve
  // itself needs a person, and nothing else on the board will surface it.
  for (const [x, y] of findDeadlocks(snapshot.asks)) {
    lines.push(`⇄ ${x} ⇄ ${y}  each waiting on the other`);
  }

  // Blocked on a peer.
  for (const a of openAsks) {
    lines.push(
      `? ${pad(a.id, 5)} ${a.from} → ${a.to}  ${age(a.createdAt, now)}`,
    );
    lines.push(`      ${a.question}`);
  }

  if (openDecisions.length || openAsks.length) lines.push('');

  // Work in flight. Last: it is moving, so it needs nothing from anyone.
  for (const t of live) {
    const owner = t.owner ?? '—';
    const mark = t.status === 'in_progress' ? '·' : ' ';
    lines.push(
      `${mark} ${pad(t.id, 5)} ${pad(t.subject, 22)} ${pad(owner, 12)} ${age(
        t.updatedAt,
        now,
      )}`,
    );
  }

  const done = snapshot.tasks.length - live.length;
  if (done > 0) lines.push(`  ${done} done`);

  if (lines.length === 2) lines.push('  (empty)');
  return lines.join('\n');
}
