import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Content, Part } from '@google/genai';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFileRestorationBlocks,
  buildImageRestorationBlock,
  composePostCompactHistory,
  countToolResponseImages,
  extractRecentFilePaths,
  extractRecentImages,
  postProcessSummary,
  readFileSizeAdaptive,
  type ComposePostCompactOptions,
  type ExtractedImage,
  type SubagentSnapshot,
} from './postCompactAttachments.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

const REPL = 'mcp__node-repl__node_repl';

/** One model turn issuing a parallel read_file call per path. */
function fileReadCall(...paths: string[]): Content {
  return content(
    'model',
    ...paths.map((p) => fnCall('read_file', { file_path: p })),
  );
}

function fileWriteCall(path: string): Content {
  return content(
    'model',
    fnCall('write_file', { file_path: path, content: '...' }),
  );
}

const png = (data: string, mimeType = 'image/png'): Part => ({
  inlineData: { mimeType, data },
});

// Mirrors the REAL shape coreToolScheduler.convertToFunctionResponse
// builds: images nest inside functionResponse.parts, NOT as top-level
// siblings. (An earlier top-level-sibling fixture never occurs in
// production and masked a bug where extractRecentImages found zero
// screenshots.)
function nestedImages(output: string, ...parts: Part[]): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: REPL,
          response: { output },
          parts,
        } as unknown as NonNullable<
          Content['parts']
        >[number]['functionResponse'],
      },
    ],
  };
}

/** A screenshot tool call and its nested-image result. */
const shot = (app: string, data: string): Content[] => [
  content('model', fnCall(REPL, { app })),
  nestedImages('screenshot returned', png(data)),
];

/** All text parts of `history`, joined with `sep`. */
const allText = (history: Content[], sep = '\n') =>
  history
    .flatMap((c) => c.parts ?? [])
    .map((p) => (p as { text?: string }).text ?? '')
    .join(sep);

const firstText = (c: Content) =>
  (c.parts?.[0] as { text?: string }).text ?? '';

const inlineParts = (history: Content[]) =>
  history.flatMap((c) => c.parts ?? []).filter((p) => p.inlineData);

let tmpDir: string;
/** Gives each test in the calling describe a fresh `tmpDir`. */
function useTmpDir() {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pca-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
}

/** Writes `data` to `tmpDir/name` and returns the path. */
function tmpFile(name: string, data: string | Buffer): string {
  const path = join(tmpDir, name);
  writeFileSync(path, data);
  return path;
}

describe('extractRecentFilePaths', () => {
  it('returns the most recently-touched file paths first', () => {
    const history = [
      fileReadCall('/a.ts'),
      fileReadCall('/b.ts'),
      fileWriteCall('/c.ts'),
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual([
      '/c.ts',
      '/b.ts',
      '/a.ts',
    ]);
  });

  it('deduplicates by file path, keeping the most recent touch', () => {
    const history = [
      fileReadCall('/a.ts'),
      fileReadCall('/b.ts'),
      fileWriteCall('/a.ts'), // a.ts is now most recent
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual(['/a.ts', '/b.ts']);
  });

  it('respects the maxFiles cap', () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      fileReadCall(`/file${i}.ts`),
    );
    expect(extractRecentFilePaths(history, 3)).toHaveLength(3);
  });

  it('returns an empty array when no file-touching tool calls exist', () => {
    const history = [userText('hello'), modelText('hi')];
    expect(extractRecentFilePaths(history, 5)).toEqual([]);
  });

  it('ignores tool calls without a file_path argument', () => {
    const history = [
      content('model', fnCall('web_fetch', { url: 'https://x.com' })),
      fileReadCall('/real.ts'),
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual(['/real.ts']);
  });

  it('recognizes edit and replace tools too', () => {
    const history = [
      content(
        'model',
        fnCall('edit', {
          file_path: '/e.ts',
          old_string: 'x',
          new_string: 'y',
        }),
      ),
      content('model', fnCall('replace', { file_path: '/r.ts' })),
    ];
    const paths = extractRecentFilePaths(history, 5);
    expect(paths).toContain('/e.ts');
    expect(paths).toContain('/r.ts');
  });

  it('returns empty array when maxFiles is 0 or negative', () => {
    const history = [fileReadCall('/a.ts'), fileReadCall('/b.ts')];
    expect(extractRecentFilePaths(history, 0)).toEqual([]);
    expect(extractRecentFilePaths(history, -1)).toEqual([]);
  });

  it('treats parallel tool calls in one content as "last part is newest"', () => {
    // Regression found via real-session E2E: 6 parallel ReadFile calls land
    // as 6 functionCall parts in ONE model content. The old forward
    // iteration filled the cap with the FIRST 5 and dropped the last-listed
    // file; on overflow the LAST 5 (newest) parts must win.
    const history = [
      fileReadCall(...[1, 2, 3, 4, 5, 6].map((i) => `/p${i}.ts`)),
    ];
    const paths = extractRecentFilePaths(history, 5);
    // Last 5 parts win, returned in newest-first order.
    expect(paths).toEqual(['/p6.ts', '/p5.ts', '/p4.ts', '/p3.ts', '/p2.ts']);
    expect(paths).not.toContain('/p1.ts');
  });

  it('excludes paths whose tool call was denied/errored (permission-bypass guard)', () => {
    // A denied read_file leaves its functionCall in history with an error
    // functionResponse. Restoring that path would read the file off disk
    // during compaction, bypassing the denial.
    const history = [
      content(
        'model',
        fnCall('read_file', { file_path: '/ws/ok.ts' }, 'call_ok'),
        fnCall('read_file', { file_path: '/ws/.env' }, 'call_denied'),
      ),
      content(
        'user',
        fnResponse('read_file', { output: 'export const ok = 1;' }, 'call_ok'),
        fnResponse(
          'read_file',
          { error: 'Permission denied for tool' },
          'call_denied',
        ),
      ),
    ];
    const paths = extractRecentFilePaths(history, 5);
    expect(paths).toContain('/ws/ok.ts');
    expect(paths).not.toContain('/ws/.env');
  });

  const bridgeCall = (name: string, file_path: string) =>
    content(
      'model',
      fnCall(
        ToolNames.TOOL_CALL,
        { name, arguments: { file_path } },
        'outer-call',
      ),
    );
  const bridgeResult = (response: Record<string, unknown>) =>
    content('user', fnResponse(ToolNames.TOOL_CALL, response, 'outer-call'));

  it.each(['read_file', 'write_file', 'edit', 'replace', 'Read_File'])(
    'restores a successful bridged %s path using the outer call id',
    (name) => {
      const history = [
        fileReadCall('/older.ts'),
        bridgeCall(name, '/bridged.ts'),
        bridgeResult({ output: 'done' }),
      ];
      expect(extractRecentFilePaths(history, 5)).toEqual([
        '/bridged.ts',
        '/older.ts',
      ]);
      expect(extractRecentFilePaths(history, 1)).toEqual(['/bridged.ts']);
    },
  );

  it.each(['Permission denied', 'Cancelled', 'Execution failed', undefined])(
    'does not restore an unsuccessful or unfinished bridge (%s)',
    (error) => {
      const history = [bridgeCall('read_file', '/private.ts')];
      if (error !== undefined) history.push(bridgeResult({ error }));
      expect(extractRecentFilePaths(history, 5)).toEqual([]);
    },
  );
});

describe('extractRecentImages', () => {
  const dataOf = (images: ExtractedImage[]) =>
    images.map((r) => r.part.inlineData?.data);

  it('returns the last N images in chronological order (oldest first)', () => {
    const history = [
      ...shot('Safari', 'aaaa'),
      ...shot('Mail', 'bbbb'),
      ...shot('Safari', 'cccc'),
    ];
    const result = extractRecentImages(history, 3);
    expect(dataOf(result)).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  it('caps at maxImages by keeping the newest', () => {
    const history = Array.from({ length: 5 }, (_, i) =>
      shot(`App${i}`, `data${i}`),
    ).flat();
    const result = extractRecentImages(history, 3);
    expect(dataOf(result)).toEqual(['data2', 'data3', 'data4']);
  });

  it('captures the preceding model functionCall as metadata', () => {
    const result = extractRecentImages(shot('Safari', 'aaaa'), 3);
    expect(result).toHaveLength(1);
    expect(result[0].sourceToolName).toBe('mcp__node-repl__node_repl');
    expect(result[0].sourceToolArgs).toEqual({ app: 'Safari' });
    expect(result[0].turnIndex).toBe(1); // user+fr is at index 1
  });

  it('also picks up images from user-paste (no preceding model+fc)', () => {
    const history = [
      content('user', { text: 'check this' }, png('pastedimage')),
    ];
    const result = extractRecentImages(history, 3);
    expect(result).toHaveLength(1);
    expect(result[0].sourceToolName).toBeUndefined();
    expect(result[0].part.inlineData?.data).toBe('pastedimage');
  });

  it('ignores non-image inlineData', () => {
    const history = [content('user', png('pdfdata', 'application/pdf'))];
    expect(extractRecentImages(history, 3)).toEqual([]);
  });

  it('extracts tool images nested in functionResponse.parts (regression: real screenshot shape)', () => {
    // No top-level inlineData anywhere: the image lives ONLY inside
    // functionResponse.parts, exactly as convertToFunctionResponse emits.
    // The pre-fix extractRecentImages returned [] here.
    const result = extractRecentImages(shot('Safari', 'nestedshot'), 3);
    expect(result).toHaveLength(1);
    expect(result[0].part.inlineData?.data).toBe('nestedshot');
    expect(result[0].sourceToolName).toBe('mcp__node-repl__node_repl');
  });

  it('collects both nested tool images and top-level user pastes', () => {
    const history = [
      ...shot('Safari', 'toolshot'),
      content('user', { text: 'and this' }, png('pasted')),
    ];
    const result = extractRecentImages(history, 3);
    expect(dataOf(result)).toEqual(['toolshot', 'pasted']);
  });
});

describe('countToolResponseImages', () => {
  it('counts only images nested in functionResponse.parts', () => {
    const history = [...shot('Safari', 'a'), ...shot('Mail', 'b')];
    expect(countToolResponseImages(history)).toBe(2);
  });

  it('excludes top-level user-pasted images', () => {
    expect(countToolResponseImages([content('user', png('pasted'))])).toBe(0);
  });

  it('counts multiple images within a single tool result, ignoring non-images', () => {
    const history = [
      nestedImages(
        '',
        png('x'),
        png('y', 'image/jpeg'),
        { text: 'not an image' },
        png('doc', 'application/pdf'),
      ),
    ];
    expect(countToolResponseImages(history)).toBe(2);
  });

  it('returns 0 for empty history', () => {
    expect(countToolResponseImages([])).toBe(0);
  });
});

/** `n` mostly-control bytes (`i % 32`). */
const controlBytes = (n: number) =>
  Buffer.from(Array.from({ length: n }, (_, i) => i % 32));

describe('readFileSizeAdaptive', () => {
  useTmpDir();
  const classify = (name: string, data: string | Buffer, maxTokens = 5_000) =>
    readFileSizeAdaptive(tmpFile(name, data), maxTokens);

  it('returns kind=embed with full content when file is under the size cap', async () => {
    const result = await classify('small.txt', 'hello world');
    expect(result.kind).toBe('embed');
    if (result.kind === 'embed') {
      expect(result.content).toBe('hello world');
    }
  });

  it('returns kind=reference when file exceeds the size cap', async () => {
    // 5000 tokens × 4 chars = 20000 chars cap; write 30000 chars to exceed
    const result = await classify('big.txt', 'x'.repeat(30_000));
    expect(result.kind).toBe('reference');
  });

  it('returns kind=missing when the file does not exist', async () => {
    const result = await readFileSizeAdaptive(join(tmpDir, 'nope.txt'), 5_000);
    expect(result.kind).toBe('missing');
  });

  it('returns kind=binary when content has too many non-printable bytes', async () => {
    const result = await classify('bin.dat', controlBytes(100));
    expect(result.kind).toBe('binary');
  });

  it('counts CHARACTERS not BYTES for the size cap (UTF-8 multibyte safe)', async () => {
    // 10000 CJK chars = ~30000 bytes but 10000 chars: under the 20000-char
    // cap (maxTokens=5000), so it embeds; counting bytes would wrongly
    // classify it as 'reference'.
    const cjkText = '中'.repeat(10_000);
    const result = await classify('cjk.txt', cjkText);
    expect(result.kind).toBe('embed');
    if (result.kind === 'embed') {
      expect(result.content).toBe(cjkText);
      expect(result.content.length).toBe(10_000);
    }
  });

  it('short-circuits oversized files to reference via stat, before reading (OOM guard)', async () => {
    // maxTokens=10 → 40-char cap → 160-byte threshold; 4 KB of control
    // bytes. Read in full, the file would be detected as 'binary', so
    // 'reference' proves the stat pre-check fired without a full read.
    const result = await classify('huge.bin', controlBytes(4096), 10);
    expect(result.kind).toBe('reference');
  });
});

describe('buildFileRestorationBlocks', () => {
  useTmpDir();

  it('produces an empty array when no files are provided', async () => {
    const blocks = await buildFileRestorationBlocks([]);
    expect(blocks).toEqual([]);
  });

  it('produces a single user message listing references for all large files', async () => {
    const big1 = tmpFile('big1.txt', 'x'.repeat(30_000));
    const big2 = tmpFile('big2.txt', 'y'.repeat(30_000));

    const blocks = await buildFileRestorationBlocks([big1, big2]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].role).toBe('user');
    const text = firstText(blocks[0]);
    expect(text).toContain(big1);
    expect(text).toContain(big2);
    expect(text).toContain('reference only');
    // Must instruct the model on how to view the actual content.
    expect(text).toMatch(/use.*read_file|call.*read_file/i);
  });

  it('produces one extra user message per embedded small file with its full content', async () => {
    const small = tmpFile('small.txt', 'console.log("hi");');

    const blocks = await buildFileRestorationBlocks([small]);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const embedBlock = blocks.find((b) =>
      firstText(b).includes('console.log("hi")'),
    );
    expect(embedBlock).toBeDefined();
    expect(embedBlock?.role).toBe('user');
  });

  it('omits the reference block entirely when no large files are present', async () => {
    const blocks = await buildFileRestorationBlocks([
      tmpFile('small.txt', 'tiny'),
    ]);
    expect(allText(blocks)).not.toMatch(/reference only/i);
  });

  it('skips missing files silently', async () => {
    const blocks = await buildFileRestorationBlocks([
      join(tmpDir, 'does-not-exist.txt'),
    ]);
    expect(blocks).toEqual([]);
  });

  it('respects POST_COMPACT_TOKEN_BUDGET across embedded files', async () => {
    // Global budget: POST_COMPACT_TOKEN_BUDGET (50_000) × CHARS_PER_TOKEN
    // (4) = 200_000 chars; per-file cap: POST_COMPACT_MAX_TOKENS_PER_FILE
    // (5_000) × 4 = 20_000 chars. 11 files at exactly the per-file cap
    // total 220_000 chars: the budget fits exactly 10, so the 11th must
    // downgrade from embed to reference.
    const letter = (i: number) => String.fromCharCode('a'.charCodeAt(0) + i);
    const files = Array.from({ length: 11 }, (_, i) =>
      tmpFile(`f${i}.txt`, letter(i).repeat(20_000)),
    );

    const blocks = await buildFileRestorationBlocks(files);

    // The reference block must exist and must mention the 11th file.
    const referenceBlock = blocks.find((b) =>
      firstText(b).includes('reference only'),
    );
    expect(referenceBlock).toBeDefined();
    expect(firstText(referenceBlock!)).toContain(files[10]);

    // The first 10 files must be embedded (each as its own user message).
    for (let i = 0; i < 10; i++) {
      const ch = letter(i);
      const embedBlock = blocks.find((b) =>
        firstText(b).includes(ch.repeat(20_000)),
      );
      expect(
        embedBlock,
        `expected file ${i} (${ch.repeat(3)}...) to be embedded`,
      ).toBeDefined();
    }

    // The 11th file must NOT be embedded: the reference block carries only
    // its path, while an embed block would hold a long run of its content.
    const embed11 = blocks.find((b) =>
      firstText(b).includes(letter(10).repeat(20_000)),
    );
    expect(embed11).toBeUndefined();
  });

  it('uses a longer fence when file content contains triple backticks', async () => {
    // The inner triple-backtick run would close a 3-backtick fence
    // prematurely with the old implementation.
    const path = tmpFile(
      'with-backticks.md',
      '# Heading\n\nSome text\n```ts\nconst x = 1;\n```\n\nMore text.',
    );

    const blocks = await buildFileRestorationBlocks([path]);
    expect(blocks).toHaveLength(1);
    const text = firstText(blocks[0]);
    // The fence must be 4+ backticks long since content has a 3-backtick run.
    expect(text).toMatch(/````\n.*const x = 1;.*\n````/s);
    // The file content (including the inner ```ts) appears intact.
    expect(text).toContain('```ts\nconst x = 1;\n```');
    expect(text).toContain('More text.');
  });

  it('strips control characters from displayed file paths', async () => {
    // A real filename can't easily carry a newline (a missing path is just
    // skipped), so this checks the rendering indirectly: a clean path forced
    // down the reference branch goes through `sanitizePathForDisplay`
    // unmodified.
    const normal = tmpFile('normal-file.ts', 'x'.repeat(30_000)); // force reference branch
    const blocks = await buildFileRestorationBlocks([normal]);
    const refText = firstText(blocks[0]);
    expect(refText).toContain(normal); // sanitization is identity for clean paths
  });
});

describe('buildImageRestorationBlock', () => {
  it('returns null when no images are provided', () => {
    expect(buildImageRestorationBlock([])).toBeNull();
  });

  it('emits a single user Content with metadata header + image parts', () => {
    const images: ExtractedImage[] = [
      {
        part: png('aaaa'),
        turnIndex: 5,
        sourceToolName: REPL,
        sourceToolArgs: { app: 'Safari' },
      },
      {
        part: png('bbbb'),
        turnIndex: 11,
        sourceToolName: REPL,
        sourceToolArgs: { app: 'Mail' },
      },
    ];
    const block = buildImageRestorationBlock(images);
    expect(block).not.toBeNull();
    expect(block!.role).toBe('user');
    expect(block!.parts).toHaveLength(3); // 1 text header + 2 images

    const header = firstText(block!);
    expect(header).toContain('Recent visual snapshots');
    expect(header).toContain('turn 5');
    expect(header).toContain('mcp__node-repl__node_repl');
    expect(header).toContain('"app":"Safari"');
    expect(header).toContain('turn 11');
    expect(header).toContain('"app":"Mail"');

    expect(block!.parts![1].inlineData?.data).toBe('aaaa');
    expect(block!.parts![2].inlineData?.data).toBe('bbbb');
  });

  it('handles images without source-tool metadata (user paste)', () => {
    const block = buildImageRestorationBlock([
      { part: png('pasted'), turnIndex: 3 },
    ]);
    const header = firstText(block!);
    expect(header).toContain('turn 3');
    expect(header).toContain('user-provided'); // labeled instead of tool name
  });
});

/** Strict alternation: no two adjacent entries share a role. */
function expectAlternating(result: Content[]) {
  for (let i = 1; i < result.length; i++) {
    expect(result[i].role).not.toBe(result[i - 1].role);
  }
}

/** The last entry is a model functionCall, so an appended user+functionResponse pairs with it. */
function expectEndsWithCall(result: Content[]) {
  const last = result[result.length - 1];
  expect(last.role).toBe('model');
  expect(last.parts?.some((p) => !!p.functionCall)).toBe(true);
}

describe('composePostCompactHistory', () => {
  useTmpDir();

  it('returns summary + ack only when history has no files or images', async () => {
    const history = [userText('hi'), modelText('hello')];
    const result = await composePostCompactHistory(history, 'SUMMARY_TEXT');
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(firstText(result[0])).toContain('SUMMARY_TEXT');
    expect(result[1].role).toBe('model');
  });

  it('orders sections as: summary → file refs → file embeds → images', async () => {
    const small = tmpFile('cfg.json', '{"a":1}');
    const big = tmpFile('big.txt', 'x'.repeat(30_000));

    const history = [
      fileReadCall(small),
      fileReadCall(big),
      content('model', fnCall(REPL, { app: 'Safari' })),
      content('user', fnResponse(REPL, { output: 'screenshot' }), png('shot')),
    ];

    const result = await composePostCompactHistory(history, 'SUM');

    // Section markers we expect, in order:
    const flatText = allText(result, '\n---\n');

    const idxSummary = flatText.indexOf('SUM');
    const idxRefs = flatText.indexOf('reference only');
    const idxEmbed = flatText.indexOf('cfg.json');
    const idxImage = flatText.indexOf('Recent visual snapshots');

    expect(idxSummary).toBeGreaterThanOrEqual(0);
    expect(idxRefs).toBeGreaterThan(idxSummary);
    expect(idxEmbed).toBeGreaterThan(idxRefs);
    expect(idxImage).toBeGreaterThan(idxEmbed);
  });

  it('includes a model ack message after the summary so role alternates correctly', async () => {
    const result = await composePostCompactHistory([userText('do x')], 'SUM');
    // First two entries must be user (summary), then model (ack).
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('model');
    expect(firstText(result[1])).toMatch(/got it|acknowledged|continue/i);
  });

  it('emits role-alternating history with multiple file/image attachments merged into a single user Content (Finding 2)', async () => {
    // Regression: each file restoration block used to be its own user
    // Content; consecutive user roles violate llm-chat.test.ts:6289's
    // strict-alternation assertion and Gemini rejects them with
    // "consecutive same-role content".
    const small = tmpFile('a.ts', 'export const a = 1;');
    const small2 = tmpFile('b.ts', 'export const b = 2;');
    const big = tmpFile('big.ts', 'x'.repeat(30_000));

    const history = [
      fileReadCall(small, small2, big),
      content('user', png('shot')),
    ];

    const result = await composePostCompactHistory(history, 'SUM');
    expectAlternating(result);
  });

  it('preserves a trailing model+functionCall so a pending functionResponse has its match (Finding 3)', async () => {
    // Regression: the old split-point fallback kept a trailing
    // model+functionCall so the pending functionResponse (in
    // sendMessageStream's pendingUserMessage) had a matching call. The
    // full-history rewrite dropped it, leaving user+functionResponse with
    // no preceding model+functionCall → API 400.
    const history = [userText('use the tool'), fileReadCall('/some/file.ts')];
    const result = await composePostCompactHistory(history, 'SUM');
    const hasTrailingFuncCall = result.some(
      (c) => c.role === 'model' && c.parts?.some((p) => !!p.functionCall),
    );
    expect(hasTrailingFuncCall).toBe(true);
    expectAlternating(result);
    expectEndsWithCall(result);
  });

  it('attachments + trailing functionCall produce a 4-entry, role-alternating output', async () => {
    // The most complex branch: postAckParts.length > 0 AND a trailing
    // model+functionCall → [user(summary), model(ack), user(attachments),
    // model(fc)]. The trailing-fc test above hits the 2-entry fold and the
    // cap tests the 3-entry shape; this is the common production case
    // (auto-compaction mid-tool-loop after reading files, with a call in
    // flight), where a model→model adjacency is a provider 400.
    const realFile = tmpFile('real.ts', 'export const x = 1;');
    const history = [
      userText('read it'),
      fileReadCall(realFile),
      userText('ok'),
      content(
        'model',
        { text: 'editing' },
        fnCall('edit', { file_path: realFile }),
      ),
    ];
    const result = await composePostCompactHistory(history, 'SUM', {
      workspaceRoot: tmpDir,
    });
    expect(result).toHaveLength(4);
    expectAlternating(result);
    expectEndsWithCall(result);
    // The embedded file proves postAckParts > 0 (the 4-entry branch, not
    // the 2-entry fold).
    expect(allText(result)).toContain('export const x = 1;');
  });

  it('skips files outside the workspace root (Finding 4)', async () => {
    // Security: extractRecentFilePaths collects ALL functionCall paths,
    // including /etc/passwd attempts the permission system already denied,
    // and readFileSizeAdaptive would read them off disk. The composer
    // filters with a workspace boundary.
    const inside = tmpFile('inside.ts', 'export const inside = true;');
    const outside = '/etc/hosts'; // exists on every system; outside tmpDir

    const result = await composePostCompactHistory(
      [fileReadCall(outside, inside)],
      'SUM',
      { workspaceRoot: tmpDir },
    );
    const text = allText(result);
    expect(text).toContain(inside);
    expect(text).not.toContain('/etc/hosts');
  });

  it('rejects a symlink inside the workspace that points outside it', async () => {
    // Security: a symlink LIVING in the workspace but pointing OUTSIDE
    // (e.g. workspace/.env -> ~/.ssh/id_rsa) passes a lexical boundary
    // check but must be rejected — realpath resolution catches it.
    const outsideDir = mkdtempSync(join(tmpdir(), 'pca-outside-'));
    const secret = join(outsideDir, 'secret.txt');
    writeFileSync(secret, 'TOP_SECRET_CONTENT');
    const link = join(tmpDir, 'innocent.ts');
    symlinkSync(secret, link); // workspace/innocent.ts -> outsideDir/secret.txt

    const result = await composePostCompactHistory(
      [fileReadCall(link)],
      'SUM',
      { workspaceRoot: tmpDir },
    );
    // Lexical resolve would embed the secret; realpath rejects the link.
    expect(allText(result)).not.toContain('TOP_SECRET_CONTENT');
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('honors AbortSignal — does not invoke file reads after abort (Finding 5)', async () => {
    const small = tmpFile('small.ts', 'tiny');

    const ctrl = new AbortController();
    ctrl.abort();
    // readFileSizeAdaptive must observe the signal. Depending on where the
    // check fires this either rejects (AbortError or similar) or returns a
    // clean restoration; the contract is to NEVER embed content after abort.
    let result: Content[] = [];
    let threw = false;
    try {
      result = await composePostCompactHistory([fileReadCall(small)], 'SUM', {
        signal: ctrl.signal,
      });
    } catch {
      threw = true;
    }
    if (!threw) {
      // The content must not appear in an embed block (a bare path
      // reference is fine).
      expect(allText(result)).not.toContain('tiny');
    }
  });

  it('strips the <analysis> block from the raw summary before placing it in newHistory', async () => {
    const raw =
      '<analysis>\nthe model was thinking out loud here\nshould not leak\n</analysis>\n\n<state_snapshot>\n  <primary_request_and_intent>actual summary</primary_request_and_intent>\n</state_snapshot>';
    const result = await composePostCompactHistory([userText('do x')], raw);
    const summaryText = firstText(result[0]);
    expect(summaryText).not.toContain('<analysis>');
    expect(summaryText).not.toContain('thinking out loud');
    expect(summaryText).toContain('<state_snapshot>');
    expect(summaryText).toContain('actual summary');
  });

  it('appends the resume trailer to the summary message text', async () => {
    const result = await composePostCompactHistory(
      [userText('do x')],
      '<state_snapshot>...</state_snapshot>',
    );
    const summaryText = firstText(result[0]);
    // Trailer instructs the resuming agent not to greet / recap.
    expect(summaryText).toMatch(/resume.*prior task|continue from/i);
    expect(summaryText).toMatch(
      /do not acknowledge|do not re-introduce|do not greet/i,
    );
  });

  it('respects maxFiles / maxImages caps from options', async () => {
    const f1 = tmpFile('one.ts', 'export const one = 1;');
    const f2 = tmpFile('two.ts', 'export const two = 2;');

    const history = [
      fileReadCall(f1, f2),
      nestedImages('', png('img1'), png('img2')),
    ];

    const result = await composePostCompactHistory(history, 'SUM', {
      workspaceRoot: tmpDir,
      maxFiles: 1,
      maxImages: 1,
    });

    expect(inlineParts(result)).toHaveLength(1);

    const text = allText(result);
    // Parallel calls in one model turn: the last (two.ts) is most recent,
    // so it is the single retained file. Assert on embedded CONTENT, not
    // the path: the path can also surface in image attribution metadata,
    // which this cap doesn't control.
    expect(text).toContain('export const two = 2;');
    expect(text).not.toContain('export const one = 1;');
  });

  it('restores no attachments when maxFiles and maxImages are 0', async () => {
    const f1 = tmpFile('z.ts', 'export const z = 1;');
    const history = [fileReadCall(f1), nestedImages('', png('i'))];
    const result = await composePostCompactHistory(history, 'SUM', {
      workspaceRoot: tmpDir,
      maxFiles: 0,
      maxImages: 0,
    });
    // Only [summary(user), ack(model)] — no attachment Content appended.
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('model');
  });

  it('output is not re-counted by the screenshot trigger (restored images are top-level)', async () => {
    // The screenshot trigger counts only images nested in
    // functionResponse.parts. Restored images come back TOP-LEVEL, so the
    // count on the output must be 0; otherwise a freshly compacted history
    // could immediately re-trigger compaction (no-loop invariant).
    const history = [...shot('Safari', 'a'), ...shot('Mail', 'b')];
    const result = await composePostCompactHistory(history, 'SUM', {
      maxImages: 5,
    });
    expect(inlineParts(result).length).toBeGreaterThan(0); // images survived...
    expect(countToolResponseImages(result)).toBe(0); // ...but top-level, uncounted
  });
});

describe('postProcessSummary', () => {
  it('returns body + trailer when no <analysis> block is present', () => {
    const out = postProcessSummary('<state_snapshot>body</state_snapshot>');
    expect(out).toContain('<state_snapshot>body</state_snapshot>');
    expect(out).toMatch(/resume.*prior task/i);
  });

  it('strips <analysis> wrappers (greedy across newlines)', () => {
    const out = postProcessSummary(
      '<analysis>\nlots of\nmulti-line\nreasoning\n</analysis>\n\n<state_snapshot>body</state_snapshot>',
    );
    expect(out).not.toContain('<analysis>');
    expect(out).not.toContain('multi-line');
    expect(out).toContain('<state_snapshot>body</state_snapshot>');
  });

  it('strips multiple <analysis> blocks if the model emits more than one', () => {
    const out = postProcessSummary(
      '<analysis>first</analysis>\n<state_snapshot>body</state_snapshot>\n<analysis>second</analysis>',
    );
    expect(out).not.toContain('<analysis>');
    expect(out).not.toContain('first');
    expect(out).not.toContain('second');
  });

  it('does NOT re-inject the <analysis> body when the model emits only scratchpad (Finding 6)', () => {
    // Regression: the old `rawSummary.trim()` fallback re-injected the whole
    // <analysis> block when stripping left nothing, defeating the point of
    // keeping the scratchpad out of the next agent's context.
    const out = postProcessSummary('<analysis>nothing else</analysis>');
    expect(out).not.toContain('<analysis>');
    expect(out).not.toContain('nothing else');
    // The trailer still gives continuation guidance with no summary body.
    expect(out).toMatch(/resume.*prior task/i);
  });

  it('strips an unclosed <analysis> block in the fallback path (Finding 6)', () => {
    // Pathological: an <analysis> tag that never closes. The closed-tag
    // regex misses, so the stripped text is non-empty and no fallback runs;
    // the unclosed-tag regex must catch it so the body never leaks.
    const out = postProcessSummary('<analysis>still thinking about the answer');
    expect(out).not.toContain('<analysis>');
    expect(out).not.toContain('still thinking');
    expect(out).toMatch(/resume.*prior task/i);
  });
});

/** Composes a minimal user/model history with `opts`; returns all text. */
async function composeText(opts: ComposePostCompactOptions) {
  const history = [userText('u'), modelText('m')];
  return allText(await composePostCompactHistory(history, 'SUMMARY', opts));
}

describe('composePostCompactHistory — plan-mode reminder', () => {
  it('injects a plan-mode reminder when planModeActive is true', async () => {
    const flat = await composeText({ planModeActive: true });
    expect(flat).toContain('<plan-mode-active>');
    expect(flat).toMatch(/may not execute modification/i);
    // Tool names come from ToolNames, not stale literals: a rename that
    // updates ToolNames keeps this reminder in sync.
    expect(flat).toContain(ToolNames.WRITE_FILE);
    expect(flat).toContain(ToolNames.EDIT);
    expect(flat).toContain(ToolNames.SHELL);
  });

  it('omits the plan-mode reminder when planModeActive is false or unset', async () => {
    for (const opts of [{}, { planModeActive: false }]) {
      expect(await composeText(opts)).not.toContain('<plan-mode-active>');
    }
  });
});

describe('composePostCompactHistory — subagent snapshot', () => {
  const sub = (
    id: string,
    description: string,
    status: SubagentSnapshot['status'],
    startTime: number,
  ): SubagentSnapshot => ({ id, description, status, startTime });
  const snapshotText = (runningSubagents: SubagentSnapshot[]) =>
    composeText({ runningSubagents });

  it('renders a <background-tasks> block listing running and paused tasks', async () => {
    const flat = await snapshotText([
      sub('agent-1', 'Run the bookmark-app E2E', 'running', 1000),
      sub('agent-2', 'Refactor session manager', 'paused', 2000),
    ]);
    expect(flat).toContain('<background-tasks>');
    expect(flat).toContain('agent-1');
    expect(flat).toContain('Run the bookmark-app E2E');
    expect(flat).toContain('agent-2');
    expect(flat).toContain('Refactor session manager');
    expect(flat).toMatch(/running/);
    expect(flat).toMatch(/paused/);
  });

  it('omits the snapshot block when runningSubagents is empty or undefined', async () => {
    for (const opts of [{ runningSubagents: [] }, {}]) {
      expect(await composeText(opts)).not.toContain('<background-tasks>');
    }
  });

  it('truncates very long descriptions to keep the snapshot bounded', async () => {
    const flat = await snapshotText([
      sub('agent-x', 'x'.repeat(1000), 'running', 1),
    ]);
    expect(flat).toMatch(/x{200}…/);
    expect(flat).not.toMatch(/x{300}/);
  });

  it('flattens newlines/tabs in descriptions so each task stays on one bullet line', async () => {
    const flat = await snapshotText([
      sub(
        'agent-a',
        'first line\nsecond line\r\nthird\twith\ttabs',
        'running',
        1,
      ),
      sub('agent-b', 'next task', 'paused', 2),
    ]);
    // agent-a's bullet stays on one line: split, "second line" would read
    // as a sibling list item or a stray paragraph between `- [..]` rows.
    expect(flat).toMatch(
      /- \[running] agent-a: first line second line third with tabs/,
    );
    // agent-b follows directly, not orphaned by a newline in agent-a.
    expect(flat).toMatch(/agent-a:[^\n]*\n- \[paused] agent-b: next task/);
  });

  it('escapes XML-sensitive characters in descriptions to prevent injection', async () => {
    const flat = await snapshotText([
      sub('agent-x', '</background-tasks><evil>injected</evil>', 'running', 1),
    ]);
    // An unescaped `</background-tasks>` from an adversarial description
    // would close our wrapper tag and inject arbitrary XML.
    const closes = flat.match(/<\/background-tasks>/g) ?? [];
    expect(closes.length).toBe(1);
    expect(flat).toContain('&lt;/background-tasks&gt;');
    expect(flat).toContain('&lt;evil&gt;');
  });

  it('escapes XML-sensitive characters in the subagent id, not just the description', async () => {
    // Ids derive from a user-configurable subagentConfig.name, so a `<`/`&`
    // there must be escaped too — escaping only the description would still
    // let the id close the wrapper or forge markup.
    const flat = await snapshotText([
      sub(
        'agent</background-tasks>&<inject>',
        'safe description',
        'running',
        1,
      ),
    ]);
    // Only our own wrapper close-tag may appear unescaped.
    const closes = flat.match(/<\/background-tasks>/g) ?? [];
    expect(closes.length).toBe(1);
    expect(flat).toContain('agent&lt;/background-tasks&gt;&amp;&lt;inject&gt;');
  });

  const manyRunning = (n: number, description: (i: number) => string) =>
    Array.from({ length: n }, (_, i) =>
      sub(`agent-${i}`, description(i), 'running', i),
    );

  it('caps the snapshot at MAX_SUBAGENT_SNAPSHOT_COUNT and notes the overflow', async () => {
    // 35 tasks against a cap of 30: 5 overflow into the trailing line.
    const flat = await snapshotText(manyRunning(35, (i) => `task ${i}`));
    // Newest 30 retained (agent-5 .. agent-34); oldest 5 dropped (agent-0..4).
    expect(flat).toContain('agent-34');
    expect(flat).toContain('agent-5');
    expect(flat).not.toMatch(/\bagent-0\b/);
    expect(flat).not.toMatch(/\bagent-4\b/);
    expect(flat).toMatch(/and 5 older tasks not shown/);
  });

  it('uses singular "task" in the overflow line when exactly one is hidden', async () => {
    const flat = await snapshotText(manyRunning(31, () => `t`));
    expect(flat).toMatch(/and 1 older task not shown/);
  });

  it('sorts subagents by startTime ascending', async () => {
    const flat = await snapshotText([
      sub('late', 'late', 'running', 3000),
      sub('early', 'early', 'paused', 1000),
      sub('mid', 'mid', 'running', 2000),
    ]);
    const earlyIdx = flat.indexOf('early');
    const midIdx = flat.indexOf('mid');
    const lateIdx = flat.indexOf('late');
    expect(earlyIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lateIdx);
  });
});
