import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findFileMarkers,
  readValidatedFile,
  replaceFileMarkers,
  safeFileName,
  sanitizeFileMarkersToFixedPoint,
  sanitizeMediaMarkersToStable,
  sanitizeStreamingFileMarkers,
  stripPartialFileMarker,
  stripPartialFileMarkerBeforeBake,
  stripPartialMediaMarkersBeforeBake,
  uploadDingTalkFile,
} from './outbound-file.js';
import { findImageMarkers } from './outbound-image.js';

// R7-2: the swap-injection point. A directory component replaced between the
// containment check and the open is invisible to every check that merely
// re-resolves the path; the test swaps the tree the moment `openSync` runs,
// which is inside that window. All other calls pass through untouched.
const openSyncWindow = vi.hoisted(() => ({
  swap: undefined as (() => void) | undefined,
}));
// R22-25: the EARLIER swap-injection point — a directory component replaced
// between the containment check and the pre-open `statSync` is invisible to
// every path-side comparison after it; the test swaps the tree the moment
// the first `statSync` runs, which is inside that window.
const statSyncWindow = vi.hoisted(() => ({
  swap: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const swap = openSyncWindow.swap;
      openSyncWindow.swap = undefined;
      swap?.();
      return actual.openSync(...args);
    }) as typeof actual.openSync,
    statSync: ((...args: Parameters<typeof actual.statSync>) => {
      const swap = statSyncWindow.swap;
      statSyncWindow.swap = undefined;
      swap?.();
      return actual.statSync(...args);
    }) as typeof actual.statSync,
  };
});

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

  it('hides complete and partial visible file paths while streaming', () => {
    expect(
      sanitizeStreamingFileMarkers(
        'before [FILE: /Users/ben/private/report.pdf] after',
      ),
    ).toBe('before  after');
    expect(
      sanitizeStreamingFileMarkers('before [FILE: /Users/ben/private/report'),
    ).toBe('before ');
    // R3-9: a bare name prefix (`[F`) is prose, not residue.
    expect(stripPartialFileMarker('before [F')).toBe('before [F');
    expect(stripPartialFileMarker('array[')).toBe('array[');
  });

  it('preserves file-like text inside code', () => {
    const text = [
      '`[FILE: /Users/ben/inline.pdf]`',
      '```text',
      '[FILE: /Users/ben/fenced.pdf]',
      '```',
    ].join('\n');

    expect(sanitizeStreamingFileMarkers(text)).toBe(text);
  });
});

describe('readValidatedFile', () => {
  it('sanitizes control characters and brackets in display names', () => {
    expect(safeFileName('/tmp/report\n[private].txt')).toBe(
      'report_private_.txt',
    );
    expect(safeFileName('/tmp/invoice\u202efdp.exe')).toBe('invoice_fdp.exe');
  });

  it('strips the zero-width format characters the explicit list omitted', () => {
    // U+200B/U+200D/U+FEFF are `\p{Cf}` too, and hide an extension just as well
    // as the bidi overrides that were enumerated by hand.
    expect(safeFileName('/tmp/report\u200b\u200d\ufeff.pdf')).toBe(
      'report_.pdf',
    );
  });

  it('never returns a lone surrogate from the length cap', () => {
    // `slice` counts UTF-16 code units, so a cut between the halves of an
    // astral character leaves an unpaired surrogate that cannot encode to UTF-8.
    const name = `${'a'.repeat(254)}${'\u{1F600}'}.png`;
    const safe = safeFileName(`/tmp/${name}`);
    expect(safe).toHaveLength(254);
    expect(Buffer.from(safe, 'utf8').toString('utf8')).toBe(safe);
  });

  it('accepts a name that merely begins with two dots', () => {
    // The containment check used `startsWith('..')`, which also rejects
    // legitimate names \u2014 only a whole `..` SEGMENT means an escape.
    const workspace = makeTempDir('dingtalk-file-workspace-');
    const filePath = join(workspace, '..config.txt');
    writeFileSync(filePath, 'settings');

    expect(
      readValidatedFile(filePath, { workspaceDir: workspace }),
    ).toMatchObject({ fileName: '..config.txt' });
  });

  it('splices are re-scanned so a removal cannot mint a new marker', () => {
    // Removal is textual, so deleting the inner marker joins its surroundings
    // into a marker that was never in the model's output.
    expect(
      sanitizeFileMarkersToFixedPoint('[FI[FILE: /tmp/a.txt]LE: /etc/passwd]'),
    ).not.toContain('/etc/passwd');
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

  it('rejects a directory component swapped before the open', () => {
    // R7-2: O_NOFOLLOW only refuses a swapped FINAL component — the kernel
    // follows an intermediate directory swapped to a symlink. Both the open
    // and a post-open re-resolution of the path then agree with each other,
    // so only the pre-open identity compared against the descriptor sees it.
    const root = makeTempDir('dingtalk-toctou-');
    const workspaceDir = join(root, 'workspace');
    const insideDir = join(workspaceDir, 'inside');
    const outsideDir = join(root, 'outside');
    mkdirSync(insideDir, { recursive: true });
    mkdirSync(outsideDir);
    writeFileSync(join(insideDir, 'report.txt'), 'inside-content');
    writeFileSync(join(outsideDir, 'report.txt'), 'SECRET-CONTENT');
    openSyncWindow.swap = () => {
      renameSync(insideDir, join(root, 'inside-moved'));
      symlinkSync(outsideDir, insideDir);
    };

    expect(() =>
      readValidatedFile(join(insideDir, 'report.txt'), { workspaceDir }),
    ).toThrow('path changed during validation');
  });

  it.runIf(process.platform === 'linux')(
    'rejects a directory component swapped before the pre-open stat',
    () => {
      // R22-25: a NON-FINAL component swapped between the containment
      // check and the pre-open stat is invisible to every path-side
      // comparison — the open and both stats resolve through the swapped
      // tree and agree. Only the descriptor itself, re-resolved through
      // /proc/self/fd and containment-checked, sees the escape. The
      // outside tree lives OUTSIDE os.tmpdir() — a target under the temp
      // directory is contained by construction and would not trip the
      // check this pins.
      const root = makeTempDir('dingtalk-toctou-stat-');
      const workspaceDir = join(root, 'workspace');
      const insideDir = join(workspaceDir, 'inside');
      const outsideDir = join(
        process.cwd(),
        `.dingtalk-toctou-outside-${Date.now()}`,
        'outside',
      );
      testDirs.push(dirname(outsideDir));
      mkdirSync(insideDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(insideDir, 'report.txt'), 'inside-content');
      writeFileSync(join(outsideDir, 'report.txt'), 'SECRET-CONTENT');
      statSyncWindow.swap = () => {
        renameSync(insideDir, join(root, 'inside-moved'));
        symlinkSync(outsideDir, insideDir);
      };

      expect(() =>
        readValidatedFile(join(insideDir, 'report.txt'), { workspaceDir }),
      ).toThrow('outside allowed directories');
    },
  );

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

describe('sanitizeFileMarkersToFixedPoint depth', () => {
  // R1-1: each pass unwinds one level of self-similar nesting, so the old
  // `pass < 8` cap returned text with a LIVE marker at depth >= 9 — which both
  // display consumers then rendered with the absolute path.
  it.each([8, 9, 24])('reaches a fixed point at nesting depth %s', (depth) => {
    const text =
      '[FI'.repeat(depth) +
      '[FILE: /etc/passwd]' +
      'LE: /etc/passwd]'.repeat(depth);
    const sanitized = sanitizeFileMarkersToFixedPoint(text);
    expect(sanitized).not.toContain('[FILE:');
    expect(sanitized).not.toContain('/etc/passwd');
    // A real fixed point: one more pass changes nothing.
    expect(sanitizeFileMarkersToFixedPoint(sanitized)).toBe(sanitized);
  });

  // R3-11: self-similar nesting unwinds one level per pass, so an unbounded
  // loop pays a full re-scan per level — measured at seconds of synchronous
  // CPU at CONTENT_LIMIT, re-paid on every streaming card flush. The sweep is
  // budgeted now and fails CLOSED when the budget is exhausted: the residue
  // is cut at the first FILE-shaped opening of each line, so the adversarial
  // depth loses its marker-shaped tail, never its no-leak guarantee. The
  // pre-budget loop took ~16 s on this input; vitest's own timeout is the
  // mutation check — restoring the unbounded loop fails it.
  it('bounds the sweep on adversarial nesting without leaking', () => {
    const depth = 1052;
    let nested = '[FILE: /x.pdf]';
    for (let i = 0; i < depth; i++) nested = `[FIL${nested}E: /p${i}.pdf]`;
    const text = nested.slice(0, 20007);

    // The pass budget caps the pass COUNT; the per-pass strip walk must also
    // stay cheap, or eight passes over a per-bracket line copy still block
    // the event loop for hundreds of ms at CONTENT_LIMIT (the round-7 probe
    // measured ~170 ms here). The index-based sweep lands an order of
    // magnitude under that.
    // R14-2: assert CPU time, not wall time — the wall-clock budget failed
    // intermittently under parallel full-suite load on shared CI hardware.
    // The anchor must also clear hardware variance: solo runs of the capped
    // sweep measured up to ~99 ms on slower machines, so the tight 80 ms
    // budget flaked on its own. 800 ms stays an order of magnitude under
    // the regression cost — the unbounded loop burns seconds of CPU and
    // trips both this budget and vitest's timeout.
    const startedCpu = process.cpuUsage();
    const sanitized = sanitizeFileMarkersToFixedPoint(text);
    const elapsedCpu = process.cpuUsage(startedCpu);
    expect((elapsedCpu.user + elapsedCpu.system) / 1000).toBeLessThan(800);

    expect(sanitized).not.toContain('[FILE:');
    expect(sanitized).not.toContain('/x.pdf');
    expect(sanitized).not.toMatch(/\/p\d+\.pdf/u);
    // The budget unwinds eight levels; the sweep then cuts the line at the
    // innermost FILE-shaped opening, leaving the prose-prefix wrappers.
    expect(sanitized).toBe('[FIL'.repeat(depth - 8));
    expect(sanitizeFileMarkersToFixedPoint(sanitized)).toBe(sanitized);
  });
});

describe('sanitizeMediaMarkersToStable exhaustion', () => {
  // R8-3: the budget-exhaustion return handed back text whose LAST transform
  // was the image pass — whose removals splice the surroundings into a fresh
  // complete `[FILE: …]` marker no file pass ever saw (the inner fixed point
  // fails closed on its own exhaustion; the outer did not). The exhaustion
  // path must fail closed the same way.
  it('runs a final file sweep after the image pass exhausts the budget', () => {
    let input = '[FIL';
    for (let i = 0; i < 8; i++) input += `[IMAGE: /w${i}.png]`;
    input += 'E: /pf9.pdf]';
    // Stand-in for the real image pass's splice: one wrapper removed per
    // invocation, so the joint loop spends its whole budget unwinding and
    // exits with the image pass having just exposed the complete marker.
    const imagePass = (text: string): string => {
      for (let i = 0; i < 8; i++) {
        const wrapper = `[IMAGE: /w${i}.png]`;
        const at = text.indexOf(wrapper);
        if (at !== -1) {
          return text.slice(0, at) + text.slice(at + wrapper.length);
        }
      }
      return text;
    };

    const sanitized = sanitizeMediaMarkersToStable(input, imagePass);

    expect(findFileMarkers(sanitized)).toHaveLength(0);
    expect(sanitized).not.toContain('/pf9.pdf');
  });
});

describe('stripPartialFileMarkerBeforeBake (R16-5)', () => {
  // The residue sweep extends an ill-formed `[FILE:` opening to END OF
  // LINE; run after images bake it deletes an already-uploaded image's
  // baked markdown. Stripping before the bake must keep the R9-3
  // confinement: residue shares its line with a deliverable marker only
  // ever inside its own gap.
  it('confines the strip to the gaps between deliverable markers', () => {
    expect(stripPartialFileMarkerBeforeBake('[FILE: /a [FILE: /b.pdf]')).toBe(
      '[FILE: /b.pdf]',
    );
    expect(stripPartialFileMarkerBeforeBake('[FILE: /b.pdf] [FILE: /a')).toBe(
      '[FILE: /b.pdf] ',
    );
  });

  it('strips a residue span carrying an image marker whole', () => {
    expect(
      stripPartialFileMarkerBeforeBake(
        'Here is the chart: [FILE: /ws/notes.txt [IMAGE: /ws/chart.png] done',
      ),
    ).toBe('Here is the chart: ');
  });

  it('leaves clean text and complete markers untouched', () => {
    const clean = 'intro [FILE: /ws/a.pdf] mid [FILE: /ws/b.pdf] outro';
    expect(stripPartialFileMarkerBeforeBake(clean)).toBe(clean);
  });
});

describe('stripPartialMediaMarkersBeforeBake (R19-x / R6-3)', () => {
  // R19-x (R6-3 closure): a removal splices its surroundings across the
  // deleted span. A single pass minted a deliverable marker the model never
  // emitted and handed it to the uploader; the joint strip iterates to a
  // fixed point with both expected lists locked at the entry text.
  it('does not bake a FILE marker fabricated by its own removal', () => {
    const out = stripPartialMediaMarkersBeforeBake(
      '[FIL[FILE:\n/x]E: /ws/secret.pdf]',
    );
    expect(findFileMarkers(out)).toHaveLength(0);
    expect(out).not.toContain('/ws/secret.pdf');
  });

  it('does not bake an IMAGE marker fabricated by a FILE removal', () => {
    // The FILE residue strip splices `[IMAG` + `E: /ws/chart.png]` into a
    // complete IMAGE marker; reconciling against the entry list drops it.
    const out = stripPartialMediaMarkersBeforeBake(
      '[IMAG[FILE:\n/x]E: /ws/chart.png]',
    );
    expect(findImageMarkers(out)).toHaveLength(0);
    expect(out).not.toContain('/ws/chart.png');
  });

  it('keeps the model markers while reconciling splice artifacts', () => {
    const out = stripPartialMediaMarkersBeforeBake(
      'keep [FILE: /ws/real.pdf] and [FIL[FILE:\n/x]E: /ws/secret.pdf]',
    );
    expect(findFileMarkers(out).map((m) => m.path)).toEqual(['/ws/real.pdf']);
    expect(out).not.toContain('/ws/secret.pdf');
  });

  // The R16-5 IMAGE mirror: an ill-formed `[IMAGE: …` sharing a line with a
  // deliverable marker is stripped BEFORE the bake instead of eating the
  // baked receipt afterwards.
  it('strips IMAGE residue confined to the gaps around deliverable markers', () => {
    const out = stripPartialMediaMarkersBeforeBake(
      'x [IMAGE: /leak/img-a [IMAGE: /workspace/b.png] y',
    );
    expect(out).not.toContain('/leak/img-a');
    expect(findImageMarkers(out).map((m) => m.path)).toEqual([
      '/workspace/b.png',
    ]);
  });

  // A nested outer marker delivers its inner one; the outer's bracket-less
  // tail fragment must not survive the gap the inner marker leaves behind.
  it('drops the unbalanced tail after a delivered nested marker', () => {
    const out = stripPartialMediaMarkersBeforeBake(
      '[FILE: [FILE: /ws/inner.pdf] /etc/shadow]',
    );
    expect(findFileMarkers(out).map((m) => m.path)).toEqual(['/ws/inner.pdf']);
    expect(out).not.toContain('/etc/shadow');
  });

  it('leaves clean mixed text and complete markers untouched', () => {
    const clean = 'intro [FILE: /ws/a.pdf] mid [IMAGE: /ws/b.png] outro';
    expect(stripPartialMediaMarkersBeforeBake(clean)).toBe(clean);
  });

  // R22-5: entry-locked alignment used to advance only on a positional hit.
  // An entry span-removed by the other kind's fail-closed residue sweep never
  // got consumed, so every later legitimate same-kind marker failed alignment
  // and was destroyed — rewritten to `[Image pending]` instead of delivered.
  // Alignment is subsequence-tolerant now: a span-removed entry desyncs only
  // itself.
  it('keeps a well-formed marker after a same-kind entry was span-removed', () => {
    const out = stripPartialMediaMarkersBeforeBake(
      '[FILE: [IMAGE: /ws/a.png] junk\n[IMAGE: /ws/b.png]',
    );
    expect(findImageMarkers(out).map((m) => m.path)).toEqual(['/ws/b.png']);
    // The marker inside the FILE residue span keeps its documented
    // fail-closed removal.
    expect(out).not.toContain('/ws/a.png');

    const mirror = stripPartialMediaMarkersBeforeBake(
      '[IMAGE: [FILE: /ws/a.txt] junk\n[FILE: /ws/b.txt]',
    );
    expect(findFileMarkers(mirror).map((m) => m.path)).toContain('/ws/b.txt');
  });

  // R23-1: a gap sanitizer used to bound its residue only by its OWN kind's
  // aligned markers, so an ill-formed opening whose same-line residue extent
  // reached a kept marker of the OTHER kind deleted it — violating the
  // invariant that a gap sanitizer never touches a marker the alignment
  // kept. Residue now stops at the cross-kind kept marker.
  it('never lets a gap sanitizer eat a cross-kind kept marker', () => {
    const out = stripPartialMediaMarkersBeforeBake(
      '[IMAGE: /a [b]] [FILE: /ws/c.pdf]',
    );
    expect(findFileMarkers(out).map((m) => m.path)).toEqual(['/ws/c.pdf']);

    const mirror = stripPartialMediaMarkersBeforeBake(
      '[FILE: /a [b]] [IMAGE: /ws/c.png]',
    );
    expect(findImageMarkers(mirror).map((m) => m.path)).toEqual(['/ws/c.png']);
  });
});
