/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure argv/tree logic for `qwen-rc sessions` (`add-session-forking` task
 * 3.3: "the terminal renders a static tree with unicode box-drawing").
 *
 * The SCAN is not here: the cli.ts glue reuses {@link listSessions} from
 * sessionList.ts — the exact source of truth behind `GET /rc/sessions` — so
 * the CLI tree and the web UI tree can never drift. Only the argv parsing,
 * the flat-listing → forest fold, and the box-drawing render are pure logic
 * worth isolating (and unit testing).
 */

import type { SessionListItem } from './sessionList.js';

export interface SessionsArgs {
  /** Workspace cwd whose chats dir to scan (default: process.cwd()). */
  cwd?: string;
  /** Emit the raw listing as JSON instead of the tree. */
  json: boolean;
}

export type SessionsArgsResult =
  | { ok: true; value: SessionsArgs }
  | { ok: false; error: string };

const USAGE = 'usage: qwen-rc sessions [--cwd <dir>] [--json]';

export function parseSessionsArgs(argv: string[]): SessionsArgsResult {
  let cwd: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      json = true;
    } else if (a === '--cwd') {
      const v = argv[++i];
      if (v === undefined)
        return { ok: false, error: '--cwd requires a value' };
      cwd = v;
    } else if (a.startsWith('--cwd=')) {
      cwd = a.slice('--cwd='.length) || undefined;
    } else {
      return { ok: false, error: `unknown argument: ${a} — ${USAGE}` };
    }
  }
  return { ok: true, value: { ...(cwd ? { cwd } : {}), json } };
}

export interface SessionTreeNode {
  item: SessionListItem;
  children: SessionTreeNode[];
}

/**
 * Pure: fold a flat listing into a forest. A session whose parent is NOT in
 * the listing (deleted, or beyond the scan cap) is listed as a ROOT with its
 * `parentSessionId` preserved in the item — truncate-don't-fabricate, the
 * same rule assembleListing applies to `forks[]`. A self-parent (hand-edited
 * transcript) is a root, never its own child.
 */
export function buildForkTree(items: SessionListItem[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const item of items) {
    byId.set(item.sessionId, { item, children: [] });
  }
  const roots: SessionTreeNode[] = [];
  for (const item of items) {
    const node = byId.get(item.sessionId)!;
    const parent = item.parentSessionId
      ? byId.get(item.parentSessionId)
      : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  // Most-recent-first at every level (updatedAt desc), matching the listing.
  const byTimeDesc = (a: SessionTreeNode, b: SessionTreeNode) =>
    new Date(b.item.updatedAt).getTime() - new Date(a.item.updatedAt).getTime();
  const sortAll = (nodes: SessionTreeNode[]): void => {
    nodes.sort(byTimeDesc);
    for (const n of nodes) sortAll(n.children);
  };
  sortAll(roots);
  return roots;
}

/** One tree line: `<sessionId>  <title?>  (<YYYY-MM-DD>)`. */
function formatNode(item: SessionListItem): string {
  const title = item.title ? `  ${item.title}` : '';
  return `${item.sessionId}${title}  (${item.updatedAt.slice(0, 10)})`;
}

/**
 * Pure: render the forest with unicode box-drawing. Static (no
 * collapse/expand — that is the web client's job per task 3.3). Roots are
 * siblings under an implicit workspace top, so every node carries a
 * connector:
 *
 * ```
 * ├── <root-a>  (2026-08-17)
 * │   ├── <fork-1>  (2026-08-16)
 * │   │   └── <grandchild>  (2026-08-15)
 * │   └── <fork-2>  (2026-08-10)
 * └── <root-b>  (2026-08-01)
 * ```
 */
export function renderForkTree(roots: SessionTreeNode[]): string {
  if (roots.length === 0) return '(no sessions)';
  const lines: string[] = [];
  const walk = (nodes: SessionTreeNode[], prefix: string): void => {
    nodes.forEach((n, i) => {
      const last = i === nodes.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${formatNode(n.item)}`);
      walk(n.children, prefix + (last ? '    ' : '│   '));
    });
  };
  walk(roots, '');
  return lines.join('\n');
}

/** The raw listing for `--json` (stable machine-readable shape). */
export function formatSessionsJson(result: {
  sessions: SessionListItem[];
  truncated: boolean;
}): string {
  return JSON.stringify(result, null, 2);
}

/**
 * `GET /rc/sessions` path for daemon-mode listings (task 1.4): the optional
 * `?cwd=` override is the SAME request-aware override the daemon route
 * honors (request cwd only becomes a sanitized project-id segment there).
 */
export function sessionsApiPath(cwd?: string): string {
  return cwd ? `/rc/sessions?cwd=${encodeURIComponent(cwd)}` : '/rc/sessions';
}

/**
 * Coerce a `GET /rc/sessions` JSON body into the listing shape the tree
 * renderer wants. The route returns the listSessions result verbatim, but a
 * foreign/older daemon may answer differently — never let a malformed body
 * crash the renderer (empty listing beats a stack trace).
 */
export function sessionsFromApiResponse(body: unknown): {
  sessions: SessionListItem[];
  truncated: boolean;
} {
  const obj =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const raw = Array.isArray(obj['sessions']) ? obj['sessions'] : [];
  const sessions: SessionListItem[] = raw.filter(
    (s): s is SessionListItem =>
      !!s &&
      typeof s === 'object' &&
      typeof (s as Record<string, unknown>)['sessionId'] === 'string',
  );
  return { sessions, truncated: obj['truncated'] === true };
}
