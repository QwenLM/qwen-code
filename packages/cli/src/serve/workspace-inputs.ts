/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';
import { isWithinRoot } from '../config/path-comparison.js';

export class DuplicateWorkspaceInputError extends Error {
  constructor(workspace: string) {
    super(
      `Duplicate --workspace value resolves to ${JSON.stringify(workspace)}. ` +
        'Pass distinct --workspace values.',
    );
    this.name = 'DuplicateWorkspaceInputError';
  }
}

export class NestedWorkspaceInputError extends Error {
  constructor(parent: string, child: string) {
    super(
      `Nested --workspace values are not supported yet: ` +
        `${JSON.stringify(child)} is inside ${JSON.stringify(parent)}. ` +
        'Pass non-nested --workspace values.',
    );
    this.name = 'NestedWorkspaceInputError';
  }
}

export class MultipleWorkspaceInputError extends Error {
  constructor() {
    super(
      'Multiple --workspace values are not supported by this single-workspace caller. ' +
        'Pass one --workspace.',
    );
    this.name = 'MultipleWorkspaceInputError';
  }
}

export class MissingWorkspaceInputError extends Error {
  constructor() {
    super('--workspace requires a value.');
    this.name = 'MissingWorkspaceInputError';
  }
}

function normalizeWorkspaceInputs(workspace: unknown): string[] {
  if (Array.isArray(workspace)) {
    if (workspace.length === 0) {
      throw new MissingWorkspaceInputError();
    }
    return workspace.map((value) => String(value));
  }
  if (workspace === undefined) return [process.cwd()];
  return [String(workspace)];
}

function isNestedWorkspace(parent: string, child: string): boolean {
  return parent !== child && isWithinRoot(child, parent);
}

function rejectDuplicateOrNestedWorkspaceInputs(
  workspaces: readonly string[],
): void {
  if (workspaces.length <= 1) return;

  let canonicalWorkspaces: string[];
  try {
    canonicalWorkspaces = workspaces.map((workspace) =>
      canonicalizeWorkspace(workspace),
    );
  } catch {
    return;
  }
  const seen = new Set<string>();
  for (const workspace of canonicalWorkspaces) {
    if (seen.has(workspace)) {
      throw new DuplicateWorkspaceInputError(workspace);
    }
    seen.add(workspace);
  }

  for (let i = 0; i < canonicalWorkspaces.length; i++) {
    for (let j = i + 1; j < canonicalWorkspaces.length; j++) {
      const first = canonicalWorkspaces[i]!;
      const second = canonicalWorkspaces[j]!;
      if (isNestedWorkspace(first, second)) {
        throw new NestedWorkspaceInputError(first, second);
      }
      if (isNestedWorkspace(second, first)) {
        throw new NestedWorkspaceInputError(second, first);
      }
    }
  }
}

export function resolveWorkspaceInputs(workspace: unknown): string[] {
  const workspaces = normalizeWorkspaceInputs(workspace);
  rejectDuplicateOrNestedWorkspaceInputs(workspaces);
  return workspaces;
}

export function resolveSingleWorkspaceInput(workspace: unknown): string {
  const workspaces = resolveWorkspaceInputs(workspace);
  if (workspaces.length > 1) {
    throw new MultipleWorkspaceInputError();
  }
  return workspaces[0]!;
}
