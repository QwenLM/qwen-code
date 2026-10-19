/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isWorkflowAncestorTrustResponse,
  parseWorkflowAncestorTrustRequest,
  WORKFLOW_ANCESTOR_TRUST_MAX_ANCESTORS,
  WORKFLOW_ANCESTOR_TRUST_MAX_PATH_BYTES,
  WORKFLOW_ANCESTOR_TRUST_MAX_PATH_CHARS,
} from './workflow-ancestor-trust.js';

const target = path.resolve(path.sep, 'repo', 'app');
const request = {
  v: 1,
  sessionId: 'session',
  canonicalTargetDir: target,
  ancestorDirs: [path.dirname(target)],
};

describe('workflow ancestor trust wire', () => {
  it('copies a valid request and accepts an empty ancestor batch', () => {
    const parsed = parseWorkflowAncestorTrustRequest(request);
    expect(parsed).toEqual(request);
    expect(parsed?.ancestorDirs).not.toBe(request.ancestorDirs);
    expect(
      parseWorkflowAncestorTrustRequest({ ...request, ancestorDirs: [] }),
    ).toEqual({ ...request, ancestorDirs: [] });
  });

  it.each([
    null,
    [],
    {},
    { ...request, v: 2 },
    { ...request, sessionId: '' },
    { ...request, sessionId: '  ' },
    { ...request, sessionId: 'session\0other' },
    { ...request, canonicalTargetDir: 'relative/path' },
    { ...request, canonicalTargetDir: `${target}\0` },
    { ...request, ancestorDirs: 'not-an-array' },
    { ...request, ancestorDirs: [undefined] },
    { ...request, ancestorDirs: new Array(1) },
    { ...request, ancestorDirs: ['relative/path'] },
    { ...request, ancestorDirs: [`${target}\0`] },
  ])('rejects malformed request %#', (invalid) => {
    expect(parseWorkflowAncestorTrustRequest(invalid)).toBeUndefined();
  });

  it('rejects inherited sparse elements', () => {
    const ancestors = new Array<string>(1);
    Object.setPrototypeOf(ancestors, { 0: path.dirname(target) });
    expect(
      parseWorkflowAncestorTrustRequest({
        ...request,
        ancestorDirs: ancestors,
      }),
    ).toBeUndefined();
  });

  it('enforces the ancestor count without truncating a batch', () => {
    const ancestorDirs = Array<string>(
      WORKFLOW_ANCESTOR_TRUST_MAX_ANCESTORS,
    ).fill(path.dirname(target));
    expect(
      parseWorkflowAncestorTrustRequest({ ...request, ancestorDirs }),
    ).toBeDefined();
    ancestorDirs.push(path.dirname(target));
    expect(
      parseWorkflowAncestorTrustRequest({ ...request, ancestorDirs }),
    ).toBeUndefined();
  });

  it('enforces the per-path character bound', () => {
    const ancestor =
      path.sep + 'a'.repeat(WORKFLOW_ANCESTOR_TRUST_MAX_PATH_CHARS);
    expect(
      parseWorkflowAncestorTrustRequest({
        ...request,
        canonicalTargetDir: ancestor,
      }),
    ).toBeUndefined();
    expect(
      parseWorkflowAncestorTrustRequest({
        ...request,
        ancestorDirs: [ancestor],
      }),
    ).toBeUndefined();
  });

  it('measures the aggregate bound in UTF-8 bytes including the target', () => {
    const ancestor = path.sep + '界'.repeat(10_000);
    const count = Math.floor(
      WORKFLOW_ANCESTOR_TRUST_MAX_PATH_BYTES /
        Buffer.byteLength(ancestor, 'utf8'),
    );
    const ancestorDirs = Array<string>(count).fill(ancestor);
    expect(
      parseWorkflowAncestorTrustRequest({ ...request, ancestorDirs }),
    ).toBeDefined();
    ancestorDirs.push(ancestor);
    expect(
      parseWorkflowAncestorTrustRequest({ ...request, ancestorDirs }),
    ).toBeUndefined();
    expect(
      parseWorkflowAncestorTrustRequest({
        ...request,
        canonicalTargetDir: ancestor,
        ancestorDirs: ancestorDirs.slice(0, count),
      }),
    ).toBeUndefined();
  });

  it.each([
    null,
    { v: 2, trusted: [true] },
    { v: 1, trusted: true },
    { v: 1, trusted: [] },
    { v: 1, trusted: [true, false] },
    { v: 1, trusted: [1] },
    { v: 1, trusted: ['true'] },
    { v: 1, trusted: new Array(1) },
  ])('rejects malformed response %#', (response) => {
    expect(isWorkflowAncestorTrustResponse(response, 1)).toBe(false);
  });

  it('accepts exact dense boolean responses', () => {
    expect(isWorkflowAncestorTrustResponse({ v: 1, trusted: [false] }, 1)).toBe(
      true,
    );
    expect(isWorkflowAncestorTrustResponse({ v: 1, trusted: [] }, 0)).toBe(
      true,
    );
  });
});
