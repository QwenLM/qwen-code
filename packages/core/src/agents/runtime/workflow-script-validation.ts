/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parse } from 'acorn';
import type { Node } from 'acorn';
import { simple } from 'acorn-walk';

/**
 * A script that compiles but uses syntax a workflow cannot run, or that the
 * check could not read. Raised before the body executes, so callers can refuse
 * the script without the hint for ordinary syntax errors.
 */
export class WorkflowUnsupportedSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowUnsupportedSyntaxError';
  }
}

/**
 * Refuse a wrapped workflow body that contains a dynamic `import()` anywhere
 * in its syntax tree. V8 only fails such a call when it is reached, which is
 * after any earlier agent() calls have already been dispatched, so the check
 * runs on the parsed tree instead of waiting for execution.
 *
 * `wrappedSource` must be the exact text V8 compiled: the wrapper adds one
 * line ahead of the author's first line, which is taken off the reported
 * line number. A parse or walk failure is thrown, never waved through.
 */
export function assertNoDynamicImport(wrappedSource: string): void {
  let first: Node | undefined;
  try {
    const ast = parse(wrappedSource, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      locations: true,
    });
    simple(ast, {
      ImportExpression(node) {
        if (!first || node.start < first.start) first = node;
      },
    });
  } catch (error) {
    const err = error as { message?: unknown; loc?: { line: number } };
    const message = String(err.message).replace(/ \(\d+:\d+\)$/, '');
    const line = err.loc ? `line ${err.loc.line - 1}: ` : '';
    throw new WorkflowUnsupportedSyntaxError(
      `${line}the script could not be checked for unsupported syntax: ${message}`,
    );
  }
  if (!first) return;
  throw new WorkflowUnsupportedSyntaxError(
    `line ${first.loc!.start.line - 1}: dynamic import() is not supported in ` +
      'workflow scripts, so the script was refused before it ran. A workflow ' +
      'cannot load modules; do file, network, or package work inside an ' +
      'agent() call and use the result it returns.',
  );
}
