// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  getArtifactImageMimeType,
  getArtifactTypeLabel,
  normalizePath,
  readWorkspaceFileAsBlob,
  withArtifactPreviewCsp,
} from './artifactUtils';

describe('artifactUtils', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
