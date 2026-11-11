/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse, type ParseEntry } from 'shell-quote';
import type { ShellCommandAnalysis } from './shellCommandAnalysis.js';
import { readShellSyntax, removeShellContinuations } from './shellSyntax.js';

/** More substitutions than this and the command is refused unanalysed. */
export const MAX_SUBSTITUTIONS = 64;
/** `sh -c` bodies and substitutions are followed this many levels deep. */
export const MAX_NESTING = 3;

// Private-use sentinels: what a token contained before static analysis
// replaced it. They survive shell-quote as literal characters.
/** A variable that may expand to the empty string. */
export const EMPTY_VAR = '\uE000';
/** A positional parameter (`$1`, `$@`, `$*`). */
export const POSITIONAL = '\uE001';
/** A command or process substitution. */
export const SUBSTITUTION = '\uE002';

export const REMOVAL_COMMANDS = new Set(['rm', 'rmdir']);

/** Wrappers whose argv is the real command: skip them and their options. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'pkexec',
  'runuser',
  'exec',
  'command',
  'env',
  'nice',
  'nohup',
  'timeout',
  'stdbuf',
  'setsid',
  'ionice',
  'busybox',
  'time',
  'eval',
  'xargs',
  'parallel',
  'watch',
]);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** Wrappers that hand their arguments to a shell as one script. */
const SCRIPT_WRAPPERS = new Set(['eval', 'watch', 'parallel']);

const SHELL_KEYWORDS = new Set([
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
  '}',
  'coproc',
]);

export const DIRECTORY_CHANGERS = new Set(['cd', 'pushd', 'popd']);

const FIND_EXEC_PRIMARIES = new Set(['-exec', '-execdir', '-ok', '-okdir']);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/** A named variable, with its `${NAME:-default}` default when it has one. */
const NAMED_VAR = /^([A-Za-z_][A-Za-z0-9_]*)(?::?-(.*))?$/s;
const POSITIONAL_VAR = /^(?:[0-9]+|[@*])(?::?-(.*))?$/s;

/** Occurrences of `$(` and backtick substitutions outside single quotes. */
export function countSubstitutions(text: string): number {
  let count = 0;
  let backticks = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) continue;
    if (ch === '`') backticks++;
    if (ch === '$' && text[i + 1] === '(' && text[i + 2] !== '(') count++;
  }
  return count + Math.ceil(backticks / 2);
}

/**
 * Replace every `$(...)`, `<(...)`, `>(...)` and backtick substitution with a
 * sentinel and hand back their bodies. Quote-aware; nested parentheses are
 * matched by depth. Runs on the raw text, so it needs no parser and is the
 * same on a cold start.
 */
function maskSubstitutions(text: string): { masked: string; inner: string[] } {
  const inner: string[] = [];
  let out = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && !inSingle) {
      out += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (inSingle) {
      out += ch;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1) {
        out += SUBSTITUTION;
        break;
      }
      inner.push(text.slice(i + 1, end));
      out += SUBSTITUTION;
      i = end;
      continue;
    }
    const opensSubstitution =
      (ch === '$' || ch === '<' || ch === '>') &&
      text[i + 1] === '(' &&
      !(ch === '$' && text[i + 2] === '(');
    if (opensSubstitution) {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      inner.push(text.slice(i + 2, j));
      out += SUBSTITUTION;
      i = j;
      continue;
    }
    out += ch;
  }
  return { masked: out, inner };
}

/** A shell-quote token: a word, an operator (globs carry their pattern), or a comment. */
type Token = string | { op: string; pattern?: string } | { comment: string };

/**
 * Tokenize one candidate and split it into simple commands on control
 * operators. Variables become sentinels so their presence survives quoting.
 */
function tokenizeSimpleCommands(
  text: string,
  positionalMayBeEmpty: boolean,
): string[][] {
  // shell-quote treats a newline as part of a token; the shell treats it as
  // a separator.
  const lines = splitUnquotedNewlines(text);
  const commands: string[][] = [];
  for (const line of lines) {
    let entries: ParseEntry[];
    try {
      entries = parse(line, (key: string) =>
        substituteVariable(key, positionalMayBeEmpty),
      );
    } catch {
      // A quoting shape shell-quote refuses is one nobody can analyse.
      commands.push([SUBSTITUTION]);
      continue;
    }
    let current: string[] = [];
    let skipNext = false;
    for (const entry of entries as Token[]) {
      if (typeof entry === 'string') {
        if (skipNext) {
          skipNext = false;
          continue;
        }
        current.push(entry);
        continue;
      }
      if ('comment' in entry) {
        break;
      }
      const op = entry.op;
      if (op === 'glob') {
        if (skipNext) {
          skipNext = false;
          continue;
        }
        current.push(entry.pattern ?? '');
        continue;
      }
      if (
        op === '>' ||
        op === '<' ||
        op === '>>' ||
        op === '>&' ||
        op === '<&' ||
        op === '<<<'
      ) {
        skipNext = true;
        continue;
      }
      // Control operator: `&&`, `||`, `;`, `;;`, `|`, `|&`, `&`, `(`, `)`.
      if (current.length > 0) commands.push(current);
      current = [];
      skipNext = false;
    }
    if (current.length > 0) commands.push(current);
  }
  return commands;
}

function splitUnquotedNewlines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '\n' && !inSingle && !inDouble) {
      lines.push(text.slice(start, i));
      start = i + 1;
    }
  }
  lines.push(text.slice(start));
  return lines.filter((line) => line.trim() !== '');
}

/**
 * What a `$…` expansion is worth to static analysis. A default that is a
 * literal is taken at face value; everything else may be empty.
 */
function substituteVariable(
  key: string,
  positionalMayBeEmpty: boolean,
): string {
  if (key === '') {
    return SUBSTITUTION;
  }
  const named = NAMED_VAR.exec(key);
  if (named) {
    const fallback = named[2];
    if (
      fallback !== undefined &&
      fallback !== '' &&
      !fallback.startsWith('$')
    ) {
      return fallback;
    }
    return EMPTY_VAR;
  }
  const positional = POSITIONAL_VAR.exec(key);
  if (positional) {
    const fallback = positional[1];
    if (
      fallback !== undefined &&
      fallback !== '' &&
      !fallback.startsWith('$')
    ) {
      return fallback;
    }
    return positionalMayBeEmpty ? EMPTY_VAR : POSITIONAL;
  }
  // `$#`, `$?`, `$$`, `$!`, arithmetic, and anything else exotic.
  return POSITIONAL;
}

/** `name() {` / `function name` anywhere in the command. */
function definesFunction(command: string): boolean {
  return /(?:^|[;&|(\n])[ \t]*(?:function[ \t]+[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\))/.test(
    command,
  );
}

/** `set -- <something non-empty>` anywhere in the command. */
function setsPositional(command: string): boolean {
  return /(?:^|[;&|(\n])[ \t]*set[ \t]+--[ \t]+(?!["']{2}(?:[\s;&|]|$)|["']?\$)[^\s;&|]/.test(
    command,
  );
}

/** Script bodies a simple command hands to another interpreter. */
function nestedScripts(tokens: string[]): string[] {
  const scripts: string[] = [];
  // `eval "rm -rf $X/*"`: the quoted argument is a script, not an argv.
  const first = tokens.find(
    (token) =>
      !SHELL_KEYWORDS.has(token.toLowerCase()) && !ASSIGNMENT.test(token),
  );
  if (first !== undefined && SCRIPT_WRAPPERS.has(commandName(first))) {
    const body = tokens.slice(tokens.indexOf(first) + 1).join(' ');
    if (body.trim() !== '') scripts.push(body);
  }
  const head = locateHead(tokens);
  if (!head) return scripts;
  if (SHELLS.has(head.name)) {
    for (let i = 0; i < head.args.length; i++) {
      const arg = head.args[i]!;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg) || arg === '--command') {
        const body = head.args[i + 1];
        if (body !== undefined) scripts.push(body);
        break;
      }
    }
  }
  if (head.name === 'find') {
    for (let i = 0; i < head.args.length; i++) {
      if (!FIND_EXEC_PRIMARIES.has(head.args[i]!)) continue;
      const body: string[] = [];
      for (let j = i + 1; j < head.args.length; j++) {
        const arg = head.args[j]!;
        if (arg === ';' || arg === '+') break;
        body.push(arg);
      }
      if (body.length > 0) scripts.push(body.join(' '));
    }
  }
  return scripts;
}

// ============================================================================
// Head location
// ============================================================================

function commandName(token: string): string {
  return token
    .replace(/^\\/, '')
    .replace(/^[^\s=]*[\\/]/, '')
    .toLowerCase();
}

/**
 * The executable a simple command runs, after keywords, assignments and
 * wrappers. `args` are the tokens after it.
 */
export function locateHead(
  tokens: readonly string[],
): { name: string; args: string[] } | null {
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (
      SHELL_KEYWORDS.has(token.toLowerCase()) ||
      ASSIGNMENT.test(token) ||
      token.startsWith(EMPTY_VAR) ||
      token.startsWith(POSITIONAL)
    ) {
      i++;
      continue;
    }
    break;
  }

  // Wrappers: skip the wrapper, its options (and the value an option may
  // take), numbers such as timeout's duration, and env's assignments.
  for (;;) {
    if (i >= tokens.length) return null;
    const name = commandName(tokens[i]!);
    if (!WRAPPERS.has(name)) break;
    i++;
    while (i < tokens.length) {
      const token = tokens[i]!;
      const tokenName = commandName(token);
      if (REMOVAL_COMMANDS.has(tokenName) || WRAPPERS.has(tokenName)) break;
      if (token === '--') {
        i++;
        break;
      }
      if (token.startsWith('-')) {
        i++;
        const value = tokens[i];
        if (
          value !== undefined &&
          !value.startsWith('-') &&
          !value.includes('=') &&
          !REMOVAL_COMMANDS.has(commandName(value)) &&
          !WRAPPERS.has(commandName(value)) &&
          !SHELLS.has(commandName(value))
        ) {
          i++;
        }
        continue;
      }
      if (
        ASSIGNMENT.test(token) ||
        /^\d/.test(token) ||
        token.startsWith(EMPTY_VAR) ||
        token.startsWith(POSITIONAL)
      ) {
        i++;
        continue;
      }
      break;
    }
  }

  if (i >= tokens.length) return null;
  return { name: commandName(tokens[i]!), args: tokens.slice(i + 1) };
}

export interface ShellExecution {
  tokens: string[];
}

const executionCache = new WeakMap<ShellCommandAnalysis, ShellExecution[]>();

/** Collect executable commands, following wrappers, interpreters, and substitutions recursively. */
export function collectShellExecutions(
  command: string,
  analysis: ShellCommandAnalysis,
): ShellExecution[] {
  const cached = executionCache.get(analysis);
  if (cached) return cached;
  const positionalMayBeEmpty =
    !definesFunction(command) && !setsPositional(command);
  const roots = analysis.topLevelSegments;
  const queue = [
    ...roots.map((text) => ({ text, depth: 0 })),
    ...(analysis.syntax?.commands ?? [])
      // Deduplicate complete candidates only; matching argument text does not cover an execution node.
      .filter((text) => !roots.includes(text))
      .map((text) => ({ text, depth: 1 })),
    ...(analysis.syntax?.embeddedScripts ?? []).map((text) => ({
      text,
      depth: 1,
    })),
  ];
  const executions: ShellExecution[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { text, depth } = queue.shift()!;
    const key = `${depth}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const syntax = readShellSyntax(text);
    const source = syntax?.source ?? removeShellContinuations(text);
    const { masked, inner } = maskSubstitutions(source);
    if (depth < MAX_NESTING) {
      // The projection removes heredoc substitutions; restore parsed commands at every recursion level.
      const parsedCommands = (syntax?.commands ?? []).filter(
        (candidate) => candidate !== text && candidate !== source,
      );
      for (const sub of [
        ...inner,
        ...parsedCommands,
        ...(syntax?.embeddedScripts ?? []),
      ]) {
        queue.push({ text: sub, depth: depth + 1 });
      }
    }
    for (const tokens of tokenizeSimpleCommands(masked, positionalMayBeEmpty)) {
      executions.push({ tokens });
      if (depth < MAX_NESTING) {
        for (const nested of nestedScripts(tokens)) {
          queue.push({ text: nested, depth: depth + 1 });
        }
      }
    }
  }
  executionCache.set(analysis, executions);
  return executions;
}
