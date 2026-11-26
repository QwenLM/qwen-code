/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Node } from 'web-tree-sitter';
import { parse } from 'shell-quote';
import { withBashSyntaxTree } from '../../utils/shell-utils.js';
import {
  SHELL_INTERPRETERS as SHELLS,
  SHELL_WRAPPERS,
  SHELL_STDIN_FORWARDERS,
  normalizeShellCommandName,
} from './shellStringAnalysis.js';

export interface ShellSyntax {
  /** For permission analysis only; tool execution must use the original command. */
  source: string;
  commands: string[];
  embeddedScripts: string[];
  hasHeredocExpansion: boolean;
  /** Budget scan input: omit only quoted input with a direct, static non-shell consumer. */
  substitutionSource: string;
}

/** Remove Bash continuations outside single quotes, preserving explicit empty arguments and single-quoted backslashes. */
export function removeShellContinuations(source: string): string {
  let single = false;
  let double = false;
  let result = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\' && !single && i + 1 < source.length) {
      if (source[i + 1] !== '\n') result += ch + source[i + 1];
      i++;
      continue;
    }
    if (ch === "'" && !double) single = !single;
    if (ch === '"' && !single) double = !double;
    result += ch;
  }
  return result;
}

const COMMAND_NODES = new Set([
  'command',
  'declaration_command',
  'unset_command',
  'test_command',
]);

/** Resolve only a static executable name, using the same classification for budget and script checks. */
function staticCommandName(name: Node | null | undefined): string | null {
  if (
    !name ||
    name.descendantsOfType([
      'simple_expansion',
      'expansion',
      'command_substitution',
      'process_substitution',
    ]).length > 0
  )
    return null;
  try {
    // Parse only the executable name. Arguments such as "$MODEL" or "bash"
    // do not decide what consumes stdin; dynamic names remain unresolved.
    const words = parse(name.text, () => {
      throw new Error('dynamic command name');
    });
    const [word] = words;
    if (words.length !== 1 || typeof word !== 'string') return null;
    return normalizeShellCommandName(word);
  } catch {
    return null;
  }
}

/** Reject known script consumers and unsupported shapes throughout a command list. */
function isStaticDataConsumer(body: Node): boolean {
  const pending = [body];
  while (pending.length) {
    const command = pending.pop()!;
    if (command.type === 'list') {
      for (const child of command.namedChildren) {
        if (!child) return false;
        pending.push(child);
      }
      continue;
    }
    if (command.type !== 'command') return false;
    const executable = staticCommandName(command.childForFieldName('name'));
    if (
      executable === null ||
      SHELLS.has(executable) ||
      SHELL_WRAPPERS.has(executable) ||
      SHELL_STDIN_FORWARDERS.has(executable) ||
      executable === 'source' ||
      executable === '.'
    )
      return false;
  }
  return true;
}

/** Prove the input has only direct static data consumers; otherwise keep the raw budget. */
function canOmitQuotedInput(redirect: Node, root: Node): boolean {
  const statement = redirect.parent;
  const command = statement?.childForFieldName('body');
  if (
    statement?.type !== 'redirected_statement' ||
    statement.parent?.id !== root.id ||
    !command ||
    // Arguments and sibling output redirects can forward this input to a shell.
    statement.descendantsOfType('process_substitution').length > 0 ||
    redirect.namedChildren.some(
      (child) =>
        child &&
        !['heredoc_start', 'heredoc_body', 'heredoc_end'].includes(child.type),
    )
  )
    return false;

  return isStaticDataConsumer(command);
}

/**
 * Use syntax nodes to distinguish commands, comments, redirected data, and expansions.
 * Preserve newlines when removing data so adjacent commands cannot be joined.
 * Pass nested execution to permission checks separately.
 */
export function readShellSyntax(source: string): ShellSyntax | null {
  return withBashSyntaxTree(source, (root) => {
    const erased: Array<[number, number]> = [];
    const substitutionData: Array<[number, number]> = [];
    const literals: Array<[number, number]> = [];
    const commands: Node[] = [];
    const embeddedScripts: string[] = [];
    let hasHeredocExpansion = false;
    const pending = [root];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'raw_string') {
        literals.push([node.startIndex, node.endIndex]);
        continue;
      }
      if (node.type === 'comment') {
        erased.push([node.startIndex, node.endIndex]);
        substitutionData.push([node.startIndex, node.endIndex]);
        continue;
      }
      if (COMMAND_NODES.has(node.type)) commands.push(node);
      if (node.type === 'heredoc_redirect') {
        const start = node.namedChildren.find(
          (child) => child?.type === 'heredoc_start',
        );
        const body = node.namedChildren.find(
          (child) => child?.type === 'heredoc_body',
        );
        const end = node.namedChildren.find(
          (child) => child?.type === 'heredoc_end',
        );
        if (!start || !body || !end) {
          continue;
        }
        // Redirect nodes may also contain pipelines or other redirects; preserve those children.
        erased.push(
          [node.startIndex, start.endIndex],
          [body.startIndex, end.endIndex],
        );
        const quoted = /['"\\]/.test(start.text);
        if (!quoted && body.namedChildCount > 0) {
          hasHeredocExpansion = true;
        }
        const owner = node.parent?.childForFieldName('body');
        const name = staticCommandName(owner?.childForFieldName('name'));
        if (quoted && canOmitQuotedInput(node, root)) {
          substitutionData.push([body.startIndex, end.endIndex]);
        }
        if (name && SHELLS.has(name) && quoted) {
          // A shell reads stdin as a script, even when the heredoc delimiter is quoted.
          embeddedScripts.push(body.text);
        }
        // Quoted delimiters suppress expansion; traverse substitutions in unquoted bodies.
        for (const child of node.namedChildren) {
          if (child && (child.type !== 'heredoc_body' || !quoted))
            pending.push(child);
        }
        continue;
      }
      for (const child of node.namedChildren) if (child) pending.push(child);
    }
    erased.sort((a, b) => a[0] - b[0]);
    substitutionData.sort((a, b) => a[0] - b[0]);
    literals.sort((a, b) => a[0] - b[0]);
    // Substitutions establish their own quote context; outer double quotes do not govern inner single quotes.
    const normalize = (text: string, offset: number) => {
      let result = '';
      let literalIndex = 0;
      for (let i = 0; i < text.length; i++) {
        while (
          literalIndex < literals.length &&
          literals[literalIndex][1] <= offset + i
        )
          literalIndex++;
        const literal = literals[literalIndex];
        if (literal && literal[0] <= offset + i && offset + i < literal[1]) {
          const end = Math.min(text.length, literal[1] - offset);
          result += text.slice(i, end);
          i = end - 1;
        } else if (text[i] === '\\' && i + 1 < text.length) {
          if (text[i + 1] !== '\n') result += text[i] + text[i + 1];
          i++;
        } else result += text[i];
      }
      return result;
    };
    const project = (start: number, end: number, ranges = erased) => {
      let result = '';
      let cursor = start;
      for (const [from, to] of ranges) {
        if (to <= cursor || from >= end) continue;
        result += source.slice(cursor, Math.max(cursor, from));
        const stop = Math.min(to, end);
        result += source
          .slice(Math.max(cursor, from), stop)
          .replace(/[^\n]/g, ' ');
        cursor = stop;
      }
      return normalize(result + source.slice(cursor, end), start).trim();
    };
    return {
      source: project(0, source.length),
      // Preserve executable commands inside the body even when the body is erased from the projection.
      commands: commands
        .sort((a, b) => a.startIndex - b.startIndex)
        .map((node) => normalize(node.text, node.startIndex).trim()),
      embeddedScripts,
      hasHeredocExpansion,
      substitutionSource: project(0, source.length, substitutionData),
    };
  });
}
