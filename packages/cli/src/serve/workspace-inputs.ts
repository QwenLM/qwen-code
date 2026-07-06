/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { canonicalizeWorkspace } from '@qwen-code/acp-bridge/workspacePaths';

export class DuplicateWorkspaceInputError extends Error {
  constructor(workspace: string) {
    super(
      `Duplicate --workspace value resolves to ${JSON.stringify(workspace)}. ` +
        'Multi-workspace serve is not enabled; pass one --workspace.',
    );
    this.name = 'DuplicateWorkspaceInputError';
  }
}

export class NestedWorkspaceInputError extends Error {
  constructor(parent: string, child: string) {
    super(
      `Nested --workspace values are not supported yet: ` +
        `${JSON.stringify(child)} is inside ${JSON.stringify(parent)}. ` +
        'Multi-workspace serve is not enabled; pass one --workspace.',
    );
    this.name = 'NestedWorkspaceInputError';
  }
}

export class MultipleWorkspaceInputError extends Error {
  constructor() {
    super(
      'Multiple --workspace values are not supported yet. ' +
        'Multi-workspace serve is not enabled; pass one --workspace.',
    );
    this.name = 'MultipleWorkspaceInputError';
  }
}

function normalizeWorkspaceInputs(workspace: unknown): string[] {
  if (Array.isArray(workspace)) {
    if (workspace.length === 0) return [process.cwd()];
    return workspace.map((value) => String(value));
  }
  if (workspace === undefined) return [process.cwd()];
  return [String(workspace)];
}

function isNestedWorkspace(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

function rejectUnsupportedMultiWorkspaceInputs(
  workspaces: readonly string[],
): void {
  if (workspaces.length <= 1) return;

  let canonicalWorkspaces: string[];
  try {
    canonicalWorkspaces = workspaces.map((workspace) =>
      canonicalizeWorkspace(workspace),
    );
  } catch {
    throw new MultipleWorkspaceInputError();
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

  throw new MultipleWorkspaceInputError();
}

export function resolveSingleWorkspaceInput(workspace: unknown): string {
  const workspaces = normalizeWorkspaceInputs(workspace);
  rejectUnsupportedMultiWorkspaceInputs(workspaces);
  return workspaces[0]!;
}
