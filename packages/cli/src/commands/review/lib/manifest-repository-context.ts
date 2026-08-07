/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RepositoryContextRoleId } from './agent-briefs.js';
import { isRepositoryContextRoleId } from './agent-briefs.js';
import type {
  RepositoryContext,
  RepositoryContextProvider,
} from './repository-context.js';
import {
  compareText,
  isControlFree,
  isSafeRepositoryRelativePath,
  MAX_ARRAY_ITEMS,
  MAX_IDENTITY_BYTES,
  MAX_LABEL_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PATH_LENGTH,
  MAX_TOKEN_LENGTH,
  validateBoundedString,
  validateBoundedStringArray,
  validateRepositoryContext,
} from './repository-context.js';

const MANIFEST_PATH = '.qwen/review-context.json';
/**
 * Visited-entry ceiling for one `relatedPaths` expansion, counted across all
 * scan roots. Dependency and build-output trees (SKIPPED_DIRECTORIES) are
 * never descended into, so only source-bearing entries count. Calibrated on
 * this repository: the whole `packages/` tree of an installed checkout stays
 * under it, so a honestly scoped manifest never fails a review, while a
 * pathological scan still ends. Exceeded, the provider throws (fail closed),
 * like every other manifest error.
 */
export const MAX_GLOB_CANDIDATES = 16384;
/**
 * Matching-work ceiling for one stage. The visited-entry cap bounds a
 * COUNT; the per-candidate matching work is a separate dimension — one
 * memoised `**` match is quadratic in segment LENGTH, and in an untrusted
 * repository an attacker controls both lengths within their schema maxima
 * (255-byte filenames, 512-character patterns), so billing segment COUNTS
 * never trips for a schema-legal stall shape. Every attempted pattern match
 * therefore charges `pattern.length × path.length` against this budget, in
 * the rule filter as well as the expansion, so a matching burst fails
 * closed instead of stalling the step. Calibrated so the documented
 * legitimate scan — every entry of an installed-checkout `packages/` tree
 * against a handful of realistic globs — stays far below it, while a
 * schema-max adversarial evaluation exhausts it within the first few dozen
 * candidates.
 */
export const MAX_MATCH_WORK = 1024 * 1024 * 1024;
const MAX_RULES = 128;
const MANIFEST_PREFIX = 'repository context manifest ';

// Dependency and build-output trees hold orders of magnitude more entries
// than any source subtree and can never be a review target; descending into
// them would exhaust the visited-entry ceiling on every installed checkout.
// Names tracked source must not live under in this repository's conventions
// (a `build/` directory holds real scripts here) stay out of this set.
// Membership is compared case-insensitively at every enforcement site, or a
// case-varied pattern walks into a skipped tree on every platform.
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

const MANIFEST_KEYS = ['label', 'rules', 'version'].sort();
const RULE_KEYS = [
  'domains',
  'paths',
  'recommendedTests',
  'relatedPaths',
  'requiredAgents',
  'requiredConfigurations',
  'unverifiedDimensions',
  'verificationNotes',
].sort();

interface ManifestRule {
  paths: string[];
  relatedPaths: string[];
  domains: string[];
  recommendedTests: string[];
  requiredConfigurations: string[];
  requiredAgents: RepositoryContextRoleId[];
  unverifiedDimensions: string[];
  verificationNotes: string[];
}

interface Manifest {
  label: string;
  rules: ManifestRule[];
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function validateManifestString(
  value: unknown,
  field: string,
  maxLength: number,
): asserts value is string {
  validateBoundedString(value, field, maxLength, MANIFEST_PREFIX);
}

/**
 * Manifest arrays are human-authored, so they need only be UNIQUE — hand-
 * sorting a config file is a sharp edge that would fail whole reviews over
 * cosmetics. The provider merges and sorts before the wire format's strict
 * sorted-and-unique validator ever sees the result (see sortedUnique below).
 */
function validateManifestStringArray(
  value: unknown,
  field: string,
  maxLength: number,
): asserts value is string[] {
  validateBoundedStringArray(value, field, maxLength, MANIFEST_PREFIX);
  if (new Set(value).size !== value.length) {
    throw new Error(`${MANIFEST_PREFIX}${field} must not contain duplicates`);
  }
}

function validateGlob(pattern: string, field: string): void {
  const segments = pattern.split('/');
  if (
    pattern.length > MAX_PATH_LENGTH ||
    !isControlFree(pattern) ||
    pattern.startsWith('/') ||
    /^[A-Za-z]:/.test(pattern) ||
    pattern.startsWith('!') ||
    pattern.includes('\\') ||
    /[{}[\]()]/.test(pattern) ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        (segment.includes('**') && segment !== '**'),
    )
  ) {
    throw new Error(
      `repository context manifest ${field} contains unsafe glob`,
    );
  }
  // The never-descend invariant below is enforced for entries discovered
  // during recursion; a pattern rooted inside a skipped tree would bypass
  // it through the scan roots, so such patterns are rejected here too.
  if (
    segments.some((segment) => SKIPPED_DIRECTORIES.has(segment.toLowerCase()))
  ) {
    throw new Error(
      `repository context manifest ${field} enters a skipped directory`,
    );
  }
}

function validateGlobArray(
  value: unknown,
  field: string,
  requireDirectoryPrefix: boolean,
): asserts value is string[] {
  validateManifestStringArray(value, field, MAX_PATH_LENGTH);
  for (const pattern of value) {
    validateGlob(pattern, field);
    // A wildcard glob must start below a non-wildcard directory segment so
    // expansion cannot begin with a repository-wide wildcard. A completely
    // static entry can never start with one, so it may sit at the top level
    // and resolves to itself when it exists as a regular file.
    if (requireDirectoryPrefix && /[*?]/.test(pattern.split('/')[0])) {
      throw new Error(
        `repository context manifest ${field} requires a directory prefix`,
      );
    }
  }
}

function optionalStringArray(
  rule: Record<string, unknown>,
  field: keyof Omit<ManifestRule, 'paths' | 'requiredAgents'>,
  maxLength: number,
): string[] {
  const value = rule[field];
  if (value === undefined) return [];
  validateManifestStringArray(value, field, maxLength);
  return value;
}

function parseManifest(content: string): Manifest {
  if (content.length > MAX_IDENTITY_BYTES) {
    throw new Error('repository context manifest exceeds the size limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error('repository context manifest is not valid JSON');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, MANIFEST_KEYS)
  ) {
    throw new Error(
      'repository context manifest has unknown or missing fields',
    );
  }
  const manifest = value as Record<string, unknown>;
  if (manifest['version'] !== 1) {
    throw new Error('unsupported repository context manifest version');
  }
  validateManifestString(manifest['label'], 'label', MAX_LABEL_LENGTH);
  if (
    !Array.isArray(manifest['rules']) ||
    manifest['rules'].length > MAX_RULES
  ) {
    throw new Error('repository context manifest rules is invalid');
  }

  const rules = manifest['rules'].map((value, index): ManifestRule => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`repository context manifest rules[${index}] is invalid`);
    }
    const rule = value as Record<string, unknown>;
    const keys = Object.keys(rule).sort();
    if (
      !keys.includes('paths') ||
      keys.some((key) => !RULE_KEYS.includes(key))
    ) {
      throw new Error(
        `repository context manifest rules[${index}] has unknown or missing fields`,
      );
    }
    validateGlobArray(rule['paths'], `rules[${index}].paths`, false);

    const relatedPaths = rule['relatedPaths'];
    if (relatedPaths !== undefined) {
      validateGlobArray(relatedPaths, `rules[${index}].relatedPaths`, true);
    }
    const requiredAgents = rule['requiredAgents'];
    if (requiredAgents !== undefined) {
      validateManifestStringArray(
        requiredAgents,
        `rules[${index}].requiredAgents`,
        MAX_TOKEN_LENGTH,
      );
      if (requiredAgents.some((role) => !isRepositoryContextRoleId(role))) {
        throw new Error(
          `repository context manifest rules[${index}].requiredAgents contains an unsupported role`,
        );
      }
    }

    return {
      paths: rule['paths'],
      relatedPaths: relatedPaths ?? [],
      domains: optionalStringArray(rule, 'domains', MAX_TOKEN_LENGTH),
      recommendedTests: optionalStringArray(
        rule,
        'recommendedTests',
        MAX_TOKEN_LENGTH,
      ),
      requiredConfigurations: optionalStringArray(
        rule,
        'requiredConfigurations',
        MAX_TOKEN_LENGTH,
      ),
      requiredAgents: (requiredAgents ?? []) as RepositoryContextRoleId[],
      unverifiedDimensions: optionalStringArray(
        rule,
        'unverifiedDimensions',
        MAX_NOTE_LENGTH,
      ),
      verificationNotes: optionalStringArray(
        rule,
        'verificationNotes',
        MAX_NOTE_LENGTH,
      ),
    };
  });

  // Bound the rule-matching work fail-closed: the filter tests every changed
  // path against every `paths` pattern, so the total — not just each rule's
  // array — is what a bulk-change PR multiplies against.
  const totalPathPatterns = rules.reduce(
    (sum, rule) => sum + rule.paths.length,
    0,
  );
  if (totalPathPatterns > MAX_ARRAY_ITEMS) {
    throw new Error(`${MANIFEST_PREFIX}paths exceeds limit`);
  }

  return { label: manifest['label'], rules };
}

// Polynomial wildcard match for one segment. The backtracking regex this
// replaced went exponential on a segment with several `*` — a legal manifest
// pattern plus a legal long filename hangs one `test()` call effectively
// forever, and in an untrusted repository both halves are attacker-committed.
function segmentMatches(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let markIndex = 0;
  while (valueIndex < value.length) {
    const character = pattern[patternIndex];
    if (character === '?' || character === value[valueIndex]) {
      patternIndex++;
      valueIndex++;
    } else if (character === '*') {
      starIndex = patternIndex;
      markIndex = valueIndex;
      patternIndex++;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      markIndex++;
      valueIndex = markIndex;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === pattern.length;
}

function globMatches(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = path.split('/');
  const memo = new Map<string, boolean>();
  const matches = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else if (patternSegments[patternIndex] === '**') {
      result =
        matches(patternIndex + 1, pathIndex) ||
        (pathIndex < pathSegments.length &&
          matches(patternIndex, pathIndex + 1));
    } else {
      result =
        pathIndex < pathSegments.length &&
        segmentMatches(
          patternSegments[patternIndex],
          pathSegments[pathIndex],
        ) &&
        matches(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return matches(0, 0);
}

function isContainedFile(worktree: string, path: string): boolean {
  try {
    const resolved = realpathSync(resolve(worktree, path));
    const contained = relative(worktree, resolved);
    return (
      contained !== '' &&
      !isAbsolute(contained) &&
      contained !== '..' &&
      !contained.startsWith(`..${sep}`) &&
      statSync(resolved).isFile()
    );
  } catch {
    return false;
  }
}

function staticDirectoryPrefix(pattern: string): string {
  const prefix: string[] = [];
  for (const segment of pattern.split('/')) {
    if (segment.includes('*') || segment.includes('?')) break;
    prefix.push(segment);
  }
  return prefix.join('/');
}

function minimalScanRoots(patterns: readonly string[]): string[] {
  const roots = sortedUnique(patterns.map(staticDirectoryPrefix));
  return roots.filter(
    (root, index) =>
      !roots.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index && root.startsWith(`${candidate}/`),
      ),
  );
}

function expandRelatedPaths(
  worktree: string,
  patterns: readonly string[],
  changedPaths: ReadonlySet<string>,
): string[] {
  const matches = new Set<string>();
  let candidates = 0;
  const patternLengths = patterns.map((pattern) => pattern.length);
  let matchWork = 0;

  const anyPatternMatches = (path: string): boolean => {
    for (let index = 0; index < patterns.length; index++) {
      matchWork += patternLengths[index] * path.length;
      if (matchWork > MAX_MATCH_WORK) {
        throw new Error(
          'repository context manifest relatedPaths matching work exceeds limit',
        );
      }
      if (globMatches(patterns[index], path)) return true;
    }
    return false;
  };

  const visit = (directory: string): void => {
    let entries;
    try {
      const stat = lstatSync(resolve(worktree, directory));
      if (stat.isSymbolicLink()) return;
      if (!stat.isDirectory()) {
        candidates++;
        if (candidates > MAX_GLOB_CANDIDATES) {
          throw new Error(
            'repository context manifest relatedPaths scan exceeds limit',
          );
        }
        const path = directory;
        if (
          !changedPaths.has(path) &&
          isContainedFile(worktree, path) &&
          anyPatternMatches(path)
        ) {
          matches.add(path);
          if (matches.size > MAX_ARRAY_ITEMS) {
            throw new Error(
              'repository context manifest relatedPaths exceeds limit',
            );
          }
        }
        return;
      }
      entries = readdirSync(resolve(worktree, directory), {
        withFileTypes: true,
      });
      // Bound the listing before sorting it, or an oversized directory pays
      // the full read plus an O(n log n) sort before the cap can trip.
      if (candidates + entries.length > MAX_GLOB_CANDIDATES) {
        throw new Error(
          'repository context manifest relatedPaths scan exceeds limit',
        );
      }
      entries.sort((left, right) => compareText(left.name, right.name));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('repository context manifest')
      ) {
        throw error;
      }
      // A subtree that EXISTS but cannot be read fails the review closed,
      // the way the identity reader does — silently skipping it would
      // degrade the scan into a complete-looking result with a hole in it.
      // Only a racing deletion still reads as "absent".
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      return;
    }

    for (const entry of entries) {
      candidates++;
      if (candidates > MAX_GLOB_CANDIDATES) {
        throw new Error(
          'repository context manifest relatedPaths scan exceeds limit',
        );
      }
      if (entry.isSymbolicLink()) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) visit(path);
        continue;
      }
      // Disk names can carry POSIX-legal bytes the wire format rejects (a
      // backslash, control characters); skip them like changedPaths does
      // instead of failing the whole review over one odd filename. The
      // shape gates run before matching: an over-long path can never reach
      // the wire format, so it can never match, and the cheap checks keep
      // the memoised matcher away from disk garbage.
      if (
        !entry.isFile() ||
        changedPaths.has(path) ||
        !isSafeRepositoryRelativePath(path) ||
        !isContainedFile(worktree, path) ||
        !anyPatternMatches(path)
      ) {
        continue;
      }
      matches.add(path);
      if (matches.size > MAX_ARRAY_ITEMS) {
        throw new Error(
          'repository context manifest relatedPaths exceeds limit',
        );
      }
    }
  };

  for (const root of minimalScanRoots(patterns)) visit(root);
  return [...matches].sort(compareText);
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

/**
 * The merge of all matching rules can outgrow the wire bound even when every
 * single rule honors it; cap it here so the error names the manifest instead
 * of surfacing later as a shape error from the wire validator. `subject`
 * distinguishes the merged PATTERN list of `relatedPaths` from the
 * resolved-files cap in the expansion, which reports the same field name —
 * an operator diagnosing a fail-closed step must be able to tell whether to
 * trim the manifest's glob list or narrow the globs' reach.
 */
function cappedSortedUnique(values: string[], subject: string): string[] {
  const merged = sortedUnique(values);
  if (merged.length > MAX_ARRAY_ITEMS) {
    throw new Error(`${MANIFEST_PREFIX}${subject} exceeds limit`);
  }
  return merged;
}

export const manifestRepositoryContextProvider: RepositoryContextProvider = {
  provide(input) {
    const content = input.readIdentityFile(MANIFEST_PATH);
    if (content === null) return null;
    const manifest = parseManifest(content);
    // Nothing caps the changed-path count a bulk diff brings, so the filter
    // charges the same budget the expansion does, with the same length-based
    // billing — a matching burst must fail closed in this stage too instead
    // of stalling the step.
    let filterWork = 0;
    const matched = manifest.rules.filter((rule) =>
      input.changedPaths.some((path) =>
        rule.paths.some((pattern) => {
          filterWork += pattern.length * path.length;
          if (filterWork > MAX_MATCH_WORK) {
            throw new Error(
              `${MANIFEST_PREFIX}paths matching work exceeds limit`,
            );
          }
          return globMatches(pattern, path);
        }),
      ),
    );
    if (matched.length === 0) return null;

    const changedPaths = new Set(input.changedPaths);
    const context: RepositoryContext = {
      version: 1,
      provider: 'manifest',
      label: manifest.label,
      domains: cappedSortedUnique(
        matched.flatMap((rule) => rule.domains),
        'domains',
      ),
      relatedPaths: expandRelatedPaths(
        input.worktree,
        cappedSortedUnique(
          matched.flatMap((rule) => rule.relatedPaths),
          'relatedPaths glob list',
        ),
        changedPaths,
      ),
      recommendedTests: cappedSortedUnique(
        matched.flatMap((rule) => rule.recommendedTests),
        'recommendedTests',
      ),
      requiredConfigurations: cappedSortedUnique(
        matched.flatMap((rule) => rule.requiredConfigurations),
        'requiredConfigurations',
      ),
      requiredAgents: cappedSortedUnique(
        matched.flatMap((rule) => rule.requiredAgents),
        'requiredAgents',
      ) as RepositoryContextRoleId[],
      unverifiedDimensions: cappedSortedUnique(
        matched.flatMap((rule) => rule.unverifiedDimensions),
        'unverifiedDimensions',
      ),
      verificationNotes: cappedSortedUnique(
        matched.flatMap((rule) => rule.verificationNotes),
        'verificationNotes',
      ),
    };
    return validateRepositoryContext(context);
  },
};
