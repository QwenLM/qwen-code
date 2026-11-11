/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildLazyMcpCatalogText,
  buildLazyMcpDeltaText,
  lazyMcpToolPrefix,
  type LazyMcpServerSnapshot,
} from '../tool-list-text.js';
import { LAZY_MCP_TEXT_MAX_CHARS } from '../constants.js';
import { buildMcpToolName } from '../../../mcp/tools/mcp-tool.js';

function server(
  serverName: string,
  tools: string[],
  extra: Partial<LazyMcpServerSnapshot> = {},
): LazyMcpServerSnapshot {
  return {
    serverName,
    toolNames: tools.map((tool) => buildMcpToolName(serverName, tool)),
    ...extra,
  };
}

/** Tool names listed under `serverName`'s header in a rendered catalog. */
function toolLine(text: string, serverName: string): string[] {
  const lines = text.split('\n');
  const prefix = lazyMcpToolPrefix(serverName);
  let index = lines.findIndex((line) =>
    line.startsWith(`- **${serverName}**`),
  );
  while (++index < lines.length && !lines[index].startsWith('- **')) {
    const line = lines[index].trim();
    if (line.startsWith(prefix)) return line.split(', ');
  }
  return [];
}

describe('buildLazyMcpCatalogText', () => {
  it('returns null when no server contributes tools', () => {
    expect(buildLazyMcpCatalogText([])).toBeNull();
    expect(buildLazyMcpCatalogText([server('empty', [])])).toBeNull();
  });

  it('lists each server with tool count, prefix, description and qualified names', () => {
    const text = buildLazyMcpCatalogText([
      server('weather', ['forecast', 'current']),
      server('db', ['query'], { instructions: 'Query the read-replica.\nMore.' }),
    ])!;
    expect(text).toContain('mcp_list');
    expect(text).toContain('mcp_get');
    expect(text).toContain('mcp_call');
    expect(text).toContain(
      '- **weather** (2 tools) — prefix `mcp__weather__`',
    );
    expect(text).toContain('- **db** (1 tool) — prefix `mcp__db__`');
    expect(text).toContain('  Query the read-replica.');
    expect(text).not.toContain('More.');
    expect(toolLine(text, 'weather')).toEqual([
      'mcp__weather__current',
      'mcp__weather__forecast',
    ]);
    expect(text).toContain('supersedes earlier MCP listings');
    expect(text).toContain(
      'An empty result does not mean a server is unconfigured',
    );
    expect(text).not.toContain('list only some of their tools');
  });

  it('prefers the configured description over server instructions', () => {
    const text = buildLazyMcpCatalogText([
      server('db', ['query'], {
        description: 'Analytics warehouse',
        instructions: 'Handshake instructions',
      }),
    ])!;
    expect(text).toContain('  Analytics warehouse');
    expect(text).not.toContain('Handshake instructions');
  });

  it('is stable regardless of input order', () => {
    const a = buildLazyMcpCatalogText([
      server('b', ['y', 'x']),
      server('a', ['z']),
    ]);
    const b = buildLazyMcpCatalogText([
      server('a', ['z']),
      server('b', ['x', 'y']),
    ]);
    expect(a).toEqual(b);
  });

  it('a server with many tools cannot crowd out the others', () => {
    const big = Array.from(
      { length: 400 },
      (_, i) => `operation_${i.toString().padStart(4, '0')}`,
    );
    const text = buildLazyMcpCatalogText([
      server('aaa-large', big),
      server('zzz-small', ['read', 'write', 'list']),
    ])!;
    expect(text.length).toBeLessThanOrEqual(LAZY_MCP_TEXT_MAX_CHARS);
    expect(toolLine(text, 'zzz-small')).toHaveLength(3);
    expect(text).toContain('- **zzz-small** (3 tools) — prefix');
    const shown = toolLine(text, 'aaa-large').length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(400);
    expect(text).toContain(`(400 tools, ${shown} shown)`);
    expect(text).toContain('list only some of their tools');
  });

  it('takes tools round-robin across servers, shorter names first', () => {
    const names = (tag: string) =>
      Array.from({ length: 300 }, (_, i) => `${tag}_tool_${i}`);
    const text = buildLazyMcpCatalogText([
      server('alpha', [...names('a'), 'x']),
      server('beta', names('b')),
    ])!;
    const alpha = toolLine(text, 'alpha');
    const beta = toolLine(text, 'beta');
    expect(alpha).toContain('mcp__alpha__x');
    expect(Math.abs(alpha.length - beta.length)).toBeLessThanOrEqual(1);
    expect(alpha.length).toBeLessThan(301);
  });

  it('splits the description budget evenly so every server keeps one', () => {
    const servers = Array.from({ length: 30 }, (_, i) =>
      server(`server_${i}`, ['read'], { instructions: '说明'.repeat(400) }),
    );
    const text = buildLazyMcpCatalogText(servers)!;
    expect(text.length).toBeLessThanOrEqual(LAZY_MCP_TEXT_MAX_CHARS);
    const descriptions = text
      .split('\n')
      .filter((line) => line.startsWith('  说明'));
    expect(descriptions).toHaveLength(30);
    expect(new Set(descriptions.map((line) => line.length)).size).toBe(1);
  });

  it('omits trailing servers when even the headers do not fit', () => {
    const servers = Array.from({ length: 500 }, (_, i) =>
      server(`server_${i.toString().padStart(4, '0')}`, ['read'], {
        instructions: 'optional-description',
      }),
    );
    const text = buildLazyMcpCatalogText(servers)!;
    expect(text.length).toBeLessThanOrEqual(LAZY_MCP_TEXT_MAX_CHARS);
    const rows = text.split('\n').filter((line) => line.startsWith('- **'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(500);
    expect(text).toContain(
      `- … ${500 - rows.length} more servers not listed.`,
    );
    expect(text).toContain('supersedes earlier MCP listings');
  });

  it('uses the normalized server segment as the prefix', () => {
    const snapshot = server('钉钉日志', ['search']);
    const text = buildLazyMcpCatalogText([snapshot])!;
    const prefix = lazyMcpToolPrefix('钉钉日志');
    expect(snapshot.toolNames[0].startsWith(prefix)).toBe(true);
    expect(text).toContain(`prefix \`${prefix}\``);
  });
});

describe('buildLazyMcpDeltaText', () => {
  it('returns null when nothing changed', () => {
    expect(buildLazyMcpDeltaText([server('a', ['x'])], [], [])).toBeNull();
  });

  it('lists new tools on a known server without repeating its description', () => {
    const current = server('repo', ['read', 'search'], {
      instructions: 'Repository tools',
    });
    const text = buildLazyMcpDeltaText([current], ['mcp__repo__search'], [])!;
    expect(text).toContain('remain available');
    expect(text).toContain('- **repo** (1 new) — prefix `mcp__repo__`');
    expect(text).toContain('  mcp__repo__search');
    expect(text).not.toContain('mcp__repo__read');
    expect(text).not.toContain('Repository tools');
    expect(text).not.toContain('No longer available');
  });

  it('describes a newly connected server', () => {
    const fresh = server('docs', ['find'], { description: 'Team docs' });
    const text = buildLazyMcpDeltaText(
      [server('repo', ['read']), fresh],
      fresh.toolNames,
      [],
    )!;
    expect(text).toContain('- **docs** (1 new)');
    expect(text).toContain('  Team docs');
  });

  it('collapses a vanished server and lists individual removals', () => {
    const text = buildLazyMcpDeltaText(
      [server('repo', ['read'])],
      [],
      ['mcp__repo__write', 'mcp__gone__a', 'mcp__gone__b'],
    )!;
    expect(text).toContain('## No longer available — do not call these');
    expect(text).toContain('`mcp__gone__*` (server disconnected or removed)');
    expect(text).toContain('- mcp__repo__write');
    expect(text).not.toContain('Newly available');
  });

  it('notes when no server is connected any more', () => {
    const text = buildLazyMcpDeltaText([], [], ['mcp__code__x'])!;
    expect(text).toContain('`mcp__code__*`');
    expect(text).toContain('No MCP servers are connected right now');
  });

  it('folds to per-server counts, then a summary, to stay within budget', () => {
    const many = server(
      'big',
      Array.from({ length: 2000 }, (_, i) => `tool_${i}`),
    );
    const counts = buildLazyMcpDeltaText([many], many.toolNames, [])!;
    expect(counts.length).toBeLessThanOrEqual(LAZY_MCP_TEXT_MAX_CHARS);
    expect(counts).toContain('- **big** (2000 new)');
    expect(counts).not.toContain('mcp__big__tool_1,');
    expect(counts).toContain('mcp_list({ server: "<server>" })');

    const gone = Array.from(
      { length: 2000 },
      (_, i) => `mcp__server_${i}__tool`,
    );
    const summary = buildLazyMcpDeltaText([], [], gone)!;
    expect(summary.length).toBeLessThanOrEqual(LAZY_MCP_TEXT_MAX_CHARS);
    expect(summary).toContain('2000 tools were removed.');
  });
});

describe('lazy MCP catalog — discovery', () => {
  it('keeps CodeMode discovery instructions within budget for partial catalogs and folded deltas', () => {
    const many = server(
      'big',
      Array.from({ length: 2000 }, (_, i) => `tool_${i}`),
    );
    const options = { codeMode: true };
    const catalog = buildLazyMcpCatalogText([many], options)!;
    const delta = buildLazyMcpDeltaText([many], many.toolNames, [], options)!;
    const gone = Array.from({ length: 2000 }, (_, i) => `mcp__server_${i}__tool`);
    const removed = buildLazyMcpDeltaText([], [], gone, options)!;

    expect(catalog).toContain('list only some of their tools');
    expect(delta).toContain('Tool names are omitted');
    expect(removed).toContain('2000 tools were removed');
    for (const text of [catalog, delta, removed]) {
      expect(text.length).toBeLessThanOrEqual(LAZY_MCP_TEXT_MAX_CHARS);
      expect(text).not.toMatch(/mcp_list|mcp_get|mcp_call/);
      expect(text).toContain('CodeMode');
    }
  });

  it('uses direct meta tools because only mode disables lazy loading', () => {
    const servers = [{ serverName: 'weather', toolNames: ['mcp__weather__a'] }];
    const text = buildLazyMcpCatalogText(servers)!;
    expect(text).toContain('mcp_list');
    expect(text).toContain('mcp_get');
    expect(text).toContain('mcp_call');
    expect(text).not.toContain('mcp.');
    expect(
      buildLazyMcpDeltaText([], [], ['mcp__old__tool']),
    ).toContain('mcp_list will return an empty result');
  });

  it('points agents with CodeMode at script discovery and prefers configured descriptions', () => {
    const servers = [
      {
        serverName: 'weather',
        description: 'Forecasts by city',
        instructions: 'Long handshake instructions',
        toolNames: ['mcp__weather__a'],
      },
    ];
    const text = buildLazyMcpCatalogText(servers, { codeMode: true })!;
    expect(text).toContain('callable only inside CodeMode');
    expect(text).toContain('searchTools(query, { namespace? })');
    expect(text).toContain('describeNamespace(server)');
    expect(text).toContain('image(block)');
    expect(text).toContain('Forecasts by city');
    expect(text).not.toContain('Long handshake instructions');
    expect(text).not.toMatch(/mcp_list|mcp_get|mcp_call|lazy-loading/);
    expect(
      buildLazyMcpDeltaText([], [], ['mcp__old__tool'], {
        codeMode: true,
      }),
    ).toContain('searchTools in CodeMode will return an empty result');
  });
});
