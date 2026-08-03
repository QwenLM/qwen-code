/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RepositoryContextRoleId } from './agent-briefs.js';
import { isRepositoryContextRoleId } from './agent-briefs.js';

export const REPOSITORY_CONTEXT_VERSION = 1 as const;

const MAX_ARRAY_ITEMS = 128;
const MAX_PROVIDER_LENGTH = 64;
const MAX_LABEL_LENGTH = 120;
const MAX_TOKEN_LENGTH = 160;
const MAX_PATH_LENGTH = 512;
const MAX_NOTE_LENGTH = 512;

export interface RepositoryContext {
  version: typeof REPOSITORY_CONTEXT_VERSION;
  provider: string;
  label: string;
  domains: string[];
  relatedPaths: string[];
  recommendedTests: string[];
  requiredConfigurations: string[];
  requiredAgents: RepositoryContextRoleId[];
  unverifiedDimensions: string[];
  verificationNotes: string[];
}

export interface RepositoryContextPlan {
  repositoryContext?: unknown;
}

export interface RepositoryContextProviderInput {
  worktree: string;
  changedPaths: string[];
  readIdentityFile(relativePath: string): string | null;
}

export interface RepositoryContextProvider {
  provide(input: RepositoryContextProviderInput): RepositoryContext | null;
}

const CONTEXT_KEYS = [
  'version',
  'provider',
  'label',
  'domains',
  'relatedPaths',
  'recommendedTests',
  'requiredConfigurations',
  'requiredAgents',
  'unverifiedDimensions',
  'verificationNotes',
].sort();

const SAFE_PROVIDER = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$/;

function isControlFree(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      return false;
    }
  }
  return true;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || compareText(values[index - 1], value) < 0,
  );
}

export function isSafeRepositoryRelativePath(path: string): boolean {
  const segments = path.split('/');
  return (
    path.length > 0 &&
    path.length <= MAX_PATH_LENGTH &&
    isControlFree(path) &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes('\\') &&
    segments.every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..',
    )
  );
}

function validateString(
  value: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !isControlFree(value) ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new Error(`repositoryContext.${field} is invalid`);
  }
}

function validateStringArray(
  value: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARRAY_ITEMS ||
    value.some(
      (item) =>
        typeof item !== 'string' ||
        item.length === 0 ||
        item.length > maxLength ||
        !isControlFree(item) ||
        (pattern !== undefined && !pattern.test(item)),
    )
  ) {
    throw new Error(`repositoryContext.${field} is invalid`);
  }
  if (!isSortedUnique(value)) {
    throw new Error(`repositoryContext.${field} must be sorted and unique`);
  }
}

/** Validate repository context before any downstream consumer trusts it. */
export function validateRepositoryContext(value: unknown): RepositoryContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('repositoryContext must be an object');
  }
  const context = value as Record<string, unknown>;
  const keys = Object.keys(context).sort();
  if (
    keys.length !== CONTEXT_KEYS.length ||
    keys.some((key, index) => key !== CONTEXT_KEYS[index])
  ) {
    throw new Error('repositoryContext has unknown or missing fields');
  }
  if (context['version'] !== REPOSITORY_CONTEXT_VERSION) {
    throw new Error('unsupported repositoryContext version');
  }

  validateString(
    context['provider'],
    'provider',
    MAX_PROVIDER_LENGTH,
    SAFE_PROVIDER,
  );
  validateString(context['label'], 'label', MAX_LABEL_LENGTH);
  for (const field of [
    'domains',
    'recommendedTests',
    'requiredConfigurations',
  ] as const) {
    validateStringArray(context[field], field, MAX_TOKEN_LENGTH);
  }
  validateStringArray(context['relatedPaths'], 'relatedPaths', MAX_PATH_LENGTH);
  if (
    context['relatedPaths'].some((path) => !isSafeRepositoryRelativePath(path))
  ) {
    throw new Error('repositoryContext.relatedPaths contains an unsafe path');
  }
  validateStringArray(
    context['requiredAgents'],
    'requiredAgents',
    MAX_TOKEN_LENGTH,
    SAFE_TOKEN,
  );
  if (
    context['requiredAgents'].some((role) => !isRepositoryContextRoleId(role))
  ) {
    throw new Error(
      'repositoryContext.requiredAgents contains an unsupported role',
    );
  }
  for (const field of ['unverifiedDimensions', 'verificationNotes'] as const) {
    validateStringArray(context[field], field, MAX_NOTE_LENGTH);
  }

  return context as unknown as RepositoryContext;
}

export function repositoryContextOf(
  plan: RepositoryContextPlan,
): RepositoryContext | null {
  if (plan.repositoryContext === undefined) return null;
  return validateRepositoryContext(plan.repositoryContext);
}
