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
import { getShellConfiguration, splitCommands } from '../utils/shell-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { ToolExecuteConfirmationDetails } from '../tools/tools.js';
import {
  hasUnsupportedShellSyntax,
  matchesCommandPattern,
} from './rule-parser.js';

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

async function hasFlatShellStructure(command: string): Promise<boolean> {
  try {
    let tree = await parseShellCommand(command);
    try {
      if (tree.rootNode.descendantsOfType('heredoc_redirect').length > 0) {
        return false;
      }
      if (tree.rootNode.hasError) {
        // The Bash grammar misreads argv after a descriptor close as a
        // redirect destination/ERROR. Reparse only that known operator in a
        // structure-only view; retain the original command for all grants.
        const closes = tree.rootNode
          .descendantsOfType('file_redirect')
          .flatMap((redirect) =>
            redirect.children.filter(
              (child) => child.type === '<&-' || child.type === '>&-',
            ),
          );
        if (closes.length === 0) return false;
        let structure = command;
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
      return (
        !tree.rootNode.hasError &&
        tree.rootNode.descendantsOfType('heredoc_redirect').length === 0 &&
        isFlatStatement(tree.rootNode)
      );
    } finally {
      tree.delete();
    }
  } catch {
    // Without the parser, keep the plain-command fallback; never reinterpret
    // control-flow or heredoc fragments as independent commands.
    return command
      .split('&&')
      .every((part) =>
        /^[A-Za-z0-9_./:@%+=,-]+(?:[ \t]+[A-Za-z0-9_./:@%+=,-]+)*$/.test(
          part.trim(),
        ),
      );
  }
}

/** Share the same safe, reusable suggestions across shell, monitor and cron. */
export async function suggestCommandRules(
  command: string,
  toolName: 'Bash' | 'Monitor',
  eligibleCommands?: readonly string[],
): Promise<Pick<ToolExecuteConfirmationDetails, 'permissionRules'>> {
  const bash = getShellConfiguration().shell === 'bash';
  if (bash && !(await hasFlatShellStructure(command))) {
    return { permissionRules: [] };
  }
  const allRules: string[] = [];
  const parts = splitCommands(command);
  const selected =
    eligibleCommands?.filter((part) => parts.includes(part)) ?? parts;
  for (const part of selected) {
    if (bash && hasUnsupportedShellSyntax(part)) {
      continue;
    }
    let rules: string[] = [];
    try {
      rules = await extractCommandRules(part);
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
  return {
    permissionRules: [...new Set(allRules)].map(
      (rule) => `${toolName}(${rule})`,
    ),
  };
}
