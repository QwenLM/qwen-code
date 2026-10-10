/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { isScalar, parseDocument, visit } from 'yaml';
import type { Config } from '../config/config.js';
import { SubagentError, SubagentErrorCode } from './types.js';
import type { SubagentConfig } from './types.js';

export function resolveAgentExecutionBackend(
  config: Config,
  definition?: SubagentConfig,
): 'container' | undefined {
  if (
    definition?.executionBackend !== undefined &&
    definition.executionBackend !== 'container'
  ) {
    throw new SubagentError(
      `Subagent "${definition.name}" has an invalid executionBackend declaration: expected "container". Refusing to run it locally.`,
      SubagentErrorCode.INVALID_CONFIG,
      definition.name,
    );
  }
  if (
    definition?.executionBackend === 'container' &&
    definition.level === 'project' &&
    !config.isTrustedFolder()
  ) {
    throw new SubagentError(
      `Cannot select container execution for subagent "${definition.name}" from an untrusted project.`,
      SubagentErrorCode.INVALID_CONFIG,
      definition.name,
    );
  }
  return config.getAgentExecutionBackend?.() ?? definition?.executionBackend;
}

/**
 * R12-5: a raw-key probe inside a block scalar (`description: |` or `>`)
 * is prose, not a declaration. Shared without changing the executor probe's
 * behavior: an AST walk failure must keep the match as a claim.
 */
export function probeMatchInsideBlockScalar(
  document: ReturnType<typeof parseDocument>,
  matchIndex: number,
): boolean {
  try {
    let inside = false;
    visit(document, (_key, node) => {
      if (
        isScalar(node) &&
        (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') &&
        node.range &&
        node.range[0] <= matchIndex &&
        matchIndex < node.range[1]
      ) {
        inside = true;
      }
    });
    return inside;
  } catch {
    // A failed walk must not drop a real claim; leave the match as a claim.
    return false;
  }
}

export function parseAgentExecutionBackend(
  frontmatterYaml: string,
  document = parseDocument(frontmatterYaml),
): 'container' | undefined {
  const present = document.has('executionBackend');
  const claimed =
    present ||
    [
      ...frontmatterYaml.matchAll(/^[ \t]*["']?executionBackend["']?[ \t]*:/gm),
    ].some((match) => !probeMatchInsideBlockScalar(document, match.index));
  if (!claimed) return undefined;

  let name: string | undefined;
  try {
    const value = document.get('name');
    if (typeof value === 'string') name = value;
  } catch {
    // An unresolved name cannot reserve another definition's name.
  }
  try {
    if (document.errors.length > 0) throw document.errors[0];
    if (!present) return undefined;
    const value = (document.toJS() as Record<string, unknown>)[
      'executionBackend'
    ];
    if (value !== 'container') throw new Error('expected "container"');
    return value;
  } catch (error) {
    throw new SubagentError(
      `Agent definition has an invalid executionBackend declaration: ${error instanceof Error ? error.message : String(error)}. Refusing to run it locally.`,
      SubagentErrorCode.INVALID_CONFIG,
      name,
    );
  }
}
