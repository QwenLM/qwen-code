/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import nodePath from 'node:path';
import os from 'node:os';
import type Parser from 'web-tree-sitter';
import { parseShellCommand } from '../utils/shellAstParser.js';

/**
 * A write-capable shell redirection reported by tree-sitter.
 * `staticTarget` is present only when the destination can be treated as one
 * literal filesystem path without shell expansion.
 */
export interface ShellAstWriteRedirect {
  operator: string;
  staticTarget?: string;
  absolute: boolean;
}

export interface ShellAstWriteAnalysis {
  redirects: ShellAstWriteRedirect[];
  devNullRedirects: number;
}

const WRITE_REDIRECT_OPERATORS = new Set([
  '>',
  '>>',
  '&>',
  '&>>',
  '>|',
  '<>',
  '>&',
]);

const DYNAMIC_NODE_TYPES = new Set([
  'brace_expansion',
  'command_substitution',
  'concatenation',
  'expansion',
  'process_substitution',
]);

function walkNamed(root: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const result: Parser.SyntaxNode[] = [];
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return result;
}

function stripOuterQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" || first === '"') && last === first) {
    return value.slice(1, -1);
  }
  return value;
}

function isDynamicNode(node: Parser.SyntaxNode): boolean {
  return (
    DYNAMIC_NODE_TYPES.has(node.type) ||
    /(?:substitution|expansion)$/.test(node.type)
  );
}

function isStaticDestination(node: Parser.SyntaxNode): boolean {
  for (const child of walkNamed(node)) {
    if (isDynamicNode(child)) return false;
  }

  const text = node.text;
  // Fail closed for shell forms whose runtime target can differ from the
  // lexical spelling. Quoted ordinary paths are still accepted.
  if (text.startsWith("$'")) return false;
  const unquoted = stripOuterQuotes(text);
  if (
    unquoted.startsWith('~') &&
    unquoted !== '~' &&
    !unquoted.startsWith('~/')
  ) {
    return false;
  }
  return !/[$`*?[\]{}'"]/.test(unquoted) && !unquoted.includes('\\');
}

function normalizeStaticTarget(target: string, quoted: boolean): string {
  const normalized = target.replace(/\\/g, '/');
  if (!quoted && (normalized === '~' || normalized.startsWith('~/'))) {
    const home = os.homedir().replace(/\\/g, '/');
    const rest = normalized.slice(1);
    return rest ? nodePath.posix.join(home, rest) : home;
  }
  return normalized;
}

function isAbsoluteShellPath(target: string): boolean {
  return target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target);
}

function isFdDuplicationTarget(
  operator: string,
  rawTarget: string,
  redirectText: string,
): boolean {
  const fdTarget = /^(?:\d+-?|-)$/;
  if (operator === '>&' && fdTarget.test(rawTarget)) return true;

  // tree-sitter reports spaced invalid spellings such as `2> &1` as a
  // write redirect plus ERROR nodes. Bash rejects them and the lightweight
  // extractor intentionally treats them as fd-shaped syntax rather than a
  // filesystem path. Keep AST reconciliation aligned with that contract.
  return /&\s*(?:\d+-?|-)(?=\s|$|[)<|;&])/.test(redirectText);
}

/**
 * The lightweight tokenizer historically drops quote provenance. A quoted
 * word such as `cp '3>' src dst` can therefore be mistaken for a redirect
 * operator and corrupt positional write semantics. Keep this narrowly scoped
 * to commands whose destination is positional and fail closed when the AST
 * proves the quoted word was not shell redirection.
 */
function hasQuotedRedirectLikeWriteArgument(command: string): boolean {
  return /(?:^|[;&|()]\s*)(?:(?:then|do|else)\s+)?(?:(?:sudo|command|builtin)\s+)*(?:cp|mv|install|ln|rsync)\b[^\n]*?(?:'\d*(?:>>?|<>|>&)[^']*'|"\d*(?:>>?|<>|>&)[^"]*")(?=\s|$)/.test(
    command,
  );
}

/**
 * `~user`, `~+`, and `~-` depend on shell expansion. If such a cd/pushd occurs
 * before a relative redirect, the lexical cwd tracked by the lightweight
 * extractor is not authoritative.
 */
function maskQuotedAndComments(input: string): string {
  let out = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let comment = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (comment) {
      if (ch === '\n') {
        comment = false;
        out += ch;
      } else {
        out += ' ';
      }
      continue;
    }
    if (escaped) {
      out += quote ? ' ' : ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      out += quote ? ' ' : ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ' ';
      continue;
    }
    if (ch === '#' && (i === 0 || /\s|[;&|()]/.test(input[i - 1]!))) {
      comment = true;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Fallback used only when the tree-sitter bridge itself throws. It ignores
 * quoted/comment text and fd duplication/close, preserving fail-closed
 * behavior for real write redirects without treating display text such as
 * `echo "a > b"` as a filesystem write.
 */
function hasUnquotedWriteRedirectForParserFallback(command: string): boolean {
  const visible = maskQuotedAndComments(command).replace(
    /\[\[[\s\S]*?\]\]/g,
    (match) => ' '.repeat(match.length),
  );

  for (let i = 0; i < visible.length; i++) {
    if (visible[i] !== '>' || visible[i - 1] === '>') continue;

    let j = i + 1;
    if (visible[j] === '>') j++;
    if (visible[j] === '|') j++;
    while (visible[j] === ' ' || visible[j] === '\t') j++;

    // fd duplication/close is shell plumbing, not a filesystem destination.
    if (visible[j] === '&') {
      j++;
      while (visible[j] === ' ' || visible[j] === '\t') j++;
      if (visible[j] === '-') {
        j++;
        if (j >= visible.length || /[\s;&|)]/.test(visible[j]!)) continue;
      } else {
        const digitStart = j;
        while (j < visible.length && /\d/.test(visible[j]!)) j++;
        if (
          j > digitStart &&
          (j >= visible.length || /[\s;&|)]/.test(visible[j]!))
        ) {
          continue;
        }
      }
    }

    return true;
  }

  return false;
}

function hasDynamicNamedTildeCwdBefore(command: string, end: number): boolean {
  const prefix = maskQuotedAndComments(command.slice(0, end));
  return /(?:^|[\n;&|()]\s*)(?:(?:then|do|else)\s+)?(?:(?:builtin|command)\s+)*(?:cd|pushd)\b(?:\s+(?:-[A-Za-z@]+|--))*\s+~(?!\/)(?:[^\s;&|)]+)(?=\s|$|[;&|)])/m.test(
    prefix,
  );
}

/**
 * Resolve cwd changes that are guaranteed by a simple `cd/pushd ... &&`
 * chain before a redirect. The returned path is lexical relative to the
 * caller's original cwd unless the chain switches to an absolute/home path.
 * Any other control-flow form is left unresolved rather than guessed.
 */
function staticCwdPrefixBeforeRedirect(
  command: string,
  end: number,
): string | undefined {
  const prefix = maskQuotedAndComments(command.slice(0, end));
  if (/(?:\|\||(^|[^&])&(?!&)|;|\n)/.test(prefix)) return undefined;

  const segments = prefix.split('&&');
  let effective: string | undefined;
  let changed = false;

  for (const segment of segments.slice(0, -1)) {
    const trimmed = segment.trim();
    const match = trimmed.match(
      /^(?:(?:builtin|command)\s+)*(?:cd|pushd)\b(?:\s+(?:-[A-Za-z@]+|--))*\s+([^\s;&|]+)\s*$/,
    );
    if (!match) continue;

    const target = match[1]!;
    if (
      target === '-' ||
      target.includes('$') ||
      target.includes('`') ||
      (target.startsWith('~') && target !== '~' && !target.startsWith('~/'))
    ) {
      return undefined;
    }

    const normalized = normalizeStaticTarget(target, false);
    if (isAbsoluteShellPath(normalized)) {
      effective = nodePath.posix.normalize(normalized);
    } else {
      effective = nodePath.posix.normalize(
        effective ? nodePath.posix.join(effective, normalized) : normalized,
      );
    }
    changed = true;
  }

  return changed ? effective : undefined;
}

/**
 * Analyze shell writes with tree-sitter. This is intentionally separate from
 * the lightweight virtual-op tokenizer: the AST answers whether a redirect is
 * real shell syntax, while the tokenizer remains useful for precise concrete
 * paths and command semantics.
 */
export async function analyzeShellWritesAST(
  command: string,
): Promise<ShellAstWriteAnalysis> {
  let tree: Parser.Tree;
  try {
    tree = await parseShellCommand(command);
  } catch {
    return {
      redirects: hasUnquotedWriteRedirectForParserFallback(command)
        ? [{ operator: 'unknown', absolute: false }]
        : [],
      devNullRedirects: 0,
    };
  }

  try {
    const root = tree.rootNode;
    const parseHadError = root.hasError;

    const redirects: ShellAstWriteRedirect[] = [];
    let devNullRedirects = 0;
    let ignoredFdRedirects = 0;
    for (const node of walkNamed(root)) {
      if (node.type !== 'file_redirect') continue;
      const operatorNode = node.children.find(
        (child) =>
          child.type !== 'file_descriptor' &&
          WRITE_REDIRECT_OPERATORS.has(child.type),
      );
      // tree-sitter-bash currently represents `<>` as `<` + ERROR(`>`).
      // Locate `<` after an optional file_descriptor so fd-prefixed forms such
      // as `3<> file` and `2<> /dev/null` follow the same path.
      const ltIndex = node.children.findIndex((child) => child.type === '<');
      const isReadWriteRedirect =
        ltIndex >= 0 &&
        node.children[ltIndex + 1]?.type === 'ERROR' &&
        node.children[ltIndex + 1]?.text === '>';
      if (!operatorNode && !isReadWriteRedirect) continue;

      const operator = isReadWriteRedirect ? '<>' : operatorNode!.type;
      const fdShapeSource = command.slice(
        node.startIndex,
        Math.min(command.length, node.endIndex + 16),
      );
      const spacedFdShape =
        /^(?:\d+\s*)?>\s*&\s*(?:\d+-?|-)(?=\s|$|[)<|;&])/.test(fdShapeSource);
      const destination = node.childForFieldName('destination');
      if (!destination) {
        if (isFdDuplicationTarget(operator, '', node.text) || spacedFdShape) {
          ignoredFdRedirects++;
          continue;
        }
        redirects.push({ operator, absolute: false });
        continue;
      }

      const destinationText = destination.text;
      const quoted =
        destinationText.length >= 2 &&
        (destinationText[0] === "'" || destinationText[0] === '"') &&
        destinationText[destinationText.length - 1] === destinationText[0];
      const rawTarget = stripOuterQuotes(destinationText);
      if (spacedFdShape || (!quoted && /^&(?:\d+|-)$/.test(rawTarget))) {
        ignoredFdRedirects++;
        continue;
      }
      if (isFdDuplicationTarget(operator, rawTarget, node.text)) {
        // fd duplication/close (including `N-`), not a filesystem write.
        ignoredFdRedirects++;
        continue;
      }
      if (rawTarget === '/dev/null') {
        devNullRedirects++;
        continue;
      }
      if (/^\/dev\/(?:tcp|udp)\//.test(rawTarget)) {
        continue;
      }

      if (!isStaticDestination(destination)) {
        redirects.push({ operator, absolute: false });
        continue;
      }

      let staticTarget = normalizeStaticTarget(rawTarget, quoted);
      let absolute = isAbsoluteShellPath(staticTarget);
      if (!absolute) {
        const cwdPrefix = staticCwdPrefixBeforeRedirect(command, node.startIndex);
        if (cwdPrefix) {
          staticTarget = nodePath.posix.normalize(
            nodePath.posix.join(cwdPrefix, staticTarget),
          );
          absolute = isAbsoluteShellPath(staticTarget);
        }
      }
      if (
        !absolute &&
        hasDynamicNamedTildeCwdBefore(command, node.startIndex)
      ) {
        redirects.push({ operator, absolute: false });
        continue;
      }

      redirects.push({
        operator,
        staticTarget,
        absolute,
      });
    }

    if (hasQuotedRedirectLikeWriteArgument(command)) {
      redirects.push({ operator: 'unknown', absolute: false });
    }

    const parseErrorRemainder = command.replace(
      /(?:\d*)>\s*&\s*(?:\d+-?|-)(?=\s|$|[)<|;&])/g,
      '',
    );
    if (
      parseHadError &&
      redirects.length === 0 &&
      devNullRedirects === 0 &&
      ignoredFdRedirects === 0 &&
      parseErrorRemainder.includes('>')
    ) {
      redirects.push({ operator: 'unknown', absolute: false });
    }

    return {
      redirects,
      devNullRedirects,
    };
  } finally {
    tree.delete();
  }
}
