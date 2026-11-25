/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ZodError } from 'zod';

import { getErrorMessage } from '../../utils/errors.js';

/**
 * Flatten a ZodError into a single human-readable line. Repeated array issues
 * with the same parent and message are compacted into index ranges, for example
 * `skills[0-9]: Path must start with ./`.
 *
 * Plain string output, suitable for embedding in error messages,
 * diagnostics, and CLI status lines that must stay single-line.
 */
export function formatZodIssues(error: ZodError): string {
  type IssueGroup = {
    parent: string;
    message: string;
    indices: number[];
  };
  type OutputEntry = string | IssueGroup;

  const groups = new Map<
    string,
    IssueGroup
  >();
  const output: OutputEntry[] = [];

  for (const issue of error.issues) {
    const last = issue.path.at(-1);
    if (typeof last !== 'number') {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      output.push(`${path}: ${issue.message}`);
      continue;
    }

    const parent = issue.path.slice(0, -1).join('.') || '<root>';
    const key = `${parent}\0${issue.message}`;
    let group = groups.get(key);
    if (!group) {
      group = { parent, message: issue.message, indices: [] };
      groups.set(key, group);
      output.push(group);
    }
    group.indices.push(last);
  }

  return output
    .map((entry) => {
      if (typeof entry === 'string') return entry;

      const { parent, message, indices } = entry;
      const sorted = [...new Set(indices)].sort((a, b) => a - b);
      const ranges: string[] = [];
      for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i];
        let end = start;
        while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
          end = sorted[++i];
        }
        ranges.push(start === end ? String(start) : `${start}-${end}`);
      }
      return `${parent}[${ranges.join(',')}]: ${message}`;
    })
    .join('; ');
}

/**
 * Format any manifest read/parse/validate error for human display.
 *
 * - JSON syntax errors → underlying message (e.g. "Unexpected token } ...")
 * - Zod validation errors → `path: message; path: message`
 *
 * Use this whenever a manifest is read from disk and may fail at any
 * stage of the read → JSON.parse → schema.parse pipeline.
 */
export function formatManifestError(error: unknown): string {
  if (error instanceof ZodError) {
    return formatZodIssues(error);
  }
  return getErrorMessage(error);
}
