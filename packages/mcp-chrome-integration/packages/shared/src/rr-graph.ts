// rr-graph.ts — shared DAG helpers for Record & Replay
// Note: keep types lightweight to avoid cross-package coupling
// Centralize step type strings and tiny helpers here to avoid magic literals.

import { EDGE_LABELS, type EdgeLabel } from './labels';

export interface RRNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}
export interface RREdge {
  id: string;
  from: string;
  to: string;
  label?: EdgeLabel;
}

// Centralized step type strings (kept in shared to avoid duplication)
export const RR_STEP_TYPES = {
  CLICK: 'click',
  DBLCLICK: 'dblclick',
  FILL: 'fill',
  DRAG: 'drag',
  KEY: 'key',
  WAIT: 'wait',
  ASSERT: 'assert',
  IF: 'if',
  FOREACH: 'foreach',
  WHILE: 'while',
  NAVIGATE: 'navigate',
  SCRIPT: 'script',
  HTTP: 'http',
  EXTRACT: 'extract',
  SCREENSHOT: 'screenshot',
  SCROLL: 'scroll',
  TRIGGER_EVENT: 'triggerEvent',
  SET_ATTRIBUTE: 'setAttribute',
  LOOP_ELEMENTS: 'loopElements',
  SWITCH_FRAME: 'switchFrame',
  OPEN_TAB: 'openTab',
  SWITCH_TAB: 'switchTab',
  CLOSE_TAB: 'closeTab',
  EXECUTE_FLOW: 'executeFlow',
  HANDLE_DOWNLOAD: 'handleDownload',
  // UI-only, mapped to WAIT
  DELAY: 'delay',
} as const;
export type RRStepType = (typeof RR_STEP_TYPES)[keyof typeof RR_STEP_TYPES];

function ensureTarget(t: any) {
  return t && typeof t === 'object' ? t : { candidates: [] };
}

// Topological order using Kahn's algorithm; edges considered as-is (caller may pre-filter labels)
export function topoOrder<T extends RRNode>(nodes: T[], edges: RREdge[]): T[] {
  const id2n = new Map(nodes.map((n) => [n.id, n] as const));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0] as const));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  const nexts = new Map<string, string[]>(nodes.map((n) => [n.id, [] as string[]] as const));
  for (const e of edges) nexts.get(e.from)!.push(e.to);
  const q: string[] = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id);
  const out: T[] = [];
  while (q.length) {
    const id = q.shift()!;
    const n = id2n.get(id);
    if (!n) continue;
    out.push(n as T);
    for (const v of nexts.get(id)!) {
      indeg.set(v, (indeg.get(v) || 0) - 1);
      if ((indeg.get(v) || 0) === 0) q.push(v);
    }
  }
  return out.length === nodes.length ? out : nodes.slice();
}

// Map a Node (Flow V2) to a linear Step (Flow V1)
export function mapNodeToStep(node: RRNode): any {
  const c: any = node.config || {};
  const base = { id: node.id } as any;
  // Config-driven generic mapping (prefer this path)
  try {
    const type = String(node.type);
    // UI-only helper: delay -> wait.sleep
    if (type === 'delay') {
      const sleep = Number((c as any).sleep ?? (c as any).ms ?? 1000);
      return { ...base, type: 'wait', condition: { sleep: Math.max(0, sleep) } };
    }
    const step: any = { ...base, type, ...c };
    if (step.target) step.target = ensureTarget(step.target);
    if (step.start) step.start = ensureTarget(step.start);
    if (step.end) step.end = ensureTarget(step.end);
    return step;
  } catch {}
  switch (node.type) {
    case RR_STEP_TYPES.CLICK:
    case RR_STEP_TYPES.DBLCLICK:
      return {
        ...base,
        type: node.type,
        target: ensureTarget(c.target),
        before: c.before,
        after: c.after,
      };
    case RR_STEP_TYPES.FILL:
      return {
        ...base,
        type: RR_STEP_TYPES.FILL,
        target: ensureTarget(c.target),
        value: c.value || '',
      };
    case RR_STEP_TYPES.DRAG:
      return {
        ...base,
        type: RR_STEP_TYPES.DRAG,
        start: ensureTarget(c.start),
        end: ensureTarget(c.end),
        path: Array.isArray(c.path) ? c.path : undefined,
      };
    case RR_STEP_TYPES.KEY:
      return { ...base, type: RR_STEP_TYPES.KEY, keys: c.keys || '' };
    case RR_STEP_TYPES.WAIT:
      return {
        ...base,
        type: RR_STEP_TYPES.WAIT,
        condition: c.condition || { text: '', appear: true },
      };
    case RR_STEP_TYPES.ASSERT:
      return {
        ...base,
        type: RR_STEP_TYPES.ASSERT,
        assert: c.assert || { exists: '' },
        failStrategy: c.failStrategy,
      };
    case RR_STEP_TYPES.IF:
      return { ...base, type: RR_STEP_TYPES.IF, condition: c.condition || {} };
    case RR_STEP_TYPES.FOREACH:
      return {
        ...base,
        type: RR_STEP_TYPES.FOREACH,
        listVar: c.listVar || '',
        itemVar: c.itemVar || 'item',
        subflowId: c.subflowId || '',
      };
    case RR_STEP_TYPES.WHILE:
      return {
        ...base,
        type: RR_STEP_TYPES.WHILE,
        condition: c.condition || {},
        subflowId: c.subflowId || '',
        maxIterations: Math.max(0, Number(c.maxIterations ?? 100)),
      };
    case RR_STEP_TYPES.NAVIGATE:
      return { ...base, type: RR_STEP_TYPES.NAVIGATE, url: c.url || '' };
    case RR_STEP_TYPES.SCRIPT:
      return {
        ...base,
        type: RR_STEP_TYPES.SCRIPT,
        world: c.world || 'ISOLATED',
        code: c.code || '',
        when: c.when,
      };
    case RR_STEP_TYPES.DELAY: // map to wait.sleep to avoid navigation confusion
      return {
        ...base,
        type: RR_STEP_TYPES.WAIT,
        condition: { sleep: Math.max(0, Number(c.ms ?? 1000)) },
      };
    case RR_STEP_TYPES.HTTP:
      return {
        ...base,
        type: RR_STEP_TYPES.HTTP,
        method: c.method || 'GET',
        url: c.url || '',
        headers: c.headers || {},
        body: c.body,
        formData: c.formData,
        saveAs: c.saveAs || '',
      };
    case RR_STEP_TYPES.EXTRACT:
      return {
        ...base,
        type: RR_STEP_TYPES.EXTRACT,
        selector: c.selector || '',
        attr: c.attr || 'text',
        js: c.js || '',
        saveAs: c.saveAs || '',
      };
    case RR_STEP_TYPES.SCREENSHOT:
      return {
        ...base,
        type: RR_STEP_TYPES.SCREENSHOT,
        selector: c.selector || '',
        fullPage: !!c.fullPage,
        saveAs: c.saveAs || '',
      };
    case RR_STEP_TYPES.SCROLL:
      return {
        ...base,
        type: RR_STEP_TYPES.SCROLL,
        mode: c.mode || 'offset',
        target: ensureTarget(c.target),
        offset: c.offset || { x: 0, y: 300 },
      };
    case RR_STEP_TYPES.TRIGGER_EVENT:
      return {
        ...base,
        type: RR_STEP_TYPES.TRIGGER_EVENT,
        target: ensureTarget(c.target),
        event: c.event || 'input',
        bubbles: c.bubbles !== false,
        cancelable: !!c.cancelable,
      };
    case RR_STEP_TYPES.SET_ATTRIBUTE:
      return {
        ...base,
        type: RR_STEP_TYPES.SET_ATTRIBUTE,
        target: ensureTarget(c.target),
        name: c.name || '',
        value: c.value,
        remove: !!c.remove,
      };
    case RR_STEP_TYPES.LOOP_ELEMENTS:
      return {
        ...base,
        type: RR_STEP_TYPES.LOOP_ELEMENTS,
        selector: c.selector || '',
        saveAs: c.saveAs || 'elements',
        itemVar: c.itemVar || 'item',
        subflowId: c.subflowId || '',
      };
    case RR_STEP_TYPES.SWITCH_FRAME:
      return {
        ...base,
        type: RR_STEP_TYPES.SWITCH_FRAME,
        frame: {
          index: c.frame && c.frame.index != null ? Number(c.frame.index) : undefined,
          urlContains: c.frame?.urlContains || '',
        },
      };
    case RR_STEP_TYPES.OPEN_TAB:
      return { ...base, type: RR_STEP_TYPES.OPEN_TAB, url: c.url || '', newWindow: !!c.newWindow };
    case RR_STEP_TYPES.SWITCH_TAB:
      return {
        ...base,
        type: RR_STEP_TYPES.SWITCH_TAB,
        tabId: c.tabId || undefined,
        urlContains: c.urlContains || '',
        titleContains: c.titleContains || '',
      };
    case RR_STEP_TYPES.CLOSE_TAB:
      return {
        ...base,
        type: RR_STEP_TYPES.CLOSE_TAB,
        tabIds: Array.isArray(c.tabIds) ? c.tabIds : undefined,
        url: c.url || '',
      };
    case RR_STEP_TYPES.EXECUTE_FLOW:
      return {
        ...base,
        type: RR_STEP_TYPES.EXECUTE_FLOW,
        flowId: c.flowId || '',
        inline: c.inline !== false,
        args: c.args || {},
      };
    case RR_STEP_TYPES.HANDLE_DOWNLOAD:
      return {
        ...base,
        type: RR_STEP_TYPES.HANDLE_DOWNLOAD,
        filenameContains: c.filenameContains || '',
        waitForComplete: c.waitForComplete !== false,
        timeoutMs: Math.max(0, Number(c.timeoutMs ?? 60000)),
        saveAs: c.saveAs || '',
      };
    default:
      return { ...base, type: RR_STEP_TYPES.SCRIPT, world: 'ISOLATED', code: '' };
  }
}

export function nodesToSteps(nodes: RRNode[], edges: RREdge[]): any[] {
  const order = edges && edges.length ? topoOrder(nodes, edges) : nodes.slice();
  return order.map((n) => mapNodeToStep(n));
}

// Reverse mapping (Step -> Node config)
export function mapStepToNodeConfig(step: unknown): Record<string, unknown> {
  if (!step || typeof step !== 'object') return {};
  const src = step as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'id' || k === 'type') continue;
    out[k] = v;
  }
  const target = out['target'];
  if (target) out['target'] = ensureTarget(target);
  const start = out['start'];
  if (start) out['start'] = ensureTarget(start);
  const end = out['end'];
  if (end) out['end'] = ensureTarget(end);
  return out;
}

export function stepsToNodes(steps: ReadonlyArray<unknown>): RRNode[] {
  const arr: RRNode[] = [];
  steps.forEach((step, i) => {
    const obj: Record<string, unknown> =
      step && typeof step === 'object' ? (step as Record<string, unknown>) : {};
    const idValue = obj['id'];
    const typeValue = obj['type'];
    const id = typeof idValue === 'string' && idValue ? idValue : `n_${i}`;
    const type = typeof typeValue === 'string' && typeValue ? typeValue : RR_STEP_TYPES.SCRIPT;
    arr.push({ id, type, config: mapStepToNodeConfig(step) });
  });
  return arr;
}

/**
 * Convert linear steps array to DAG format (nodes + edges).
 * Generates sequential edges connecting nodes in order.
 */
export function stepsToDAG(steps: ReadonlyArray<unknown>): { nodes: RRNode[]; edges: RREdge[] } {
  const nodes = stepsToNodes(steps);
  const edges: RREdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const from = nodes[i].id;
    const to = nodes[i + 1].id;
    // Include index in edge id to avoid collision when step ids repeat
    edges.push({
      id: `e_${i}_${from}_${to}`,
      from,
      to,
      label: EDGE_LABELS.DEFAULT,
    });
  }
  return { nodes, edges };
}
