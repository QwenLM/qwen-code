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

  it('records workspace and managed artifacts with inferred storage', async () => {
    const tool = new RecordArtifactTool();

    await expect(
      tool
        .build({
          title: 'Workspace report',
          workspacePath: 'reports/summary.html',
        })
        .execute(signal),
    ).resolves.toMatchObject({
      artifacts: [
        {
          title: 'Workspace report',
          storage: 'workspace',
          workspacePath: 'reports/summary.html',
        },
      ],
    });

    await expect(
      tool
        .build({
          title: 'Managed preview',
          managedId: 'ext-123',
        })
        .execute(signal),
    ).resolves.toMatchObject({
      artifacts: [
        {
          title: 'Managed preview',
          storage: 'managed',
          managedId: 'ext-123',
        },
      ],
    });
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

  it('rejects workspace paths that escape the workspace', () => {
    const tool = new RecordArtifactTool();

    for (const workspacePath of [
      '../secret.txt',
      '..\\secret.txt',
      '..\\..\\secret.txt',
      'reports\\..\\..\\secret.txt',
      'reports/..\\..\\secret.txt',
      'C:\\tmp\\report.html',
      'C:/tmp/report.html',
      'C:tmp\\report.html',
      '\\\\server\\share\\report.html',
      '\\tmp\\report.html',
    ]) {
      expect(() =>
        tool.build({
          title: 'Escape',
          workspacePath,
        }),
      ).toThrow(/workspacePath/);
    }
  });

  it('accepts safe workspace-relative artifact paths', async () => {
    const tool = new RecordArtifactTool();

    await expect(
      tool
        .build({
          title: 'Safe report',
          workspacePath: 'reports/summary.html',
        })
        .execute(signal),
    ).resolves.toMatchObject({
      artifacts: [{ workspacePath: 'reports/summary.html' }],
    });

    await expect(
      tool
        .build({
          title: 'Windows-style relative report',
          workspacePath: 'reports\\summary.html',
        })
        .execute(signal),
    ).resolves.toMatchObject({
      artifacts: [{ workspacePath: 'reports\\summary.html' }],
    });
  });

  it('rejects unsafe urls before reporting success', () => {
    const tool = new RecordArtifactTool();

    expect(() =>
      tool.build({
        title: 'Credentials',
        url: 'https://user:pass@example.com/resource',
      }),
    ).toThrow(/credentials/);

    expect(() =>
      tool.build({
        title: 'FTP',
        url: 'ftp://example.com/resource',
      }),
    ).toThrow(/http or https/);
  });

  it('rejects path-like managed ids before reporting success', () => {
    const tool = new RecordArtifactTool();

    for (const managedId of ['../secret', 'folder/item', 'folder\\item']) {
      expect(() =>
        tool.build({
          title: 'Managed path',
          managedId,
        }),
      ).toThrow(/opaque managed resource id/);
    }
  });

  it('rejects storage values that do not match the locator', () => {
    const tool = new RecordArtifactTool();

    expect(() =>
      tool.build({
        title: 'Workspace mismatch',
        storage: 'external_url',
        workspacePath: 'report.html',
      }),
    ).toThrow(/storage.*workspace/);
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

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        tool.build({
          title: 'Non-finite metadata',
          url: 'https://example.com/resource',
          metadata: { value },
        }),
      ).toThrow(/metadata/);
    }
  });

  it('rejects invalid artifact sizes before reporting success', () => {
    const tool = new RecordArtifactTool();

    for (const sizeBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        tool.build({
          title: 'Sized artifact',
          url: 'https://example.com/resource',
          sizeBytes,
        }),
      ).toThrow(/sizeBytes/);
    }
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
        title: 'SVG data url',
        description: 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'HTML mime',
        mimeType: 'text/html<script>',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'Workspace payload',
        workspacePath: '<img src=x onerror=alert(1)>.html',
      }),
    ).toThrow(/unsafe markup/);

    expect(() =>
      tool.build({
        title: 'Managed payload',
        managedId: '<script>alert(1)</script>',
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

  it('allows benign words ending with on before equals signs', () => {
    const tool = new RecordArtifactTool();

    expect(() =>
      tool.build({
        title: 'conversation=value',
        description: 'configuration=value',
        url: 'https://example.com/resource',
      }),
    ).not.toThrow();
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
        title: 'safe\u2028evil',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/control characters/);

    expect(() =>
      tool.build({
        title: 'safe\u2066evil',
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

  it('accepts line whitespace in descriptions but not titles', async () => {
    const tool = new RecordArtifactTool();

    await expect(
      tool
        .build({
          title: 'Multiline report',
          description: 'Line one\nLine two\tindented\r\nLine three',
          url: 'https://example.com/resource',
        })
        .execute(signal),
    ).resolves.toMatchObject({
      artifacts: [
        {
          description: 'Line one\nLine two\tindented\r\nLine three',
        },
      ],
    });

    expect(() =>
      tool.build({
        title: 'Bad\nTitle',
        url: 'https://example.com/resource',
      }),
    ).toThrow(/control characters/);
  });
});
