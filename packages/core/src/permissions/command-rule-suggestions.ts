/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type Parser from 'web-tree-sitter';
import {
  extractCommandRules,
  parseShellCommand,
} from '../utils/shellAstParser.js';
import {
  getShellConfiguration,
  splitCommands,
  stripShellCommandPrefixes,
  stripShellWrapper,
} from '../utils/shell-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { ToolExecuteConfirmationDetails } from '../tools/tools.js';
import {
  hasUnsupportedShellSyntax,
  matchesRule,
  matchesCommandPattern,
  parseRule,
} from './rule-parser.js';
import { splitCommandForRules } from './permission-manager.js';
import { removeShellLineContinuations } from './shell-command-syntax.js';

const debugLogger = createDebugLogger('PERMISSIONS');

function isFlatStatement(node: Parser.SyntaxNode): boolean {
  switch (node.type) {
    case 'program':
    case 'list':
    case 'pipeline':
    case 'negated_command':
    case 'redirected_statement':
    case 'subshell':
    case 'compound_statement':
      return node.namedChildren.every(isFlatStatement);
    case 'command':
    case 'file_redirect':
    case 'variable_assignment':
    case 'variable_assignments':
    case 'comment':
      return true;
    default:
      return false;
  }
}

function isSimpleTrailingHeredoc(redirect: Parser.SyntaxNode): boolean {
  const parent = redirect.parent;
  const body = parent?.childForFieldName('body');
  const start = redirect.namedChildren.find(
    (child) => child.type === 'heredoc_start',
  );
  const end = redirect.namedChildren.find(
    (child) => child.type === 'heredoc_end',
  );
  return Boolean(
    parent?.type === 'redirected_statement' &&
      parent.namedChildren.length === 2 &&
      body &&
      redirect.startIndex >= body.endIndex &&
      start &&
      !start.isMissing &&
      end &&
      !end.isMissing &&
      end.text.length > 0 &&
      redirect.children.every((child) =>
        ['<<', '<<-', 'heredoc_start', 'heredoc_body', 'heredoc_end'].includes(
          child.type,
        ),
      ),
  );
}

interface CommandPart {
  text: string;
  start: number;
  end: number;
}

function commandRanges(
  command: string,
  parts: readonly string[],
): CommandPart[] {
  let offset = 0;
  return parts.map((text) => {
    const start = command.indexOf(text, offset);
    offset = start + text.length;
    return { text, start, end: offset };
  });
}

async function shellRuleParts(command: string): Promise<CommandPart[]> {
  try {
    let tree = await parseShellCommand(command);
    let structure = command;
    let closes: Array<{ startIndex: number; endIndex: number }> = [];
    try {
      const heredocs = tree.rootNode.descendantsOfType('heredoc_redirect');
      if (
        heredocs.some((redirect) => !isSimpleTrailingHeredoc(redirect)) ||
        (heredocs.length > 0 && tree.rootNode.hasError)
      ) {
        return [];
      }
      if (tree.rootNode.hasError) {
        // The Bash grammar misreads argv after a descriptor close as a
        // redirect destination/ERROR. Reparse only that known operator in a
        // structure-only view; retain the original command for all grants.
        closes = tree.rootNode
          .descendantsOfType('file_redirect')
          .flatMap((redirect) =>
            redirect.children.filter(
              (child) => child.type === '<&-' || child.type === '>&-',
            ),
          )
          .map(({ startIndex, endIndex }) => ({ startIndex, endIndex }));
        if (closes.length === 0) return [];
        for (const close of closes.sort(
          (a, b) => b.startIndex - a.startIndex,
        )) {
          structure =
            structure.slice(0, close.startIndex) +
            ' '.repeat(close.endIndex - close.startIndex) +
            structure.slice(close.endIndex);
        }
        const reparsed = await parseShellCommand(structure);
        tree.delete();
        tree = reparsed;
      }
      if (
        tree.rootNode.hasError ||
        (closes.length > 0 &&
          tree.rootNode.descendantsOfType('heredoc_redirect').length > 0)
      ) {
        return [];
      }
      type Range = { start: number; end: number };
      const collect = (node: Parser.SyntaxNode): Range[] => {
        if (['program', 'list', 'pipeline'].includes(node.type)) {
          return node.namedChildren.flatMap(collect);
        }
        if (node.type === 'redirected_statement') {
          const body = node.childForFieldName('body');
          if (body && ['list', 'pipeline'].includes(body.type)) {
            const parts = collect(body);
            if (
              node.namedChildren.some(
                (child) => child.type === 'heredoc_redirect',
              )
            ) {
              // Keep independent statements, never the command that owns the
              // heredoc or any words from its header/body.
              return parts.filter((part) => part.end < body.endIndex);
            }
            for (const part of parts) {
              if (part.start === body.startIndex) part.start = node.startIndex;
              if (part.end === body.endIndex) part.end = node.endIndex;
            }
            return parts;
          }
        }
        if (
          ![
            'command',
            'redirected_statement',
            'negated_command',
            'subshell',
            'compound_statement',
          ].includes(node.type) ||
          !isFlatStatement(node)
        ) {
          return [];
        }
        return [{ start: node.startIndex, end: node.endIndex }];
      };
      return collect(tree.rootNode).map(({ start, end }) => {
        // A masked descriptor close at a statement edge still belongs to
        // the original invocation, even though it is absent from this tree.
        for (const close of [...closes].sort(
          (a, b) => b.startIndex - a.startIndex,
        )) {
          if (
            close.endIndex <= start &&
            /^(?:[ \t]|\\\r?\n)*$/.test(structure.slice(close.endIndex, start))
          ) {
            start = close.startIndex;
          }
        }
        for (const close of [...closes].sort(
          (a, b) => a.startIndex - b.startIndex,
        )) {
          if (
            close.startIndex >= end &&
            /^(?:[ \t]|\\\r?\n)*$/.test(structure.slice(end, close.startIndex))
          ) {
            end = close.endIndex;
          }
        }
        return { text: command.slice(start, end).trim(), start, end };
      });
    } finally {
      tree.delete();
    }
  } catch {
    // Without the parser, keep the plain-command fallback; never reinterpret
    // control-flow or heredoc fragments as independent commands.
    const parts = command.split('&&').map((part) => part.trim());
    if (
      !parts.every((part) =>
        /^[A-Za-z0-9_./:@%+=,-]+(?:[ \t]+[A-Za-z0-9_./:@%+=,-]+)*$/.test(part),
      )
    )
      return [];
    let offset = 0;
    return parts.map((text) => {
      const start = command.indexOf(text, offset);
      offset = start + text.length;
      return { text, start, end: offset };
    });
  }
}

/** Share the same safe, reusable suggestions across shell, monitor and cron. */
export async function suggestCommandRules(
  command: string,
  toolName: 'Bash' | 'Monitor',
  eligibleCommands?: readonly string[],
): Promise<Pick<ToolExecuteConfirmationDetails, 'permissionRules'>> {
  const bash = getShellConfiguration().shell === 'bash';
  if (bash) command = removeShellLineContinuations(command);
  const allRules: string[] = [];
  const eligible = eligibleCommands?.map((part) =>
    bash ? removeShellLineContinuations(part) : part,
  );
  const rawParts = commandRanges(command, splitCommands(command));
  if (rawParts.some((part) => part.start < 0)) return { permissionRules: [] };
  const parts = bash ? await shellRuleParts(command) : rawParts;
  const selected = parts.filter((part) => {
    if (!eligible) return true;
    const overlapping = rawParts.filter(
      (raw) => raw.start < part.end && part.start < raw.end,
    );
    return (
      overlapping.length > 0 &&
      overlapping.every((raw) => eligible.includes(raw.text))
    );
  });
  for (const { text: part } of selected) {
    if (bash && hasUnsupportedShellSyntax(part)) {
      continue;
    }
    const unprefixed = bash ? stripShellCommandPrefixes(part) : part;
    if (
      unprefixed !== undefined &&
      stripShellWrapper(unprefixed) !== unprefixed
    ) {
      // An outer shell wildcard would authorize every script passed to -c.
      continue;
    }
    let rules: string[] = [];
    try {
      const tree = await parseShellCommand(part);
      const hasError = tree.rootNode.hasError;
      tree.delete();
      // A structure-only descriptor-close repair does not certify the
      // original parse's derived commands. Retain only the literal fallback.
      if (!hasError) {
        rules = (await extractCommandRules(part)).filter(
          (rule) => !/^[*\s]*$/.test(rule),
        );
      }
    } catch (error) {
      debugLogger.warn('Failed to extract command rules:', error);
    }
    if (!rules.some((rule) => matchesCommandPattern(rule, part))) {
      // A literal '*' in a raw fallback would become a permission glob.
      if (part.includes('*')) {
        continue;
      }
      rules.push(part);
    }
    allRules.push(...rules);
  }
  const permissionRules = [...new Set(allRules)].map(
    (rule) => `${toolName}(${rule})`,
  );
  const rules = permissionRules.map(parseRule).filter((rule) => rule !== null);
  const canonicalTool = toolName === 'Bash' ? 'run_shell_command' : 'monitor';
  const matcherParts = commandRanges(
    command,
    splitCommandForRules(command, canonicalTool),
  );
  if (matcherParts.some((part) => part.start < 0))
    return { permissionRules: [] };
  const required = matcherParts.filter(
    (part) =>
      !eligible ||
      rawParts.some(
        (raw) =>
          eligible.includes(raw.text) &&
          raw.start < part.end &&
          part.start < raw.end,
      ),
  );
  // Cover the selected segments produced by the matcher splitter. This does
  // not certify an enclosing shell wrapper's permission.
  const covered = required.every((part) =>
    rules.some((rule) => matchesRule(rule, canonicalTool, part.text)),
  );
  return { permissionRules: covered ? permissionRules : [] };
}
