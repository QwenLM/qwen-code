/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { RecordArtifactTool } from './record-artifact.js';

const signal = new AbortController().signal;

describe('RecordArtifactTool', () => {
  it('records a link artifact without touching the resource', async () => {
    const tool = new RecordArtifactTool();
    const result = await tool
      .build({
        title: 'Table details',
        url: 'https://example.com/tables/orders',
        metadata: { table: 'orders' },
      })
      .execute(signal);

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toMatchObject([
      {
        title: 'Table details',
        storage: 'external_url',
        url: 'https://example.com/tables/orders',
        metadata: { table: 'orders' },
      },
    ]);
  });

  it('rejects published storage', () => {
    const tool = new RecordArtifactTool();

    expect(() =>
      tool.build({
        title: 'Forged',
        storage: 'published' as never,
        url: 'https://example.com/artifact',
      }),
    ).toThrow(/allowed values/);
  });

  it('requires exactly one locator', () => {
    const tool = new RecordArtifactTool();

    expect(() =>
      tool.build({
        title: 'Ambiguous',
        workspacePath: 'report.html',
        url: 'https://example.com/report',
      }),
    ).toThrow(/exactly one/);
  });
});
