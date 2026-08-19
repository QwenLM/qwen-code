/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseSessionsArgs,
  buildForkTree,
  renderForkTree,
  formatSessionsJson,
  sessionsApiPath,
  sessionsFromApiResponse,
} from './sessionsCli.js';
import type { SessionListItem } from './sessionList.js';

const item = (
  sessionId: string,
  updatedAt: string,
  extra: Partial<SessionListItem> = {},
): SessionListItem => ({
  sessionId,
  forks: [],
  updatedAt,
  ...extra,
});

describe('parseSessionsArgs', () => {
  it('defaults: no cwd, table output', () => {
    const r = parseSessionsArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ json: false });
  });

  it('parses --cwd (space and = forms) and --json', () => {
    expect(
      parseSessionsArgs(['--cwd', '/x']).ok &&
        parseSessionsArgs(['--cwd', '/x']).value.cwd,
    ).toBe('/x');
    expect(
      parseSessionsArgs(['--cwd=/y']).ok &&
        parseSessionsArgs(['--cwd=/y']).value.cwd,
    ).toBe('/y');
    expect(
      parseSessionsArgs(['--json']).ok &&
        parseSessionsArgs(['--json']).value.json,
    ).toBe(true);
  });

  it('rejects unknown arguments', () => {
    const r = parseSessionsArgs(['--bogus']);
    expect(r.ok).toBe(false);
  });
});

describe('buildForkTree', () => {
  it('folds children under their parent and keeps roots separate', () => {
    const roots = buildForkTree([
      item('root-a', '2026-08-17T00:00:00Z'),
      item('fork-1', '2026-08-16T00:00:00Z', { parentSessionId: 'root-a' }),
      item('fork-2', '2026-08-15T00:00:00Z', { parentSessionId: 'root-a' }),
      item('root-b', '2026-08-01T00:00:00Z'),
    ]);
    expect(roots.map((r) => r.item.sessionId)).toEqual(['root-a', 'root-b']);
    expect(roots[0].children.map((c) => c.item.sessionId)).toEqual([
      'fork-1',
      'fork-2',
    ]);
  });

  it('orders siblings by updatedAt desc at every level', () => {
    const roots = buildForkTree([
      item('root', '2026-08-01T00:00:00Z'),
      item('old', '2026-08-10T00:00:00Z', { parentSessionId: 'root' }),
      item('new', '2026-08-20T00:00:00Z', { parentSessionId: 'root' }),
      item('mid', '2026-08-15T00:00:00Z', { parentSessionId: 'root' }),
    ]);
    expect(roots[0].children.map((c) => c.item.sessionId)).toEqual([
      'new',
      'mid',
      'old',
    ]);
  });

  it('treats an orphan (parent not listed) as a root, keeping parentSessionId', () => {
    const roots = buildForkTree([
      item('orphan', '2026-08-16T00:00:00Z', { parentSessionId: 'gone' }),
      item('root', '2026-08-17T00:00:00Z'),
    ]);
    expect(roots.map((r) => r.item.sessionId)).toEqual(['root', 'orphan']);
    const orphan = roots.find((r) => r.item.sessionId === 'orphan');
    expect(orphan?.item.parentSessionId).toBe('gone');
    expect(orphan?.children).toEqual([]);
  });

  it('treats a self-parent as a root, never its own child', () => {
    const roots = buildForkTree([
      item('self', '2026-08-16T00:00:00Z', { parentSessionId: 'self' }),
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0].children).toEqual([]);
  });
});

describe('renderForkTree', () => {
  it('renders an empty forest as a placeholder', () => {
    expect(renderForkTree([])).toBe('(no sessions)');
  });

  it('renders a nested tree with unicode box-drawing', () => {
    const roots = buildForkTree([
      item('root-a', '2026-08-17T00:00:00Z', { title: 'Main' }),
      item('fork-1', '2026-08-16T00:00:00Z', { parentSessionId: 'root-a' }),
      item('grand', '2026-08-15T00:00:00Z', { parentSessionId: 'fork-1' }),
    ]);
    const lines = renderForkTree(roots).split('\n');
    expect(lines).toEqual([
      '└── root-a  Main  (2026-08-17)',
      '    └── fork-1  (2026-08-16)',
      '        └── grand  (2026-08-15)',
    ]);
  });

  it('uses └── for the last sibling and │   continuation above earlier ones', () => {
    const roots = buildForkTree([
      item('root-a', '2026-08-17T00:00:00Z'),
      item('root-b', '2026-08-01T00:00:00Z'),
      item('a', '2026-08-10T00:00:00Z', { parentSessionId: 'root-a' }),
      item('b', '2026-08-20T00:00:00Z', { parentSessionId: 'root-a' }),
    ]);
    const lines = renderForkTree(roots).split('\n');
    expect(lines).toEqual([
      '├── root-a  (2026-08-17)',
      '│   ├── b  (2026-08-20)',
      '│   └── a  (2026-08-10)',
      '└── root-b  (2026-08-01)',
    ]);
  });
});

describe('formatSessionsJson', () => {
  it('serialises the listing verbatim', () => {
    const result = {
      sessions: [item('s1', '2026-08-17T00:00:00Z')],
      truncated: false,
    };
    expect(JSON.parse(formatSessionsJson(result))).toEqual(result);
  });
});

describe('sessionsApiPath', () => {
  it('is the bare route without a cwd', () => {
    expect(sessionsApiPath()).toBe('/rc/sessions');
    expect(sessionsApiPath(undefined)).toBe('/rc/sessions');
  });

  it('appends an encoded ?cwd= override', () => {
    expect(sessionsApiPath('/w')).toBe('/rc/sessions?cwd=%2Fw');
    expect(sessionsApiPath('/a b/c')).toBe('/rc/sessions?cwd=%2Fa%20b%2Fc');
  });
});

describe('sessionsFromApiResponse', () => {
  it('passes a well-formed listing through', () => {
    const body = {
      sessions: [item('s1', '2026-08-17T00:00:00Z', { title: 'Main' })],
      truncated: true,
    };
    expect(sessionsFromApiResponse(body)).toEqual(body);
  });

  it('drops rows without a string sessionId', () => {
    const body = {
      sessions: [
        item('s1', '2026-08-17T00:00:00Z'),
        { sessionId: 42, forks: [], updatedAt: 'x' },
        null,
        'garbage',
        { forks: [] },
      ],
    };
    const r = sessionsFromApiResponse(body);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('yields an empty listing for a malformed body', () => {
    expect(sessionsFromApiResponse(null)).toEqual({
      sessions: [],
      truncated: false,
    });
    expect(sessionsFromApiResponse('nope')).toEqual({
      sessions: [],
      truncated: false,
    });
    expect(sessionsFromApiResponse({ sessions: 'x' })).toEqual({
      sessions: [],
      truncated: false,
    });
  });

  it('coerces truncated to a strict boolean true', () => {
    expect(
      sessionsFromApiResponse({ sessions: [], truncated: 'yes' }).truncated,
    ).toBe(false);
    expect(
      sessionsFromApiResponse({ sessions: [], truncated: true }).truncated,
    ).toBe(true);
  });
});
