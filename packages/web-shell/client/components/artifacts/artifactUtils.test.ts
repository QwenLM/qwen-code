// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  artifactKindLabel,
  downloadWorkspaceFile,
  getArtifactFreshnessKey,
  getArtifactImageMimeType,
  getArtifactTypeLabel,
  getReviewDownloadMimeType,
  isDownloadOnlyWorkspaceArtifact,
  isOfficeDocumentPath,
  normalizePath,
  readWorkspaceFileAsBlob,
  withArtifactPreviewCsp,
} from './artifactUtils';

describe('artifactUtils', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds a preview freshness key from status, updatedAt, and content hash', () => {
    expect(
      getArtifactFreshnessKey({
        status: 'changed',
        updatedAt: '2026-08-24T00:00:00.000Z',
        metadata: { 'qwen.workspace.sha256': 'abc' },
      }),
    ).toBe('changed:2026-08-24T00:00:00.000Z:abc');
    expect(
      getArtifactFreshnessKey({
        status: 'available',
        updatedAt: '2026-08-24T00:00:01.000Z',
      }),
    ).toBe('available:2026-08-24T00:00:01.000Z:');
  });

  it('labels office documents from path or kind', () => {
    expect(artifactKindLabel('file', 'data/table.xlsx')).toBe('Excel');
    expect(artifactKindLabel('document', 'brief.docx')).toBe('Word');
    expect(artifactKindLabel('document', 'deck.pptx')).toBe('PowerPoint');
    expect(artifactKindLabel('document')).toBe('Document');
    expect(isOfficeDocumentPath('reports/a.XLSX')).toBe(true);
    expect(
      isDownloadOnlyWorkspaceArtifact({
        kind: 'file',
        workspacePath: 'a.xlsx',
      }),
    ).toBe(true);
    expect(
      isDownloadOnlyWorkspaceArtifact({
        kind: 'pdf',
        workspacePath: 'paper.pdf',
      }),
    ).toBe(true);
    expect(
      isDownloadOnlyWorkspaceArtifact({
        kind: 'image',
        workspacePath: 'photo.png',
      }),
    ).toBe(false);
    expect(
      isDownloadOnlyWorkspaceArtifact({
        kind: 'file',
        workspacePath: 'notes.md',
      }),
    ).toBe(false);
  });

  it.each([
    { workspacePath: 'notes.md' },
    { workspacePath: 'notes.markdown' },
    { workspacePath: 'notes', mimeType: 'text/markdown' },
    { workspacePath: 'notes', mimeType: 'text/markdown; charset=utf-8' },
    { workspacePath: 'report.html' },
    { workspacePath: 'report.htm' },
    { workspacePath: 'report', mimeType: 'text/html' },
    { workspacePath: 'report', mimeType: 'text/html; charset=utf-8' },
  ])('previews document-classified text artifacts', (artifact) => {
    expect(
      isDownloadOnlyWorkspaceArtifact({ kind: 'document', ...artifact }),
    ).toBe(false);
  });

  it.each([
    { workspacePath: 'photo.png' },
    { workspacePath: 'photo', mimeType: 'image/png' },
  ])('previews document-classified raster image artifacts', (artifact) => {
    expect(
      isDownloadOnlyWorkspaceArtifact({ kind: 'document', ...artifact }),
    ).toBe(false);
  });

  it.each([
    ['document', 'graphic.svg', 'image/svg+xml'],
    ['image', 'graphic.svg', 'image/svg+xml'],
    ['file', 'graphic.svg', 'image/svg+xml'],
    ['image', 'graphic.svg', 'image/png'],
    ['image', 'graphic.svg', 'text/html'],
    ['file', 'graphic', 'image/svg+xml'],
  ])('keeps SVG artifacts download-only', (kind, workspacePath, mimeType) => {
    expect(
      isDownloadOnlyWorkspaceArtifact({ kind, workspacePath, mimeType }),
    ).toBe(true);
  });

  it.each([
    ['report.docx', 'text/html'],
    ['report.xlsx', 'image/png'],
    ['report.pdf', 'text/markdown'],
    ['clip.mp4', 'image/png'],
  ])(
    'does not let previewable MIME types override download-only paths',
    (workspacePath, mimeType) => {
      expect(isDownloadOnlyWorkspaceArtifact({ workspacePath, mimeType })).toBe(
        true,
      );
    },
  );

  it('rejects directory stats before reading bytes', async () => {
    const readFileBytes = vi.fn();
    const statFile = vi.fn().mockResolvedValue({
      sizeBytes: 0,
      modifiedMs: 1,
      type: 'directory',
    });

    await expect(
      readWorkspaceFileAsBlob(
        readFileBytes,
        'exports',
        'application/octet-stream',
        {
          statFile,
        },
      ),
    ).rejects.toThrow('Directories cannot be opened');
    expect(readFileBytes).not.toHaveBeenCalled();
  });

  it('resolves parent path segments', () => {
    expect(normalizePath('src/foo/../bar.ts')).toBe('src/bar.ts');
    expect(normalizePath('/workspace/app/../app/src/./main.ts')).toBe(
      '/workspace/app/src/main.ts',
    );
    expect(normalizePath('../outside/file.ts')).toBe('../outside/file.ts');
  });

  it('prefers the artifact type from metadata', () => {
    const artifact = {
      kind: 'other',
      metadata: { artifactType: 'Diagram' },
    } as DaemonSessionArtifact;

    expect(getArtifactTypeLabel(artifact)).toBe('Diagram');
  });

  it('falls back to the artifact kind label without metadata', () => {
    const artifact = { kind: 'other' } as DaemonSessionArtifact;

    expect(getArtifactTypeLabel(artifact)).toBe('other');
  });

  it('detects safe raster image artifacts from MIME type or path', () => {
    expect(
      getArtifactImageMimeType({
        mimeType: 'image/webp; charset=binary',
      } as DaemonSessionArtifact),
    ).toBe('image/webp');
    expect(
      getArtifactImageMimeType({
        workspacePath: 'images/photo.JPG',
      } as DaemonSessionArtifact),
    ).toBe('image/jpeg');
    expect(
      getArtifactImageMimeType({
        mimeType: 'image/svg+xml',
        workspacePath: 'diagram.jpg',
      } as DaemonSessionArtifact),
    ).toBeUndefined();
    expect(
      getArtifactImageMimeType({
        mimeType: 'image/jpg',
      } as DaemonSessionArtifact),
    ).toBe('image/jpeg');
  });

  it('maps review downloads to HTML or Markdown by extension', () => {
    expect(getReviewDownloadMimeType('report.html')).toBe('text/html');
    expect(getReviewDownloadMimeType('report.htm')).toBe('text/html');
    expect(getReviewDownloadMimeType('REPORT.HTML')).toBe('text/html');
    expect(getReviewDownloadMimeType('notes.md')).toBe('text/markdown');
    expect(getReviewDownloadMimeType('notes.markdown')).toBe('text/markdown');
  });

  it('stops at the file size even when byte windows stay truncated', async () => {
    const statFile = vi.fn().mockResolvedValue({
      sizeBytes: 5,
      modifiedMs: 1,
    });
    const readFileBytes = vi
      .fn()
      .mockResolvedValueOnce({
        contentBase64: btoa('ab'),
        offset: 0,
        returnedBytes: 2,
        sizeBytes: 5,
        truncated: true,
      })
      .mockResolvedValueOnce({
        contentBase64: btoa('cde'),
        offset: 2,
        returnedBytes: 3,
        sizeBytes: 5,
        truncated: true,
      });

    const blob = await readWorkspaceFileAsBlob(
      readFileBytes,
      'photo.jpg',
      'image/jpeg',
      { statFile },
    );

    expect(blob).toMatchObject({ size: 5, type: 'image/jpeg' });
    expect(statFile).toHaveBeenCalledTimes(2);
    expect(readFileBytes).toHaveBeenNthCalledWith(1, 'photo.jpg', {
      offset: 0,
      maxBytes: 100 * 1024,
    });
    expect(readFileBytes).toHaveBeenNthCalledWith(2, 'photo.jpg', {
      offset: 2,
      maxBytes: 100 * 1024,
    });
  });

  it('stops reading image chunks after cancellation', async () => {
    let cancelled = false;
    const statFile = vi.fn().mockResolvedValue({
      sizeBytes: 5,
      modifiedMs: 1,
    });
    const readFileBytes = vi.fn().mockImplementation(async () => {
      cancelled = true;
      return {
        contentBase64: btoa('ab'),
        offset: 0,
        returnedBytes: 2,
        sizeBytes: 5,
      };
    });

    await expect(
      readWorkspaceFileAsBlob(readFileBytes, 'photo.jpg', 'image/jpeg', {
        statFile,
        isCancelled: () => cancelled,
      }),
    ).rejects.toThrow('cancelled');
    expect(readFileBytes).toHaveBeenCalledTimes(1);
  });

  it('rejects images larger than the configured preview limit', async () => {
    const statFile = vi.fn().mockResolvedValue({
      sizeBytes: 5,
      modifiedMs: 1,
    });
    const readFileBytes = vi.fn().mockResolvedValue({
      contentBase64: btoa('ab'),
      offset: 0,
      returnedBytes: 2,
      sizeBytes: 5,
    });

    await expect(
      readWorkspaceFileAsBlob(readFileBytes, 'photo.jpg', 'image/jpeg', {
        statFile,
        maxBytes: 4,
      }),
    ).rejects.toThrow('too large');
    expect(readFileBytes).not.toHaveBeenCalled();
  });

  it('rejects downloads larger than the default Blob limit', async () => {
    const readFileBytes = vi.fn();
    const stat = vi.fn().mockResolvedValue({
      sizeBytes: 100 * 1024 * 1024 + 1,
      modifiedMs: 1,
    });

    await expect(
      downloadWorkspaceFile({ readFileBytes, stat }, 'video.mp4'),
    ).rejects.toThrow('too large');
    expect(readFileBytes).not.toHaveBeenCalled();
  });

  it('rejects chunks read across different file versions', async () => {
    const statFile = vi
      .fn()
      .mockResolvedValueOnce({ sizeBytes: 2, modifiedMs: 1 })
      .mockResolvedValueOnce({ sizeBytes: 2, modifiedMs: 2 });
    const readFileBytes = vi.fn().mockResolvedValue({
      contentBase64: btoa('ab'),
      offset: 0,
      returnedBytes: 2,
      sizeBytes: 2,
    });

    await expect(
      readWorkspaceFileAsBlob(readFileBytes, 'photo.jpg', 'image/jpeg', {
        statFile,
      }),
    ).rejects.toThrow('changed while loading');
    expect(statFile).toHaveBeenCalledTimes(2);
  });

  it('injects preview CSP and strips unsafe metadata', () => {
    const output = withArtifactPreviewCsp(`
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; report-uri https://example.com/report">
          <meta http-equiv="refresh" content="0; url=https://example.com">
        </head>
        <body>
          <noscript><meta http-equiv="refresh" content="0; url=https://example.com"></noscript>
          <p>Hello</p>
        </body>
      </html>
    `);

    expect(output).toContain('Content-Security-Policy');
    expect(output).toContain("default-src 'none'");
    expect(output).toContain("script-src 'unsafe-inline'");
    expect(output).not.toContain('report-uri');
    expect(output).not.toMatch(/http-equiv=["']?refresh/i);
    expect(output).not.toMatch(/<noscript\b/i);
    expect(output).toContain('<p>Hello</p>');
  });

  it('uses the same sanitization when DOMParser is unavailable', () => {
    vi.stubGlobal('DOMParser', undefined);

    const output = withArtifactPreviewCsp(`
      <meta http-equiv="Content-Security-Policy" content="report-uri https://example.com/report">
      <noscript><meta http-equiv="refresh" content="0; url=https://example.com"></noscript>
      <meta http-equiv="refresh" content="0; url=https://example.com">
      <p>Hello</p>
    `);

    expect(output).toContain('Content-Security-Policy');
    expect(output).toContain("default-src 'none'");
    expect(output).toContain("script-src 'unsafe-inline'");
    expect(output).not.toContain('report-uri');
    expect(output).not.toMatch(/http-equiv=["']?refresh/i);
    expect(output).not.toMatch(/<noscript\b/i);
    expect(output).toContain('<p>Hello</p>');
  });
});
