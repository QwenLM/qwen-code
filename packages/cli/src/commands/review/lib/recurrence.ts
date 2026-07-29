/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Deterministic pre-scan for recurring writes into long-lived containers.
//
// A live dogfood missed a real blocker: the diff added a per-tool-turn append of
// a bounded string into the outgoing request, and one hop away that request was
// pushed verbatim into conversation history nothing reclaims — unbounded,
// quadratic-in-turns accumulation. Every dimension agent read the diff
// hunk-locally; no lens asked "this write recurs — what bounds the CONTAINER it
// flows into, and who reclaims old entries?" Same medicine as script-lint:
// enumerate deterministically here, and REQUIRE the performance agent to
// adjudicate each site (see the weld in agent-prompt.ts). False negatives are
// acceptable; noise is not — the patterns are high-precision and the output is
// capped.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPath } from './diff-plan.js';
import { writeStderrLine } from '../../../utils/stdioHelpers.js';

export type AccumulationKind = 'push' | 'map-set' | 'append' | 'listener';

export interface AccumulationCandidate {
  /** New-side path of the file holding the write. */
  file: string;
  /** New-file line number of the added line. */
  line: number;
  /** The trimmed added line (truncated for display). */
  snippet: string;
  /** The receiver expression being written into. */
  receiver: string;
  kind: AccumulationKind;
  /**
   * Where the receiver flows next — call sites, aliases, returns of the same
   * identifier later in the post-diff file. Measured without this: an agent
   * handed a candidate on a staging local traced it to its declaration,
   * answered "per-turn local, bounded", and cleared a real unbounded-growth
   * blocker — the accumulation lived one MORE hop away, where the staging
   * array is handed to the send path and pushed into history. The scanner
   * hands the trace's next step over mechanically so the adjudication starts
   * there instead of stopping at the declaration.
   */
  downstream?: Array<{ line: number; snippet: string }>;
}

/**
 * Hard cap on candidates. The list is welded into one agent's prompt; a diff
 * that trips the patterns fifty times would drown the adjudication contract in
 * its own enumeration. Earliest sites win — only production source is scanned,
 * so the cap never spends a slot on a test file.
 */
export const MAX_CANDIDATES = 12;

const SNIPPET_MAX_CHARS = 200;

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A property-access chain: `this.history`, `messagesRef.current`, `queue`. */
const CHAIN = String.raw`(?:this|[A-Za-z_$][\w$]*)(?:(?:\?\.|\.)[A-Za-z_$][\w$]*)*`;
const NOT_MID_CHAIN = String.raw`(?<![\w$.])`;

// `splice` belongs here: an insert-form splice grows the array exactly as a
// push does, and the miss was measured — the dogfooded blocker's write site
// was `requestToSend.splice(insertAt, 0, reminder)`, invisible to a
// push/unshift-only pattern. The regex matches the CALL-OPENING line, so a
// call whose arguments span multiple lines still matches on its first line.
const PUSH_RE = new RegExp(
  `${NOT_MID_CHAIN}(${CHAIN})\\.(?:push|unshift|splice)\\(`,
);
const SET_RE = new RegExp(`${NOT_MID_CHAIN}(${CHAIN})\\.set\\(`);
const APPEND_RE = new RegExp(`${NOT_MID_CHAIN}(${CHAIN})\\.append\\w*\\(`);
const APPEND_FILE_RE = /\bappendFileSync\s*\(/;
/** Registrations that pair with a remover — only on `this.*` receivers. */
const LISTENER_RE = new RegExp(
  `${NOT_MID_CHAIN}(this(?:\\.[A-Za-z_$][\\w$]*)+)\\.(?:on|once|add(?:Event)?Listener)\\(`,
);
const PLUS_EQ_RE = new RegExp(`^\\s*(${CHAIN})\\s*\\+=\\s*(.+)$`);

/**
 * An INDENTED `const`/`let`/`var` declaration — a function-local. A column-0
 * declaration is module-level state and deliberately does not match: a
 * module-level `const history = []` added by the same hunk is exactly the
 * long-lived container this scan exists to surface.
 */
const LOCAL_DECL_RE = /^\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** The chain's root identifier: `this.a.b` → `this`, `queue?.items` → `queue`. */
function rootOf(receiver: string): string {
  return receiver.replace(/\?/g, '').split('.', 1)[0];
}

/** A receiver `.push`/`.unshift` treats as long-lived unless proven local. */
function pushEligible(receiver: string, locals: Set<string>): boolean {
  if (rootOf(receiver) === 'this') return true;
  if (receiver.endsWith('.current')) return true;
  if (/history/i.test(receiver)) return true;
  // A bare or dotted receiver whose root the diff shows as a function-local is
  // an obvious local; anything else could be module-level or an outer-scope
  // field the hunk does not show — when unsure, INCLUDE (the agent adjudicates).
  return !locals.has(rootOf(receiver));
}

/**
 * The narrower gate for `.set(` / `.append*(` / `+=`: `this.*`, or a bare
 * identifier not visibly local. Dotted non-`this` receivers (`headers.set`,
 * `url.searchParams.append`) are the dominant noise source for these patterns
 * and are excluded — a false negative is fine, noise is the enemy.
 */
function stateEligible(receiver: string, locals: Set<string>): boolean {
  if (rootOf(receiver) === 'this') return true;
  return !receiver.includes('.') && !locals.has(receiver);
}

/** RHS shapes that cannot grow a container: numeric counters. */
function isNumericAccumulation(rhs: string): boolean {
  return /^[+-]?\d+(?:\.\d+)?\s*;?\s*$/.test(rhs.trim());
}

function candidateFor(
  content: string,
  locals: Set<string>,
): { receiver: string; kind: AccumulationKind } | null {
  const push = PUSH_RE.exec(content);
  if (push && pushEligible(push[1], locals)) {
    return { receiver: push[1], kind: 'push' };
  }
  const set = SET_RE.exec(content);
  if (set && stateEligible(set[1], locals)) {
    return { receiver: set[1], kind: 'map-set' };
  }
  if (APPEND_FILE_RE.test(content)) {
    return { receiver: 'appendFileSync', kind: 'append' };
  }
  const append = APPEND_RE.exec(content);
  if (append && stateEligible(append[1], locals)) {
    return { receiver: append[1], kind: 'append' };
  }
  const listener = LISTENER_RE.exec(content);
  if (listener) {
    return { receiver: listener[1], kind: 'listener' };
  }
  const plusEq = PLUS_EQ_RE.exec(content);
  if (
    plusEq &&
    stateEligible(plusEq[1], locals) &&
    !isNumericAccumulation(plusEq[2])
  ) {
    return { receiver: plusEq[1], kind: 'append' };
  }
  return null;
}

/**
 * Scan a unified diff's ADDED lines in production source files for writes into
 * long-lived containers. Test, docs and generated files are excluded with the
 * same classification the diff plan uses, so the review judges these sites by
 * the same map it chunks by.
 */
export function scanAccumulationCandidates(
  diffText: string,
): AccumulationCandidate[] {
  const lines = diffText.split('\n');
  const out: AccumulationCandidate[] = [];

  let path = '';
  let isSource = false;
  let inHunk = false;
  /** New-side line number of the next body line of the current hunk. */
  let newCursor = 0;
  /**
   * Names the diff shows declared as function-locals in this FILE's hunks.
   * Declaration precedes use, so a forward walk has seen the `const parts = []`
   * by the time it reaches `parts.push(...)`.
   */
  let locals = new Set<string>();

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      path = '';
      isSource = false;
      inHunk = false;
      locals = new Set<string>();
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') {
        path = p.startsWith('b/') ? p.slice(2) : p;
        isSource = classifyPath(path) === 'source';
      }
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      inHunk = true;
      newCursor = Number(hunk[1]);
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith('+')) {
      const content = line.slice(1);
      const decl = LOCAL_DECL_RE.exec(content);
      if (decl) locals.add(decl[1]);
      if (isSource && path && out.length < MAX_CANDIDATES) {
        const hit = candidateFor(content, locals);
        if (hit) {
          out.push({
            file: path,
            line: newCursor,
            snippet: content.trim().slice(0, SNIPPET_MAX_CHARS),
            receiver: hit.receiver,
            kind: hit.kind,
          });
        }
      }
      newCursor++;
    } else if (line === '' || line.startsWith(' ')) {
      // Context: present on the new side. A local declared in a context line
      // still classifies a later added write to it.
      const decl = LOCAL_DECL_RE.exec(line === '' ? '' : line.slice(1));
      if (decl) locals.add(decl[1]);
      newCursor++;
    }
    // `-` lines: old side only — no new-side line, and a removed declaration
    // does not exist in the file the write lands in.
  }

  return out;
}

/** Downstream sites listed per candidate. Three is a trace's next step, not a tour. */
const DOWNSTREAM_MAX = 3;

/**
 * Lines where `root` flows ONWARD in the post-diff file: passed as an argument
 * (including spread), aliased on an assignment's right side, or returned. Write
 * sites into the receiver and its declaration are not flows and are skipped.
 * Sites after the write are preferred (values flow forward), earlier ones kept
 * only when nothing later matches.
 */
export function findDownstream(
  fileText: string,
  root: string,
  writeLine: number,
): Array<{ line: number; snippet: string }> {
  const id = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flow = new RegExp(
    `(?:[(,]\\s*(?:\\.\\.\\.)?${id}\\b|=\\s*${id}\\b|\\breturn\\s+${id}\\b)`,
  );
  const write = new RegExp(`\\b${id}\\s*(?:\\.|\\[|=[^=])`);
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b`);
  const after: Array<{ line: number; snippet: string }> = [];
  const before: Array<{ line: number; snippet: string }> = [];
  const lines = fileText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    if (n === writeLine) continue;
    const text = lines[i];
    if (!flow.test(text) || decl.test(text)) continue;
    // A line that both mentions the root in argument position AND writes into
    // it (`other.push(root)` vs `root.push(x)`) — the write regex keys on the
    // root itself being dotted/indexed/assigned, which a pure flow line is not.
    if (write.test(text) && !flow.test(text.replace(write, ''))) continue;
    const entry = { line: n, snippet: text.trim().slice(0, SNIPPET_MAX_CHARS) };
    (n > writeLine ? after : before).push(entry);
    if (after.length >= DOWNSTREAM_MAX) break;
  }
  return [...after, ...before].slice(0, DOWNSTREAM_MAX);
}

/**
 * The scan shaped for spreading into a capture command's plan, mirroring
 * `planEffortField`: `{ recurrenceCandidates }` when the scan found any,
 * `{}` otherwise — the field is present only when non-empty, so consumers
 * key on its presence.
 *
 * `fileRoot` locates the post-diff files for the downstream trace (the repo
 * root for a local capture, the PR worktree for fetch-pr). Downstream sites
 * are attached only for receivers that are not `this.*` — a class field IS
 * the long-lived container; a bare identifier may be a staging local whose
 * real container sits one more hop away, and that hop is exactly what an
 * adjudicating agent was measured to skip. An unreadable file simply yields
 * no downstream — the candidate still lands.
 */
export function planRecurrenceField(
  diffText: string,
  fileRoot = '.',
): {
  recurrenceCandidates?: AccumulationCandidate[];
} {
  const candidates = scanAccumulationCandidates(diffText);
  if (candidates.length === 0) return {};
  for (const c of candidates) {
    if (rootOf(c.receiver) === 'this') continue;
    try {
      const text = readFileSync(join(fileRoot, c.file), 'utf8');
      const sites = findDownstream(text, rootOf(c.receiver), c.line);
      if (sites.length > 0) c.downstream = sites;
    } catch {
      /* no post-diff file here (diff-only plan) — the candidate stands alone */
    }
  }
  writeStderrLine(
    `recurrence: ${candidates.length} accumulation candidate(s) recorded for ` +
      `the performance agent to adjudicate`,
  );
  return { recurrenceCandidates: candidates };
}
