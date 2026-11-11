/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentContext } from '../attachments/get-attachments.js';
import type { PostCompactRestoredFilesAttachment } from '../attachments/models/restore-attachments.js';
import { restoreAttachment } from '../attachments/transcript-conversion.js';
import { registerRestoredFileReads } from '../attachments/transcript-state.js';
import type { Config } from '../config/config.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import type { Message, UserMessage } from '../protocol/transcript/message.js';
import { READ_FILE_TOOL_NAME } from '../tools/tool-names.js';
import { initializeShellSession } from '../utils/Shell.js';
import { ReadFileTool } from '../tools/read-file.js';
import { addLineNumbers } from '../utils/lineNumbers.js';
import { partListUnionToContent } from '../tools/tool-use-result-builder.js';
import {
  collectPreservedReadFilePathsFromHistory,
  finalizePostCompact,
  selectFilesWithinBudget,
} from './post-compact-finalize.js';

vi.mock('../tools/jit-context.js', () => ({
  activateConditionalSkillsForPath: vi.fn(),
  discoverJitContext: vi.fn().mockResolvedValue(undefined),
}));

let nextId = 0;
function userText(text: string): UserMessage {
  return {
    type: 'user',
    uuid: `restore-user-${++nextId}`,
    timestamp: '2026-10-29T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function readHistory(
  filePath: string,
  text: string,
  range: { offset?: number; limit?: number } = {},
): Message[] {
  const id = `restore-read-${++nextId}`;
  return [
    {
      type: 'assistant',
      uuid: `restore-assistant-${++nextId}`,
      timestamp: '2026-10-29T00:00:00.000Z',
      message: {
        type: 'message',
        role: 'assistant',
        id,
        model: 'test-model',
        stop_reason: 'tool_use',
        stop_sequence: null,
        container: null,
        context_management: null,
        usage: cloneUsage(),
        content: [
          {
            type: 'tool_use',
            id,
            name: READ_FILE_TOOL_NAME,
            input: { file_path: filePath, ...range },
          },
        ],
      },
    },
    {
      ...userText(''),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: text }],
      },
    },
  ];
}

const config = {
  getApprovedPlanPath: () => null,
  getSkillManager: () => undefined,
  isPlanMode: () => false,
} as unknown as Config;

describe('post-compact current file restoration', () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'post-compact-reread-'));
    directories.push(directory);
    const ctx = createAttachmentContext(directory);
    const readConfig = {
      ...config,
      getTargetDir: () => directory,
      getModel: () => 'test-model',
      isAutoMemoryEnabled: () => false,
      fileReadState: ctx.fileReadState,
    } as unknown as Config;
    initializeShellSession(readConfig, directory);
    return { directory, ctx, config: readConfig };
  }

  function restoredFiles(
    result: Awaited<ReturnType<typeof finalizePostCompact>>,
  ) {
    const message = result.attachmentMessages.find(
      (message) => message.attachment.type === 'post_compact_restored_files',
    );
    return message
      ? (restoreAttachment(
          message.attachment,
        ) as PostCompactRestoredFilesAttachment)
      : undefined;
  }

  it('restores current disk text with Read wording and the user/system-reminder envelope', async () => {
    const { directory, ctx, config } = await setup();
    const filePath = join(directory, 'current.txt');
    await writeFile(filePath, 'OLD\n');
    const history = readHistory(filePath, 'OLD\n');
    ctx.readFileState.set(filePath, {
      content: 'OLD\n',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    });
    await writeFile(filePath, 'NEW\nsecond line\n');
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: history,
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        config,
      }),
    )!;

    expect(attachment.files[0].content).toBe('NEW\nsecond line\n');
    expect(attachment.files[0].readState?.timestamp).toBe(
      Math.floor((await stat(filePath)).mtimeMs),
    );
    expect(ctx.fileReadState.has(filePath)).toBe(false);
    expect(attachment.toUserMessages()).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '<system-reminder>\n' +
              `Called the Read tool with the following input: ${JSON.stringify({ file_path: filePath })}` +
              '\n</system-reminder>',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '<system-reminder>\n' +
              'Result of calling the Read tool:\n1\tNEW\n2\tsecond line\n3\t' +
              '\n</system-reminder>',
          },
        ],
      },
    ]);
    registerRestoredFileReads(ctx.fileReadState, attachment.files);
    expect(ctx.fileReadState.get(filePath)).toMatchObject({
      content: 'NEW\nsecond line\n',
      isPartialView: false,
      contentNotInModelContext: false,
    });
  });

  it('rereads the whole file instead of reusing an old partial range', async () => {
    const { directory, ctx, config } = await setup();
    const filePath = join(directory, 'range.txt');
    await writeFile(filePath, 'first\nsecond\nthird');
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: readHistory(filePath, 'old partial line', {
          offset: 2,
          limit: 1,
        }),
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        config,
      }),
    )!;
    expect(attachment.files[0]).toMatchObject({
      content: 'first\nsecond\nthird',
      truncated: false,
      readState: { offset: 1, limit: undefined, isPartialView: false },
    });
  });

  it('skips missing, non-text and denied files without falling back to old results', async () => {
    const { directory, ctx, config } = await setup();
    const valid = join(directory, 'valid.txt');
    const denied = join(directory, 'denied.txt');
    const binary = join(directory, 'binary.dat');
    const missing = join(directory, 'missing.txt');
    await writeFile(valid, 'CURRENT');
    await writeFile(denied, 'must not be restored');
    await writeFile(binary, Buffer.from([0, 1, 2, 0, 3]));
    ctx.permissionPaths = {
      rules: { allow: {}, deny: { session: ['Read(denied.txt)'] }, ask: {} },
      additionalDirectories: [],
    };
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: [valid, denied, binary, missing].flatMap((filePath) =>
          readHistory(filePath, 'OLD'),
        ),
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        config,
      }),
    )!;
    expect(
      attachment.files.map((file) => [file.filePath, file.content]),
    ).toEqual([[valid, 'CURRENT']]);
  });

  it('keeps the exclusion for files covered by retained original messages', async () => {
    const { directory, ctx, config } = await setup();
    const filePath = join(directory, 'retained.txt');
    await writeFile(filePath, 'NEW');
    const history = readHistory(filePath, 'OLD');
    const result = await finalizePostCompact({
      workingHistory: history,
      newHistory: [userText('summary'), ...history],
      targetDir: directory,
      ctx,
      config,
    });
    expect(restoredFiles(result)).toBeUndefined();
  });

  it('restores only the CC file reference when fresh content exceeds the token budget', async () => {
    const { directory, ctx, config } = await setup();
    const filePath = join(directory, 'large.txt');
    await writeFile(filePath, 'CURRENT\n' + 'x'.repeat(100_000));
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: readHistory(filePath, 'old small file'),
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        config,
      }),
    )!;
    expect(attachment.files[0]).toMatchObject({
      referenceOnly: true,
      content: '',
    });
    expect(attachment.files[0].readState).toBeUndefined();
    expect(attachment.toUserMessages()[0].content).toEqual([
      {
        type: 'text',
        text:
          '<system-reminder>\n' +
          `Note: ${filePath} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.` +
          '\n</system-reminder>',
      },
    ]);
    registerRestoredFileReads(ctx.fileReadState, attachment.files);
    expect(ctx.fileReadState.has(filePath)).toBe(false);
  });

  it('keeps a file reference when the current file exceeds the reader byte limit', async () => {
    const { directory, ctx, config } = await setup();
    const filePath = join(directory, 'oversized.txt');
    await writeFile(filePath, 'x'.repeat(300_000));
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: readHistory(filePath, 'old small file'),
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        config,
      }),
    )!;
    expect(attachment.files[0]).toMatchObject({
      referenceOnly: true,
      content: '',
    });
    expect(attachment.files[0].readState).toBeUndefined();
    expect(JSON.stringify(attachment.toUserMessages())).toContain(
      'was read before the last conversation was summarized, but the contents are too large to include.',
    );
  });

  it('uses the CC empty-file warning for an empty current file', async () => {
    const { directory, ctx, config } = await setup();
    const filePath = join(directory, 'empty.txt');
    await writeFile(filePath, '');
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: readHistory(filePath, 'old non-empty text'),
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        config,
      }),
    )!;
    expect(attachment.files[0].content).toBe('');
    expect(JSON.stringify(attachment.toUserMessages())).toContain(
      'Warning: the file exists but the contents are empty.',
    );
  });

  it('recognizes preserved files in both the new Read wording and older Path reminders', () => {
    expect(
      collectPreservedReadFilePathsFromHistory(
        [
          userText(
            'Called the Read tool with the following input: {"file_path":"src/new.ts"}\n' +
              'Result of calling the Read tool:\n1\tnew\nPath: /project/old.ts\n' +
              'Called the Read tool with the following input: invalid JSON',
          ),
        ],
        '/project',
      ),
    ).toEqual(new Set(['/project/src/new.ts', '/project/old.ts']));
  });

  it('excludes dedicated plan and loaded memory recovery paths before taking five recent files', async () => {
    const { directory, ctx, config } = await setup();
    const ordinary = Array.from({ length: 6 }, (_, index) =>
      join(directory, `file-${index}.txt`),
    );
    const plan = join(directory, 'plan.md');
    const memory = join(directory, 'AGENTS.md');
    const rule = join(directory, 'rule.md');
    const autoMemory = join(directory, 'MEMORY.md');
    const sdk = join(directory, 'sdk.md');
    const all = [...ordinary, plan, memory, rule, autoMemory, sdk];
    await Promise.all(all.map((file) => writeFile(file, 'CURRENT')));
    ctx.loadedNestedMemoryPaths.add(memory);
    const memoryContextManager = {
      getLoadedPaths: () => new Set([rule]),
      getAutoMemoryIndexFileStates: () => [{ indexPath: autoMemory }],
    } as unknown as NonNullable<
      import('../attachments/types.js').AttachmentExternalContext['memoryContextManager']
    >;
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: all.flatMap((file) => readHistory(file, 'OLD')),
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        externalContext: {
          memoryContextManager,
          sdkMemoryFileStates: [
            { filePath: sdk, content: 'CURRENT', timestamp: 1 },
          ],
        },
        config: { ...config, getApprovedPlanPath: () => plan } as Config,
      }),
    )!;
    expect(attachment.files.map((file) => file.filePath)).toEqual(
      ordinary.slice(1).reverse(),
    );
  });

  it('uses validated Read input and whole-file recovery without changing ordinary Read pagination', async () => {
    const { directory, ctx, config } = await setup();
    const filePath = join(directory, 'paged.txt');
    await writeFile(
      filePath,
      Array.from({ length: 2005 }, () => 'x').join('\n'),
    );
    const build = vi.spyOn(ReadFileTool.prototype, 'build');
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: readHistory(filePath, 'old partial', {
          offset: 4,
          limit: 1,
        }),
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        config,
      }),
    )!;
    expect(build).toHaveBeenCalledWith({ file_path: filePath });
    const file = attachment.files[0];
    expect(file.readResult).toMatchObject({
      type: 'text',
      file: { numLines: 2005, startLine: 1, totalLines: 2005 },
    });
    expect(file.readState).toMatchObject({
      offset: 1,
      limit: undefined,
      isPartialView: false,
    });
    expect(file.formattedContent).toContain(
      addLineNumbers({ content: file.content, startLine: 1 }),
    );
    expect(file.formattedContent).not.toContain(
      'using the default 2000-line limit',
    );
    expect(attachment.toUserMessages()).toHaveLength(2);
    expect(JSON.stringify(attachment.toUserMessages()[1])).not.toContain(
      'using the default 2000-line limit',
    );
    expect(ctx.fileReadState.has(filePath)).toBe(false);
    registerRestoredFileReads(ctx.fileReadState, attachment.files);
    expect(ctx.fileReadState.get(filePath)?.isPartialView).toBe(false);
    const ordinary = await new ReadFileTool(config).build({
      file_path: filePath,
    }).executeWithContext!({
      signal: new AbortController().signal,
      fileReadState: ctx.fileReadState,
    });
    expect(ordinary.toolUseResult).toMatchObject({
      type: 'text',
      file: { numLines: 2000, totalLines: 2005 },
    });
    expect(ordinary.llmContent).toContain('using the default 2000-line limit');
  });

  it('limits restoration to 5000 tokens without reducing a subsequent ordinary Read budget', async () => {
    const { directory, ctx, config } = await setup();
    const filePath = join(directory, 'over-restore-budget.txt');
    await writeFile(filePath, 'x'.repeat(24000));
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: readHistory(filePath, 'OLD'),
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        config,
      }),
    )!;
    expect(attachment.files[0].referenceOnly).toBe(true);
    const ordinary = await new ReadFileTool(config).build({
      file_path: filePath,
    }).executeWithContext!({
      signal: new AbortController().signal,
      fileReadState: ctx.fileReadState,
    });
    expect(ordinary.error).toBeUndefined();
    expect(ordinary.toolUseResult).toMatchObject({
      type: 'text',
      file: { content: 'x'.repeat(24000) },
    });
  });

  it('budgets serialized attachment payloads and continues after an oversized candidate', () => {
    const tooLarge = {
      filePath: '/large.txt',
      content: '\n'.repeat(100000),
      formattedContent: 'tiny output',
      truncated: false,
    };
    const later = {
      filePath: '/small.txt',
      content: 'fits',
      formattedContent: 'x'.repeat(250000),
      truncated: false,
    };
    // Escaping newlines in JSON makes the first payload exceed 50k tokens.
    // The rendered text is deliberately different: budgeting must use payloads.
    expect(selectFilesWithinBudget([tooLarge, later])).toEqual([later]);
  });

  async function writeNotebook(directory: string, cells: unknown[]) {
    const filePath = join(directory, 'example.ipynb');
    await writeFile(
      filePath,
      JSON.stringify({
        cells,
        metadata: { language_info: { name: 'python' } },
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );
    return filePath;
  }

  it.each([
    ['empty', []],
    [
      'single cell',
      [{ cell_type: 'markdown', id: 'intro', source: ['hello'], metadata: {} }],
    ],
    [
      'multiple cells',
      [
        { cell_type: 'markdown', id: 'intro', source: ['hello'], metadata: {} },
        {
          cell_type: 'code',
          id: 'code',
          source: ['print(42)'],
          metadata: {},
          execution_count: 1,
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['42\n'] }],
        },
      ],
    ],
  ])(
    'restores a %s notebook with canonical Read output and survives transcript replay',
    async (_name, cells) => {
      const { directory, ctx, config } = await setup();
      const filePath = await writeNotebook(directory, cells as unknown[]);
      const attachment = restoredFiles(
        await finalizePostCompact({
          workingHistory: readHistory(filePath, 'OLD'),
          newHistory: [userText('summary')],
          targetDir: directory,
          ctx,
          config,
        }),
      )!;
      expect(attachment.files).toHaveLength(1);
      const file = attachment.files[0];
      expect(file.readResult?.type).toBe('notebook');
      expect(file.readState).toMatchObject({
        isPartialView: false,
        contentNotInModelContext: false,
      });
      expect(ctx.fileReadState.has(filePath)).toBe(false);
      const ordinary = await new ReadFileTool(config).build({
        file_path: filePath,
      }).executeWithContext!({
        signal: new AbortController().signal,
        fileReadState: ctx.fileReadState,
      });
      expect(ordinary.error).toBeUndefined();
      const canonical =
        cells.length === 0 ? [] : partListUnionToContent(ordinary.llmContent);
      expect(file.formattedParts).toEqual(
        typeof canonical === 'string'
          ? [{ type: 'text', text: canonical }]
          : canonical,
      );
      expect(attachment.toUserMessages()).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `<system-reminder>\nCalled the Read tool with the following input: ${JSON.stringify({ file_path: filePath })}\n</system-reminder>`,
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `<system-reminder>\nResult of calling the Read tool:\n${JSON.stringify(file.formattedParts)}\n</system-reminder>`,
            },
          ],
        },
      ]);
      const replayed = restoreAttachment(
        JSON.parse(JSON.stringify(attachment.toTranscript())),
      ) as PostCompactRestoredFilesAttachment;
      expect(replayed.toUserMessages()).toEqual(attachment.toUserMessages());
      ctx.fileReadState.clear();
      registerRestoredFileReads(ctx.fileReadState, replayed.files);
      expect(ctx.fileReadState.get(filePath)).toMatchObject({
        isPartialView: false,
        contentNotInModelContext: false,
      });
    },
  );

  it('preserves notebook output images as image blocks rather than JSON text', async () => {
    const { directory, ctx, config } = await setup();
    const image =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XcAAAAASUVORK5CYII=';
    const filePath = await writeNotebook(directory, [
      {
        cell_type: 'code',
        id: 'image-cell',
        source: ['display(image)'],
        metadata: {},
        execution_count: 1,
        outputs: [
          {
            output_type: 'display_data',
            data: { 'image/png': image, 'text/plain': ['a plot'] },
            metadata: {},
          },
        ],
      },
    ]);
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: readHistory(filePath, 'OLD'),
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        config,
      }),
    )!;
    const messages = attachment.toUserMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContainEqual({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data: image },
    });
    const imageResult = messages[1].content;
    if (!Array.isArray(imageResult)) throw new Error('Expected notebook blocks');
    expect(
      imageResult
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    ).not.toContain(image);
    const replayed = restoreAttachment(
      JSON.parse(JSON.stringify(attachment.toTranscript())),
    ) as PostCompactRestoredFilesAttachment;
    expect(replayed.toUserMessages()).toEqual(messages);
  });

  it.each([
    ['tokens', 24000],
    ['bytes', 300000],
  ])(
    'keeps a reference for a notebook exceeding the %s limit',
    async (_limit, size) => {
      const { directory, ctx, config } = await setup();
      const filePath = await writeNotebook(directory, [
        {
          cell_type: 'markdown',
          id: 'large',
          source: ['x'.repeat(size as number)],
          metadata: {},
        },
      ]);
      const attachment = restoredFiles(
        await finalizePostCompact({
          workingHistory: readHistory(filePath, 'OLD'),
          newHistory: [userText('summary')],
          targetDir: directory,
          ctx,
          config,
        }),
      )!;
      expect(attachment.files[0]).toMatchObject({
        referenceOnly: true,
        content: '',
      });
      expect(attachment.files[0].readState).toBeUndefined();
      expect(ctx.fileReadState.has(filePath)).toBe(false);
      if (size === 24000) {
        const ordinary = await new ReadFileTool(config).build({
          file_path: filePath,
        }).executeWithContext!({
          signal: new AbortController().signal,
          fileReadState: ctx.fileReadState,
        });
        expect(ordinary.error).toBeUndefined();
        expect(ordinary.toolUseResult).toMatchObject({ type: 'notebook' });
      }
    },
  );

  it('keeps non-text bytes and their normal Read warning under a text extension', async () => {
    const { directory, ctx, config } = await setup();
    const filePath = join(directory, 'binary-content.txt');
    await writeFile(filePath, Buffer.from([0, 1, 2, 0, 3]));
    const attachment = restoredFiles(
      await finalizePostCompact({
        workingHistory: readHistory(filePath, 'OLD'),
        newHistory: [userText('summary')],
        targetDir: directory,
        ctx,
        config,
      }),
    )!;
    expect(attachment.files[0].content).toBe('\0\x01\x02\0\x03');
    expect(attachment.files[0].formattedContent).toContain('NUL bytes');
    expect(attachment.files[0].referenceOnly).not.toBe(true);
  });

  it('resets recovery limits for both ordinary execution entrypoints even when reusing an invocation', async () => {
    const { directory, ctx, config } = await setup();
    const filePath = join(directory, 'normal-read.txt');
    await writeFile(filePath, 'long text\n'.repeat(2005));
    const invocation = new ReadFileTool(config).build({ file_path: filePath });
    const signal = new AbortController().signal;
    const recovery = await invocation.executeWithContext!({
      signal,
      fileReadState: ctx.fileReadState,
      fileReadingLimits: { maxTokens: 5000, wholeFile: true },
    });
    expect(recovery.error?.type).toBe('file_too_large');
    const ordinary = await invocation.execute(signal);
    expect(ordinary.error).toBeUndefined();
    expect(ordinary.toolUseResult).toMatchObject({
      type: 'text',
      file: { numLines: 2000 },
    });
    const ordinaryWithContext = await invocation.executeWithContext!({
      signal,
      fileReadState: ctx.fileReadState,
      dedupUnchangedReads: false,
    });
    expect(ordinaryWithContext.error).toBeUndefined();
    expect(ordinaryWithContext.toolUseResult).toMatchObject({
      type: 'text',
      file: { numLines: 2000 },
    });
  });
});
