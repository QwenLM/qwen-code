/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { normalizeWorkflowSourceRef } from './workflow-source-ref.js';

describe('normalizeWorkflowSourceRef', () => {
  it('copies an external definition reference without interpreting its id as a path', () => {
    const source = {
      id: 'catalog/flow-1',
      revision: '7',
      digest: 'sha256:abc',
      title: 'Import data',
    };
    const normalized = normalizeWorkflowSourceRef(source);
    expect(normalized).toEqual(source);
    source.revision = '8';
    expect(normalized.revision).toBe('7');
  });

  it.each([
    null,
    [],
    'flow',
    {},
    { id: 'flow', revision: 1 },
    { id: '', revision: '1' },
    { id: ' flow', revision: '1' },
    { id: 'flow', revision: '1', title: '' },
    { id: 'flow', revision: '1', digest: 'x'.repeat(257) },
    { id: 'flow', revision: '1', title: 'x'.repeat(513) },
    { id: 'flow', revision: '1', permissions: ['*'] },
    { id: 'flow', revision: '1', title: 'a\nb' },
    { id: 'flow', revision: '1', title: 'a\u0085b' },
    { id: 'flow', revision: '1', title: 'a\u009bb' },
    { id: 'flow', revision: '1', title: 'a\u061cb' },
    { id: 'flow', revision: '1', title: 'a\u202eb' },
    { id: 'flow', revision: '1', title: 'a\u2066b' },
  ])('rejects malformed provenance %j', (source) => {
    expect(() => normalizeWorkflowSourceRef(source)).toThrow(/sourceRef/);
  });
});
