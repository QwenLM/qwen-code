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
 * scan roots. Deliberately far above any realistic subtree — this repository's
 * whole `packages/` tree is under it — so a honestly scoped manifest never
 * fails a review, while a `**`-at-the-root style pathological scan still ends.
 * Exceeded, the provider throws (fail closed), like every other manifest error.
 */
export const MAX_GLOB_CANDIDATES = 16384;
const MAX_RULES = 128;
const MANIFEST_PREFIX = 'repository context manifest ';

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
}

function validateGlobArray(
  value: unknown,
  field: string,
  requireDirectoryPrefix: boolean,
): asserts value is string[] {
  validateManifestStringArray(value, field, MAX_PATH_LENGTH);
  for (const pattern of value) {
    validateGlob(pattern, field);
    if (
      requireDirectoryPrefix &&
      (!pattern.includes('/') || /[*?]/.test(pattern.split('/')[0]))
    ) {
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

  return { label: manifest['label'], rules };
}

// One compiled expression per pattern segment: at the bounds (thousands of
// candidates x dozens of patterns) recompiling per (pattern, path) pair is six
// figures of throwaway RegExp constructions for one repo-context run.
const segmentExpressions = new Map<string, RegExp>();

function segmentMatches(pattern: string, value: string): boolean {
  let expression = segmentExpressions.get(pattern);
  if (expression === undefined) {
    let source = '^';
    for (const character of pattern) {
      if (character === '*') source += '[^/]*';
      else if (character === '?') source += '[^/]';
      else source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
    expression = new RegExp(`${source}$`);
    segmentExpressions.set(pattern, expression);
  }
  return expression.test(value);
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
          patterns.some((pattern) => globMatches(pattern, path)) &&
          isContainedFile(worktree, path)
        ) {
          matches.add(path);
        }
        return;
      }
      entries = readdirSync(resolve(worktree, directory), {
        withFileTypes: true,
      }).sort((left, right) => compareText(left.name, right.name));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('repository context manifest')
      ) {
        throw error;
      }
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
        visit(path);
        continue;
      }
      // Disk names can carry POSIX-legal bytes the wire format rejects (a
      // backslash, control characters); skip them like changedPaths does
      // instead of failing the whole review over one odd filename.
      if (
        !entry.isFile() ||
        changedPaths.has(path) ||
        !patterns.some((pattern) => globMatches(pattern, path)) ||
        !isContainedFile(worktree, path) ||
        !isSafeRepositoryRelativePath(path)
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

export const manifestRepositoryContextProvider: RepositoryContextProvider = {
  provide(input) {
    const content = input.readIdentityFile(MANIFEST_PATH);
    if (content === null) return null;
    const manifest = parseManifest(content);
    const matched = manifest.rules.filter((rule) =>
      input.changedPaths.some((path) =>
        rule.paths.some((pattern) => globMatches(pattern, path)),
      ),
    );
    if (matched.length === 0) return null;

    const changedPaths = new Set(input.changedPaths);
    const context: RepositoryContext = {
      version: 1,
      provider: 'manifest',
      label: manifest.label,
      domains: sortedUnique(matched.flatMap((rule) => rule.domains)),
      relatedPaths: expandRelatedPaths(
        input.worktree,
        sortedUnique(matched.flatMap((rule) => rule.relatedPaths)),
        changedPaths,
      ),
      recommendedTests: sortedUnique(
        matched.flatMap((rule) => rule.recommendedTests),
      ),
      requiredConfigurations: sortedUnique(
        matched.flatMap((rule) => rule.requiredConfigurations),
      ),
      requiredAgents: sortedUnique(
        matched.flatMap((rule) => rule.requiredAgents),
      ) as RepositoryContextRoleId[],
      unverifiedDimensions: sortedUnique(
        matched.flatMap((rule) => rule.unverifiedDimensions),
      ),
      verificationNotes: sortedUnique(
        matched.flatMap((rule) => rule.verificationNotes),
      ),
    };
    return validateRepositoryContext(context);
  },
};
