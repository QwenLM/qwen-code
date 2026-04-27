/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import stringWidth from 'string-width';

interface FlowNode {
  id: string;
  label: string;
  shape: FlowNodeShape;
}

interface FlowEdge {
  from: FlowNode;
  to: FlowNode;
  label?: string;
}

interface MermaidVisualResult {
  title: string;
  lines: string[];
  warning?: string;
}

type FlowNodeShape = 'rect' | 'diamond' | 'round';

interface FlowGraph {
  nodes: Map<string, FlowNode>;
  outgoing: Map<string, FlowEdge[]>;
  incomingCount: Map<string, number>;
  roots: FlowNode[];
}

interface PositionedNode {
  node: FlowNode;
  lines: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  rank: number;
}

const FLOW_START_RE = /^(?:flowchart|graph)\s+([A-Za-z]{2})/i;
const SEQUENCE_START_RE = /^sequenceDiagram\b/i;
const LINE_COMMENT_RE = /^%%/;
const MAX_RENDERED_LINES = 80;
const MIN_CANVAS_WIDTH = 24;
const NODE_GAP_X = 4;
const NODE_GAP_Y = 4;

function truncateToWidth(text: string, width: number): string {
  if (width <= 0 || stringWidth(text) <= width) return text;
  let result = '';
  for (const char of text) {
    if (stringWidth(result + char + '…') > width) break;
    result += char;
  }
  return result + '…';
}

function center(text: string, width: number): string {
  const padding = Math.max(0, width - stringWidth(text));
  const left = Math.floor(padding / 2);
  return ' '.repeat(left) + text + ' '.repeat(padding - left);
}

function stripMermaidPunctuation(text: string): string {
  return text
    .trim()
    .replace(/[;,]+$/g, '')
    .trim();
}

function normalizeNodeLabel(label: string): string {
  return label
    .replace(/^["']|["']$/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\n/g, '\n');
}

function nodeLabelLines(label: string): string[] {
  return label
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function singleLineLabel(label: string): string {
  return nodeLabelLines(label).join(' ');
}

function parseNodeToken(rawToken: string): FlowNode | null {
  const token = stripMermaidPunctuation(rawToken)
    .replace(/^\|.*?\|/, '')
    .trim();
  if (!token || /^subgraph\b|^end$/i.test(token)) return null;

  const idMatch = /^([A-Za-z0-9_.$:-]+)\s*(.*)$/.exec(token);
  if (!idMatch) {
    return {
      id: token,
      label: normalizeNodeLabel(token),
      shape: 'rect',
    };
  }

  const id = idMatch[1]!;
  const rest = idMatch[2]!.trim();
  const labelMatch =
    /^\[\[(.+)\]\]$/.exec(rest) ??
    /^\[(.+)\]$/.exec(rest) ??
    /^\(\((.+)\)\)$/.exec(rest) ??
    /^\((.+)\)$/.exec(rest) ??
    /^\{(.+)\}$/.exec(rest) ??
    /^>\s*(.+)\]$/.exec(rest);
  const shape: FlowNodeShape = /^\{(.+)\}$/.test(rest)
    ? 'diamond'
    : /^\(\((.+)\)\)$/.test(rest) || /^\((.+)\)$/.test(rest)
      ? 'round'
      : 'rect';

  return {
    id,
    label: normalizeNodeLabel(labelMatch?.[1] ?? id),
    shape,
  };
}

function parseFlowEdge(line: string): FlowEdge | null {
  const patterns: Array<{
    re: RegExp;
    labelIndex?: number;
    fromIndex: number;
    toIndex: number;
  }> = [
    {
      re: /^(.+?)\s*--\s*(.+?)\s*-->\s*(.+)$/i,
      fromIndex: 1,
      labelIndex: 2,
      toIndex: 3,
    },
    {
      re: /^(.+?)\s*-->\|(.+?)\|\s*(.+)$/i,
      fromIndex: 1,
      labelIndex: 2,
      toIndex: 3,
    },
    {
      re: /^(.+?)\s*(?:-->|---|==>|-\.->|--x|--o)\s*(.+)$/i,
      fromIndex: 1,
      toIndex: 2,
    },
  ];

  for (const pattern of patterns) {
    const match = pattern.re.exec(line);
    if (!match) continue;
    const from = parseNodeToken(match[pattern.fromIndex]!);
    const to = parseNodeToken(match[pattern.toIndex]!);
    if (!from || !to) return null;
    const label =
      pattern.labelIndex !== undefined
        ? stripMermaidPunctuation(match[pattern.labelIndex]!)
        : undefined;
    return { from, to, label: label || undefined };
  }

  return null;
}

function normalizeFlowNodeLabels(edges: FlowEdge[]): FlowEdge[] {
  const labelById = new Map<string, string>();
  const shapeById = new Map<string, FlowNodeShape>();

  for (const edge of edges) {
    for (const node of [edge.from, edge.to]) {
      if (node.label !== node.id && !labelById.has(node.id)) {
        labelById.set(node.id, node.label);
      }
      if (node.shape !== 'rect' && !shapeById.has(node.id)) {
        shapeById.set(node.id, node.shape);
      }
    }
  }

  return edges.map((edge) => ({
    ...edge,
    from: {
      ...edge.from,
      label: labelById.get(edge.from.id) ?? edge.from.label,
      shape: shapeById.get(edge.from.id) ?? edge.from.shape,
    },
    to: {
      ...edge.to,
      label: labelById.get(edge.to.id) ?? edge.to.label,
      shape: shapeById.get(edge.to.id) ?? edge.to.shape,
    },
  }));
}

function boxNode(node: FlowNode, width: number): string[] {
  const labels = nodeLabelLines(node.label).map((line) =>
    truncateToWidth(line, Math.max(3, width - 4)),
  );
  const innerWidth = Math.max(4, ...labels.map((label) => stringWidth(label)));
  if (node.shape === 'diamond') {
    return [
      ` ╱${'─'.repeat(innerWidth + 2)}╲ `,
      ...labels.map((label) => ` ◇ ${center(label, innerWidth)} ◇ `),
      ` ╲${'─'.repeat(innerWidth + 2)}╱ `,
    ];
  }

  if (node.shape === 'round') {
    return [
      `╭${'─'.repeat(innerWidth + 2)}╮`,
      ...labels.map((label) => `│ ${center(label, innerWidth)} │`),
      `╰${'─'.repeat(innerWidth + 2)}╯`,
    ];
  }

  return [
    `┌${'─'.repeat(innerWidth + 2)}┐`,
    ...labels.map((label) => `│ ${center(label, innerWidth)} │`),
    `└${'─'.repeat(innerWidth + 2)}┘`,
  ];
}

function buildFlowGraph(edges: FlowEdge[]): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const outgoing = new Map<string, FlowEdge[]>();
  const incomingCount = new Map<string, number>();

  for (const edge of edges) {
    nodes.set(edge.from.id, edge.from);
    nodes.set(edge.to.id, edge.to);
    const outgoingEdges = outgoing.get(edge.from.id) ?? [];
    outgoingEdges.push(edge);
    outgoing.set(edge.from.id, outgoingEdges);
    incomingCount.set(edge.to.id, (incomingCount.get(edge.to.id) ?? 0) + 1);
    if (!incomingCount.has(edge.from.id)) incomingCount.set(edge.from.id, 0);
  }

  const roots = Array.from(nodes.values()).filter(
    (node) => (incomingCount.get(node.id) ?? 0) === 0,
  );

  return {
    nodes,
    outgoing,
    incomingCount,
    roots: roots.length > 0 ? roots : [edges[0]!.from],
  };
}

function renderNodeLines(node: FlowNode, maxWidth: number): string[] {
  return boxNode(node, Math.max(8, maxWidth));
}

function lineWidth(line: string): number {
  return stringWidth(line);
}

function computeRanks(graph: FlowGraph): Map<string, number> {
  const ranks = new Map<string, number>();
  const queue = [...graph.roots];

  for (const root of graph.roots) {
    ranks.set(root.id, 0);
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    const rank = ranks.get(node.id) ?? 0;
    for (const edge of graph.outgoing.get(node.id) ?? []) {
      if (ranks.has(edge.to.id)) continue;
      ranks.set(edge.to.id, rank + 1);
      queue.push(edge.to);
    }
  }

  for (const node of graph.nodes.values()) {
    if (!ranks.has(node.id)) ranks.set(node.id, 0);
  }

  return ranks;
}

function branchPreference(label: string | undefined): number {
  if (!label) return 0;
  const normalized = label.trim().toLowerCase();
  if (/^(no|false|fail|failed|否|不|失败)$/.test(normalized)) return -1;
  if (/^(yes|true|pass|passed|是|成功)$/.test(normalized)) return 1;
  return 0;
}

function groupNodesByRank(
  graph: FlowGraph,
  ranks: Map<string, number>,
): FlowNode[][] {
  const layers: FlowNode[][] = [];
  const preferenceById = new Map<string, number>();
  const parentEdgesById = new Map<string, FlowEdge[]>();
  const originalIndexById = new Map<string, number>();

  Array.from(graph.nodes.values()).forEach((node, index) => {
    originalIndexById.set(node.id, index);
  });

  for (const edgeList of graph.outgoing.values()) {
    for (const edge of edgeList) {
      const parentEdges = parentEdgesById.get(edge.to.id) ?? [];
      parentEdges.push(edge);
      parentEdgesById.set(edge.to.id, parentEdges);
      const preference = branchPreference(edge.label);
      if (preference !== 0 && !preferenceById.has(edge.to.id)) {
        preferenceById.set(edge.to.id, preference);
      }
    }
  }

  for (const node of graph.nodes.values()) {
    const rank = ranks.get(node.id) ?? 0;
    layers[rank] ??= [];
    layers[rank]!.push(node);
  }
  const orderById = new Map<string, number>();
  for (const [rank, layer] of layers.entries()) {
    layer?.sort((a, b) => {
      const parentOrderDelta =
        parentOrder(a, rank, ranks, parentEdgesById, orderById) -
        parentOrder(b, rank, ranks, parentEdgesById, orderById);
      if (parentOrderDelta !== 0) return parentOrderDelta;
      const preferenceDelta =
        (preferenceById.get(a.id) ?? 0) - (preferenceById.get(b.id) ?? 0);
      if (preferenceDelta !== 0) return preferenceDelta;
      return (
        (originalIndexById.get(a.id) ?? 0) - (originalIndexById.get(b.id) ?? 0)
      );
    });
    layer?.forEach((node, index) => {
      orderById.set(node.id, index);
    });
  }
  return layers.filter((layer) => layer.length > 0);
}

function parentOrder(
  node: FlowNode,
  rank: number,
  ranks: Map<string, number>,
  parentEdgesById: Map<string, FlowEdge[]>,
  orderById: Map<string, number>,
): number {
  const parentEdges = parentEdgesById.get(node.id) ?? [];
  const orders = parentEdges
    .filter((edge) => (ranks.get(edge.from.id) ?? 0) < rank)
    .map((edge) => orderById.get(edge.from.id))
    .filter((order): order is number => order !== undefined);

  if (orders.length === 0) return Number.POSITIVE_INFINITY;
  return orders.reduce((sum, order) => sum + order, 0) / orders.length;
}

function createCanvas(width: number, height: number): string[][] {
  return Array.from({ length: height }, () => Array(width).fill(' '));
}

function mergeCanvasChar(existing: string, next: string): string {
  if (existing === ' ' || existing === next) return next;
  if ('▼▲◀▶→←↩'.includes(existing)) return existing;
  if ('▼▲◀▶→←↩'.includes(next)) return next;
  if (
    (existing === '│' && next === '─') ||
    (existing === '─' && next === '│') ||
    existing === '┼' ||
    next === '┼'
  ) {
    return '┼';
  }
  if ('┌┐└┘╭╮╰╯╱╲◇'.includes(existing)) return existing;
  return next;
}

function putChar(
  canvas: string[][],
  x: number,
  y: number,
  char: string,
  overwrite = false,
): void {
  if (y < 0 || y >= canvas.length || x < 0 || x >= canvas[y]!.length) return;
  canvas[y]![x] = overwrite ? char : mergeCanvasChar(canvas[y]![x]!, char);
}

function putText(
  canvas: string[][],
  x: number,
  y: number,
  text: string,
  overwrite = false,
): void {
  let cursor = x;
  for (const char of text) {
    const width = Math.max(1, stringWidth(char));
    putChar(canvas, cursor, y, char, overwrite);
    for (let offset = 1; offset < width; offset++) {
      if (
        y >= 0 &&
        y < canvas.length &&
        cursor + offset >= 0 &&
        cursor + offset < canvas[y]!.length
      ) {
        canvas[y]![cursor + offset] = '';
      }
    }
    cursor += width;
  }
}

function drawHorizontal(
  canvas: string[][],
  y: number,
  x1: number,
  x2: number,
): void {
  const start = Math.min(x1, x2);
  const end = Math.max(x1, x2);
  for (let x = start; x <= end; x++) putChar(canvas, x, y, '─');
}

function drawVertical(
  canvas: string[][],
  x: number,
  y1: number,
  y2: number,
): void {
  const start = Math.min(y1, y2);
  const end = Math.max(y1, y2);
  for (let y = start; y <= end; y++) putChar(canvas, x, y, '│');
}

function drawNode(canvas: string[][], positioned: PositionedNode): void {
  positioned.lines.forEach((line, offset) => {
    putText(canvas, positioned.x, positioned.y + offset, line, true);
  });
}

function layoutVertical(
  graph: FlowGraph,
  contentWidth: number,
): PositionedNode[] {
  const ranks = computeRanks(graph);
  const layers = groupNodesByRank(graph, ranks);
  const positioned: PositionedNode[] = [];
  let y = 0;

  for (const layer of layers) {
    const gapCount = Math.max(0, layer.length - 1);
    const maxNodeWidth = Math.max(
      8,
      Math.floor((contentWidth - gapCount * NODE_GAP_X) / layer.length),
    );
    const rendered = layer.map((node) => ({
      node,
      lines: renderNodeLines(node, Math.min(28, maxNodeWidth)),
    }));
    const totalWidth =
      rendered.reduce((sum, item) => sum + lineWidth(item.lines[0]!), 0) +
      gapCount * NODE_GAP_X;
    let x = Math.max(0, Math.floor((contentWidth - totalWidth) / 2));
    const layerHeight = Math.max(...rendered.map((item) => item.lines.length));

    for (const item of rendered) {
      const width = lineWidth(item.lines[0]!);
      const height = item.lines.length;
      positioned.push({
        node: item.node,
        lines: item.lines,
        x,
        y,
        width,
        height,
        centerX: x + Math.floor(width / 2),
        centerY: y + Math.floor(height / 2),
        rank: ranks.get(item.node.id) ?? 0,
      });
      x += width + NODE_GAP_X;
    }

    y += layerHeight + NODE_GAP_Y;
  }

  return positioned;
}

function layoutHorizontal(
  graph: FlowGraph,
  contentWidth: number,
): PositionedNode[] | null {
  const ranks = computeRanks(graph);
  const layers = groupNodesByRank(graph, ranks);
  const columnWidth = Math.max(
    10,
    Math.min(
      24,
      Math.floor(
        (contentWidth - (layers.length - 1) * NODE_GAP_X) / layers.length,
      ),
    ),
  );
  const totalWidth =
    layers.length * columnWidth + (layers.length - 1) * NODE_GAP_X;
  if (totalWidth > contentWidth || layers.length === 0) return null;

  const positioned: PositionedNode[] = [];
  let x = Math.max(0, Math.floor((contentWidth - totalWidth) / 2));

  for (const layer of layers) {
    let y = 0;
    for (const node of layer) {
      const lines = renderNodeLines(node, columnWidth);
      const width = lineWidth(lines[0]!);
      positioned.push({
        node,
        lines,
        x: x + Math.floor((columnWidth - width) / 2),
        y,
        width,
        height: lines.length,
        centerX: x + Math.floor(columnWidth / 2),
        centerY: y + Math.floor(lines.length / 2),
        rank: ranks.get(node.id) ?? 0,
      });
      y += lines.length + NODE_GAP_Y;
    }
    x += columnWidth + NODE_GAP_X;
  }

  return positioned;
}

function drawForwardVerticalEdge(
  canvas: string[][],
  from: PositionedNode,
  to: PositionedNode,
  label: string | undefined,
): void {
  const startY = from.y + from.height;
  const endY = to.y - 1;
  const midY = Math.max(startY, Math.floor((startY + endY) / 2));

  if (Math.abs(from.centerX - to.centerX) <= 1) {
    drawVertical(canvas, from.centerX, startY, endY);
    putChar(canvas, from.centerX, endY, '▼');
    if (label) {
      putText(
        canvas,
        Math.min(canvas[midY]!.length - 1, from.centerX + 2),
        midY,
        truncateToWidth(label, 14),
      );
    }
    return;
  }

  const bendY = Math.max(startY, Math.min(midY, endY - 1));
  const targetIsRight = to.centerX > from.centerX;
  drawVertical(canvas, from.centerX, startY, bendY);
  drawHorizontal(canvas, bendY, from.centerX, to.centerX);
  if (bendY + 1 <= endY) {
    drawVertical(canvas, to.centerX, bendY + 1, endY);
  }
  putChar(canvas, from.centerX, bendY, targetIsRight ? '└' : '┘', true);
  putChar(canvas, to.centerX, bendY, targetIsRight ? '┐' : '┌', true);
  putChar(canvas, to.centerX, endY, '▼');

  if (label) {
    const text = truncateToWidth(label, 14);
    const labelX =
      Math.abs(to.centerX - from.centerX) > stringWidth(text) + 2
        ? Math.min(from.centerX, to.centerX) +
          Math.floor(
            (Math.abs(to.centerX - from.centerX) - stringWidth(text)) / 2,
          )
        : Math.min(canvas[bendY]!.length - stringWidth(text), from.centerX + 2);
    putText(canvas, Math.max(0, labelX), bendY, text, true);
  }
}

function drawVerticalFork(
  canvas: string[][],
  from: PositionedNode,
  targets: Array<{ edge: FlowEdge; to: PositionedNode }>,
): void {
  if (targets.length === 0) return;
  if (targets.length === 1) {
    drawForwardVerticalEdge(
      canvas,
      from,
      targets[0]!.to,
      targets[0]!.edge.label,
    );
    return;
  }

  const sortedTargets = [...targets].sort(
    (a, b) => a.to.centerX - b.to.centerX,
  );
  const startY = from.y + from.height;
  const firstTargetTop = Math.min(
    ...sortedTargets.map((target) => target.to.y),
  );
  const forkY = Math.max(startY, firstTargetTop - 3);
  const labelY = Math.min(forkY + 1, firstTargetTop - 2);
  const minX = Math.min(...sortedTargets.map((target) => target.to.centerX));
  const maxX = Math.max(...sortedTargets.map((target) => target.to.centerX));

  drawVertical(canvas, from.centerX, startY, forkY);
  drawHorizontal(canvas, forkY, minX, maxX);
  putChar(canvas, from.centerX, forkY, '┴', true);

  for (const [index, target] of sortedTargets.entries()) {
    const endY = target.to.y - 1;
    const targetJunction =
      sortedTargets.length === 1
        ? '┴'
        : index === 0
          ? '┌'
          : index === sortedTargets.length - 1
            ? '┐'
            : '┬';
    putChar(canvas, target.to.centerX, forkY, targetJunction, true);
    putChar(canvas, target.to.centerX, endY, '▼');
    if (target.edge.label) {
      const label = `[${truncateToWidth(target.edge.label, 10)}]`;
      const x = Math.max(
        0,
        Math.min(
          canvas[labelY]!.length - stringWidth(label),
          target.to.centerX - Math.floor(stringWidth(label) / 2),
        ),
      );
      putText(canvas, x, labelY, label, true);
    }
    if (forkY + 1 <= labelY - 1) {
      drawVertical(canvas, target.to.centerX, forkY + 1, labelY - 1);
    }
    if (labelY + 1 <= endY) {
      drawVertical(canvas, target.to.centerX, labelY + 1, endY);
    }
  }
}

function formatLoopNote(
  from: PositionedNode,
  to: PositionedNode,
  label: string | undefined,
): string {
  const edgeLabel = label ? ` [${label}]` : '';
  return `${singleLineLabel(from.node.label)}${edgeLabel} ↩ to ${singleLineLabel(
    to.node.label,
  )}`;
}

function drawHorizontalEdge(
  canvas: string[][],
  from: PositionedNode,
  to: PositionedNode,
  label: string | undefined,
): void {
  const forward = to.rank > from.rank;
  const fromX = forward ? from.x + from.width : from.x - 1;
  const toX = forward ? to.x - 1 : to.x + to.width;
  const midX = Math.floor((fromX + toX) / 2);

  if (from.centerY === to.centerY) {
    drawHorizontal(canvas, from.centerY, fromX, toX);
    putChar(canvas, toX, to.centerY, forward ? '▶' : '◀');
    if (label) {
      const text = truncateToWidth(label, 12);
      putText(
        canvas,
        Math.max(0, midX - Math.floor(stringWidth(text) / 2)),
        from.centerY,
        text,
      );
    }
    return;
  }

  drawHorizontal(canvas, from.centerY, fromX, midX);
  drawVertical(canvas, midX, from.centerY, to.centerY);
  drawHorizontal(canvas, to.centerY, midX, toX);
  putChar(canvas, toX, to.centerY, forward ? '▶' : '◀');

  if (label) {
    const text = truncateToWidth(label, 12);
    putText(
      canvas,
      Math.max(0, midX - Math.floor(stringWidth(text) / 2)),
      Math.min(from.centerY, to.centerY),
      text,
    );
  }
}

function canvasToLines(canvas: string[][], contentWidth: number): string[] {
  return canvas
    .map((row) => truncateToWidth(row.join('').trimEnd(), contentWidth))
    .filter(
      (line, index, lines) => line.length > 0 || index < lines.length - 1,
    );
}

function renderLayeredFlowchart(
  edges: FlowEdge[],
  contentWidth: number,
  horizontal: boolean,
): string[] {
  const width = Math.max(MIN_CANVAS_WIDTH, contentWidth);
  const graph = buildFlowGraph(edges);
  const positioned =
    horizontal && graph.nodes.size <= 8
      ? (layoutHorizontal(graph, width) ?? layoutVertical(graph, width))
      : layoutVertical(graph, width);
  const byId = new Map(positioned.map((node) => [node.node.id, node]));
  const canvasHeight =
    Math.max(...positioned.map((node) => node.y + node.height), 1) + 2;
  const canvas = createCanvas(width, canvasHeight);
  const loopNotes: string[] = [];

  for (const edge of edges) {
    if (!horizontal && (graph.outgoing.get(edge.from.id)?.length ?? 0) > 1) {
      continue;
    }
    const from = byId.get(edge.from.id);
    const to = byId.get(edge.to.id);
    if (!from || !to) continue;
    if (horizontal && to.rank !== from.rank) {
      drawHorizontalEdge(canvas, from, to, edge.label);
    } else if (to.rank > from.rank) {
      drawForwardVerticalEdge(canvas, from, to, edge.label);
    } else {
      loopNotes.push(formatLoopNote(from, to, edge.label));
    }
  }

  if (!horizontal) {
    for (const edgeList of graph.outgoing.values()) {
      if (edgeList.length <= 1) continue;
      const source = byId.get(edgeList[0]!.from.id);
      if (!source) continue;
      const forwardTargets: Array<{ edge: FlowEdge; to: PositionedNode }> = [];
      for (const edge of edgeList) {
        const target = byId.get(edge.to.id);
        if (!target) continue;
        if (target.rank > source.rank) {
          forwardTargets.push({ edge, to: target });
        } else {
          loopNotes.push(formatLoopNote(source, target, edge.label));
        }
      }
      drawVerticalFork(canvas, source, forwardTargets);
    }
  }

  for (const node of positioned) {
    drawNode(canvas, node);
  }

  const lines = canvasToLines(canvas, contentWidth);
  if (loopNotes.length > 0) {
    lines.push('');
    lines.push('Cycles:');
    for (const note of loopNotes) {
      lines.push(truncateToWidth(`  ${note}`, contentWidth));
    }
  }

  return lines;
}

function renderFlowchart(
  source: string,
  contentWidth: number,
): MermaidVisualResult {
  const rawLines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !LINE_COMMENT_RE.test(line));
  const first = rawLines[0] ?? '';
  const direction = FLOW_START_RE.exec(first)?.[1]?.toUpperCase() ?? 'TD';
  const lines = rawLines.slice(FLOW_START_RE.test(first) ? 1 : 0);
  const edgeLines = lines.flatMap((line) =>
    line
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean),
  );
  const edges = edgeLines
    .map(parseFlowEdge)
    .filter((edge): edge is FlowEdge => edge !== null);
  const normalizedEdges = normalizeFlowNodeLabels(edges);

  if (normalizedEdges.length === 0) {
    return {
      title: 'Mermaid flowchart',
      lines: [
        '┌ Mermaid diagram ┐',
        '│ No previewable edges found. │',
        '└─────────────────┘',
      ],
      warning: 'Flowchart preview supports simple A --> B style edges.',
    };
  }

  const horizontal = direction.includes('LR') || direction.includes('RL');
  const rendered = renderLayeredFlowchart(
    normalizedEdges,
    contentWidth,
    horizontal,
  );

  return {
    title: `Mermaid flowchart (${direction})`,
    lines: rendered.slice(0, MAX_RENDERED_LINES),
    warning:
      rendered.length > MAX_RENDERED_LINES
        ? `Preview truncated to ${MAX_RENDERED_LINES} lines.`
        : undefined,
  };
}

function parseParticipant(line: string): { id: string; label: string } | null {
  const match = /^(?:participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i.exec(line);
  if (!match) return null;
  const id = stripMermaidPunctuation(match[1]!);
  return {
    id,
    label: stripMermaidPunctuation(match[2] ?? id),
  };
}

function renderSequence(
  source: string,
  contentWidth: number,
): MermaidVisualResult {
  const rawLines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !LINE_COMMENT_RE.test(line) &&
        !SEQUENCE_START_RE.test(line),
    );
  const participants = new Map<string, string>();
  const messages: string[] = [];

  for (const line of rawLines) {
    const participant = parseParticipant(line);
    if (participant) {
      participants.set(participant.id, participant.label);
      continue;
    }

    const messageMatch =
      /^(.+?)(-->>|->>|-->|->|--x|-x)\s*(.+?)\s*:\s*(.+)$/.exec(line);
    if (!messageMatch) continue;
    const from = stripMermaidPunctuation(messageMatch[1]!);
    const arrow = messageMatch[2]!.includes('--') ? '⇢' : '→';
    const to = stripMermaidPunctuation(messageMatch[3]!);
    const message = stripMermaidPunctuation(messageMatch[4]!);
    if (!participants.has(from)) participants.set(from, from);
    if (!participants.has(to)) participants.set(to, to);
    messages.push(
      truncateToWidth(
        `${participants.get(from) ?? from} ${arrow} ${participants.get(to) ?? to}: ${message}`,
        contentWidth,
      ),
    );
  }

  const header =
    participants.size > 0
      ? `Participants: ${Array.from(participants.values()).join(' | ')}`
      : 'Participants: not declared';
  const lines = [truncateToWidth(header, contentWidth), ''];
  lines.push(
    ...(messages.length > 0 ? messages : ['No previewable messages found.']),
  );

  return {
    title: 'Mermaid sequence diagram',
    lines: lines.slice(0, MAX_RENDERED_LINES),
    warning:
      messages.length === 0
        ? 'Sequence preview supports A->>B: message style arrows.'
        : undefined,
  };
}

export function renderMermaidVisual(
  source: string,
  contentWidth: number,
): MermaidVisualResult {
  const trimmed = source.trim();
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim()) ?? '';
  if (FLOW_START_RE.test(firstLine)) {
    return renderFlowchart(trimmed, contentWidth);
  }
  if (SEQUENCE_START_RE.test(firstLine)) {
    return renderSequence(trimmed, contentWidth);
  }

  const type = firstLine.split(/\s+/)[0] || 'unknown';
  return {
    title: `Mermaid ${type} diagram`,
    lines: [
      '┌─────────────────────────────┐',
      '│ Visual preview unavailable. │',
      '└─────────────────────────────┘',
    ],
    warning:
      'First preview supports flowchart/graph and sequenceDiagram diagrams.',
  };
}
