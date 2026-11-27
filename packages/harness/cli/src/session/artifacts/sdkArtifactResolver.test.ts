/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseResolveSessionArtifactsResponse } from './sdkArtifactResolver.js';

describe('parseResolveSessionArtifactsResponse', () => {
  it('maps the public camelCase callback result to the Worker wire shape', () => {
    expect(
      parseResolveSessionArtifactsResponse({
        artifacts: [
          {
            path: '/workspace/out/report.md',
            displayPath: 'out/report.md',
            name: 'report.md',
            group: { key: 'outputs', name: 'Outputs' },
            relativePath: 'report.md',
            size: 12,
            mime: 'text/markdown',
            mtime: 123,
            kind: 'changed',
            additions: 3,
            deletions: 1,
            isNew: false,
          },
        ],
      }),
    ).toEqual([
      {
        path: '/workspace/out/report.md',
        display_path: 'out/report.md',
        name: 'report.md',
        group: { key: 'outputs', name: 'Outputs' },
        relative_path: 'report.md',
        size: 12,
        mime: 'text/markdown',
        mtime: 123,
        kind: 'changed',
        additions: 3,
        deletions: 1,
        is_new: false,
      },
    ]);
  });

  it('keeps an empty array as an authoritative clearing snapshot', () => {
    expect(
      parseResolveSessionArtifactsResponse({ artifacts: [] }),
    ).toEqual([]);
  });

  it('rejects relative paths and incomplete changed metadata', () => {
    expect(() =>
      parseResolveSessionArtifactsResponse({
        artifacts: [
          {
            path: 'report.md',
            displayPath: 'report.md',
            name: 'report.md',
            kind: 'presented',
          },
        ],
      }),
    ).toThrow(/absolute/);
    expect(() =>
      parseResolveSessionArtifactsResponse({
        artifacts: [
          {
            path: '/workspace/report.md',
            displayPath: 'report.md',
            name: 'report.md',
            kind: 'changed',
            additions: 1,
            deletions: 0,
          },
        ],
      }),
    ).toThrow(/isNew/);
  });
});
