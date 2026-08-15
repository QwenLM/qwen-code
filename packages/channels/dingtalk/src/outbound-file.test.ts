import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findFileMarkers,
  readValidatedFile,
  replaceFileMarkers,
  safeFileName,
  sanitizeStreamingFileMarkers,
  stripPartialFileMarker,
  uploadDingTalkFile,
} from './outbound-file.js';

const testDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('outbound file markers', () => {
  it('finds markers outside fenced and inline code', () => {
    const text = [
      'before',
      '[FILE: /tmp/report.pdf]',
      '```text',
      '[FILE: /tmp/fenced.pdf]',
      '```',
      '`[FILE: /tmp/inline.pdf]`',
      'after',
    ].join('\n');

    const markers = findFileMarkers(text);

    expect(markers).toEqual([
      expect.objectContaining({ path: '/tmp/report.pdf' }),
    ]);
    expect(replaceFileMarkers(text, markers, ['[File: report.pdf]'])).toBe(
      [
        'before',
        '[File: report.pdf]',
        '```text',
        '[FILE: /tmp/fenced.pdf]',
        '```',
        '`[FILE: /tmp/inline.pdf]`',
        'after',
      ].join('\n'),
    );
  });

  it('uses parsed markdown code regions to classify markers', () => {
    expect(
      findFileMarkers('Example:\n\n \t[FILE: /workspace/code.txt]\n'),
    ).toEqual([]);
    expect(
      findFileMarkers('Run `echo [FILE: /workspace/live.txt] to send').map(
        ({ path }) => path,
      ),
    ).toEqual(['/workspace/live.txt']);
    expect(
      findFileMarkers(
        '```text [FILE: /workspace/fence-info.txt]\ncontent\n```',
      ),
    ).toEqual([]);
    expect(
      findFileMarkers(
        '`\u{e000}QWEN_MEDIA_MARKER_0\u{e001}`\n[FILE: /workspace/live.txt]',
      ).map(({ path }) => path),
    ).toEqual(['/workspace/live.txt']);
  });

  it('hides complete and partial visible file paths while streaming', () => {
    expect(
      sanitizeStreamingFileMarkers(
        'before [FILE: /Users/ben/private/report.pdf] after',
      ),
    ).toBe('before  after');
    expect(
      sanitizeStreamingFileMarkers('before [FILE: /Users/ben/private/report'),
    ).toBe('before ');
    expect(stripPartialFileMarker('before [F')).toBe('before ');
    expect(stripPartialFileMarker('array[')).toBe('array[');
  });

  it('scrubs file marker paths inside code', () => {
    const text = [
      '`[FILE: /Users/ben/inline.pdf]`',
      '```text',
      '[FILE: /Users/ben/fenced.pdf]',
      '```',
    ].join('\n');

    expect(sanitizeStreamingFileMarkers(text)).toBe(
      ['``', '```text', '', '```'].join('\n'),
    );
  });

  it('sanitizes nested markers to a fixed point', () => {
    for (const text of [
      'A [FILE: /Users/ben/secret [FILE: x]] B',
      '[FILE:[FILE: /a.pdf] /b.pdf]',
      '[FILE: /hid[FILE: /a] den /x]',
    ]) {
      const sanitized = sanitizeStreamingFileMarkers(text);
      expect(findFileMarkers(sanitized)).toEqual([]);
      expect(sanitized).not.toMatch(/\[FILE:/iu);
    }
  });
});

describe('readValidatedFile', () => {
  it('sanitizes control characters and brackets in display names', () => {
    expect(safeFileName('/tmp/report\n[private].txt')).toBe(
      'report_private_.txt',
    );
    expect(safeFileName('/tmp/invoice\u202efdp.exe')).toBe('invoice_fdp.exe');
  });

  it('reads a regular file and derives safe DingTalk metadata', () => {
    const workspace = makeTempDir('dingtalk-file-workspace-');
    const filePath = join(workspace, '周报 final.PDF');
    const data = Buffer.from('report');
    writeFileSync(filePath, data);

    expect(
      readValidatedFile(filePath, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toMatchObject({
      data,
      fileName: '周报 final.PDF',
      fileType: 'pdf',
      mimeType: 'application/octet-stream',
    });
  });

  it('uses the generic file type for a name without an extension', () => {
    const workspace = makeTempDir('dingtalk-file-workspace-');
    const filePath = join(workspace, 'LICENSE');
    writeFileSync(filePath, 'license');

    expect(
      readValidatedFile(filePath, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toMatchObject({
      fileName: 'LICENSE',
      fileType: 'file',
      mimeType: 'application/octet-stream',
    });
  });

  it('allows files in the system temporary directory', () => {
    const workspace = makeTempDir('dingtalk-file-workspace-');
    const temporary = makeTempDir('dingtalk-file-temporary-');
    const filePath = join(temporary, 'report.txt');
    writeFileSync(filePath, 'report');

    expect(
      readValidatedFile(filePath, { workspaceDir: workspace }),
    ).toMatchObject({
      fileName: 'report.txt',
      data: Buffer.from('report'),
    });
  });

  it('rejects relative paths, empty files, and directories', () => {
    const workspace = makeTempDir('dingtalk-file-workspace-');
    const emptyPath = join(workspace, 'empty.txt');
    const directoryPath = join(workspace, 'directory.txt');
    writeFileSync(emptyPath, '');
    mkdirSync(directoryPath);

    expect(() =>
      readValidatedFile('relative.txt', {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toThrow('File path must be absolute');
    expect(() =>
      readValidatedFile(emptyPath, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toThrow('File is empty');
    expect(() =>
      readValidatedFile(directoryPath, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toThrow('Not a regular file');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects named pipes without waiting for a writer',
    () => {
      const workspace = makeTempDir('dingtalk-file-workspace-');
      const pipePath = join(workspace, 'report.pipe');
      execFileSync('mkfifo', [pipePath]);

      expect(() =>
        readValidatedFile(pipePath, {
          workspaceDir: workspace,
          temporaryDir: workspace,
        }),
      ).toThrow('Not a regular file');
    },
  );

  it('rejects a symlink that escapes the allowed directories', () => {
    const workspace = makeTempDir('dingtalk-file-workspace-');
    const outside = makeTempDir('dingtalk-file-outside-');
    const outsideFile = join(outside, 'outside.txt');
    const linkedFile = join(workspace, 'linked.txt');
    writeFileSync(outsideFile, 'private');
    symlinkSync(outsideFile, linkedFile);

    expect(() =>
      readValidatedFile(linkedFile, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toThrow('outside allowed directories');
  });

  it('does not expose an unavailable allowed directory in the error', () => {
    const workspace = makeTempDir('dingtalk-file-workspace-');
    const filePath = join(workspace, 'report.txt');
    const missingRoot = join(workspace, 'missing-root');
    writeFileSync(filePath, 'report');

    let message = '';
    try {
      readValidatedFile(filePath, {
        workspaceDir: missingRoot,
        temporaryDir: missingRoot,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('File allowed directory unavailable');
    expect(message).not.toContain(missingRoot);
  });

  it('rejects files larger than the upload limit before reading them', () => {
    const workspace = makeTempDir('dingtalk-file-workspace-');
    const filePath = join(workspace, 'large.bin');
    writeFileSync(filePath, 'x');
    truncateSync(filePath, 20 * 1024 * 1024 + 1);

    expect(() =>
      readValidatedFile(filePath, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toThrow('File too large');
  });
});

describe('uploadDingTalkFile', () => {
  it('uploads a file with type=file and preserves the MediaID', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ errcode: 0, media_id: '@lAL-file-media-id' }),
          { status: 200 },
        ),
      );

    await expect(
      uploadDingTalkFile(
        {
          data: Buffer.from('report'),
          fileName: 'report.pdf',
          fileType: 'pdf',
          mimeType: 'application/octet-stream',
        },
        'access-token',
      ),
    ).resolves.toBe('@lAL-file-media-id');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/media/upload?');
    expect(String(url)).toContain('type=file');
    expect(init?.method).toBe('POST');
    const media = (init?.body as FormData).get('media');
    expect(media).toBeInstanceOf(Blob);
    expect((media as File).name).toBe('report.pdf');
  });
});
