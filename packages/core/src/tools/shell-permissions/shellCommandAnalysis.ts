/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission analysis uses the Bash syntax tree to separate executable code
 * from data before scanning execution boundaries. Comments and heredoc data
 * do not produce executable segments; expansions in the body are checked separately.
 * A conservative scan remains available without the parser, but unanalyzed
 * heredocs cannot qualify for automatic read-only approval.
 */

import { splitCommands } from '../../utils/shell-utils.js';
import {
  readShellSyntax,
  removeShellContinuations,
  type ShellSyntax,
} from './shellSyntax.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Diagnostic features detected by the scanner.
 */
export interface ShellCommandFeatures {
  /** Top-level separator found: &&, ||, ;, \n, &, |, |& */
  hasTopLevelSeparator: boolean;
  /** A standalone top-level `&` background operator was found. */
  hasBackgroundExecution: boolean;
  /** Pipeline operator | or |& at top level */
  hasPipeline: boolean;
  /** $() command substitution outside single quotes */
  hasCommandSubstitution: boolean;
  /** Backtick command substitution outside single quotes */
  hasBacktickSubstitution: boolean;
  /** Process substitution <() or >() outside single quotes */
  hasProcessSubstitution: boolean;
  /** Bare top-level subshell (...) outside single quotes */
  hasSubshellExecution: boolean;
  /** Nested execution boundary: $(), backticks, process substitution, or subshell */
  hasNestedExecution: boolean;
  /**
   * Dynamic syntax that blocks broad allow but is not fully parsed into
   * executable segments. Currently triggered by:
   * - Process substitution (<(), >())
   * - Eval-like builtins as first token of a segment
   */
  hasUnknownDynamicSyntax: boolean;
  /** First token of any segment is an eval-like builtin */
  hasEvalLikeBuiltin: boolean;
}

/**
 * Result of analyzing a shell command for permission decisions.
 */
export interface ShellCommandAnalysis {
  syntax?: ShellSyntax;
  analysisIncomplete?: boolean;
  /** The original command string */
  original: string;

  /**
   * True when prefix/wildcard allow must not match the full original command.
   * Exact full-command rules may still match.
   */
  blocksBroadAllow: boolean;

  /**
   * Top-level executable segments split by shell control operators.
   * Used for per-subcommand allow checks.
   *
   * Nested structures ($(), backticks, parenthesized subshells) are kept
   * intact — their contents are NOT extracted as separate segments.
   */
  topLevelSegments: string[];

  /**
   * All commands that deny/ask should check.
   * Includes top-level segments plus parser-extracted commands (which may
   * include nested command substitution contents when tree-sitter is available).
   */
  executableSegments: string[];

  /**
   * True when tree-sitter contributed additional segments beyond what the
   * synchronous scanner found. When false and the scanner detected nested
   * execution boundaries, deny/ask rules may not cover nested commands.
   */
  hasParserSegments: boolean;

  /** Diagnostic features */
  features: ShellCommandFeatures;
}

// ============================================================================
// Eval-like builtins
// ============================================================================

/**
 * Builtins that evaluate, source, replace, or reinterpret command text.
 * A broad allow rule for these is effectively arbitrary code execution.
 */
const EVAL_LIKE_BUILTINS = new Set([
  'eval',
  'source',
  '.', // synonym for source
  'exec',
  'trap',
  'enable',
  'hash',
  'alias',
  'command',
  'builtin',
  'coproc',
]);

// ============================================================================
// Scanner
// ============================================================================

/**
 * Internal result from the synchronous scanner.
 */
interface ScanResult {
  blocksBroadAllow: boolean;
  topLevelSegments: string[];
  features: ShellCommandFeatures;
}

/**
 * Synchronous, zero-dependency shell shape scanner.
 *
 * Scans the command character-by-character with quote and nesting tracking
 * to detect execution boundaries. This is the security floor — its results
 * are authoritative even when tree-sitter is unavailable.
 *
 * Design principles:
 * - Single quotes suppress ALL shell expansion (no boundaries inside).
 * - Double quotes suppress operators but NOT command substitution ($(), ``).
 * - Backslash outside single quotes escapes the next character.
 * - Backslash-newline is line continuation, not a separator.
 * - Top-level segments split only on unquoted, unnested operators.
 * - $(), ``, <(), >() are execution boundaries that block broad allow.
 */
export function scanShellShape(command: string): ScanResult {
  return analyzeShellCommand(command);
}

function scanExecutableShape(command: string): ScanResult {
  const features: ShellCommandFeatures = {
    hasTopLevelSeparator: false,
    hasBackgroundExecution: false,
    hasPipeline: false,
    hasCommandSubstitution: false,
    hasBacktickSubstitution: false,
    hasProcessSubstitution: false,
    hasSubshellExecution: false,
    hasNestedExecution: false,
    hasUnknownDynamicSyntax: false,
    hasEvalLikeBuiltin: false,
  };

  let blocksBroadAllow = false;

  // Quote/nesting state
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let parenDepth = 0;

  // Segment collection
  const segments: string[] = [];
  let segStart = 0;

  const len = command.length;

  for (let i = 0; i < len; i++) {
    const ch = command[i];

    // ── Single quote tracking ──
    // Single quotes suppress everything. No escaping inside single quotes.
    if (ch === "'" && !inDouble && !inBacktick && parenDepth === 0) {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle) continue;

    // ── Backslash escaping (outside single quotes) ──
    if (ch === '\\') {
      if (i + 1 < len) {
        const next = command[i + 1];
        if (next === '\n') {
          // Backslash-newline is line continuation — skip both characters.
          // This is NOT a separator.
          i++; // skip \n
          continue;
        }
        // Any other backslash-X: the next character is escaped and should
        // not trigger boundary detection.
        i++; // skip next char
        continue;
      }
      // Trailing backslash at end of string — nothing to escape.
      continue;
    }

    // ── Double quote tracking ──
    if (ch === '"' && !inBacktick && parenDepth === 0) {
      inDouble = !inDouble;
      continue;
    }

    // ── Inside double quotes: only $() and `` are execution boundaries ──
    if (inDouble) {
      // $( inside double quotes (unescaped — backslash already handled above)
      if (ch === '$' && i + 1 < len && command[i + 1] === '(') {
        features.hasCommandSubstitution = true;
        blocksBroadAllow = true;
      }
      // Backtick inside double quotes
      if (ch === '`') {
        features.hasBacktickSubstitution = true;
        blocksBroadAllow = true;
      }
      // Operators (|, &, ;, newline) inside double quotes are literal.
      continue;
    }

    // ── Backtick tracking (outside double quotes) ──
    if (ch === '`') {
      inBacktick = !inBacktick;
      if (!inBacktick) {
        // Closing backtick — boundary already set on open.
        continue;
      }
      features.hasBacktickSubstitution = true;
      blocksBroadAllow = true;
      continue;
    }
    if (inBacktick) continue;

    // ── Nesting: $( and bare ( ──
    if (ch === '$' && i + 1 < len && command[i + 1] === '(') {
      features.hasCommandSubstitution = true;
      blocksBroadAllow = true;
      parenDepth++;
      i++; // skip '('
      continue;
    }
    if (ch === '(' && parenDepth === 0) {
      // Bare ( at top level is a subshell — an execution boundary.
      features.hasSubshellExecution = true;
      blocksBroadAllow = true;
      parenDepth++;
      continue;
    }
    if (ch === '(' && parenDepth > 0) {
      parenDepth++;
      continue;
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth--;
      continue;
    }
    if (parenDepth > 0) continue;

    // ── Top-level operator detection (outside all quoting and nesting) ──

    // Process substitution: <( and >(
    // Must be checked BEFORE pipe detection to avoid <( being seen as < then (.
    if ((ch === '<' || ch === '>') && i + 1 < len && command[i + 1] === '(') {
      features.hasProcessSubstitution = true;
      features.hasUnknownDynamicSyntax = true;
      blocksBroadAllow = true;
      // Enter the nested substitution
      parenDepth++;
      i++; // skip '('
      continue;
    }

    let opLen = 0;

    if (ch === '&' && i + 1 < len && command[i + 1] === '&') {
      opLen = 2; // &&
    } else if (ch === '|' && i + 1 < len && command[i + 1] === '|') {
      opLen = 2; // ||
    } else if (ch === '|' && i + 1 < len && command[i + 1] === '&') {
      opLen = 2; // |& (bash pipe stderr)
      features.hasPipeline = true;
    } else if (ch === ';' || ch === '\n') {
      opLen = 1;
    } else if (ch === '|') {
      opLen = 1; // pipe
      features.hasPipeline = true;
    } else if (ch === '&') {
      opLen = 1; // background
      features.hasBackgroundExecution = true;
    }

    if (opLen > 0) {
      features.hasTopLevelSeparator = true;
      blocksBroadAllow = true;

      const seg = command.slice(segStart, i).trim();
      if (seg) segments.push(seg);
      segStart = i + opLen;
      i += opLen - 1; // loop will i++
    }
  }

  // Trailing segment
  const last = command.slice(segStart).trim();
  if (last) segments.push(last);

  // Canonical segment list: scanner segments if any, otherwise the full command.
  const topLevelSegments =
    segments.length > 0 ? segments : [command.trim()].filter(Boolean);

  // ── Eval-like builtin detection ──
  // Check first token of each top-level segment.
  for (const seg of topLevelSegments) {
    const firstToken = extractFirstToken(seg);
    if (firstToken && EVAL_LIKE_BUILTINS.has(firstToken)) {
      features.hasEvalLikeBuiltin = true;
      features.hasUnknownDynamicSyntax = true;
      blocksBroadAllow = true;
      break;
    }
  }

  // Derived: true when any nested execution boundary was detected.
  features.hasNestedExecution =
    features.hasCommandSubstitution ||
    features.hasBacktickSubstitution ||
    features.hasProcessSubstitution ||
    features.hasSubshellExecution;

  return {
    blocksBroadAllow,
    topLevelSegments,
    features,
  };
}

/**
 * Extracts the first whitespace-delimited token from a command segment.
 * Skips leading environment variable assignments (VAR=value).
 * Returns null if the segment is empty or only contains env assignments.
 */
function extractFirstToken(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/);

  for (const token of tokens) {
    // Skip env var assignments: VAR=value, VAR+=value, VAR[0]=value
    if (/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(token)) {
      continue;
    }
    // Strip any leading path: /usr/bin/eval → eval
    const basename = token.includes('/') ? token.split('/').pop()! : token;
    return basename || null;
  }

  return null;
}

// ============================================================================
// Analyzer (composition of scanner + parser)
// ============================================================================

/** Collect control flow, executable commands, and redirected scripts for permission and safety checks. */
export function analyzeShellCommand(
  command: string,
  depth = 0,
): ShellCommandAnalysis {
  const syntax = readShellSyntax(command);
  const scan = scanExecutableShape(
    syntax?.source ?? removeShellContinuations(command),
  );
  if (syntax?.hasHeredocExpansion || syntax?.embeddedScripts.length) {
    scan.features.hasNestedExecution = true;
    scan.blocksBroadAllow = true;
  }

  // A quoted heredoc passed to a shell is still a script whose commands need recursive checks.
  const embedded =
    depth < 3
      ? (syntax?.embeddedScripts ?? []).map((script) =>
          analyzeShellCommand(script, depth + 1),
        )
      : [];
  const parserSegments = [
    ...(syntax?.commands ?? splitCommands(command, 'bash')),
    ...embedded.flatMap((item) => item.executableSegments),
  ];

  const topLevelSegments =
    !syntax && /<</.test(command) ? [] : scan.topLevelSegments;

  // De-duplicate after trimming: scanner and parser may produce the same
  // segment with minor whitespace differences.
  const allSegments = [...topLevelSegments, ...parserSegments]
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const executableSegments: string[] = [];
  for (const seg of allSegments) {
    if (!seen.has(seg)) {
      seen.add(seg);
      executableSegments.push(seg);
    }
  }

  return {
    syntax: syntax ?? undefined,
    analysisIncomplete:
      (!syntax && /<<|\\\n/.test(command)) ||
      embedded.some((item) => item.analysisIncomplete) ||
      (depth >= 3 && !!syntax?.embeddedScripts.length),
    original: command,
    blocksBroadAllow: scan.blocksBroadAllow,
    topLevelSegments,
    executableSegments,
    hasParserSegments: parserSegments.length > 0,
    features: scan.features,
  };
}
