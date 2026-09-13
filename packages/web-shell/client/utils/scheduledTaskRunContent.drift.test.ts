/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildScheduledTaskRunContent,
  parseScheduledTaskRunContent,
} from './scheduledTaskRunContent';

// The Web Shell bundles for the browser and does not depend on the CLI or
// `@qwen-code/qwen-code-core`, so the run envelope (instruction sentence,
// header labels, session lines, metadata sanitizer) is copied into
// `scheduledTaskRunContent.ts` rather than imported. A comment asking the
// next person to keep the copies in sync is not a mechanism: read the CLI
// and core sources and run both copies over the same inputs, so an edit to
// either side without the other fails here.
const cliSource = readFileSync(
  fileURLToPath(
    new URL('../../../cli/src/runtime/scheduled-task-run.ts', import.meta.url),
  ),
  'utf8',
);
const coreSanitizerSource = readFileSync(
  fileURLToPath(
    new URL('../../../core/src/utils/terminalSafe.ts', import.meta.url),
  ),
  'utf8',
);

/** Extract a function body by balanced-brace scan from its signature. The
 * extracted bodies contain no unbalanced braces outside of `${…}` pairs. */
function extractFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) {
    throw new Error(`could not locate \`${signature}\` in source`);
  }
  const openBrace = source.indexOf('{', start + signature.length);
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openBrace + 1, i);
    }
  }
  throw new Error(`unbalanced braces after \`${signature}\``);
}

function extractConstLiteral(source: string, name: string): string {
  // Match to end-of-line, not to the first `;` — a regex literal can carry a
  // `;` inside a character class (e.g. TERMINAL_CSI_REGEX's `[\\d;?]`).
  const match = source.match(
    new RegExp(`(?:export )?const ${name} =\\s*(.+);[ \\t]*$`, 'm'),
  );
  if (!match) {
    throw new Error(`could not locate \`${name}\` in source`);
  }
  return match[1]!;
}

function evalLiteral(literal: string): unknown {
  return new Function(`return (${literal});`)();
}

/** Rebuild the CLI's `cleanMetadataLine` from core's sanitizer and the CLI
 * source, so regex drift on either side is caught. */
function cliCleanMetadataLine(): (value: string) => string {
  const osc = evalLiteral(
    extractConstLiteral(coreSanitizerSource, 'TERMINAL_OSC_REGEX'),
  );
  const csi = evalLiteral(
    extractConstLiteral(coreSanitizerSource, 'TERMINAL_CSI_REGEX'),
  );
  const shiftDcs = evalLiteral(
    extractConstLiteral(coreSanitizerSource, 'TERMINAL_SHIFT_DCS_REGEX'),
  );
  const stripBody = extractFunctionBody(
    coreSanitizerSource,
    'export function stripTerminalControlSequences(s: string): string',
  );
  const stripFn = new Function(
    'TERMINAL_OSC_REGEX',
    'TERMINAL_CSI_REGEX',
    'TERMINAL_SHIFT_DCS_REGEX',
    's',
    stripBody,
  ) as (osc: RegExp, csi: RegExp, shiftDcs: RegExp, value: string) => string;
  const strip = (value: string) => stripFn(osc, csi, shiftDcs, value);
  const cleanBody = extractFunctionBody(
    cliSource,
    'function cleanMetadataLine(value: string): string',
  );
  const cleanFn = new Function(
    'stripTerminalControlSequences',
    'value',
    cleanBody,
  ) as (strip: (value: string) => string, value: string) => string;
  return (value: string) => cleanFn(strip, value);
}

function cliInstruction(): string {
  const literal = extractConstLiteral(
    cliSource,
    'SCHEDULED_TASK_RUN_INSTRUCTION',
  );
  return evalLiteral(literal) as string;
}

/** Rebuild the CLI's `buildScheduledTaskRunPrompt` from source, wired to the
 * extracted instruction and sanitizer, so the envelope shape itself is
 * compared rather than re-typed. */
function cliBuildScheduledTaskRunPrompt(): (input: {
  id: string;
  name?: string;
  cron: string;
  prompt: string;
  triggeredAt: number;
  trigger: 'scheduled' | 'manual';
  sessionMode?: 'persistent' | 'per_run';
}) => string {
  const clean = cliCleanMetadataLine();
  const truncateBody = extractFunctionBody(
    cliSource,
    'function truncateRunLabel(value: string): string',
  );
  const maxRunLabelLength = evalLiteral(
    extractConstLiteral(cliSource, 'MAX_RUN_SESSION_NAME_LENGTH'),
  ) as number;
  const truncateFn = new Function(
    'MAX_RUN_SESSION_NAME_LENGTH',
    'value',
    truncateBody,
  ) as (max: number, value: string) => string;
  const truncate = (value: string) => truncateFn(maxRunLabelLength, value);
  const buildBody = extractFunctionBody(
    cliSource,
    'export function buildScheduledTaskRunPrompt(input: {',
  );
  const buildFn = new Function(
    'SCHEDULED_TASK_RUN_INSTRUCTION',
    'cleanMetadataLine',
    'truncateRunLabel',
    'input',
    buildBody,
  ) as (
    instruction: string,
    clean: (value: string) => string,
    truncate: (value: string) => string,
    input: {
      id: string;
      name?: string;
      cron: string;
      prompt: string;
      triggeredAt: number;
      trigger: 'scheduled' | 'manual';
      sessionMode?: 'persistent' | 'per_run';
    },
  ) => string;
  const instruction = cliInstruction();
  return (input) => buildFn(instruction, clean, truncate, input);
}

const CLEAN_CASES = [
  'plain label',
  'with \x1b]8;;https://evil\x07link\x1b]8;;\x07 osc',
  'csi \x1b[31mred\x1b[0m',
  'shift-dcs \x1bNop',
  'bidi ‮override‬',
  'alm \u061c mark',
  'c1  byte',
  'bel  bell',
  'new\nline',
  '  padded   spaces  ',
];

const TASKS = [
  {
    id: 't1',
    name: 'Hourly review',
    cron: '0 * * * *',
    prompt: 'review the next PR',
  },
  { id: 't2', cron: '@daily', prompt: 'unnamed prompt label' },
  { id: 't3', name: '‮', cron: '0 9 * * *', prompt: 'bidi-only name' },
  {
    id: 't4',
    name: 'ansi \x1b[31mname\x1b[0m',
    cron: '*/5 * * * *',
    prompt: 'line one\nline two',
  },
  { id: 't5', cron: '0 0 * * 0', prompt: `long ${'x'.repeat(120)} prompt` },
];

describe('scheduledTaskRunContent drift vs CLI', () => {
  it('sanity-checks that the CLI sources were parsed', () => {
    expect(cliInstruction()).toContain('scheduled task run');
    expect(cliCleanMetadataLine()('  a  ')).toBe('a');
  });

  it('pins the model-facing instruction sentence to the CLI copy', () => {
    const localSeparator = `\n\n${cliInstruction()}\n\n`;
    const local = buildScheduledTaskRunContent({
      id: 't1',
      name: 'x',
      cron: '0 * * * *',
      triggeredAt: 0,
      trigger: 'scheduled',
      sessionMode: 'persistent',
      prompt: 'p',
    });
    expect(local).toContain(localSeparator);
  });

  it('pins the five header labels and both session lines verbatim', () => {
    for (const label of [
      'Scheduled task: ',
      'Task ID: ',
      'Schedule: ',
      'Triggered at: ',
      'Trigger: ',
      'Session: reuse the task conversation',
      'Session: new chat for this run',
    ]) {
      expect(cliSource).toContain(label);
    }
  });

  it('agrees with the CLI cleanMetadataLine on every probe input', () => {
    const cli = cliCleanMetadataLine();
    const disagreements: string[] = [];
    for (const input of CLEAN_CASES) {
      // The local copy is not exported; reach it through the builder's
      // `cron` line, which is cleanMetadataLine applied verbatim.
      const viaLocal = buildScheduledTaskRunContent({
        id: 't',
        name: 'n',
        cron: input,
        triggeredAt: 0,
        trigger: 'scheduled',
        sessionMode: 'per_run',
        prompt: 'p',
      })
        .split('\n')[2]!
        .slice('Schedule: '.length);
      if (cli(input) !== viaLocal) disagreements.push(JSON.stringify(input));
    }
    expect(disagreements).toEqual([]);
  });

  it('produces a byte-identical envelope to the CLI builder', () => {
    const cliBuild = cliBuildScheduledTaskRunPrompt();
    const mismatches: string[] = [];
    for (const task of TASKS) {
      for (const sessionMode of ['persistent', 'per_run'] as const) {
        for (const trigger of ['scheduled', 'manual'] as const) {
          const cli = cliBuild({
            ...task,
            triggeredAt: 123,
            trigger,
            sessionMode,
          });
          const local = buildScheduledTaskRunContent({
            ...task,
            name: task.name ?? null,
            triggeredAt: 123,
            trigger,
            sessionMode,
          });
          if (cli !== local)
            mismatches.push(`${task.id}/${sessionMode}/${trigger}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('round-trips through the parser, and rejects a non-envelope message', () => {
    for (const task of TASKS) {
      const content = buildScheduledTaskRunContent({
        ...task,
        name: task.name ?? null,
        triggeredAt: 456,
        trigger: 'manual',
        sessionMode: 'persistent',
      });
      const parsed = parseScheduledTaskRunContent(content);
      expect(parsed).not.toBeNull();
      expect(parsed!.id).toBe(task.id);
      expect(parsed!.cron).toBe(task.cron);
      expect(parsed!.trigger).toBe('manual');
      expect(parsed!.sessionMode).toBe('persistent');
      expect(parsed!.prompt).toBe(task.prompt);
    }
    expect(parseScheduledTaskRunContent('just a chat message')).toBeNull();
  });
});
