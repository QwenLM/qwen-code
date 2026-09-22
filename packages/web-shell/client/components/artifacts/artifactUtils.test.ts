// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import {
  artifactKindLabel,
  artifactPreviewDocument,
  loadArtifactPreviewDocument,
  downloadWorkspaceFile,
  getArtifactFreshnessKey,
  getArtifactImageMimeType,
  getArtifactTypeLabel,
  getReviewDownloadMimeType,
  isDownloadOnlyWorkspaceArtifact,
  isOfficeDocumentPath,
  normalizePath,
  readWorkspaceFileAsBlob,
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

  it('prefers recognized file types before the artifact kind', () => {
    expect(artifactKindLabel('file', 'todolist.md')).toBe('Markdown');
    expect(artifactKindLabel('file', 'preview.html')).toBe('HTML');
    expect(artifactKindLabel('file', 'photo.png')).toBe('Image');
    expect(artifactKindLabel('link', 'report.pdf?download=1')).toBe('PDF');
    expect(artifactKindLabel('file', 'unknown.custom')).toBe('file');
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
      maxBytes: 256 * 1024,
    });
    expect(readFileBytes).toHaveBeenNthCalledWith(2, 'photo.jpg', {
      offset: 2,
      maxBytes: 256 * 1024,
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

  it('downloads without host link interception and retains the URL until the browser can consume it', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn().mockReturnValue('blob:workspace-file');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const hostClick = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener('click', hostClick);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.isConnected).toBe(true);
        expect(this.download).toBe('result.txt');
        expect(this.href).toBe('blob:workspace-file');
        expect(
          this.dispatchEvent(
            new Event('click', { bubbles: true, cancelable: true }),
          ),
        ).toBe(true);
      });
    try {
      await downloadWorkspaceFile(
        {
          stat: vi.fn().mockResolvedValue({ sizeBytes: 2, modifiedMs: 1 }),
          readFileBytes: vi.fn().mockResolvedValue({
            contentBase64: btoa('ab'),
            offset: 0,
            returnedBytes: 2,
            sizeBytes: 2,
          }),
        },
        'reports/result.txt',
        'text/plain',
      );
      expect(createObjectURL).toHaveBeenCalledWith(
        expect.objectContaining({ size: 2, type: 'text/plain' }),
      );
      expect(click).toHaveBeenCalledOnce();
      expect(document.querySelector('a[download="result.txt"]')).toBeNull();
      expect(hostClick).not.toHaveBeenCalled();
      expect(revokeObjectURL).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:workspace-file');
    } finally {
      window.removeEventListener('click', hostClick);
      click.mockRestore();
      vi.useRealTimers();
    }
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

  it('keeps user HTML inside an opaque child with a restrictive parent policy', () => {
    const title = 'Page "quoted" <title>';
    const output = artifactPreviewDocument(
      '<p>Hello</p><script>let n=0</script>',
      title,
    );
    const parent = new DOMParser().parseFromString(output, 'text/html');
    const child = parent.querySelector('iframe')!;
    expect(parent.querySelector('script')).toBeNull();
    expect(parent.querySelector('meta')?.content).toContain("frame-src 'none'");
    expect(child.title).toBe(title);
    expect(child.getAttribute('sandbox')).toBe('allow-scripts');
    expect(child.srcdoc).toContain('<p>Hello</p><script>let n=0</script>');
    expect(child.srcdoc).toContain("default-src 'none'");
  });

  it('injects preview CSP and strips unsafe metadata', () => {
    const wrapped = artifactPreviewDocument(
      `
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
    `,
      'Preview',
    );
    const output = new DOMParser()
      .parseFromString(wrapped, 'text/html')
      .querySelector('iframe')!.srcdoc;

    expect(output).toContain('Content-Security-Policy');
    expect(output).toContain("default-src 'none'");
    expect(output).toContain("script-src 'unsafe-inline'");
    expect(output).not.toContain('report-uri');
    expect(output).not.toMatch(/http-equiv=["']?refresh/i);
    expect(output).not.toMatch(/<noscript\b/i);
    expect(output).toContain('<p>Hello</p>');
  });

  it('parses ordinary HTML only once without fetching resources', async () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await loadArtifactPreviewDocument(
        '<p>Hello</p>',
        'Preview',
        new AbortController().signal,
      );
      expect(parse).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('loads only exact export resources with SRI and embeds them in offline frames', async () => {
    vi.stubGlobal('__WEB_SHELL_VERSION__', '0.23.4');
    const base = 'https://unpkg.com/@qwen-code/qwen-code@0.23.4/';
    const integrity = `sha384-${'a'.repeat(64)}`;
    const html = `<script id="transcript-document" type="application/json">{}</script>
      <script id="transcript-renderer" integrity="${integrity}" crossorigin="anonymous" src="${base}export-transcript-document.js"></script>
      <link id="transcript-stylesheet" rel="stylesheet" integrity="${integrity}" href="${base}export-transcript-document.css">
      <script src="${base}export-transcript-document.js?probe=blocked"></script>`;
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response('verified bytes'));
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    const parent = new DOMParser().parseFromString(
      await loadArtifactPreviewDocument(html, 'Export', signal),
      'text/html',
    );
    const child = new DOMParser().parseFromString(
      parent.querySelector('iframe')!.srcdoc,
      'text/html',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const extension of ['js', 'css']) {
      expect(fetchMock).toHaveBeenCalledWith(
        `${base}export-transcript-document.${extension}`,
        {
          integrity,
          signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
        },
      );
    }
    for (const document of [parent, child]) {
      const policy = document.querySelector('meta')!.content;
      expect(policy).toContain("script-src 'unsafe-inline' data:;");
      expect(policy).toContain("style-src 'unsafe-inline' data:;");
      expect(policy).toContain("default-src 'none'");
      expect(policy).not.toContain('unpkg.com');
    }
    expect(
      child.querySelector('#transcript-renderer')?.getAttribute('src'),
    ).toBe(`data:text/javascript;base64,${btoa('verified bytes')}`);
    expect(
      child.querySelector('#transcript-stylesheet')?.getAttribute('href'),
    ).toBe(`data:text/css;base64,${btoa('verified bytes')}`);
    for (const { invalid, blockedExtension } of [
      { invalid: html.replace('0.23.4/', 'latest/'), blockedExtension: 'js' },
      {
        invalid: html.replace('0.23.4/', '0.23.4-secret-data/'),
        blockedExtension: 'js',
      },
      { invalid: html.replace('0.23.4/', '0.23.3/'), blockedExtension: 'js' },
      {
        invalid: html.replace('unpkg.com/', 'unpkg.com.evil.example/'),
        blockedExtension: 'js',
      },
      { invalid: html.replace('.js"', '.js?x=1"'), blockedExtension: 'js' },
      {
        invalid: html.replace(`integrity="${integrity}"`, ''),
        blockedExtension: 'js',
      },
      {
        invalid: html.replace('export-transcript-document.css', 'evil.css'),
        blockedExtension: 'css',
      },
      {
        invalid: html.replace(
          `rel="stylesheet" integrity="${integrity}"`,
          'rel="stylesheet"',
        ),
        blockedExtension: 'css',
      },
    ]) {
      fetchMock.mockClear();
      await expect(
        loadArtifactPreviewDocument(invalid, 'Export', signal),
      ).rejects.toThrow('Unsupported export preview resource');
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).endsWith(`.${blockedExtension}`),
        ),
      ).toBe(false);
    }
  });

  it('aborts the sibling asset fetch when one arm rejects', async () => {
    vi.stubGlobal('__WEB_SHELL_VERSION__', '0.23.4');
    const base = 'https://unpkg.com/@qwen-code/qwen-code@0.23.4/';
    const integrity = `sha384-${'a'.repeat(64)}`;
    const html = `<script id="transcript-document" type="application/json">{}</script>
      <script id="transcript-renderer" integrity="${integrity}" src="${base}export-transcript-document.js"></script>
      <link id="transcript-stylesheet" rel="stylesheet" integrity="${integrity}" href="${base}export-transcript-document.css">`;
    let cssSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (url: unknown, init?: RequestInit): Promise<Response> => {
        if (String(url).endsWith('.js')) {
          throw new TypeError('Integrity mismatch');
        }
        cssSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve, reject) => {
          cssSignal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
          setTimeout(() => resolve(new Response('css')), 10);
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      loadArtifactPreviewDocument(html, 'Export', new AbortController().signal),
    ).rejects.toThrow('Integrity mismatch');
    expect(cssSignal?.aborted).toBe(true);
  });

  it('does not render an export when its resource integrity check fails', async () => {
    vi.stubGlobal('__WEB_SHELL_VERSION__', '0.23.4');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Integrity mismatch')),
    );
    const html = `<script id="transcript-document" type="application/json">{}</script><script id="transcript-renderer" integrity="sha384-${'a'.repeat(64)}" src="https://unpkg.com/@qwen-code/qwen-code@0.23.4/export-transcript-document.js"></script>`;
    await expect(
      loadArtifactPreviewDocument(html, 'Export', new AbortController().signal),
    ).rejects.toThrow('Integrity mismatch');
  });

  it('uses the same sanitization when DOMParser is unavailable', () => {
    const parser = new DOMParser();
    vi.stubGlobal('DOMParser', undefined);

    const wrapped = artifactPreviewDocument(
      `
      <meta http-equiv="Content-Security-Policy" content="report-uri https://example.com/report">
      <noscript><meta http-equiv="refresh" content="0; url=https://example.com"></noscript>
      <meta http-equiv="refresh" content="0; url=https://example.com">
      <p>Hello</p>
    `,
      'Preview',
    );
    const output = parser
      .parseFromString(wrapped, 'text/html')
      .querySelector('iframe')!.srcdoc;

    expect(output).toContain('Content-Security-Policy');
    expect(output).toContain("default-src 'none'");
    expect(output).toContain("script-src 'unsafe-inline'");
    expect(output).not.toContain('report-uri');
    expect(output).not.toMatch(/http-equiv=["']?refresh/i);
    expect(output).not.toMatch(/<noscript\b/i);
    expect(output).toContain('<p>Hello</p>');
  });
});
