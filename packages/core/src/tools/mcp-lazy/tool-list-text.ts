/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LAZY_MCP_SERVER_DESC_MAX_CHARS,
  LAZY_MCP_TEXT_MAX_CHARS,
} from './constants.js';
import { truncateString } from '../../utils/textUtils.js';
import {
  MCP_QUALIFIED_NAME_SEPARATOR,
  MCP_TOOL_PREFIX,
  normalizeMcpSegment,
} from '../../mcp/tools/mcp-names.js';

/**
 * Snapshot of a connected MCP server's contribution that the lazy mode
 * surfaces to the model via the `mcp_lazy_tools_delta` attachment.
 */
export interface LazyMcpServerSnapshot {
  serverName: string;
  /** User-configured server description; preferred over `instructions`. */
  description?: string;
  /** Server's `instructions` from the MCP handshake, if any. */
  instructions?: string;
  /** Fully qualified `mcp__server__tool` names this server provides. */
  toolNames: string[];
}

export interface LazyMcpTextOptions {
  /** The agent reaches deferred tools inside CodeMode; the meta tools are hidden from it. */
  codeMode?: boolean;
}

const DISCOVERY_COPY = {
  direct: {
    lead: 'Use these three meta tools to discover and invoke them:',
    bullets: [
      '  • `mcp_list({ keyword?, server?, includeDescription? })` — search or list tools.',
      "  • `mcp_get({ toolName })` — fetch a tool's input schema.",
      '  • `mcp_call({ toolName, arguments })` — invoke a tool by its ' +
        'fully-qualified `mcp__server__tool` name.',
    ],
    fallback: 'mcp_list/mcp_get/mcp_call.',
    discover: 'mcp_list',
    listServer:
      'call `mcp_list({ server: "<server>" })`.',
    invoke: 'mcp_get / mcp_call',
  },
  codeMode: {
    lead: 'They are callable only inside CodeMode scripts:',
    bullets: [
      '  • `await searchTools(query, { namespace? })` or `ALL_TOOLS` — discover tools; ' +
        'namespace is a server name below.',
      '  • `await describeNamespace(server)` — server instructions and tool names.',
      "  • `await describeTool(name)` — a tool's signature.",
      '  • `tools[name](args)` — invoke it; show image blocks from its result with `image(block)`.',
    ],
    fallback: 'searchTools/describeTool in CodeMode, then tools[name](args).',
    discover: 'searchTools in CodeMode',
    listServer: 'call `await describeNamespace(server)` inside CodeMode.',
    invoke: 'describeTool / tools[name](args) inside CodeMode',
  },
};

/** Qualified-name prefix every tool of `serverName` starts with. */
export function lazyMcpToolPrefix(serverName: string): string {
  return `${MCP_TOOL_PREFIX}${normalizeMcpSegment(serverName)}${MCP_QUALIFIED_NAME_SEPARATOR}`;
}

function serverSummary(server: LazyMcpServerSnapshot): string {
  const text = server.description?.trim() || server.instructions || '';
  return (text.split('\n', 1)[0] ?? '').trim();
}

function countLabel(total: number, shown: number): string {
  const tools = total === 1 ? '1 tool' : `${total} tools`;
  if (shown === total) return tools;
  return shown === 0 ? `${tools}, none shown` : `${tools}, ${shown} shown`;
}

function serverHeader(
  server: LazyMcpServerSnapshot,
  label: string,
): string {
  return `- **${server.serverName}** (${label}) — prefix \`${lazyMcpToolPrefix(server.serverName)}\``;
}

/** Longest header the server can end up with, whatever number of tools is shown. */
function reservedHeaderLength(server: LazyMcpServerSnapshot): number {
  const total = server.toolNames.length;
  return Math.max(
    serverHeader(server, countLabel(total, 0)).length,
    serverHeader(server, countLabel(total, Math.max(0, total - 1))).length,
  );
}

const DESCRIPTION_INDENT = '\n  ';
const TOOLS_INDENT = '\n  ';
const TOOLS_SEPARATOR = ', ';

/**
 * 完整目录：每个服务器必有表头（工具数 + 名称前缀），描述平均分预算，
 * 工具名按服务器轮流、名字短的优先取，避免工具多的服务器挤掉其他服务器。
 */
export function buildLazyMcpCatalogText(
  servers: readonly LazyMcpServerSnapshot[],
  options?: LazyMcpTextOptions,
): string | null {
  const sorted = servers
    .filter((server) => server.toolNames.length > 0)
    .sort((a, b) => a.serverName.localeCompare(b.serverName));
  if (sorted.length === 0) return null;

  const { lead, bullets, fallback, discover, listServer } = options?.codeMode
    ? DISCOVERY_COPY.codeMode
    : DISCOVERY_COPY.direct;
  const intro = [
    (options?.codeMode ? '' : 'MCP lazy-loading is active. ') +
      'Some MCP tools are deferred and are not directly ' +
      `exposed in your tool list. ${lead}`,
    '',
    ...bullets,
  ].join('\n');
  const footer = [
    'Call MCP tools directly only when they are exposed in your tool list; ' +
      `otherwise use ${fallback}`,
    'This catalog supersedes earlier MCP listings. Later reminders only announce changes. ' +
      `Use ${discover} for current discovery. An empty result does not mean a server is unconfigured.`,
  ].join('\n');
  const partialHint =
    'Servers marked "shown" list only some of their tools. To see all tools of a server, ' +
    listServer;
  const fixed = `${intro}\n\n## MCP servers\n\n${partialHint}\n\n${footer}`;
  const omittedLine = (count: number) =>
    `- … ${count} more servers not listed. Use ${discover} to discover their tools.`;
  const skeletonLength = (kept: number) =>
    fixed.length +
    sorted
      .slice(0, kept)
      .reduce((sum, server) => sum + reservedHeaderLength(server) + 1, 0) +
    (kept < sorted.length ? omittedLine(sorted.length - kept).length + 1 : 0);

  let kept = sorted.length;
  while (kept > 0 && skeletonLength(kept) > LAZY_MCP_TEXT_MAX_CHARS) kept--;
  const listed = sorted.slice(0, kept);
  let remaining = LAZY_MCP_TEXT_MAX_CHARS - skeletonLength(kept);

  const descriptions = new Map<LazyMcpServerSnapshot, string>();
  if (listed.length > 0) {
    const perServer = Math.min(
      LAZY_MCP_SERVER_DESC_MAX_CHARS,
      Math.floor(remaining / 2 / listed.length) - DESCRIPTION_INDENT.length,
    );
    if (perServer > 3) {
      for (const server of listed) {
        const summary = serverSummary(server);
        if (!summary) continue;
        const text = truncateString(summary, perServer - 3, '...');
        descriptions.set(server, text);
        remaining -= DESCRIPTION_INDENT.length + text.length;
      }
    }
  }

  const selected = new Map<LazyMcpServerSnapshot, Set<string>>(
    listed.map((server) => [server, new Set<string>()]),
  );
  const queues = listed.map((server) => ({
    server,
    order: [...server.toolNames].sort(
      (a, b) => a.length - b.length || a.localeCompare(b),
    ),
    next: 0,
  }));
  let active = queues;
  while (active.length > 0) {
    const stillActive: typeof queues = [];
    for (const queue of active) {
      const name = queue.order[queue.next];
      const picked = selected.get(queue.server)!;
      const cost =
        name.length +
        (picked.size === 0 ? TOOLS_INDENT.length : TOOLS_SEPARATOR.length);
      if (cost > remaining) continue;
      picked.add(name);
      remaining -= cost;
      queue.next++;
      if (queue.next < queue.order.length) stillActive.push(queue);
    }
    active = stillActive;
  }

  const complete =
    kept === sorted.length &&
    listed.every(
      (server) => selected.get(server)!.size === server.toolNames.length,
    );
  const blocks = listed.map((server) => {
    const picked = [...selected.get(server)!].sort((a, b) =>
      a.localeCompare(b),
    );
    let block = serverHeader(
      server,
      countLabel(server.toolNames.length, picked.length),
    );
    const description = descriptions.get(server);
    if (description) block += DESCRIPTION_INDENT + description;
    if (picked.length > 0)
      block += TOOLS_INDENT + picked.join(TOOLS_SEPARATOR);
    return block;
  });
  if (kept < sorted.length) blocks.push(omittedLine(sorted.length - kept));

  return [
    intro,
    `## MCP servers\n${blocks.join('\n')}`,
    ...(complete ? [] : [partialHint]),
    footer,
  ].join('\n\n');
}

/** Server segment of a qualified name, or undefined when it is not one. */
function serverSegment(qualifiedName: string): string | undefined {
  if (!qualifiedName.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = qualifiedName.slice(MCP_TOOL_PREFIX.length);
  const end = rest.indexOf(MCP_QUALIFIED_NAME_SEPARATOR);
  return end > 0 ? rest.slice(0, end) : undefined;
}

/**
 * 增量提醒：只说明相对已告知目录的新增与移除。放不下时逐级折叠
 * （工具名 → 每个服务器的数量 → 总数），保证不超过预算。
 */
export function buildLazyMcpDeltaText(
  servers: readonly LazyMcpServerSnapshot[],
  addedNames: readonly string[],
  removedNames: readonly string[],
  options?: LazyMcpTextOptions,
): string | null {
  if (addedNames.length === 0 && removedNames.length === 0) return null;
  const { discover, listServer, invoke } = options?.codeMode
    ? DISCOVERY_COPY.codeMode
    : DISCOVERY_COPY.direct;
  const added = new Set(addedNames);
  const sorted = [...servers].sort((a, b) =>
    a.serverName.localeCompare(b.serverName),
  );
  const addedGroups = sorted
    .map((server) => ({
      server,
      names: server.toolNames
        .filter((name) => added.has(name))
        .sort((a, b) => a.localeCompare(b)),
    }))
    .filter((group) => group.names.length > 0);

  const liveSegments = new Set(
    servers.map((server) => normalizeMcpSegment(server.serverName)),
  );
  const goneSegments = new Set<string>();
  const removedTools: string[] = [];
  for (const name of [...removedNames].sort((a, b) => a.localeCompare(b))) {
    const segment = serverSegment(name);
    if (segment !== undefined && !liveSegments.has(segment))
      goneSegments.add(segment);
    else removedTools.push(name);
  }
  const goneServers = [...goneSegments].map(
    (segment) =>
      `${MCP_TOOL_PREFIX}${segment}${MCP_QUALIFIED_NAME_SEPARATOR}*`,
  );

  const head =
    'MCP tool catalog update. Tools from earlier MCP reminders remain available ' +
    'unless listed as removed below.';
  const tail =
    servers.length === 0
      ? `No MCP servers are connected right now; ${discover} will return an empty result until one reconnects.`
      : `Use ${invoke} for these tools the same way as for the others.`;

  const render = (detail: 'full' | 'counts' | 'summary') => {
    const sections: string[] = [head];
    if (addedGroups.length > 0) {
      if (detail === 'summary') {
        sections.push(
          `## Newly available\n${addedNames.length} new tools on ${addedGroups.length} servers. Use ${discover} to discover them.`,
        );
      } else {
        const lines = addedGroups.map(({ server, names }) => {
          const isNewServer = names.length === server.toolNames.length;
          let line = `- **${server.serverName}** (${names.length} new) — prefix \`${lazyMcpToolPrefix(server.serverName)}\``;
          const summary = isNewServer ? serverSummary(server) : '';
          if (summary)
            line +=
              DESCRIPTION_INDENT +
              truncateString(summary, LAZY_MCP_SERVER_DESC_MAX_CHARS - 3, '...');
          if (detail === 'full')
            line += TOOLS_INDENT + names.join(TOOLS_SEPARATOR);
          return line;
        });
        if (detail === 'counts')
          lines.push(
            `Tool names are omitted to save space. To see all tools of a server, ${listServer}`,
          );
        sections.push(`## Newly available\n${lines.join('\n')}`);
      }
    }
    if (goneServers.length > 0 || removedTools.length > 0) {
      const lines: string[] = [];
      if (detail === 'summary') {
        lines.push(
          `${removedNames.length} tools were removed. Rediscover with ${discover} before calling a tool from an earlier listing.`,
        );
      } else {
        for (const pattern of goneServers)
          lines.push(`- \`${pattern}\` (server disconnected or removed)`);
        if (removedTools.length > 0)
          lines.push(
            detail === 'full'
              ? `- ${removedTools.join(TOOLS_SEPARATOR)}`
              : `- ${removedTools.length} tools on still-connected servers. Rediscover with ${discover} before calling them.`,
          );
      }
      sections.push(
        `## No longer available — do not call these\n${lines.join('\n')}`,
      );
    }
    sections.push(tail);
    return sections.join('\n\n');
  };

  for (const detail of ['full', 'counts'] as const) {
    const text = render(detail);
    if (text.length <= LAZY_MCP_TEXT_MAX_CHARS) return text;
  }
  return render('summary');
}
