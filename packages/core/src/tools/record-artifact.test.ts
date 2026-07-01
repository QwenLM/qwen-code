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

  it('rejects workspace traversal and unsafe urls before reporting success', () => {
    const tool = new RecordArtifactTool();

    expect(() =>
      tool.build({
        title: 'Escape',
        workspacePath: '../secret.txt',
      }),
    ).toThrow(/workspacePath/);

    expect(() =>
      tool.build({
        title: 'Credentials',
        url: 'https://user:pass@example.com/resource',
      }),
    ).toThrow(/credentials/);
  });

  it('rejects artifact metadata that the daemon store would drop', () => {
    const tool = new RecordArtifactTool();

    expect(() =>
      tool.build({
        title: 'Huge metadata',
        url: 'https://example.com/resource',
        metadata: { value: 'x'.repeat(4096) },
      }),
    ).toThrow(/metadata/);
  });

  it('rejects unsafe display markup before reporting success', () => {
    const tool = new RecordArtifactTool();

    expect(() =>
      tool.build({
        title: '<script>alert(1)</script>',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'External style',
        description: '<style>body{display:none}</style>',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'Entity payload',
        description: '&#x3c;script&#x3e;',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'Script data url',
        description: 'data:text/javascript,alert(1)',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'Metadata key',
        url: 'https://example.com/resource',
        metadata: { '<script>': 'unsafe key' },
      }),
    ).toThrow(/metadata/);

    expect(() =>
      tool.build({
        title: 'Metadata value',
        url: 'https://example.com/resource',
        metadata: { preview: 'data:text/javascript,alert(1)' },
      }),
    ).toThrow(/metadata/);
  });

  it('rejects Unicode control characters before reporting success', () => {
    const tool = new RecordArtifactTool();

    expect(() =>
      tool.build({
        title: 'Hidden\u202eTitle',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/control characters/);

    expect(() =>
      tool.build({
        title: 'Metadata key',
        url: 'https://example.com/resource',
        metadata: { 'preview\u200b': 'hidden' },
      }),
    ).toThrow(/metadata/);
  });
});
