/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SearchHit, SearchOptions, SearchResult } from './transcripts.js';

/** Validated args for the `qwen-rc search` CLI. */
export interface ParsedSearchArgs {
  query: string;
  /** Workspace cwd whose chats dir is searched (default process.cwd()). */
  cwd?: string;
  opts: Pick<SearchOptions, 'kind' | 'sessionId' | 'limit' | 'since' | 'until'>;
  /** `--json`: emit machine-readable JSON on stdout instead of the text view. */
  json: boolean;
  /** `--rank`: BM25 ranked query over the prebuilt index (vs the live scan). */
  rank: boolean;
}

const VALID_KINDS = ['user', 'assistant', 'tool', 'all'];

const USAGE =
  'usage: qwen-rc search <query…> [--cwd=<dir>] [--kind=user|assistant|tool|all] [--since=<iso>] [--until=<iso>] [--limit=<n>] [--session=<id>] [--rank] [--json]';

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

  return {
    ok: true,
    value: {
      query,
      cwd,
      opts,
      json: flags.has('json'),
      rank: flags.has('rank'),
    },
  };
}

/**
 * Machine-readable rendering of search results for `--json`: a single stable
 * JSON object `{ hits, truncated }` where each hit carries
 * `{ sessionId, eventId, kind, ts, snippet }` (the same SearchHit fields the
 * route returns). Pure — no trailing newline, the CLI adds one via console.log.
 */
export function formatSearchResultsJson(result: SearchResult): string {
  return JSON.stringify({ hits: result.hits, truncated: result.truncated });
}

/**
 * `GET /rc/search` query string for daemon-mode search (task 1.4). The route
 * reads `q`, `kind`, `sessionId`, `limit`, `since`, `until` (ISO-8601 — the
 * local CLI keeps epoch ms, so convert here) and `rank=bm25`. `--cwd` has no
 * remote meaning (the daemon searches ITS workspace) and is intentionally
 * NOT sent.
 */
export function buildSearchApiQuery(parsed: ParsedSearchArgs): string {
  const p = new URLSearchParams();
  p.set('q', parsed.query);
  if (parsed.opts.kind !== undefined) p.set('kind', parsed.opts.kind);
  if (parsed.opts.sessionId !== undefined)
    p.set('sessionId', parsed.opts.sessionId);
  if (parsed.opts.limit !== undefined)
    p.set('limit', String(parsed.opts.limit));
  if (parsed.opts.since !== undefined)
    p.set('since', new Date(parsed.opts.since).toISOString());
  if (parsed.opts.until !== undefined)
    p.set('until', new Date(parsed.opts.until).toISOString());
  if (parsed.rank) p.set('rank', 'bm25');
  return p.toString();
}

/**
 * Coerce a `GET /rc/search` JSON body into the local SearchResult shape.
 * The route answers `{hits, truncated, elapsedMs, mode}`; a foreign daemon
 * may differ — an empty result beats a crash.
 */
export function searchFromApiResponse(body: unknown): SearchResult {
  const obj =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const raw = Array.isArray(obj['hits']) ? obj['hits'] : [];
  const hits = raw.filter(
    (h): h is SearchHit =>
      !!h &&
      typeof h === 'object' &&
      typeof (h as Record<string, unknown>)['sessionId'] === 'string',
  );
  return { hits, truncated: obj['truncated'] === true };
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
