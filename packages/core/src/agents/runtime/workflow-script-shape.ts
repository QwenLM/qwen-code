/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview A static read of a workflow script, for two consumers that must
 * not run it:
 *
 * - the approval dialog, which shows where the agents are — a step, a
 *   `parallel()`/`pipeline()` fan-out, a loop — instead of leaving the user to
 *   infer it from a 1,200-character excerpt;
 * - the launch gate, which refuses a script that reads a clock or a random
 *   source before any agent has spent a token, rather than letting it fail on
 *   whichever call reaches the sandbox guard first.
 *
 * It is a tokenizer, not a parser. String contents, template text and comments
 * are masked out, so an `agent(` or `Date.now(` inside them is not code;
 * template `${...}` expressions are kept, because they are code. Two limits are
 * accepted: a regular-expression literal is not recognised (a quote inside one
 * can desynchronise the masking for the rest of that line), and a local
 * binding that shadows `Date` or `Math` still counts as the global.
 */

export type WorkflowShapeRowKind = 'step' | 'parallel' | 'loop';

export interface WorkflowShapeRow {
  readonly kind: WorkflowShapeRowKind;
  /** `agent(` call sites in this row. A loop or fan-out runs each many times. */
  count: number;
  /** The loop head, e.g. `while (budget.remaining() > 50_000)`. Loops only. */
  readonly condition?: string;
  /** Leading string-literal prompts, summarised. At most two. */
  readonly prompts: string[];
  /** 1-based line of the row's first call site. */
  readonly line: number;
}

export type WorkflowNonDeterministicCall =
  | 'Math.random()'
  | 'Date.now()'
  | 'Date.parse()'
  | 'Date.UTC()'
  | 'new Date()';

export interface WorkflowDeterminismViolation {
  readonly call: WorkflowNonDeterministicCall;
  /** 1-based line in the script as written. */
  readonly line: number;
}

export interface WorkflowScriptShape {
  readonly rows: readonly WorkflowShapeRow[];
  readonly agentCalls: number;
  readonly determinismViolations: readonly WorkflowDeterminismViolation[];
}

const PROMPT_SUMMARY_CHARS = 60;
const LOOP_HEAD_CHARS = 40;
const MAX_PROMPTS_PER_ROW = 2;
const MAX_VIOLATIONS_LISTED = 5;
/** Prompt text read past this is never shown; stop accumulating it. */
const PROMPT_READ_LIMIT = 400;

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const SPACE = /\s/;

/**
 * The source with every character that is not code replaced by a space.
 * Newlines survive, so indexes and line numbers match the original.
 */
function maskNonCode(source: string): string {
  const n = source.length;
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  // Brace depth just outside each open `${`, innermost last.
  const templateStack: number[] = [];
  let braceDepth = 0;

  // Template text from `from` (past a backtick, or past the `}` closing an
  // expression) up to where code resumes.
  const scanTemplateText = (from: number): number => {
    let j = from;
    while (j < n) {
      const ch = source[j];
      if (ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === '`') {
        blank(from, j + 1);
        return j + 1;
      }
      if (ch === '$' && source[j + 1] === '{') {
        blank(from, j + 2);
        templateStack.push(braceDepth);
        braceDepth++;
        return j + 2;
      }
      j++;
    }
    blank(from, n);
    return n;
  };

  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const newline = source.indexOf('\n', i);
      const end = newline === -1 ? n : newline;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && source[j] !== ch && source[j] !== '\n') {
        j += source[j] === '\\' ? 2 : 1;
      }
      const end = Math.min(n, j + 1);
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '`') {
      blank(i, i + 1);
      i = scanTemplateText(i + 1);
      continue;
    }
    if (ch === '{') {
      braceDepth++;
    } else if (ch === '}') {
      if (
        templateStack.length > 0 &&
        templateStack[templateStack.length - 1] === braceDepth - 1
      ) {
        templateStack.pop();
        braceDepth--;
        blank(i, i + 1);
        i = scanTemplateText(i + 1);
        continue;
      }
      braceDepth = Math.max(0, braceDepth - 1);
    }
    i++;
  }
  return out.join('');
}

function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A summary of the string literal starting at the first non-space character at
 * or after `from` in the original source, or `undefined` when the argument is
 * not a literal. Template expressions are shown as `…`.
 */
function readPromptSummary(source: string, from: number): string | undefined {
  let p = from;
  while (p < source.length && SPACE.test(source[p])) p++;
  const quote = source[p];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  let text = '';
  let j = p + 1;
  while (j < source.length && text.length < PROMPT_READ_LIMIT) {
    const ch = source[j];
    if (ch === '\\') {
      const escaped = source[j + 1] ?? '';
      text +=
        escaped === 'n' || escaped === 't' || escaped === 'r' ? ' ' : escaped;
      j += 2;
      continue;
    }
    if (ch === quote) break;
    if (quote !== '`' && ch === '\n') break;
    if (quote === '`' && ch === '$' && source[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < source.length && depth > 0) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}') depth--;
        j++;
      }
      text += '…';
      continue;
    }
    text += ch;
    j++;
  }
  const summary = collapse(text, PROMPT_SUMMARY_CHARS);
  return summary.length > 0 ? summary : undefined;
}

interface Context {
  readonly kind: 'parallel' | 'loop';
  readonly id: number;
  /** Bracket depth outside the context. */
  readonly openDepth: number;
  /** Index where the body starts; calls before it (a loop head) are outside. */
  readonly bodyStart: number;
  /** A braceless loop body ends with its statement, not with a bracket. */
  readonly statement: boolean;
  readonly condition?: string;
  /** Statement bodies only: whether any token of the body has been seen. */
  consumed: boolean;
  readonly isDo: boolean;
}

/** Read a workflow script's agent layout and its non-deterministic calls. */
export function scanWorkflowScriptShape(source: string): WorkflowScriptShape {
  const code = maskNonCode(source);
  const n = code.length;
  const rows: WorkflowShapeRow[] = [];
  const rowByContext = new Map<number, WorkflowShapeRow>();
  const violations: WorkflowDeterminismViolation[] = [];
  const stack: Context[] = [];
  // Indexes of the `}` that closed a `do { }` body, so its `while (...)` tail
  // is not read as a new loop around the next statement.
  const doBodyCloses = new Set<number>();
  let lastRow: WorkflowShapeRow | undefined;
  let lastRowWasTopLevel = false;
  let agentCalls = 0;
  let depth = 0;
  let line = 1;
  let nextId = 0;

  const skipSpace = (from: number): number => {
    let k = from;
    while (k < n && SPACE.test(code[k])) k++;
    return k;
  };
  const readIdent = (from: number): string => {
    let k = from;
    while (k < n && IDENT_PART.test(code[k])) k++;
    return code.slice(from, k);
  };
  const previousNonSpaceIndex = (from: number): number => {
    let k = from - 1;
    while (k >= 0 && SPACE.test(code[k])) k--;
    return k;
  };
  const matchingClose = (open: number): number => {
    let d = 0;
    for (let k = open; k < n; k++) {
      const c = code[k];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') {
        d--;
        if (d === 0) return k;
      }
    }
    return -1;
  };
  const innermost = (at: number): Context | undefined => {
    for (let s = stack.length - 1; s >= 0; s--) {
      if (at >= stack[s].bodyStart) return stack[s];
    }
    return undefined;
  };
  const popClosedBlocks = (closeIndex: number): void => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const closes = top.statement
        ? depth < top.openDepth
        : closeIndex > top.bodyStart && depth <= top.openDepth;
      if (!closes) break;
      stack.pop();
      if (top.isDo) doBodyCloses.add(closeIndex);
    }
  };
  const popEndedStatements = (): void => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top.statement || !top.consumed || depth !== top.openDepth) break;
      stack.pop();
    }
  };

  const recordAgent = (start: number, open: number): void => {
    agentCalls++;
    const context = innermost(start);
    const prompt = readPromptSummary(source, open + 1);
    let row: WorkflowShapeRow | undefined;
    if (context) {
      row = rowByContext.get(context.id);
      if (!row) {
        row = {
          kind: context.kind,
          count: 0,
          ...(context.condition ? { condition: context.condition } : {}),
          prompts: [],
          line,
        };
        rowByContext.set(context.id, row);
        rows.push(row);
      }
    } else if (lastRow?.kind === 'step' && lastRowWasTopLevel) {
      row = lastRow;
    } else {
      row = { kind: 'step', count: 0, prompts: [], line };
      rows.push(row);
    }
    row.count++;
    if (prompt !== undefined && row.prompts.length < MAX_PROMPTS_PER_ROW) {
      row.prompts.push(prompt);
    }
    lastRow = row;
    lastRowWasTopLevel = context === undefined;
  };

  const recordMemberCall = (
    object: 'Date' | 'Math',
    end: number,
    names: readonly string[],
  ): void => {
    const dot = skipSpace(end);
    if (code[dot] !== '.') return;
    const nameStart = skipSpace(dot + 1);
    const name = readIdent(nameStart);
    if (!names.includes(name)) return;
    if (code[skipSpace(nameStart + name.length)] !== '(') return;
    violations.push({
      call: `${object}.${name}()` as WorkflowNonDeterministicCall,
      line,
    });
  };

  const handleWord = (word: string, start: number, end: number): void => {
    switch (word) {
      case 'agent': {
        const open = skipSpace(end);
        if (code[open] === '(') recordAgent(start, open);
        return;
      }
      case 'parallel':
      case 'pipeline': {
        const open = skipSpace(end);
        if (code[open] !== '(') return;
        stack.push({
          kind: 'parallel',
          id: nextId++,
          openDepth: depth,
          bodyStart: open,
          statement: false,
          consumed: false,
          isDo: false,
        });
        return;
      }
      case 'while':
      case 'for': {
        if (
          word === 'while' &&
          doBodyCloses.has(previousNonSpaceIndex(start))
        ) {
          return;
        }
        let open = skipSpace(end);
        if (
          word === 'for' &&
          code.startsWith('await', open) &&
          !IDENT_PART.test(code[open + 5] ?? '')
        ) {
          open = skipSpace(open + 5);
        }
        if (code[open] !== '(') return;
        const close = matchingClose(open);
        if (close === -1) return;
        const body = skipSpace(close + 1);
        if (body >= n || code[body] === ';') return;
        stack.push({
          kind: 'loop',
          id: nextId++,
          openDepth: depth,
          bodyStart: body,
          statement: code[body] !== '{',
          condition: `${word} (${collapse(source.slice(open + 1, close), LOOP_HEAD_CHARS)})`,
          consumed: false,
          isDo: false,
        });
        return;
      }
      case 'do': {
        const body = skipSpace(end);
        if (code[body] !== '{') return;
        stack.push({
          kind: 'loop',
          id: nextId++,
          openDepth: depth,
          bodyStart: body,
          statement: false,
          condition: 'do … while',
          consumed: false,
          isDo: true,
        });
        return;
      }
      case 'Math':
        recordMemberCall('Math', end, ['random']);
        return;
      case 'Date':
        recordMemberCall('Date', end, ['now', 'parse', 'UTC']);
        return;
      case 'new': {
        const target = skipSpace(end);
        if (
          readIdent(target) === 'Date' &&
          code[skipSpace(target + 4)] !== '.'
        ) {
          violations.push({ call: 'new Date()', line });
        }
        return;
      }
      default:
        return;
    }
  };

  for (let i = 0; i < n; i++) {
    const ch = code[i];
    if (ch === '\n') {
      line++;
      popEndedStatements();
      continue;
    }
    if (SPACE.test(ch)) continue;
    const top = stack[stack.length - 1];
    if (top?.statement && i >= top.bodyStart) top.consumed = true;
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
      popClosedBlocks(i);
      continue;
    }
    if (ch === ';') {
      popEndedStatements();
      continue;
    }
    if (!IDENT_START.test(ch) || (i > 0 && IDENT_PART.test(code[i - 1]))) {
      continue;
    }
    const word = readIdent(i);
    const end = i + word.length;
    const prev = previousNonSpaceIndex(i);
    if (prev < 0 || code[prev] !== '.') handleWord(word, i, end);
    i = end - 1;
  }

  return { rows, agentCalls, determinismViolations: violations };
}

/**
 * The launch refusal for a script that reads a clock or a random source. A
 * resume replays agent results keyed on the call sequence, and a script whose
 * sequence depends on the time or a random draw cannot be replayed.
 */
export function describeWorkflowDeterminismViolations(
  violations: readonly WorkflowDeterminismViolation[],
): string {
  const listed = violations
    .slice(0, MAX_VIOLATIONS_LISTED)
    .map((v) => `${v.call} on line ${v.line}`);
  const more = violations.length - listed.length;
  const where =
    more > 0 ? `${listed.join(', ')} and ${more} more` : listed.join(', ');
  return (
    `Workflow scripts must be deterministic so a resume replays the same calls, and this script calls ${where}. ` +
    'None of these is available in a workflow script: pass timestamps or seeds in through `args`, or stamp the result after the workflow returns.'
  );
}
