/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SearchOptions, SearchResult } from './transcripts.js';

/** Validated args for the `qwen-rc search` CLI. */
export interface ParsedSearchArgs {
  query: string;
  /** Workspace cwd whose chats dir is searched (default process.cwd()). */
  cwd?: string;
  opts: Pick<SearchOptions, 'kind' | 'sessionId' | 'limit' | 'since' | 'until'>;
}

const VALID_KINDS = ['user', 'assistant', 'tool', 'all'];

const USAGE =
  'usage: qwen-rc search <query…> [--cwd=<dir>] [--kind=user|assistant|tool|all] [--since=<iso>] [--until=<iso>] [--limit=<n>] [--session=<id>]';

/**
 * Parse `qwen-rc search` argv (everything after `search`). Total/never-throws.
 * The query is the positional (non-`--` tokens joined). `--key=value` flags are
 * validated; an invalid kind/limit/since/until or a missing query yields a usage
 * error (the CLI exits 2). Mirrors `parseExplainArgs`/`parseRoutingTest`.
 */
export function parseSearchArgs(
  argv: readonly string[],
): { ok: true; value: ParsedSearchArgs } | { ok: false; error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const val = eq === -1 ? '' : arg.slice(eq + 1);
      flags.set(key, val);
    } else {
      positional.push(arg);
    }
  }

  const query = positional.join(' ').trim();
  if (!query) return { ok: false, error: USAGE };

  const opts: ParsedSearchArgs['opts'] = {};

  const kind = flags.get('kind');
  if (kind !== undefined) {
    if (!VALID_KINDS.includes(kind)) {
      return {
        ok: false,
        error: `invalid --kind '${kind}' (expected user|assistant|tool|all)`,
      };
    }
    opts.kind = kind;
  }

  const session = flags.get('session');
  if (session !== undefined && session.length > 0) opts.sessionId = session;

  const limitRaw = flags.get('limit');
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: `invalid --limit '${limitRaw}'` };
    }
    opts.limit = Math.trunc(n);
  }

  for (const key of ['since', 'until'] as const) {
    const raw = flags.get(key);
    if (raw !== undefined && raw.length > 0) {
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) {
        return {
          ok: false,
          error: `invalid --${key} '${raw}' (expected ISO-8601)`,
        };
      }
      opts[key] = ms;
    }
  }

  const cwdRaw = flags.get('cwd');
  const cwd = cwdRaw !== undefined && cwdRaw.length > 0 ? cwdRaw : undefined;

  return { ok: true, value: { query, cwd, opts } };
}

/**
 * Render search results for the terminal: one block per hit (a header line plus
 * an indented snippet) and a count footer. `(no hits)` when empty. Pure.
 */
export function formatSearchResults(result: SearchResult): string {
  if (result.hits.length === 0) return '(no hits)';
  const blocks = result.hits.map((h) => {
    const header = `${h.ts}  [${h.kind}]  ${h.sessionId}`;
    return h.snippet ? `${header}\n  ${h.snippet}` : header;
  });
  const footer = `${result.hits.length} hit(s)${
    result.truncated ? ' (truncated)' : ''
  }`;
  return blocks.join('\n') + '\n\n' + footer;
}
