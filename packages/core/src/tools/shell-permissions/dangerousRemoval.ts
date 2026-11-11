/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Catastrophic-removal detection for shell commands.
 *
 * The flag-based dangerous-command patterns (`dangerousCommandDetection.ts`)
 * make every `rm -rf` a prompt that allow rules cannot fill, and Yolo waives
 * them all. This module is the narrower, stronger tier: it looks at what an
 * `rm` / `rmdir` would actually remove and objects only when the target is
 * the workspace, the home directory, a system root, a variable that may
 * expand to nothing, or a glob that cannot be resolved statically. Its ask
 * carries `bypassImmune`, which the mode layer, the rule wrappers and the ask
 * handler all honour: Yolo keeps the prompt, rule and hook asks do not replace
 * it, and a channel with nobody to ask denies.
 *
 * The contract is the hit/miss table in
 * `docs/designs/2026-09-14-dangerous-removal-yolo-alignment.md`. Plain
 * `rm -rf ./build` is deliberately not a hit.
 */

import { realpathSync } from 'node:fs';
import * as nodePath from 'node:path';
import { homedir } from '../../utils/paths.js';
import { expandTilde } from '../../utils/expandTilde.js';
import type { ShellCommandAnalysis } from './shellCommandAnalysis.js';
import type { ToolPermissionResult } from '../tool-checkers/rule-precedence.js';
import {
  collectShellExecutions,
  countSubstitutions,
  locateHead,
  MAX_SUBSTITUTIONS,
  EMPTY_VAR,
  POSITIONAL,
  SUBSTITUTION,
  REMOVAL_COMMANDS,
  DIRECTORY_CHANGERS,
} from './shellExecutionAnalysis.js';

export type DangerousRemovalAsk = Extract<
  ToolPermissionResult,
  { kind: 'ask' }
>;

export interface DangerousRemovalOptions {
  /** Where the command runs; relative targets resolve here. */
  executionCwd?: string;
  /** The permission boundary; workspace containment is judged against it. */
  permissionCwd?: string;
  additionalDirectories: readonly string[];
}

export const DANGEROUS_REMOVAL_DECISION_POINT = 'shell.dangerous_removal.ask';
export const DANGEROUS_REMOVAL_KIND = 'dangerousRemoval';

// ============================================================================
// Entry point
// ============================================================================

/**
 * Objects to a removal whose target cannot be trusted statically, or would be
 * catastrophic. Returns null when every removal in the command is ordinary.
 */
export function checkDangerousRemoval(
  command: string,
  analysis: ShellCommandAnalysis,
  opts: DangerousRemovalOptions,
): DangerousRemovalAsk | null {
  if (!/\brm(?:dir)?\b/i.test(command)) {
    return null;
  }

  const substitutionCount = countSubstitutions(command);
  if (substitutionCount > MAX_SUBSTITUTIONS) {
    return dangerousRemovalAsk(
      'rm',
      `This command contains ${substitutionCount} command substitutions — too many to analyze for catastrophic removals. This requires explicit approval and cannot be auto-allowed by permission rules.`,
      `— too many command substitutions to analyze (${substitutionCount})`,
    );
  }

  const executions = collectShellExecutions(command, analysis);
  const changesDirectory = executions.some(({ tokens }) => {
    const head = locateHead(tokens);
    return head !== null && DIRECTORY_CHANGERS.has(head.name);
  });
  for (const { tokens } of executions) {
    const head = locateHead(tokens);
    if (!head || !REMOVAL_COMMANDS.has(head.name)) continue;
    const ask = judgeRemoval(head.name, head.args, opts, changesDirectory);
    if (ask) return ask;
  }
  return null;
}

// ============================================================================
// Target judgement
// ============================================================================

/**
 * The targets of an `rm` argv: everything after `--`, and otherwise the first
 * non-option token and everything after it. Options after the first target
 * are kept as targets on purpose — losing one is worse than judging `-v`.
 */
function removalTargets(args: readonly string[]): string[] {
  const targets: string[] = [];
  let afterDoubleDash = false;
  let sawTarget = false;
  for (const arg of args) {
    if (afterDoubleDash || sawTarget) {
      targets.push(arg);
    } else if (arg === '--') {
      afterDoubleDash = true;
    } else if (arg === '-' || !arg.startsWith('-')) {
      targets.push(arg);
      sawTarget = true;
    }
  }
  return targets;
}

function hasParentsFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--parents' || /^-[a-zA-Z]*p/.test(arg));
}

function judgeRemoval(
  command: string,
  args: readonly string[],
  opts: DangerousRemovalOptions,
  changesDirectory: boolean,
): DangerousRemovalAsk | null {
  const workspaceDirs = [
    ...(opts.permissionCwd ? [opts.permissionCwd] : []),
    ...opts.additionalDirectories,
  ].map((dir) => nodePath.resolve(dir));
  const parents = command === 'rmdir' && hasParentsFlag(args);

  for (const rawTarget of removalTargets(args)) {
    // An explicit empty path is not the working directory; rm does not resolve it as one.
    if (rawTarget === '') continue;
    const displayed = rawTarget
      .replaceAll(EMPTY_VAR, '$VAR')
      .replaceAll(POSITIONAL, '$N')
      .replaceAll(SUBSTITUTION, '$(...)');

    if (rawTarget.includes(SUBSTITUTION)) {
      return unresolvable(command, displayed);
    }

    // Pass A: what the shell removes when every possibly-empty variable is
    // empty. Only a root wipe counts — `$UNSET/*` becoming `/*` — so an
    // ordinary `$OUT/build` is not a prompt in anyone's mode.
    if (rawTarget.includes(EMPTY_VAR)) {
      const emptied = rawTarget
        .replaceAll(EMPTY_VAR, '')
        .replaceAll(POSITIONAL, '');
      if (emptied !== '') {
        const stripped = stripGlobTail(
          resolveTarget(emptied, opts.executionCwd),
        );
        if (stripped && isFilesystemRoot(stripped.base)) {
          return dangerousRemovalAsk(
            command,
            `Dangerous ${command} operation detected: '${displayed}'\n\nThis target is a shell variable expansion that points at the filesystem root when the variable is unset or empty — e.g. \`rm -rf $UNSET/*\` becomes \`rm -rf /*\`. This requires explicit approval and cannot be auto-allowed by permission rules.`,
            `on possibly-empty variable path: ${displayed}`,
          );
        }
      }
    }

    // Pass B: the variable is opaque and non-empty; judge the literal part.
    const opaque = rawTarget
      .replaceAll(EMPTY_VAR, '__var__')
      .replaceAll(POSITIONAL, '__positional__');
    const tilded = expandTilde(opaque);
    if (tilded.startsWith('~')) {
      return unresolvable(command, displayed);
    }
    if (/^[\\/]{2}/.test(tilded)) {
      // UNC and extended-length paths are refused elsewhere; not ours.
      continue;
    }

    const resolved = resolveTarget(tilded, opts.executionCwd);
    if (resolved === null) {
      continue;
    }
    const absolute = isAbsoluteTarget(tilded);
    const stripped = stripGlobTail(resolved)!;
    const { base, strippedSegments } = stripped;
    const globbed = strippedSegments > 0;

    if (globbed) {
      if (changesDirectory && !absolute) {
        return dangerousRemovalAsk(
          command,
          `Dangerous ${command} operation detected: '${displayed}'\n\nThis command changes directories before the removal, so the relative glob target cannot be statically resolved. This requires explicit approval and cannot be auto-allowed by permission rules.`,
          `on statically-unresolvable target: ${displayed}`,
        );
      }
      const unresolvableGlob =
        (!absolute && /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(tilded)) ||
        /\*[\\/]+$/.test(tilded) ||
        parents;
      if (unresolvableGlob) {
        return unresolvable(command, displayed);
      }
    }

    const candidates = [base];
    const real = safeRealpath(base);
    if (real !== null && real !== base) candidates.push(real);

    if (!globbed || !/[*?[]/.test(base)) {
      for (const candidate of candidates) {
        const hit = judgePath(candidate, workspaceDirs);
        if (hit) return describeHit(command, displayed, hit);
      }
      if (parents) {
        let ancestor = nodePath.dirname(base);
        while (ancestor !== nodePath.dirname(ancestor)) {
          const hit = judgePath(ancestor, workspaceDirs);
          if (hit) return describeHit(command, displayed, hit);
          ancestor = nodePath.dirname(ancestor);
        }
      }
    }

    if (globbed) {
      const wildcardSegments = base
        .split(/[\\/]+/)
        .filter((segment) => /[*?[]/.test(segment)).length;
      if (strippedSegments + wildcardSegments > 1) {
        return dangerousRemovalAsk(
          command,
          `Dangerous ${command} operation detected: '${displayed}'\n\nThis command's glob pattern traverses directories that cannot be statically enumerated. This requires explicit approval and cannot be auto-allowed by permission rules.`,
          `on statically-unresolvable target: ${displayed}`,
        );
      }
    }
  }
  return null;
}

function isAbsoluteTarget(target: string): boolean {
  return nodePath.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target);
}

/** The target as an absolute path, or null when it is relative and cwd-less. */
function resolveTarget(target: string, cwd: string | undefined): string | null {
  if (isAbsoluteTarget(target)) return nodePath.normalize(target);
  if (!cwd) return null;
  return nodePath.resolve(cwd, target);
}

/**
 * Peel trailing `/*` and `/**` segments off a resolved path: the directory
 * whose contents the glob would take, and how many levels were peeled.
 */
function stripGlobTail(
  resolved: string | null,
): { base: string; strippedSegments: number } | null {
  if (resolved === null) return null;
  let base = stripTrailingSeparators(resolved);
  let strippedSegments = 0;
  for (;;) {
    const match = /[\\/]\*+$/.exec(base);
    if (!match) break;
    base = base.slice(0, match.index) || '/';
    strippedSegments++;
  }
  return { base, strippedSegments };
}

function isFilesystemRoot(path: string): boolean {
  const canonical = canonicalForComparison(path);
  return canonical === '/' || /^[A-Za-z]:\/?$/.test(canonical);
}

type PathHit = 'critical' | 'workspace';

function judgePath(
  candidate: string,
  workspaceDirs: readonly string[],
): PathHit | null {
  if (isCriticalPath(candidate)) return 'critical';
  if (workspaceDirs.some((dir) => isSameOrAncestor(candidate, dir))) {
    return 'workspace';
  }
  return null;
}

function describeHit(
  command: string,
  displayed: string,
  hit: PathHit,
): DangerousRemovalAsk {
  if (hit === 'critical') {
    return dangerousRemovalAsk(
      command,
      `Dangerous ${command} operation detected: '${displayed}'\n\nThis command would remove a critical system directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
      `on critical path: ${displayed}`,
    );
  }
  return dangerousRemovalAsk(
    command,
    `Dangerous ${command} operation detected: '${displayed}'\n\nThis command would remove a workspace directory (the working directory, an additional working directory, or one of their parent directories). This requires explicit approval and cannot be auto-allowed by permission rules.`,
    `on working directory or its ancestor: ${displayed}`,
  );
}

function unresolvable(command: string, displayed: string): DangerousRemovalAsk {
  return dangerousRemovalAsk(
    command,
    `Dangerous ${command} operation detected: '${displayed}'\n\nThis command's removal target cannot be statically resolved to a directory. This requires explicit approval and cannot be auto-allowed by permission rules.`,
    `on statically-unresolvable target: ${displayed}`,
  );
}

// ============================================================================
// Path predicates
// ============================================================================

function stripTrailingSeparators(path: string): string {
  const stripped = path.replace(/[\\/]+$/, '');
  return stripped === ''
    ? '/'
    : /^[A-Za-z]:$/.test(stripped)
      ? stripped + '/'
      : stripped;
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // Missing, unreadable, or a path that is not real on this machine: judge
    // the resolved spelling alone.
    return null;
  }
}

const CASE_INSENSITIVE =
  process.platform === 'darwin' || process.platform === 'win32';

function foldCase(path: string): string {
  return CASE_INSENSITIVE ? path.toLowerCase() : path;
}

/** Forward slashes, macOS `/private` aliases folded, no trailing slash. */
function canonicalForComparison(path: string): string {
  let out = path.replace(/[\\/]+/g, '/');
  out = out.replace(/^\/private\/(etc|var|tmp|home)(\/|$)/i, '/$1$2');
  if (out.length > 1 && out.endsWith('/') && !/^[A-Za-z]:\/$/.test(out)) {
    out = out.slice(0, -1);
  }
  return out;
}

let cachedHomes: string[] | null = null;
function homeDirectories(): string[] {
  if (cachedHomes) return cachedHomes;
  const home = canonicalForComparison(homedir());
  const homes = [home];
  const real = safeRealpath(homedir());
  if (real !== null) {
    const canonicalReal = canonicalForComparison(real);
    if (canonicalReal !== home) homes.push(canonicalReal);
  }
  cachedHomes = homes.map(foldCase);
  return cachedHomes;
}

/** For tests: forget the cached home directory spellings. */
export function resetDangerousRemovalCaches(): void {
  cachedHomes = null;
}

/**
 * `/`, a drive root, the home directory, or any directory directly under the
 * root — `/etc`, `/usr`, `/Users`, `C:\Windows`.
 */
export function isCriticalPath(path: string): boolean {
  const canonical = canonicalForComparison(path);
  if (canonical === '/') return true;
  if (/^[A-Za-z]:\/?$/.test(canonical)) return true;
  if (homeDirectories().includes(foldCase(canonical))) return true;
  if (/^\/[^/]+$/.test(canonical)) return true;
  if (/^[A-Za-z]:\/[^/]+$/.test(canonical)) return true;
  return false;
}

/** `target` is `dir` itself or one of its ancestors. */
export function isSameOrAncestor(target: string, dir: string): boolean {
  const relativePath = nodePath.relative(
    foldCase(canonicalForComparison(target)),
    foldCase(canonicalForComparison(dir)),
  );
  if (relativePath === '') return true;
  if (relativePath.startsWith('..') || nodePath.isAbsolute(relativePath)) {
    return false;
  }
  return true;
}

// ============================================================================
// Result
// ============================================================================

function dangerousRemovalAsk(
  command: string,
  message: string,
  shortReason: string,
): DangerousRemovalAsk {
  return {
    kind: 'ask',
    reason: {
      message,
      attribution: {
        type: 'safetyCheck',
        reason: `Dangerous ${command} operation ${shortReason}`,
        safetyCheckKind: DANGEROUS_REMOVAL_KIND,
        // Auto mode routes this to the classifier, as the reference does.
        classifierApprovable: true,
        bypassImmune: true,
      },
      decisionPoint: DANGEROUS_REMOVAL_DECISION_POINT,
    },
    // No "always allow": there is no rule that should cover this. The
    // channels read `persistable` off the prompt to hide the option too.
    suggestions: [],
  };
}
