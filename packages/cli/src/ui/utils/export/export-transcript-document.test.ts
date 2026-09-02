import { describe, expect, it } from 'vitest';
import {
  EXPORT_TRANSCRIPT_LIMITS_V1,
  assertExportTranscriptDocumentV1,
  classifyPermissionResolutionForExport,
  createExportTranscriptDocumentV1,
} from './export-transcript-document.js';
import { escapeJsonForHtmlScriptData } from './html-script-data.js';

const CANARY = 'CHAT_TRANSCRIPT_TEST_SECRET_DO_NOT_EXPORT';
const EXPORT_OPTIONS = {
  rendererVersion: '0.21.11-test.1',
  exportedAt: '2026-08-16T01:00:00.000Z',
} as const;

function record(
  uuid: string,
  parentUuid: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid,
    parentUuid,
    sessionId: 'raw-session-id',
    timestamp: '2026-08-16T00:00:00.000Z',
    cwd: '/Users/tester/project',
    version: 'test',
    type: 'user',
    message: { role: 'user', parts: [{ text: uuid }] },
    ...overrides,
  };
}

const sessionData = {
  startTime: '2026-08-16T00:00:00.000Z',
  metadata: {
    sessionId: `session-${CANARY}`,
    startTime: '2026-08-16T00:00:00.000Z',
    exportTime: '2026-08-16T01:00:00.000Z',
    cwd: '/Users/tester/project',
    gitRepo: 'qwen-code',
    gitBranch: 'feat/transcript',
    model: 'qwen-test',
    channel: 'cli',
    promptCount: 1,
    totalTokens: 12,
    filesWritten: 1,
    linesAdded: 2,
    linesRemoved: 0,
    uniqueFiles: [`/Users/tester/${CANARY}.ts`],
  },
};

describe('ExportTranscriptDocumentV1', () => {
  it('projects records through an explicit allowlist without raw leakage', () => {
    const records = [
      record('user-1', null, {
        message: { role: 'user', parts: [{ text: 'Read the file' }] },
      }),
      record('tool-start', 'user-1', {
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'read-1',
                name: 'read_file',
                args: {
                  path: '/Users/tester/visible.ts',
                  credential: CANARY,
                },
              },
            },
          ],
        },
      }),
      record('tool-result', 'tool-start', {
        type: 'tool_result',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'read-1',
                name: 'read_file',
                response: { output: CANARY },
              },
            },
          ],
        },
        toolCallResult: {
          callId: 'read-1',
          resultDisplay: {
            type: 'vision_bridge_notice',
            summary: 'Safe visible result at /Users/tester',
            notice: 'One page converted from C:\\Users\\tester directory.',
          },
        },
      }),
      record('internal', 'tool-result', {
        type: 'system',
        subtype: 'custom_title',
        systemPayload: { title: CANARY },
      }),
    ];

    const document = createExportTranscriptDocumentV1(records, sessionData, {
      rendererVersion: '0.21.11-test.1',
      exportedAt: '2026-08-16T01:00:00.000Z',
      title: 'Synthetic transcript',
    });
    const serialized = JSON.stringify(document);

    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain('/Users/tester');
    expect(serialized).not.toContain('raw-session-id');
    expect(serialized).not.toContain('user-1');
    expect(serialized).not.toContain('read-1');
    expect(serialized).not.toMatch(/"(?:rawInput|rawOutput|toolCall)"/);
    expect(document.metadata).toMatchObject({
      projectName: 'project',
      repository: 'qwen-code',
      complete: true,
      truncated: false,
    });
    expect(document.metadata).not.toHaveProperty('uniqueFiles');
    expect(document.blocks.every((block) => block.createdAt === 0)).toBe(true);
    expect(
      document.blocks.find((block) => block.kind === 'tool'),
    ).toMatchObject({
      preview: { kind: 'file_read', path: 'visible.ts' },
      resultPreview: {
        kind: 'text',
        text: 'Safe visible result at [home]\nOne page converted from [home] directory.',
      },
    });
    expect(document.diagnostics).toContainEqual({
      code: 'record_internal_excluded',
      severity: 'info',
      count: 1,
    });
  });

  it('redacts home paths from visible text without corrupting image data', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('visible-paths', null, {
          message: {
            role: 'user',
            parts: [
              {
                text: [
                  'Unix /Users/alice/private.txt',
                  'Windows C:\\Users\\alice\\private.txt',
                  'URI file:///Users/alice/private.txt',
                  'Windows URI file:///C:/Users/alice/private.txt',
                  'Hosted URI file://localhost/home/alice/private.txt',
                  'Remote host URI file://host/Users/alice/private.txt',
                  'Encoded host URI file://host/%2Fhome%2Falice%2Fprivate.txt',
                  'HOME=/home/alice/private.txt',
                  'Case variants /users/alice/private.txt /HOME/bob/private.txt',
                  'Normalized /home//alice/private.txt /home/./alice/private.txt',
                  '--dir=/Users/alice/private.txt',
                  'encoded=%2Fhome%2Falice%2Fprivate.txt',
                  'joined=/home/alice/a,/home/bob/b',
                  'traversal=/home/alice/../../etc/passwd',
                  'file traversal=file:///home/alice/..',
                  'nested=/home/alice/home/notes.txt',
                  'forged=[home]/home/alice/private.txt',
                  'redundant=//home/alice/private.txt /./home/bob/private.txt',
                  'mixed=C:\\Users/alice/private.txt /home\\bob/private.txt',
                  'windows dotted=C:\\Users\\.\\alice\\private.txt',
                  '![safe](data:image/png;base64,/home/AA)',
                ].join('\n'),
              },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const text =
      document.blocks[0]?.kind === 'user' ? document.blocks[0].text : '';

    expect(text).toContain('Unix [home]/private.txt');
    expect(text).toContain('Windows [home]\\private.txt');
    expect(text).toContain('URI file://[home]/private.txt');
    expect(text).toContain('Windows URI file://[home]/private.txt');
    expect(text).toContain('Hosted URI file://[home]/private.txt');
    expect(text).toContain('Remote host URI file://[home]/private.txt');
    expect(text).toContain('Encoded host URI file://[home]/private.txt');
    expect(text).toContain(
      'Case variants [home]/private.txt [home]/private.txt',
    );
    expect(text).toContain('Normalized [home]/private.txt [home]/private.txt');
    expect(text).toContain('[image omitted: safe]');
    expect(text).not.toContain('data:image/png;base64,/home/AA');
    expect(text).not.toContain('/Users/alice');
    expect(text).not.toContain('C:\\Users\\alice');
    expect(text).not.toContain('/home/alice');
    expect(text).not.toContain('%2Fhome%2Falice');
    expect(text).not.toContain('/home/bob');
    expect(text).toContain('joined=[home]/a,[home]/b');
    expect(text).not.toContain('nested=[home]/home/');
    expect(text).not.toContain('forged=[home]/home/');
    expect(text).not.toContain('//home/alice');
    expect(text).not.toContain('/./home/bob');
    expect(text).not.toContain('C:\\Users/alice');
    expect(text).not.toContain('/home\\bob');
    expect(text).not.toContain('Users\\.\\alice');
  });

  it('redacts delimiter-wrapped, URL-adjacent, and URL-query home path entrances', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('bypass-entrances', null, {
          message: {
            role: 'user',
            parts: [
              {
                text: [
                  'see /home/"alice"/notes',
                  '(https://evil)/home/alice/x',
                  "curl 'http://127.0.0.1:3000/open?file=/home/alice/doc.md'",
                  'Saved output to C:\\Users\\John Smith\\file.txt today',
                  'Visit https://example.com/a,/home/urluser/private.txt now',
                  'Visit https://example.com/a;file:///home/fileuser/private.txt now',
                  'see /home/alice/notes',
                ].join('\n'),
              },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const text =
      document.blocks[0]?.kind === 'user' ? document.blocks[0].text : '';

    expect(text).toContain('[home]');
    expect(text).not.toContain('alice');
    expect(text).not.toContain('John');
    expect(text).not.toContain('Smith');
    expect(text).not.toContain('urluser');
    expect(text).not.toContain('fileuser');
    expect(text).not.toContain('/home/');
    expect(text).not.toContain('%2Fhome');
  });

  it.each(['/Users/./bob', '/home/../home/alice', 'C:\\Users\\.\\alice'])(
    'redacts a structured home root with dot segments: %s',
    (cwd) => {
      const document = createExportTranscriptDocumentV1(
        [record('structured-dot-path', null)],
        {
          ...sessionData,
          metadata: { ...sessionData.metadata, cwd },
        },
        EXPORT_OPTIONS,
      );

      expect(document.metadata.projectName).toBe('[home]');
    },
  );

  it('marks excluded file attachments as incomplete', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('user-file-ref', null, {
          message: {
            role: 'user',
            parts: [{ text: 'check\n\n@attachment:///secret.log' }],
          },
          systemPayload: {
            displayText: 'check\n\n@attachment:///secret.log',
            hookContext: '',
            attachmentReferences: [
              {
                type: 'resource',
                attachmentId: 'secret.log',
                mimeType: 'text/plain',
                size: 6,
              },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );

    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(document.diagnostics).toContainEqual({
      code: 'file_attachment_excluded',
      severity: 'warning',
      count: 1,
    });
  });

  it('re-caps labels after home-path redaction grows them', () => {
    const document = createExportTranscriptDocumentV1(
      [record('label-growth', null)],
      {
        ...sessionData,
        metadata: {
          ...sessionData.metadata,
          model: `${'m'.repeat(188)}file:/home/a`,
        },
      },
      EXPORT_OPTIONS,
    );

    expect(document.metadata.model).toHaveLength(200);
    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(document.diagnostics).toContainEqual({
      code: 'label_sanitized',
      severity: 'warning',
      count: 1,
    });
  });

  it('redacts home roots while preserving percent-encoded basenames', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('read-home-root', null, {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'read-home',
                  name: 'read_file',
                  args: { path: '/home/alice' },
                },
              },
              {
                functionCall: {
                  id: 'read-literal',
                  name: 'read_file',
                  args: { path: '/tmp/%2Fhome%2Falice%2Fnotes' },
                },
              },
              {
                functionCall: {
                  id: 'read-file-url-home',
                  name: 'read_file',
                  args: { path: 'file:///home/alice' },
                },
              },
            ],
          },
        }),
      ],
      {
        ...sessionData,
        metadata: { ...sessionData.metadata, cwd: '/Users/bob' },
      },
      EXPORT_OPTIONS,
    );

    expect(document.metadata.projectName).toBe('[home]');
    expect(
      document.blocks
        .filter((block) => block.kind === 'tool')
        .map((block) => block.preview),
    ).toEqual([
      { kind: 'file_read', path: '[home]' },
      { kind: 'file_read', path: '%2Fhome%2Falice%2Fnotes' },
      { kind: 'file_read', path: '[home]' },
    ]);
  });

  it('redacts encoded home paths without aborting on token prefixes or invalid escapes', () => {
    const encodedHomePath = '%2Fhome%2Falice';
    const document = createExportTranscriptDocumentV1(
      [
        record('encoded-home-paths', null, {
          message: {
            role: 'user',
            parts: [
              {
                text: [
                  `prefixed=foo${encodedHomePath}`,
                  `nested=logpath${encodedHomePath}%2Fnotes.txt`,
                  'windows=abc%2FUsers%2Fbob',
                  `assignment=DIR%3D${encodedHomePath}`,
                  'leading=%%2Fhome%2Falice',
                  `invalid=x=${encodedHomePath}%%`,
                ].join('\n'),
              },
            ],
          },
        }),
      ],
      {
        ...sessionData,
        metadata: {
          ...sessionData.metadata,
          gitRepo: `owner/${encodedHomePath}`,
        },
      },
      EXPORT_OPTIONS,
    );
    const text =
      document.blocks[0]?.kind === 'user' ? document.blocks[0].text : '';

    expect(text).toContain('prefixed=foo[home]');
    expect(text).toContain('nested=logpath[home]');
    expect(text).toContain('windows=abc[home]');
    expect(text).toContain('assignment=DIR=[home]');
    expect(text).toContain('leading=%[home]');
    expect(text).toContain('invalid=x=[home]');
    expect(text).not.toContain(encodedHomePath);
    expect(text).not.toContain('%2FUsers%2Fbob');
    expect(document.metadata.repository).toBe(encodedHomePath);
  });

  it('redacts nested home layouts in projectName', () => {
    for (const cwd of [
      '/usr/home/alice',
      '/export/home/alice',
      '\\server\\home\\alice',
    ]) {
      const document = createExportTranscriptDocumentV1(
        [
          record('nested-home', null, {
            message: {
              role: 'user',
              parts: [{ text: 'nested home probe' }],
            },
          }),
        ],
        {
          ...sessionData,
          metadata: { ...sessionData.metadata, cwd },
        },
        EXPORT_OPTIONS,
      );
      expect(document.metadata.projectName).toBe('[home]');
    }
  });

  it('fails closed when encoded home paths exceed the decode-pass limit', () => {
    const encodeLayers = (value: string, count: number) => {
      let encoded = value;
      for (let index = 0; index < count; index += 1) {
        encoded = encodeURIComponent(encoded);
      }
      return encoded;
    };
    const unix = encodeLayers('/home/alice/private.txt', 4);
    const windows = encodeLayers('C:\\Users\\bob\\private.txt', 4);
    const document = createExportTranscriptDocumentV1(
      [
        record('deeply-encoded-home-paths', null, {
          message: {
            role: 'user',
            parts: [{ text: `Unix ${unix}\nWindows ${windows}` }],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const text =
      document.blocks[0]?.kind === 'user' ? document.blocks[0].text : '';

    expect(text).not.toContain(unix);
    expect(text).not.toContain(windows);
    expect(text).not.toContain('alice');
    expect(text).not.toContain('bob');
  });

  it('redacts home paths split across literal and encoded text boundaries', () => {
    const payloads = [
      '/home%2Falice/private.txt',
      '/Users%2Falice/private.txt',
      '/home%5Calice/private.txt',
      '/hom%65/alice/private.txt',
      'data:image/png;base64,QUJD/home/alice/private.txt',
      '![x](data:image/png;base64,iVBORw0KGgo=)/home/alice/private.txt',
    ];
    const document = createExportTranscriptDocumentV1(
      [
        record('split-encoded-home-paths', null, {
          message: {
            role: 'user',
            parts: [{ text: payloads.join('\n') }],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const text =
      document.blocks[0]?.kind === 'user' ? document.blocks[0].text : '';

    for (const payload of payloads) expect(text).not.toContain(payload);
    expect(text).not.toContain('alice');
  });

  it('exports qwen-native edit args as a complete file diff', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('edit-user', null),
        record('edit-start', 'edit-user', {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'edit-native',
                  name: 'edit',
                  args: {
                    file_path: '/workspace/project/src/index.ts',
                    old_string: 'const value = 1;',
                    new_string: 'const value = 2;',
                  },
                },
              },
            ],
          },
        }),
        record('edit-result', 'edit-start', {
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'edit-native',
                  name: 'edit',
                  response: { output: 'Edit applied' },
                },
              },
            ],
          },
          toolCallResult: {
            callId: 'edit-native',
            status: 'success',
            resultDisplay: {
              fileName: 'src/index.ts',
              originalContent: 'const value = 1;',
              newContent: 'const value = 2;',
              fileDiff: '-const value = 1;\n+const value = 2;',
            },
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const edit = document.blocks.find(
      (block) => block.kind === 'tool' && block.toolName === 'edit',
    );

    expect(edit).toMatchObject({
      preview: {
        kind: 'file_diff',
        path: 'index.ts',
        oldText: 'const value = 1;',
        newText: 'const value = 2;',
      },
      resultPreview: { kind: 'text', text: 'File change applied' },
    });
    expect(document.metadata).toMatchObject({
      complete: true,
      truncated: false,
    });
    expect(document.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'tool_result_presentation_missing' }),
    );
  });

  it('does not treat remote URL paths as local home paths', () => {
    const urls = [
      'https://example.com./home/alice/notes.txt',
      'https://[::1]/home/alice/notes.txt',
    ];
    const document = createExportTranscriptDocumentV1(
      [
        record('remote-url-text', null, {
          message: {
            role: 'user',
            parts: [{ text: urls.join('\n') }],
          },
        }),
        record('remote-url-tools', 'remote-url-text', {
          type: 'assistant',
          message: {
            role: 'model',
            parts: urls.map((url, index) => ({
              functionCall: {
                id: `fetch-${index}`,
                name: 'web_fetch',
                args: { url },
              },
            })),
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const text =
      document.blocks[0]?.kind === 'user' ? document.blocks[0].text : '';
    const fetchUrls = document.blocks.flatMap((block) =>
      block.kind === 'tool' && block.preview.kind === 'web_fetch'
        ? [block.preview.url]
        : [],
    );

    expect(text).toBe(urls.join('\n'));
    expect(fetchUrls).toEqual(urls);
  });

  it('preserves visible turns across excluded causal system records', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('turn-1-user', null, {
          message: { role: 'user', parts: [{ text: 'TURN1_USER' }] },
        }),
        record('turn-1-assistant', 'turn-1-user', {
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'TURN1_ASSISTANT' }] },
        }),
        record('turn-result', 'turn-1-assistant', {
          type: 'system',
          subtype: 'turn_result',
          systemPayload: { status: 'completed' },
        }),
        record('turn-2-user', 'turn-result', {
          message: { role: 'user', parts: [{ text: 'TURN2_USER' }] },
        }),
        record('turn-2-assistant', 'turn-2-user', {
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'TURN2_ASSISTANT' }] },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const text = document.blocks
      .flatMap((block) => ('text' in block ? [block.text] : []))
      .join('\n');

    expect(text).toContain('TURN1_USER');
    expect(text).toContain('TURN1_ASSISTANT');
    expect(text).toContain('TURN2_USER');
    expect(text).toContain('TURN2_ASSISTANT');
    expect(text).not.toContain('saved history is incomplete');
    expect(document.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'history_gap' }),
    );
  });

  it('preserves visible slash-command output', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('slash-result', null, {
          type: 'system',
          subtype: 'slash_command',
          systemPayload: {
            phase: 'result',
            rawCommand: '/summary',
            outputHistoryItems: [
              { type: 'assistant', text: 'SLASH_VISIBLE_OUTPUT' },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );

    expect(
      document.blocks.some(
        (block) =>
          'text' in block && block.text.includes('SLASH_VISIBLE_OUTPUT'),
      ),
    ).toBe(true);
    expect(document.metadata.complete).toBe(true);
  });

  it('sanitizes Windows drive-root metadata instead of aborting', () => {
    const document = createExportTranscriptDocumentV1(
      [],
      { ...sessionData, metadata: { ...sessionData.metadata, cwd: 'C:\\' } },
      EXPORT_OPTIONS,
    );

    expect(document.metadata.projectName).toBe('[path]');
  });

  it('sanitizes typed preview fields before schema validation', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('preview-tools', null, {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'ask-1',
                  name: 'ask_user_question',
                  args: {
                    questions: [
                      {
                        header: '\u0001',
                        question: 'Continue?',
                        options: [],
                      },
                    ],
                  },
                },
              },
              {
                functionCall: {
                  id: 'read-1',
                  name: 'read_file',
                  args: { file_path: 'source.ts', lineRange: [-5, 1.5] },
                },
              },
              {
                functionCall: {
                  id: 'code-1',
                  name: 'exec_code',
                  args: { code: 'print(1)', origin: '\u0001' },
                },
              },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const previews = document.blocks.flatMap((block) =>
      block.kind === 'tool' ? [block.preview] : [],
    );

    expect(previews).toContainEqual({
      kind: 'ask_user_question',
      questions: [{ question: 'Continue?', options: [], raw: null }],
    });
    expect(previews).toContainEqual({
      kind: 'file_read',
      path: 'source.ts',
      range: [0, 1],
    });
    expect(previews).toContainEqual({ kind: 'code_block', code: 'print(1)' });
  });

  it('rejects backslash authority Markdown destinations', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('unsafe-link', null, {
          message: {
            role: 'user',
            parts: [{ text: '[download](/\\evil.example/file)' }],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const text =
      document.blocks[0]?.kind === 'user' ? document.blocks[0].text : '';

    expect(text).toBe('download');
    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
  });

  it('does not charge plain text fences as rich render tasks', () => {
    const content = Array.from(
      { length: EXPORT_TRANSCRIPT_LIMITS_V1.maxRichRenderTasks + 1 },
      (_, index) => `\`\`\`text\nplain-${index}\n\`\`\``,
    ).join('\n');
    const document = createExportTranscriptDocumentV1(
      [
        record('plain-fences', null, {
          message: { role: 'user', parts: [{ text: content }] },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const text =
      document.blocks[0]?.kind === 'user' ? document.blocks[0].text : '';

    expect(text).not.toContain('source fallback');
    expect(document.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'rich_render_budget_exceeded' }),
    );
  });

  it('degrades instead of aborting when JSON escaping exceeds the envelope', () => {
    const raster = 'A'.repeat(
      Math.floor(EXPORT_TRANSCRIPT_LIMITS_V1.maxRasterBytes / 3) * 4,
    );
    const escapeDenseText = '<'.repeat(100_000);
    const records = Array.from({ length: 75 }, (_, index) =>
      record(
        `large-envelope-${index}`,
        index === 0 ? null : `large-envelope-${index - 1}`,
        {
          type: index % 2 === 0 ? 'user' : 'assistant',
          message: {
            role: index % 2 === 0 ? 'user' : 'model',
            parts:
              index === 0
                ? [
                    { text: escapeDenseText },
                    { inlineData: { mimeType: 'image/png', data: raster } },
                    { inlineData: { mimeType: 'image/png', data: raster } },
                  ]
                : [{ text: escapeDenseText }],
          },
        },
      ),
    );
    const document = createExportTranscriptDocumentV1(records, sessionData, {
      rendererVersion: '0.21.11-test.1',
      exportedAt: '2026-08-16T01:00:00.000Z',
    });

    expect(
      new TextEncoder().encode(
        escapeJsonForHtmlScriptData(JSON.stringify(document)),
      ).byteLength,
    ).toBeLessThanOrEqual(EXPORT_TRANSCRIPT_LIMITS_V1.maxEnvelopeBytes);
    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(document.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'envelope_budget_exceeded' }),
    );
  });

  it('degrades a completed tool when its safe result preview is unavailable', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('tool-start', null, {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'large-result',
                  name: 'read_file',
                  args: { path: 'large.txt' },
                },
              },
            ],
          },
        }),
        record('tool-result', 'tool-start', {
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'large-result',
                  name: 'read_file',
                  response: { output: 'x'.repeat(100_001) },
                },
              },
            ],
          },
          toolCallResult: {
            callId: 'large-result',
            resultDisplay: 'x'.repeat(100_001),
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const tool = document.blocks.find((block) => block.kind === 'tool');

    expect(tool?.resultPreview).toEqual({
      kind: 'text',
      text: '[tool result omitted from export]',
    });
    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(document.diagnostics).toContainEqual({
      code: 'tool_result_presentation_missing',
      severity: 'error',
      count: 1,
    });
  });

  it('rewrites todo, plan, dependency, and delegation references opaquely', () => {
    const nativeTodoId = `todo-${CANARY}`;
    const nativeDependencyId = `dependency-${CANARY}`;
    const nativePlanId = `plan-${CANARY}`;
    const nativeParentDelegationId = `parent-${CANARY}`;
    const document = createExportTranscriptDocumentV1(
      [
        record('todo-tool', null, {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'todo-call',
                  name: 'todo_write',
                  args: {
                    entries: [
                      {
                        content: 'Safe todo',
                        status: 'completed',
                        _meta: {
                          qwenTodo: {
                            id: nativeTodoId,
                            blockedBy: [nativeDependencyId],
                          },
                        },
                      },
                    ],
                    plan: { id: nativePlanId, revision: 1 },
                  },
                },
              },
            ],
          },
        }),
        record('todo-result', 'todo-tool', {
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'todo-call',
                  name: 'todo_write',
                  response: { output: 'Todo completed' },
                },
              },
            ],
          },
          toolCallResult: {
            callId: 'todo-call',
            resultDisplay: {
              type: 'todo_list',
              planId: nativePlanId,
              todos: [
                {
                  id: nativeTodoId,
                  content: 'Safe todo',
                  status: 'completed',
                  blockedBy: [nativeDependencyId],
                },
              ],
            },
          },
        }),
        record('delegation-tool', 'todo-result', {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'delegation-call',
                  name: 'Task',
                  args: {
                    agentName: 'reviewer',
                    task: 'Review safely',
                    parentDelegationId: nativeParentDelegationId,
                  },
                },
              },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const serialized = JSON.stringify(document);
    const todoTool = document.blocks.find(
      (block) =>
        block.kind === 'tool' && block.resultPreview?.kind === 'todo_list',
    );
    const delegationTool = document.blocks.find(
      (block) =>
        block.kind === 'tool' && block.preview.kind === 'subagent_delegation',
    );

    expect(serialized).not.toContain(CANARY);
    expect(todoTool?.kind).toBe('tool');
    expect(delegationTool?.kind).toBe('tool');
    if (todoTool?.kind !== 'tool' || delegationTool?.kind !== 'tool') {
      throw new Error('Expected projected tool blocks.');
    }
    expect(todoTool.resultPreview).toMatchObject({
      kind: 'todo_list',
      entries: [
        {
          id: expect.stringMatching(/^todo-/),
          blockedBy: [expect.stringMatching(/^todo-/)],
        },
      ],
      planId: expect.stringMatching(/^plan-/),
    });
    expect(delegationTool.preview).toMatchObject({
      kind: 'subagent_delegation',
      parentDelegationId: expect.stringMatching(/^tool-call-/),
    });
  });

  it('exports a truncated todo preview without widening the schema', () => {
    const entries = Array.from({ length: 1_001 }, (_, index) => ({
      content: `Task ${index}`,
      status: 'pending',
    }));
    const document = createExportTranscriptDocumentV1(
      [
        record('todo-tool', null, {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'todo-call',
                  name: 'todo_write',
                  args: {
                    entries,
                  },
                },
              },
            ],
          },
        }),
        record('todo-result', 'todo-tool', {
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'todo-call',
                  name: 'todo_write',
                  response: { output: 'Todo list saved' },
                },
              },
            ],
          },
          toolCallResult: {
            callId: 'todo-call',
            resultDisplay: { type: 'todo_list', todos: entries },
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const tool = document.blocks.find(
      (block) =>
        block.kind === 'tool' && block.resultPreview?.kind === 'todo_list',
    );
    if (tool?.kind !== 'tool' || tool.resultPreview?.kind !== 'todo_list') {
      throw new Error('Expected a projected todo result.');
    }

    expect(tool.resultPreview).toMatchObject({
      kind: 'todo_list',
      truncated: true,
    });
    expect(tool.resultPreview.entries).toHaveLength(1_000);
    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(document.diagnostics).toContainEqual({
      code: 'todo_preview_truncated',
      severity: 'warning',
      count: 1,
    });
    const validationCandidate = {
      ...document,
      blocks: document.blocks.map((block) =>
        block === tool ? { ...block, preview: tool.resultPreview } : block,
      ),
    };
    expect(() =>
      assertExportTranscriptDocumentV1(validationCandidate),
    ).not.toThrow();
  });

  it('reduces permission outcomes to safe terminal states', () => {
    const nativeOptionId = `allow-${CANARY}`;
    const options = [
      {
        optionId: nativeOptionId,
        label: 'Allow once',
        raw: { kind: 'allow_once', credential: CANARY },
      },
    ];

    const approved = classifyPermissionResolutionForExport(
      `selected:${nativeOptionId}`,
      options,
    );
    const unknown = classifyPermissionResolutionForExport(
      `selected:missing-${CANARY}`,
      options,
    );
    const terminalCases = [
      ['deny', 'rejected'],
      ['reject_always', 'rejected'],
      ['cancel', 'cancelled'],
      ['timeout', 'expired'],
    ] as const;

    expect(approved).toEqual({ value: 'approved', lossy: false });
    expect(unknown).toEqual({ value: 'resolved', lossy: true });
    for (const [input, value] of terminalCases) {
      expect(classifyPermissionResolutionForExport(input, options)).toEqual({
        value,
        lossy: false,
      });
    }
    expect(
      classifyPermissionResolutionForExport('selected:reject', [
        {
          optionId: 'reject',
          label: 'Reject',
          raw: { kind: 'reject_always' },
        },
      ]),
    ).toEqual({ value: 'rejected', lossy: false });
    expect(JSON.stringify({ approved, unknown })).not.toContain(CANARY);
  });

  it('marks visible text budget degradation before rendering', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('user-large', null),
        record('large', 'user-large', {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'edit-large',
                  name: 'edit',
                  args: {
                    path: '/Users/tester/large.ts',
                    oldText: '中'.repeat(150_000),
                    newText: 'small',
                  },
                },
              },
            ],
          },
        }),
        record('after-large', 'large', {
          message: {
            role: 'user',
            parts: [{ text: 'AFTER_BLOCK_PRESENT' }],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );

    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(document.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'text_budget_exceeded' }),
      ]),
    );
    expect(JSON.stringify(document.blocks)).toContain(
      '[content omitted: export text budget exceeded]',
    );
    expect(JSON.stringify(document.blocks)).toContain('AFTER_BLOCK_PRESENT');

    const records = Array.from({ length: 100 }, (_, index) => {
      const assistant = index % 2 === 1;
      return record(`budget-${index}`, index ? `budget-${index - 1}` : null, {
        type: assistant ? 'assistant' : 'user',
        message: {
          role: assistant ? 'model' : 'user',
          parts: [{ text: 'x'.repeat(100_000) }],
        },
      });
    });
    const globallyBounded = createExportTranscriptDocumentV1(
      records,
      sessionData,
      EXPORT_OPTIONS,
    );

    expect(globallyBounded.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(
      new TextEncoder().encode(
        globallyBounded.blocks
          .map((block) => ('text' in block ? block.text : ''))
          .join(''),
      ).byteLength,
    ).toBeLessThanOrEqual(EXPORT_TRANSCRIPT_LIMITS_V1.maxVisibleTextBytes);
  });

  it('degrades pathological markdown without throwing a raw range error', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('deep-markdown', null, {
          message: {
            role: 'user',
            parts: [
              {
                text: `${'> '.repeat(6_000)}[link](https://example.com)`,
              },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );

    expect(document.blocks[0]).toMatchObject({
      kind: 'user',
      text: '[markdown omitted: complexity limit exceeded]',
    });
    expect(document.diagnostics).toContainEqual({
      code: 'markdown_complexity_exceeded',
      severity: 'warning',
      count: 1,
    });
    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
  });

  it('marks rich-task complexity fallback as incomplete', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('rich-task-complexity', null, {
          message: {
            role: 'user',
            parts: [
              {
                text: ['```mermaid', 'graph TD', '```', '['.repeat(513)].join(
                  '\n',
                ),
              },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );

    expect(document.blocks[0]).toMatchObject({
      kind: 'user',
      text: '[markdown omitted: complexity limit exceeded]',
    });
    expect(document.diagnostics).toContainEqual({
      code: 'markdown_complexity_exceeded',
      severity: 'warning',
      count: 1,
    });
    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
  });

  it('marks sanitized metadata URLs as incomplete without leaking secrets', () => {
    const document = createExportTranscriptDocumentV1(
      [record('user-url', null)],
      {
        ...sessionData,
        metadata: {
          ...sessionData.metadata,
          gitRepo:
            'https://alice:password@example.com/qwen-code?token=secret#fragment',
        },
      },
      EXPORT_OPTIONS,
    );
    const serialized = JSON.stringify(document);

    expect(document.metadata).toMatchObject({
      repository: 'https://example.com/qwen-code',
      complete: false,
      truncated: true,
    });
    expect(document.diagnostics).toContainEqual({
      code: 'url_sanitized',
      severity: 'warning',
      count: 1,
    });
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secret');
  });

  it('marks array truncation before rendering', () => {
    const questions = Array.from(
      { length: EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength + 1 },
      (_, index) => ({ question: `Question ${index}`, options: [] }),
    );
    const document = createExportTranscriptDocumentV1(
      [
        record('question-tool', null, {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'question-1',
                  name: 'ask_user_question',
                  args: { questions },
                },
              },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const tool = document.blocks.find((block) => block.kind === 'tool');

    expect(tool?.preview.kind).toBe('ask_user_question');
    expect(
      tool?.preview.kind === 'ask_user_question'
        ? tool.preview.questions.length
        : 0,
    ).toBe(EXPORT_TRANSCRIPT_LIMITS_V1.maxArrayLength);
    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(document.diagnostics).toContainEqual({
      code: 'array_budget_exceeded',
      severity: 'warning',
      count: 1,
    });
  });

  it('sanitizes active Markdown links without changing code examples', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('markdown-links', null, {
          message: {
            role: 'user',
            parts: [
              {
                text: [
                  '[safe](https://example.com/path)',
                  '[credential](https://alice:password@example.com/private?CHAT_TRANSCRIPT_URL_CANARY#fragment)',
                  '[unsafe](javascript:CHAT_TRANSCRIPT_URL_CANARY)',
                  '[space]( javascript:CHAT_TRANSCRIPT_URL_CANARY )',
                  '<javascript:CHAT_TRANSCRIPT_URL_CANARY>',
                  '<https://bob:password@example.com/autolink?CHAT_TRANSCRIPT_URL_CANARY>',
                  'https://carol:password@example.com/bare?CHAT_TRANSCRIPT_URL_CANARY#fragment',
                  'www.example.com/path?CHAT_TRANSCRIPT_URL_CANARY',
                  '`[unequal](javascript:CHAT_TRANSCRIPT_URL_CANARY)``',
                  '> [evil]: javascript:CHAT_TRANSCRIPT_URL_CANARY',
                  '> [reference][evil]',
                  '```js `not-a-fence`',
                  '[after-invalid-fence](javascript:CHAT_TRANSCRIPT_URL_CANARY)',
                  '`https://dave:password@example.com/inline?CHAT_TRANSCRIPT_URL_CANARY`',
                  'You can clone with:',
                  '    git clone https://frank:password@example.com/repo.git?CHAT_TRANSCRIPT_URL_CANARY',
                  '> ```bash',
                  '> curl https://grace:password@example.com/api?CHAT_TRANSCRIPT_URL_CANARY',
                  '> ```',
                  '```text',
                  'https://erin:password@example.com/fenced?CHAT_TRANSCRIPT_URL_CANARY',
                  '```',
                ].join('\n'),
              },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const text =
      document.blocks[0]?.kind === 'user' ? document.blocks[0].text : '';

    expect(text).toContain('[safe](https://example.com/path)');
    expect(text).toContain('[credential](<https://example.com/private>)');
    expect(text).toContain('\nhttps://example.com/autolink\n');
    expect(text).toContain('https://example.com/bare');
    expect(text).toContain('http://www.example.com/path');
    expect(text).not.toContain(
      'https://example.com/autolink?CHAT_TRANSCRIPT_URL_CANARY',
    );
    expect(text).not.toContain(
      'https://example.com/bare?CHAT_TRANSCRIPT_URL_CANARY',
    );
    expect(text).not.toContain(
      'http://www.example.com/path?CHAT_TRANSCRIPT_URL_CANARY',
    );
    expect(text).toContain(
      '`https://dave:password@example.com/inline?CHAT_TRANSCRIPT_URL_CANARY`',
    );
    expect(text).toContain('https://example.com/repo.git');
    expect(text).toContain(
      '> curl https://grace:password@example.com/api?CHAT_TRANSCRIPT_URL_CANARY',
    );
    expect(text).toContain(
      'https://erin:password@example.com/fenced?CHAT_TRANSCRIPT_URL_CANARY',
    );
    expect(text).not.toContain('javascript:');
    expect(text).not.toContain('frank:password');
    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(document.diagnostics).toEqual(
      expect.arrayContaining([
        { code: 'url_rejected', severity: 'warning', count: 6 },
        { code: 'url_sanitized', severity: 'warning', count: 5 },
      ]),
    );
  });

  it('preserves Markdown-like syntax inside structured code fields', () => {
    const code = [
      "const endpoint = 'https://example.com/api?mode=test#fragment';",
      "const literal = '![not-an-image](https://example.com/image.png)';",
    ].join('\n');
    const document = createExportTranscriptDocumentV1(
      [
        record('code-tool', null, {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'code-1',
                  name: 'exec_code',
                  args: { language: 'typescript', code },
                },
              },
            ],
          },
        }),
        record('code-result', 'code-tool', {
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'code-1',
                  name: 'exec_code',
                  response: { output: 'ok' },
                },
              },
            ],
          },
          toolCallResult: {
            callId: 'code-1',
            resultDisplay: {
              type: 'vision_bridge_notice',
              summary: 'Execution complete',
              notice: 'No output.',
            },
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const tool = document.blocks.find((block) => block.kind === 'tool');

    expect(tool?.preview).toEqual({
      kind: 'code_block',
      language: 'typescript',
      code,
    });
    expect(document.metadata).toMatchObject({
      complete: true,
      truncated: false,
    });
  });

  it('freezes rich rendering after 100 tasks while preserving safe source', () => {
    const content = Array.from(
      { length: EXPORT_TRANSCRIPT_LIMITS_V1.maxRichRenderTasks + 1 },
      (_, index) => `\`\`\`mermaid\ngraph TD; A${index}-->B${index}\n\`\`\``,
    ).join('\n');
    const document = createExportTranscriptDocumentV1(
      [
        record('rich-user', null, {
          message: { role: 'user', parts: [{ text: content }] },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );

    const block = document.blocks[0];
    expect(block?.kind).toBe('user');
    expect(block && 'text' in block ? block.text : '').toContain(
      '```text [source fallback: mermaid]',
    );
    expect(document.metadata).toMatchObject({
      complete: true,
      truncated: false,
    });
    expect(document.diagnostics).toContainEqual({
      code: 'rich_render_budget_exceeded',
      severity: 'warning',
      count: 1,
    });
  });

  it('counts renderer-compatible fence variants and container fences', () => {
    const fence = (index: number): string => {
      switch (index % 4) {
        case 0:
          return `\`\`\`\`mermaid\ngraph TD; A${index}-->B${index}\n\`\`\`\``;
        case 1:
          return `~~~~ mermaid\ngraph TD; A${index}-->B${index}\n~~~~`;
        case 2:
          return `> \`\`\`mermaid\n> graph TD; A${index}-->B${index}\n> \`\`\``;
        default:
          return `\`\`\`\tmermaid\ngraph TD; A${index}-->B${index}\n\`\`\``;
      }
    };
    const content = Array.from(
      { length: EXPORT_TRANSCRIPT_LIMITS_V1.maxRichRenderTasks + 1 },
      (_, index) => fence(index),
    ).join('\n');
    const document = createExportTranscriptDocumentV1(
      [
        record('rich-variants', null, {
          message: { role: 'user', parts: [{ text: content }] },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );

    expect(document.diagnostics).toContainEqual({
      code: 'rich_render_budget_exceeded',
      severity: 'warning',
      count: 1,
    });
  });

  it('budgets image-generation thumbnails as raster data, not visible text', () => {
    const thumbnailData = `/Users/alice${'A'.repeat(600 * 1024 - 12)}`;
    const thumbnailUrl = `data:IMAGE/PNG;base64,${thumbnailData}`;
    const document = createExportTranscriptDocumentV1(
      [
        record('image-tool', null, {
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'image-1',
                  name: 'dalle3_generate',
                  args: { prompt: 'A safe image', thumbnailUrl },
                },
              },
            ],
          },
        }),
        record('image-result', 'image-tool', {
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'image-1',
                  name: 'dalle3_generate',
                  response: { output: 'Generated image' },
                },
              },
            ],
          },
          toolCallResult: {
            callId: 'image-1',
            resultDisplay: 'Generated image',
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const tool = document.blocks.find((block) => block.kind === 'tool');

    expect(tool?.preview).toMatchObject({
      kind: 'image_generation',
      thumbnailUrl: `data:image/png;base64,${thumbnailData}`,
    });
    expect(JSON.stringify(document)).not.toContain('data:IMAGE/PNG');
    expect(document.metadata).toMatchObject({
      complete: true,
      truncated: false,
    });
    expect(document.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'text_budget_exceeded' }),
      ]),
    );
  });

  it('rejects home paths in validated visible text without inspecting raster data', () => {
    const envelope = {
      schemaVersion: 1,
      rendererVersion: '0.21.11-test.1',
      diagnostics: [],
      metadata: {
        exportedAt: '2026-08-16T01:00:00.000Z',
        complete: true,
        truncated: false,
      },
    };

    expect(() =>
      assertExportTranscriptDocumentV1({
        ...envelope,
        blocks: [
          {
            id: 'user-home-path',
            kind: 'user',
            clientReceivedAt: 0,
            createdAt: 0,
            updatedAt: 0,
            text: 'Leaked /Users/alice/private.txt',
            streaming: false,
          },
        ],
      }),
    ).toThrowError('home_path_forbidden');

    expect(() =>
      assertExportTranscriptDocumentV1({
        ...envelope,
        blocks: [
          {
            id: 'user-file-home-path',
            kind: 'user',
            clientReceivedAt: 0,
            createdAt: 0,
            updatedAt: 0,
            text: 'Leaked file://localhost/HOME/alice/private.txt',
            streaming: false,
          },
        ],
      }),
    ).toThrowError('home_path_forbidden');

    expect(() =>
      assertExportTranscriptDocumentV1({
        ...envelope,
        blocks: [
          {
            id: 'user-raster-data',
            kind: 'user',
            clientReceivedAt: 0,
            createdAt: 0,
            updatedAt: 0,
            text: 'Safe image',
            streaming: false,
            images: [{ data: '/home/AA', mimeType: 'image/png' }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects schema and semantic safety violations', () => {
    const envelope = (
      blocks: unknown[] = [],
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      schemaVersion: 1,
      rendererVersion: '0.21.11-test.1',
      blocks,
      diagnostics: [],
      metadata: {
        exportedAt: '2026-08-16T01:00:00.000Z',
        complete: true,
        truncated: false,
      },
      ...overrides,
    });
    const block = (
      id: string,
      kind: string,
      fields: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      id,
      kind,
      clientReceivedAt: 0,
      createdAt: 0,
      updatedAt: 0,
      ...fields,
    });
    const tool = (fields: Record<string, unknown>): Record<string, unknown> =>
      block('tool-safe', 'tool', {
        toolCallId: 'read-1',
        title: 'Read',
        status: 'completed',
        preview: { kind: 'file_read', path: 'index.ts' },
        ...fields,
      });
    const cases: Array<{ value: unknown; error: string }> = [
      {
        value: envelope([], { rendererVersion: 'latest' }),
        error: 'schema_validation_failed',
      },
      {
        value: { ...envelope(), widened: true },
        error: 'schema_validation_failed',
      },
      {
        value: envelope([
          block('duplicate', 'prompt_cancelled'),
          block('duplicate', 'prompt_cancelled'),
        ]),
        error: 'duplicate_block_id',
      },
      {
        value: envelope([
          block('permission-safe', 'permission', {
            requestId: 'permission-1',
            title: 'Allow read?',
            options: [
              { optionId: 'permission-option-1', label: 'Allow', raw: null },
            ],
            preview: { kind: 'generic' },
            resolved: 'selected:' + CANARY,
          }),
        ]),
        error: 'schema_validation_failed',
      },
      {
        value: envelope([tool({ status: 'failed', title: 'Read failed' })]),
        error: 'schema_validation_failed',
      },
      {
        value: envelope([
          tool({ resultPreview: { kind: 'generic', summary: '   ' } }),
        ]),
        error: 'schema_validation_failed',
      },
      {
        value: envelope([
          tool({
            preview: {
              kind: 'file_read',
              path: 'index.ts',
              credential: CANARY,
            },
          }),
        ]),
        error: 'schema_validation_failed',
      },
      {
        value: envelope([
          block('error-safe', 'error', {
            text: 'Failed safely',
            errorKind: 'unknown-' + CANARY,
          }),
        ]),
        error: 'schema_validation_failed',
      },
      {
        value: envelope([
          tool({
            toolCallId: 'image-1',
            title: 'Generate image',
            status: 'cancelled',
            preview: {
              kind: 'image_generation',
              prompt: 'A safe image',
              thumbnailUrl: 'data:IMAGE/PNG;base64,iVBORw0KGgo=',
            },
          }),
        ]),
        error: 'schema_validation_failed',
      },
      {
        value: envelope([
          block('user-safe', 'user', {
            text: 'Hello',
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        ]),
        error: 'schema_validation_failed',
      },
      {
        value: envelope([
          block('user-safe', 'user', {
            text: '![remote](https://example.invalid/track.png)',
            streaming: false,
          }),
        ]),
        error: 'invalid_markdown_image',
      },
      {
        value: envelope([
          block('user-safe', 'user', {
            text: '[![remote](https://example.invalid/nested-track.png)](https://example.com)',
            streaming: false,
          }),
        ]),
        error: 'invalid_markdown_image',
      },
      {
        value: envelope([
          block('user-safe', 'user', {
            text: '[credential](https://alice:password@example.com/path?token=canary)',
            streaming: false,
          }),
        ]),
        error: 'invalid_markdown_url',
      },
      {
        value: envelope([], {
          metadata: {
            exportedAt: '2026-08-16T01:00:00.000Z',
            complete: true,
            truncated: false,
            repository: 'https://secret@example.com/qwen-code?token=canary',
          },
        }),
        error: 'invalid_metadata',
      },
      {
        value: envelope([], {
          diagnostics: [
            { code: 'url_sanitized', severity: 'warning', count: 1 },
          ],
          metadata: {
            exportedAt: '2026-08-16T01:00:00.000Z',
            complete: false,
            truncated: false,
          },
        }),
        error: 'invalid_metadata_state',
      },
    ];

    for (const testCase of cases) {
      expect(() =>
        assertExportTranscriptDocumentV1(testCase.value),
      ).toThrowError(testCase.error);
    }
  });

  it('rejects cyclic envelopes before recursive field validation', () => {
    const document = createExportTranscriptDocumentV1([], sessionData, {
      rendererVersion: '0.21.11-test.1',
      exportedAt: '2026-08-16T01:00:00.000Z',
    });
    const cyclic = structuredClone(document) as unknown as Record<
      string,
      unknown
    >;
    cyclic['metadata'] = cyclic;

    expect(() => assertExportTranscriptDocumentV1(cyclic)).toThrowError(
      expect.objectContaining({ code: 'cyclic_envelope' }),
    );
  });

  it('rejects unsafe structured URLs that JSON Schema cannot express', () => {
    expect(() =>
      assertExportTranscriptDocumentV1({
        schemaVersion: 1,
        rendererVersion: '0.21.11-test.1',
        blocks: [
          {
            id: 'unsafe-fetch',
            kind: 'tool',
            clientReceivedAt: 0,
            createdAt: 0,
            updatedAt: 0,
            toolCallId: 'fetch-1',
            title: 'Fetch',
            status: 'cancelled',
            preview: {
              kind: 'web_fetch',
              url: 'https://alice:password@example.com/path?token=secret',
            },
          },
        ],
        diagnostics: [],
        metadata: {
          exportedAt: '2026-08-16T01:00:00.000Z',
          complete: true,
          truncated: false,
        },
      }),
    ).toThrowError('invalid_block');
  });

  it('preserves semantic validation for diagnostic labels', () => {
    const document = createExportTranscriptDocumentV1([], sessionData, {
      rendererVersion: '0.21.11-test.1',
      exportedAt: '2026-08-16T01:00:00.000Z',
    });

    expect(() =>
      assertExportTranscriptDocumentV1({
        ...document,
        diagnostics: [{ code: 'unsafe\nlabel', severity: 'info', count: 1 }],
      }),
    ).toThrowError('invalid_diagnostic');
  });

  it('rejects object property floods before field validation', () => {
    const document = createExportTranscriptDocumentV1([], sessionData, {
      rendererVersion: '0.21.11-test.1',
      exportedAt: '2026-08-16T01:00:00.000Z',
    });
    const metadata = Object.fromEntries(
      Array.from(
        { length: EXPORT_TRANSCRIPT_LIMITS_V1.maxObjectProperties + 1 },
        (_, index) => [`extra-${index}`, index],
      ),
    );

    expect(() =>
      assertExportTranscriptDocumentV1({ ...document, metadata }),
    ).toThrowError(
      expect.objectContaining({ code: 'object_property_budget_exceeded' }),
    );
  });

  it('applies the structured raster policy to Markdown images', () => {
    const document = createExportTranscriptDocumentV1(
      [
        record('markdown-images', null, {
          message: {
            role: 'user',
            parts: [
              {
                text: [
                  '![remote](https://example.invalid/track.png)',
                  '[![nested remote](https://example.invalid/nested-track.png?u=victim)](https://example.com)',
                  '![svg](data:image/svg+xml;base64,PHN2Zy8+)',
                  '![safe](data:image/png;base64,iVBORw0KGgo=)',
                  '[![nested safe](data:image/png;base64,iVBORw0KGgo=)](https://example.com)',
                  '',
                  '![animated reference][animated-gif]',
                  '',
                  '[animated-gif]: data:image/gif;base64,LAAs',
                  '',
                  '![remote reference][tracker]',
                  '',
                  '[tracker]: https://example.invalid/reference.png',
                  '',
                  '<img src="https://example.invalid/html.png">',
                  '',
                  '`![inline code](https://example.invalid/inline-code.png)`',
                  '```md',
                  '![fenced code](https://example.invalid/fenced-code.png)',
                  '```',
                  '    ![indented code](https://example.invalid/indented-code.png)',
                  '\\![escaped image](https://example.invalid/escaped-image.png)',
                  '\\\\![even escape](https://example.invalid/even-escape.png)',
                  '\\\\\\![odd escape](https://example.invalid/odd-escape.png)',
                ].join('\n'),
              },
            ],
          },
        }),
      ],
      sessionData,
      EXPORT_OPTIONS,
    );
    const text =
      document.blocks[0]?.kind === 'user' ? document.blocks[0].text : '';

    expect(text).not.toContain('track.png');
    expect(text).not.toContain('nested-track.png');
    expect(text).not.toContain('<img');
    expect(text).toContain('inline-code.png');
    expect(text).toContain('fenced-code.png');
    expect(text).toContain('indented-code.png');
    expect(text).toContain('escaped-image.png');
    expect(text).not.toContain('even-escape.png');
    expect(text).toContain('odd-escape.png');
    expect(text).not.toContain('image/svg+xml');
    expect(text).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(text).toContain(
      '[![nested safe](data:image/png;base64,iVBORw0KGgo=)](https://example.com)',
    );
    expect(text).not.toContain('![animated reference](');
    expect(document.metadata).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(document.diagnostics).toContainEqual({
      code: 'markdown_image_rejected',
      severity: 'warning',
      count: 7,
    });
  });

  it('accepts a static GIF whose compressed payload contains descriptor bytes', () => {
    const staticGif =
      'R0lGODlhCAAIAPUAAAAAABUAAAAcABoLGwAgAAAxAAA+AB0oGQMbN2UcGEM1AGsnJwBFCQBzBRhNIh9XOmFBNxAATBg5XTUTZGcTT1IsTT56RlVlQk1teGhrZ4I8XVqhUX2Vczl0hklUgmGRkm2Co22uwIiBg5KSkpmljZWEoq2IuYWzqYi/rJm7oJ+1uJ67vbi5u7i8u8Cxl8WSqciitLP2utzFs7WU2NCgwtOZ7vas/73Ow7T32Lf938bRxNHgz8vf69js7gAAAAAAACH5BAAAAAAALAAAAAAIAAgAAAY6wJ0u1+PJaDaW6oaLsWa1UOm0QrleMNEHNDKlSCOIxoPZcDIdSmIxuVgekooiEGE0HIjBoQAgGAQAQQA7';

    expect(() =>
      assertExportTranscriptDocumentV1({
        schemaVersion: 1,
        rendererVersion: '0.21.11-test.1',
        blocks: [
          {
            id: 'user-safe',
            kind: 'user',
            clientReceivedAt: 0,
            createdAt: 0,
            updatedAt: 0,
            text: 'Static GIF',
            streaming: false,
            images: [{ data: staticGif, mimeType: 'image/gif' }],
          },
        ],
        diagnostics: [],
        metadata: {
          exportedAt: '2026-08-16T01:00:00.000Z',
          complete: true,
          truncated: false,
        },
      }),
    ).not.toThrow();
  });

  it('freezes every V1 limit in one shared constant', () => {
    expect(EXPORT_TRANSCRIPT_LIMITS_V1).toEqual({
      maxBlocks: 1_000,
      maxTextBytes: 400 * 1024,
      maxVisibleTextBytes: 8 * 1024 * 1024,
      maxRasterBytes: 8 * 1024 * 1024,
      maxTotalRasterBytes: 16 * 1024 * 1024,
      maxEnvelopeBytes: 32 * 1024 * 1024,
      maxObjectDepth: 16,
      maxObjectProperties: 1_000,
      maxArrayLength: 1_000,
      maxRichRenderTasks: 100,
    });
  });

  it('escapes HTML script terminators in serialized document data', () => {
    const escaped = escapeJsonForHtmlScriptData(
      JSON.stringify({ text: '</ScRiPt><!--\u2028\u2029' }),
    );

    expect(escaped.toLowerCase()).not.toContain('</script');
    expect(escaped).not.toContain('<!--');
    expect(escaped).toContain('\\u2028');
    expect(escaped).toContain('\\u2029');
  });

  it('rejects invalid producer versions and export timestamps', () => {
    expect(() =>
      createExportTranscriptDocumentV1([], sessionData, {
        ...EXPORT_OPTIONS,
        rendererVersion: 'latest',
      }),
    ).toThrowError('invalid_renderer_version');
    expect(() =>
      createExportTranscriptDocumentV1([], sessionData, {
        ...EXPORT_OPTIONS,
        exportedAt: 'not-a-date',
      }),
    ).toThrowError('invalid_exported_at');
  });
});
