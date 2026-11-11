/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Node } from 'web-tree-sitter';
import { withBashSyntaxTree } from '../../utils/shell-utils.js';

export interface ShellSyntax {
  /** For permission analysis only; tool execution must use the original command. */
  source: string;
  commands: string[];
  embeddedScripts: string[];
  hasHeredocExpansion: boolean;
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
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * Use syntax nodes to distinguish commands, comments, redirected data, and expansions.
 * Preserve newlines when removing data so adjacent commands cannot be joined.
 * Pass nested execution to permission checks separately.
 */
export function readShellSyntax(source: string): ShellSyntax | null {
  return withBashSyntaxTree(source, (root) => {
    const erased: Array<[number, number]> = [];
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
        const name = owner
          ?.childForFieldName('name')
          ?.text.replace(/^.*\//, '');
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
    const project = (start: number, end: number) => {
      let result = '';
      let cursor = start;
      for (const [from, to] of erased) {
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
    };
  });
}
