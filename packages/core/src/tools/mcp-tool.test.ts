/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import sharp from 'sharp';
import type { Mock, Mocked } from 'vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import {
  DiscoveredMCPTool,
  generateValidName,
  type McpDirectClient,
  type McpToolAnnotations,
} from './mcp-tool.js';
import type { McpAppToolResult, ToolResult } from './tools.js';
import { ToolConfirmationOutcome } from './tools.js';
import type { Config } from '../config/config.js';
import type { CallableTool, Part } from '@google/genai';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { ToolErrorType } from './tool-error.js';
import {
  MCPServerStatus,
  removeMCPServerStatus,
  updateMCPServerStatus,
} from './mcp-client.js';
import {
  INVOCATION_CONTEXT_META_KEY,
  runWithInvocationContext,
  type InvocationContextV1,
} from '../utils/invocation-context.js';
import * as imageView from '../utils/image-view.js';
import * as inlineMediaLimit from '../core/inlineMediaLimit.js';
import { fnResponse } from '../test-utils/model-fixtures.js';

vi.mock('node:fs/promises');

const { mockDebugWarn } = vi.hoisted(() => ({ mockDebugWarn: vi.fn() }));
vi.mock('../utils/debugLogger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/debugLogger.js')>()),
  createDebugLogger: () => ({
    isEnabled: () => false,
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockDebugWarn,
    error: vi.fn(),
  }),
}));

// Only the parts of CallableTool that DiscoveredMCPTool uses are mocked.
const mockCallTool = vi.fn();
const mockToolMethod = vi.fn();

const mockCallableToolInstance: Mocked<CallableTool> = {
  tool: mockToolMethod as any, // Not directly used by DiscoveredMCPTool instance methods
  callTool: mockCallTool as any,
};

describe('generateValidName', () => {
  it('should return a valid name for a simple function', () => {
    expect(generateValidName('myFunction')).toBe('myFunction');
  });

  it('should replace invalid characters with underscores', () => {
    const normalized = generateValidName('invalid-name with spaces');
    expect(normalized).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    expect(normalized).not.toBe('invalid-name with spaces');
  });

  it('should normalize dotted MCP names for strict providers', () => {
    const normalized = generateValidName(
      'mcp__zybio__literature.search_pubmed',
    );

    expect(normalized).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    expect(normalized).not.toContain('.');
    expect(normalized).toBe(
      generateValidName('mcp__zybio__literature.search_pubmed'),
    );
    expect(generateValidName(normalized)).toBe(normalized);
  });

  it('should not collide after replacing unsupported characters', () => {
    expect(generateValidName('mcp__zybio__literature.search_pubmed')).not.toBe(
      generateValidName('mcp__zybio__literature_search_pubmed'),
    );
  });

  it('should truncate long names', () => {
    const name = 'x'.repeat(80);
    const normalized = generateValidName(name);

    expect(normalized).toHaveLength(63);
    expect(normalized).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    expect(normalized).toBe(generateValidName(name));
    expect(normalized).not.toBe(generateValidName(`${name}y`));
  });

  it('should handle names with only invalid characters', () => {
    expect(generateValidName('!@#$%^&*()')).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
  });

  it.each([
    ['should handle names that are exactly 63 characters long', 63],
    ['should handle names that are exactly 64 characters long', 64],
    ['should handle names that are longer than 64 characters', 80],
  ])('%s', (_title, length) => {
    expect(generateValidName('a'.repeat(length)).length).toBe(63);
  });
});

describe('DiscoveredMCPTool', () => {
  const serverName = 'mock-mcp-server';
  const serverToolName = 'actual-server-tool-name';
  const baseDescription = 'A test MCP tool.';
  const inputSchema: Record<string, unknown> = {
    type: 'object' as const,
    properties: { param: { type: 'string' } },
    required: ['param'],
  };

  let tool: DiscoveredMCPTool;

  // Names the positional constructor arguments; omitted ones stay undefined.
  const mkTool = (
    o: {
      callable?: CallableTool;
      toolName?: string;
      trust?: boolean;
      config?: unknown;
      client?: McpDirectClient;
      timeout?: number;
      idle?: number;
      annotations?: McpToolAnnotations;
      allowCtx?: boolean;
      appUri?: string;
      appUi?: Record<string, unknown>;
      appResourceLimits?: DiscoveredMCPTool['appResourceLimits'];
    } = {},
  ) =>
    new DiscoveredMCPTool(
      o.callable ?? mockCallableToolInstance,
      serverName,
      o.toolName ?? serverToolName,
      baseDescription,
      inputSchema,
      o.trust,
      undefined,
      o.config as Config,
      o.client,
      o.timeout,
      o.idle,
      o.annotations,
      false,
      o.allowCtx,
      o.appUri,
      o.appUi,
      o.appResourceLimits,
    );
  const exec = (
    t: DiscoveredMCPTool = tool,
    param = 'test',
    signal = new AbortController().signal,
  ) => t.build({ param }).execute(signal);

  type Blocks = NonNullable<McpAppToolResult['content']>;
  const textBlock = (text: string) => ({ type: 'text', text });
  const textResult = (text: string) => ({ content: [textBlock(text)] });
  const img = (data: string, mimeType = 'image/png') => ({
    type: 'image',
    data,
    mimeType,
  });
  const directClient = (content: Blocks): McpDirectClient => ({
    callTool: vi.fn(async () => ({ content })),
  });
  const failing = (error: unknown): McpDirectClient => ({
    callTool: vi.fn().mockRejectedValueOnce(error),
  });
  const coded = (message: string, code = -32001) =>
    Object.assign(new Error(message), { code });
  // The text part announcing an inline part, and the pair it heads.
  const banner = (kind: string, mimeType: string) =>
    `[Tool '${serverToolName}' provided the following ${kind} with mime-type: ${mimeType}]`;
  const media = (kind: string, mimeType: string, data: string): Part[] => [
    { text: banner(kind, mimeType) },
    { inlineData: { mimeType, data } },
  ];

  describe('invocation context metadata', () => {
    const invocationContext: InvocationContextV1 = {
      version: 1,
      sessionId: 'session-1',
      promptId: 'prompt-1',
      originatorClientId: 'client-1',
    };

    const createDirectTool = (client: McpDirectClient, allowCtx: boolean) =>
      mkTool({ client, allowCtx });

    const successfulClient = () =>
      ({
        callTool: vi.fn<McpDirectClient['callTool']>(async () =>
          textResult('ok'),
        ),
      }) satisfies McpDirectClient;

    it.each(['summary', 'json', 'empty'] as const)(
      'preserves CUA action handles with %s content',
      async (kind) => {
        const structuredContent = {
          snapshot_id: 's00000001',
          elements: [{ element_token: 's00000001:8', label: 'View' }],
        };
        const serialized = JSON.stringify(structuredContent);
        const content =
          kind === 'empty'
            ? []
            : [
                {
                  type: 'text' as const,
                  text: kind === 'json' ? serialized : 'View menu',
                },
              ];
        const mcpClient: McpDirectClient = {
          callTool: vi.fn(async () => ({ content, structuredContent })),
        };
        const result = await exec(createDirectTool(mcpClient, false));
        expect(result.llmContent).toEqual([
          { text: serialized },
          ...(kind === 'summary' ? [{ text: 'View menu' }] : []),
        ]);
      },
    );

    it('injects trusted request metadata for an allowed stdio tool', async () => {
      const mcpClient = successfulClient();
      const modelArguments = {
        param: 'test',
        _meta: {
          [INVOCATION_CONTEXT_META_KEY]: { forged: true },
        },
      };

      await runWithInvocationContext(invocationContext, () =>
        createDirectTool(mcpClient, true)
          .build(modelArguments)
          .execute(new AbortController().signal),
      );

      expect(mcpClient.callTool).toHaveBeenCalledWith(
        {
          name: serverToolName,
          arguments: modelArguments,
          _meta: {
            [INVOCATION_CONTEXT_META_KEY]: invocationContext,
          },
        },
        expect.objectContaining({ onprogress: expect.any(Function) }),
      );
    });

    it.each([
      { allowInvocationContext: false, runWithContext: true },
      { allowInvocationContext: true, runWithContext: false },
    ])(
      'omits request metadata for $allowInvocationContext/$runWithContext',
      async ({ allowInvocationContext, runWithContext }) => {
        const mcpClient = successfulClient();
        const execute = () =>
          exec(createDirectTool(mcpClient, allowInvocationContext));

        if (runWithContext) {
          await runWithInvocationContext(invocationContext, execute);
        } else {
          await execute();
        }

        expect(
          Object.hasOwn(
            vi.mocked(mcpClient.callTool).mock.calls[0][0],
            '_meta',
          ),
        ).toBe(false);
      },
    );

    it('preserves the policy through qualification and trust clones', async () => {
      const mcpClient = successfulClient();
      const clonedTool = createDirectTool(mcpClient, true)
        .asFullyQualifiedTool()
        .withTrust(true);

      await runWithInvocationContext(invocationContext, () => exec(clonedTool));

      expect(vi.mocked(mcpClient.callTool).mock.calls[0][0]._meta).toEqual({
        [INVOCATION_CONTEXT_META_KEY]: invocationContext,
      });
    });
  });

  beforeEach(() => {
    mockCallTool.mockClear();
    mockToolMethod.mockClear();
    tool = mkTool();
  });

  afterEach(() => {
    removeMCPServerStatus(serverName);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('constructor', () => {
    it('should set properties correctly', () => {
      const expectedName = `mcp__${serverName}__${serverToolName}`;
      expect(tool.name).toBe(expectedName);
      expect(tool.schema.name).toBe(expectedName);
      expect(tool.schema.description).toBe(baseDescription);
      expect(tool.schema.parameters).toBeUndefined();
      expect(tool.schema.parametersJsonSchema).toEqual(inputSchema);
      expect(tool.serverToolName).toBe(serverToolName);
    });
  });

  describe('execute', () => {
    // A PNG signature and IHDR tag: sniffs as PNG, yet is too short to decode.
    const PNG_HEADER = 'iVBORw0KGgoAAAANSUhEUg==';
    const parseError = '[Error: Could not parse tool response]';

    // The callable tool answers with one functionResponse part.
    const respond = (response: Record<string, unknown>) => {
      const parts = [fnResponse(serverToolName, response)];
      mockCallTool.mockResolvedValue(parts);
      return parts;
    };
    const runContent = (content: unknown[], param?: string) => {
      respond({ content });
      return exec(tool, param);
    };
    const pngResponse = () => respond({ content: [img(PNG_HEADER)] });
    const solid = (width: number, height: number, channels: 3 | 4 = 3) =>
      sharp({ create: { width, height, channels, background: '#204080' } });
    const b64 = async (image: ReturnType<typeof sharp>) =>
      (await image.toBuffer()).toString('base64');
    const oversizedPngBase64 = () => b64(solid(3840, 2160).png());
    const dims = (data: string) =>
      sharp(Buffer.from(data, 'base64')).metadata();
    const longEdge = async (data: string) => {
      const { width, height } = await dims(data);
      return Math.max(width, height);
    };

    it('should call mcpTool.callTool with correct parameters and format display output', async () => {
      const text = JSON.stringify({ success: true, details: 'executed' });
      const toolResult: ToolResult = await runContent(
        [{ type: 'text', text }],
        'testValue',
      );

      expect(mockCallTool).toHaveBeenCalledWith([
        { name: serverToolName, args: { param: 'testValue' } },
      ]);
      expect(toolResult.llmContent).toEqual([{ text }]);
      expect(toolResult.returnDisplay).toBe(text);
    });

    it('should handle empty result from getDisplayFromParts', async () => {
      mockCallTool.mockResolvedValue([]);
      const toolResult = await exec(tool, 'testValue');
      expect(toolResult.returnDisplay).toBe(parseError);
      expect(toolResult.llmContent).toEqual([{ text: parseError }]);
    });

    it('should propagate rejection if mcpTool.callTool rejects', async () => {
      const expectedError = new Error('MCP call failed');
      mockCallTool.mockRejectedValue(expectedError);
      await expect(exec(tool, 'failCase')).rejects.toThrow(expectedError);
    });

    it.each([
      { isErrorValue: true, description: 'true (bool)' },
      { isErrorValue: 'true', description: '"true" (str)' },
    ])(
      'should return a structured error if MCP tool reports an error',
      async ({ isErrorValue }) => {
        const parts = respond({ error: { isError: isErrorValue } });
        const result = await exec(tool, 'isErrorTrueCase');

        expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
        expect(result.llmContent).toBe(
          `MCP tool '${serverToolName}' reported tool error for function call: ${safeJsonStringify(
            { name: serverToolName, args: { param: 'isErrorTrueCase' } },
          )} with response: ${safeJsonStringify(parts)}`,
        );
        expect(result.returnDisplay).toContain(
          `Error: MCP tool '${serverToolName}' reported an error.`,
        );
      },
    );

    it('preserves typed images returned with an MCP tool error', async () => {
      respond({
        error: { isError: true },
        content: [textBlock('failure context'), img('ERROR_IMAGE_DATA')],
      });
      const result = await exec(tool, 'error-image');

      expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
      expect(result.error?.message).toContain('failure context');
      expect(result.error?.message).not.toContain('ERROR_IMAGE_DATA');
      expect(result.llmContent).toEqual([
        { text: 'failure context' },
        ...media('image data', 'image/png', 'ERROR_IMAGE_DATA'),
      ]);
    });

    it.each([
      { isErrorValue: false, description: 'false (bool)' },
      { isErrorValue: 'false', description: '"false" (str)' },
    ])(
      'should consider a ToolResult with isError ${description} to be a success',
      async ({ isErrorValue }) => {
        const text = JSON.stringify({ success: true, details: 'executed' });
        respond({
          error: { isError: isErrorValue },
          content: [textBlock(text)],
        });
        const toolResult = await exec(tool, 'isErrorFalseCase');
        expect(toolResult.llmContent).toEqual([{ text }]);
        expect(toolResult.returnDisplay).toBe(text);
      },
    );

    it('should handle a simple text response correctly', async () => {
      const successMessage = 'This is a success message.';
      // The GenAI SDK wraps the MCP response, whose `content` holds MCP
      // ContentBlocks, in a functionResponse Part.
      const toolResult = await runContent([textBlock(successMessage)]);

      // llmContent is a clean Part array; the display is the plain text.
      expect(toolResult.llmContent).toEqual([{ text: successMessage }]);
      expect(toolResult.returnDisplay).toBe(successMessage);
      expect(mockCallTool).toHaveBeenCalledWith([
        { name: serverToolName, args: { param: 'test' } },
      ]);
    });

    const link = (uri: string) => ({
      type: 'resource_link',
      uri,
      name: 'resource-name',
      title: 'My Resource',
    });
    const embeddedText = (text: string) => ({
      type: 'resource',
      resource: {
        uri: 'file:///path/to/text.txt',
        text,
        mimeType: 'text/plain',
      },
    });
    const jpeg = 'BASE64_IMAGE_DATA';

    it.each<[string, unknown[], Part[], string]>([
      [
        'should handle an AudioBlock response',
        [{ type: 'audio', data: 'BASE64_AUDIO_DATA', mimeType: 'audio/mp3' }],
        media('audio data', 'audio/mp3', 'BASE64_AUDIO_DATA'),
        `${banner('audio data', 'audio/mp3')}\n[audio/mp3]`,
      ],
      [
        'should handle a ResourceLinkBlock response',
        [link('file:///path/to/thing')],
        [{ text: 'Resource Link: My Resource at file:///path/to/thing' }],
        'Resource Link: My Resource at file:///path/to/thing',
      ],
      [
        'should handle an embedded text ResourceBlock response',
        [embeddedText('This is the text content.')],
        [{ text: 'This is the text content.' }],
        'This is the text content.',
      ],
      [
        'should handle an embedded binary ResourceBlock response',
        [
          {
            type: 'resource',
            resource: {
              uri: 'file:///path/to/data.bin',
              blob: 'BASE64_BINARY_DATA',
              mimeType: 'application/octet-stream',
            },
          },
        ],
        media(
          'embedded resource',
          'application/octet-stream',
          'BASE64_BINARY_DATA',
        ),
        `${banner('embedded resource', 'application/octet-stream')}\n[application/octet-stream]`,
      ],
      [
        'should handle a mix of content block types',
        [
          textBlock('First part.'),
          img(jpeg, 'image/jpeg'),
          textBlock('Second part.'),
        ],
        [
          { text: 'First part.' },
          ...media('image data', 'image/jpeg', jpeg),
          { text: 'Second part.' },
        ],
        `First part.\n${banner('image data', 'image/jpeg')}\n[image/jpeg]\nSecond part.`,
      ],
      [
        'should ignore unknown content block types',
        [textBlock('Valid part.'), { type: 'future_block', data: 'some-data' }],
        [{ text: 'Valid part.' }],
        'Valid part.',
      ],
      [
        'should handle a complex mix of content block types',
        [
          textBlock('Here is a resource.'),
          link('file:///path/to/resource'),
          embeddedText('Embedded text content.'),
          img(jpeg, 'image/jpeg'),
        ],
        [
          { text: 'Here is a resource.' },
          { text: 'Resource Link: My Resource at file:///path/to/resource' },
          { text: 'Embedded text content.' },
          ...media('image data', 'image/jpeg', jpeg),
        ],
        `Here is a resource.\nResource Link: My Resource at file:///path/to/resource\nEmbedded text content.\n${banner('image data', 'image/jpeg')}\n[image/jpeg]`,
      ],
    ])('%s', async (_title, content, llmContent, returnDisplay) => {
      const toolResult = await runContent(content);
      expect(toolResult.llmContent).toEqual(llmContent);
      expect(toolResult.returnDisplay).toBe(returnDisplay);
    });

    it('bounds an oversized image returned by an MCP tool', async () => {
      const toolResult = await runContent(
        [img(await oversizedPngBase64())],
        'screenshot',
      );

      const parts = toolResult.llmContent as Part[];
      // The envelope names the mime the model receives, not the server's.
      expect(parts[0]!.text).toContain('mime-type: image/jpeg]');
      const inline = parts[1]!.inlineData!;
      expect(inline.mimeType).toBe('image/jpeg');
      const bounded = await dims(inline.data!);
      expect(Math.max(bounded.width, bounded.height)).toBeLessThanOrEqual(1568);
      expect(
        Math.ceil(bounded.width / 28) * Math.ceil(bounded.height / 28),
      ).toBeLessThanOrEqual(1568);
    });

    it('bounds images sequentially', async () => {
      const mockBoundImageBuffer = vi.spyOn(imageView, 'boundImageBuffer');
      let releaseFirst!: () => void;
      const first = new Promise<null>((resolve) => {
        releaseFirst = () => resolve(null);
      });
      mockBoundImageBuffer
        .mockImplementationOnce(() => first)
        .mockResolvedValueOnce(null);

      const execution = runContent(
        [img(PNG_HEADER), img(PNG_HEADER)],
        'screenshots',
      );
      await vi.waitFor(() => expect(mockBoundImageBuffer).toHaveBeenCalled());
      const callsBeforeRelease = mockBoundImageBuffer.mock.calls.length;
      releaseFirst();
      await execution;
      expect(callsBeforeRelease).toBe(1);
      expect(mockBoundImageBuffer).toHaveBeenCalledTimes(2);
      // The renderer's error messages label bytes by their source; a bare mime
      // type identifies no server, and several can be configured at once.
      const firstLabel = mockBoundImageBuffer.mock.calls[0]?.[1];
      expect(firstLabel).toContain(`${serverName}/${serverToolName}`);
      expect(firstLabel).toContain('image/png');
    });

    describe('omni delivery exemption', () => {
      // Under omni delivery the funnel uploads these parts by reference, so
      // the inline clamp here would withhold an image it could deliver.
      const omniStub = (deliveryActive: boolean, omniEnabled = true) => {
        const isOmniDeliveryActive = vi.fn(() => deliveryActive);
        const loadOmniMediaReader = vi.fn(async () => ({
          isOmniDeliveryActive,
        }));
        const config = {
          isOmniEnabled: vi.fn(() => omniEnabled),
          loadOmniMediaReader,
          getTruncateToolOutputThreshold: () => 1000,
          getTruncateToolOutputLines: () => 50,
          getUsageStatisticsEnabled: () => false,
          isTrustedFolder: () => true,
          storage: { getProjectTempDir: () => '/tmp/test-project' },
        } as any;
        return { config, loadOmniMediaReader, isOmniDeliveryActive };
      };

      // Shrink the clamp ceiling to 1 byte so any inline part would be
      // withheld if the clamp ran, standing in for a real oversized payload.
      const shrinkClamp = () => {
        const realClamp = inlineMediaLimit.clampInlineMediaPart;
        return vi
          .spyOn(inlineMediaLimit, 'clampInlineMediaPart')
          .mockImplementation((part, _limitBytes, remedy) =>
            realClamp(part, 1, remedy),
          );
      };

      it('delivers an over-limit image to omni instead of withholding it', async () => {
        const clamp = shrinkClamp();
        // The decoder rejects a >100 MiB source and forwards the part as-is.
        vi.spyOn(imageView, 'boundImageBuffer').mockRejectedValue(
          new imageView.ImageViewError(
            'source_too_large',
            `Image exceeds the 100 MB source limit: ${serverName}/${serverToolName} image/png`,
          ),
        );
        pngResponse();
        const { config, isOmniDeliveryActive } = omniStub(true);

        const result = await exec(mkTool({ config }), 'screenshot');

        expect(isOmniDeliveryActive).toHaveBeenCalledWith(config);
        expect(clamp).not.toHaveBeenCalled();
        expect(result.llmContent).toEqual(
          media('image data', 'image/png', PNG_HEADER),
        );
      });

      it('still withholds an over-limit image when omni delivery is inactive', async () => {
        const clamp = shrinkClamp();
        pngResponse();
        const { config } = omniStub(false);

        const result = await exec(mkTool({ config }), 'screenshot');

        expect(clamp).toHaveBeenCalled();
        const placeholder = (result.llmContent as Part[])[1]!;
        expect(placeholder.text).toContain('[Media omitted: image/png');
      });

      it('does not load the omni module when omni is disabled', async () => {
        // The cheap gate must run BEFORE the dynamic import: that import
        // touches the filesystem, which breaks mock-fs suites and costs a
        // module load for every non-omni user.
        shrinkClamp();
        pngResponse();
        const { config, loadOmniMediaReader } = omniStub(true, false);

        await exec(mkTool({ config }), 'screenshot');

        expect(loadOmniMediaReader).not.toHaveBeenCalled();
      });

      it('leaves audio to omni but still withholds a non-media blob', async () => {
        // The funnel only takes image, audio and video parts; anything else
        // stays inline whatever the delivery mode, so it keeps the limit.
        shrinkClamp();
        respond({
          content: [
            { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' },
            {
              type: 'resource',
              resource: { uri: 'file:///backup.zip', blob: 'AAAA' },
            },
          ],
        });
        const { config } = omniStub(true);

        const result = await exec(mkTool({ config }), 'mixed');

        const parts = result.llmContent as Part[];
        expect(parts[1]).toEqual({
          inlineData: { mimeType: 'audio/wav', data: 'AAAA' },
        });
        expect(parts[3]!.text).toContain(
          '[Media omitted: application/octet-stream',
        );
      });
    });

    it('never sends a non-image inline part to the renderer', async () => {
      const bound = vi.spyOn(imageView, 'boundImageBuffer');
      await runContent(
        [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }],
        'recording',
      );
      expect(bound).not.toHaveBeenCalled();
    });

    it('withholds oversized audio at the inline limit', async () => {
      // Audio is never resized, but it is still re-sent on every turn, so it
      // gets the same inline limit as images, as `read_file` applies.
      vi.stubEnv('QWEN_CODE_MAX_INLINE_MEDIA_BYTES', '1');
      const bound = vi.spyOn(imageView, 'boundImageBuffer');
      const result = await runContent(
        [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }],
        'recording',
      );

      expect(bound).not.toHaveBeenCalled();
      const parts = result.llmContent as Part[];
      expect(parts[0]!.text).toContain('audio data with mime-type: audio/wav]');
      expect(parts[1]!.text).toContain('[Media omitted: audio/wav');
      expect(parts[1]!.text).toContain('smaller or lower-resolution');
    });

    it('withholds an oversized untyped non-image blob without decoding it', async () => {
      // The bytes are not an image, so the renderer never sees them; the
      // inline limit still applies.
      vi.stubEnv('QWEN_CODE_MAX_INLINE_MEDIA_BYTES', '1');
      const bound = vi.spyOn(imageView, 'boundImageBuffer');
      const result = await runContent(
        [
          {
            type: 'resource',
            resource: { uri: 'file:///backup.zip', blob: 'AAAA' },
          },
        ],
        'archive',
      );

      expect(bound).not.toHaveBeenCalled();
      const parts = result.llmContent as Part[];
      expect(parts[1]!.text).toContain(
        '[Media omitted: application/octet-stream',
      );
    });

    it('warns with the server and tool when the renderer is unavailable', async () => {
      mockDebugWarn.mockClear();
      vi.spyOn(imageView, 'boundImageBuffer').mockRejectedValueOnce(
        new imageView.ImageViewError(
          'renderer_unavailable',
          'Image rendering is unavailable because the "sharp" image module could not be loaded.',
        ),
      );
      pngResponse();

      await exec(tool, 'screenshot');

      expect(mockDebugWarn).toHaveBeenCalledWith(
        expect.stringContaining(`${serverName}/${serverToolName}`),
      );
    });

    it.each(['already fits', 'renderer rejects'] as const)(
      'applies the inline media limit when an image %s',
      async (outcome) => {
        vi.stubEnv('QWEN_CODE_MAX_INLINE_MEDIA_BYTES', '1');
        const bound = vi.spyOn(imageView, 'boundImageBuffer');
        if (outcome === 'already fits') {
          bound.mockResolvedValueOnce(null);
        } else {
          bound.mockRejectedValueOnce(
            new imageView.ImageViewError('decode_failed', 'failed to decode'),
          );
        }
        pngResponse();

        const result = await exec(tool, 'screenshot');

        const parts = result.llmContent as Part[];
        expect(parts[0]).toEqual({ text: banner('image data', 'image/png') });
        const placeholder = parts[1]!.text!;
        expect(placeholder).toContain('[Media omitted: image/png');
        expect(placeholder).toContain('inline limit');
        // These bytes exist only inside the tool result, so the default advice
        // to reference an `@file` path cannot be followed.
        expect(placeholder).not.toContain('@file path');
        expect(placeholder).toContain('smaller or lower-resolution');
      },
    );

    it('leaves an in-budget image from an MCP tool untouched', async () => {
      const data = await b64(solid(200, 100, 4).png());
      const toolResult = await runContent([img(data)], 'icon');

      const parts = toolResult.llmContent as Part[];
      expect(parts[1]!.inlineData).toEqual({ mimeType: 'image/png', data });
    });

    it('re-encodes an in-budget image that outweighs the inline ceiling', async () => {
      // 1200x800 fits the visual budget (long edge 1200, 43x29 = 1247 patches)
      // but stored uncompressed it outweighs a 1 MiB ceiling, while the same
      // frame re-encodes to ~11 KB of JPEG. Deciding "already fits" on geometry
      // alone returns null here, and the trailing clamp then drops the part to
      // a placeholder instead of keeping the resized image.
      vi.stubEnv('QWEN_CODE_MAX_INLINE_MEDIA_BYTES', String(1024 * 1024));
      const heavy = await b64(solid(1200, 800).png({ compressionLevel: 0 }));

      const result = await runContent([img(heavy)], 'screenshot');

      const parts = result.llmContent as Part[];
      expect(parts[1]!.text).toBeUndefined();
      const inline = parts[1]!.inlineData!;
      expect(inline.mimeType).toBe('image/jpeg');
      expect(Buffer.from(inline.data!, 'base64').length).toBeLessThan(
        1024 * 1024,
      );
      expect(parts[0]!.text).toContain('mime-type: image/jpeg]');
    });

    it('forwards an image the renderer cannot bound unchanged', async () => {
      const data = await b64(solid(3840, 2160).gif());
      const bound = vi.spyOn(imageView, 'boundImageBuffer');

      const toolResult = await runContent([img(data, 'image/gif')], 'gif');

      const parts = toolResult.llmContent as Part[];
      expect(parts[1]!.inlineData).toEqual({ mimeType: 'image/gif', data });
      // The renderer cannot output GIF, so it is not asked to decode one.
      expect(bound).not.toHaveBeenCalled();
    });

    it('labels an in-budget image a resource block does not type', async () => {
      // MCP makes a resource's mime optional. Left as
      // application/octet-stream, the converters drop the image as
      // unsupported media, so the sniffed mime is adopted, bytes unchanged.
      const blob = await b64(solid(200, 100).png());

      const result = await runContent(
        [{ type: 'resource', resource: { uri: 'file:///icon.png', blob } }],
        'icon',
      );

      expect(result.llmContent).toEqual(
        media('embedded resource', 'image/png', blob),
      );
    });

    it('bounds an oversized image whose mime label is wrong', async () => {
      const result = await runContent(
        [img(await oversizedPngBase64(), 'IMAGE/PNG')],
        'screenshot',
      );

      const parts = result.llmContent as Part[];
      expect(parts[0]!.text).toContain('mime-type: image/jpeg]');
      expect(parts[1]!.inlineData!.mimeType).toBe('image/jpeg');
    });

    it('bounds an oversized image returned with an MCP tool error', async () => {
      respond({
        error: { isError: true },
        content: [
          textBlock('failure context'),
          img(await oversizedPngBase64()),
        ],
      });

      const result = await exec(tool, 'error-image');

      expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
      const parts = result.llmContent as Part[];
      expect(parts[2]!.inlineData!.mimeType).toBe('image/jpeg');
      expect(await longEdge(parts[2]!.inlineData!.data!)).toBeLessThanOrEqual(
        1568,
      );
    });

    it('bounds an oversized image returned through the direct client', async () => {
      const client = directClient([img(await oversizedPngBase64())]);

      const result = await exec(mkTool({ client }), 'screenshot');

      const parts = result.llmContent as Part[];
      expect(parts[1]!.inlineData!.mimeType).toBe('image/jpeg');
      expect(await longEdge(parts[1]!.inlineData!.data!)).toBeLessThanOrEqual(
        1568,
      );
    });

    it('fails the call when bounding is aborted', async () => {
      const abort = new Error('Tool call aborted');
      abort.name = 'AbortError';
      vi.spyOn(imageView, 'boundImageBuffer').mockRejectedValue(abort);
      pngResponse();

      await expect(exec(tool, 'screenshot')).rejects.toThrow(
        'Tool call aborted',
      );
    });

    describe('AbortSignal support', () => {
      it('should abort immediately if signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(exec(tool, 'test', controller.signal)).rejects.toThrow(
          'Tool call aborted',
        );

        // Tool should not be called if signal is already aborted
        expect(mockCallTool).not.toHaveBeenCalled();
      });

      it('should abort during tool execution', async () => {
        const controller = new AbortController();
        // A delayed response simulates a long-running tool.
        mockCallTool.mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve([fnResponse(serverToolName, textResult('Success'))]);
              }, 1000);
            }),
        );

        const promise = exec(tool, 'test', controller.signal);
        // Abort after a short delay to simulate cancellation during execution
        setTimeout(() => controller.abort(), 50);

        await expect(promise).rejects.toThrow('Tool call aborted');
      });

      it('should complete successfully if not aborted', async () => {
        respond(textResult('Success'));

        const result = await exec();

        expect(result.llmContent).toEqual([{ text: 'Success' }]);
        expect(result.returnDisplay).toBe('Success');
        expect(mockCallTool).toHaveBeenCalledWith([
          { name: serverToolName, args: { param: 'test' } },
        ]);
      });

      it('should handle tool error even when abort signal is provided', async () => {
        respond({ error: { isError: true } });

        const result = await exec();

        expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
        expect(result.returnDisplay).toContain(
          `Error: MCP tool '${serverToolName}' reported an error.`,
        );
      });

      it('should handle callTool rejection with abort signal', async () => {
        const expectedError = new Error('Network error');
        mockCallTool.mockRejectedValue(expectedError);
        await expect(exec()).rejects.toThrow(expectedError);
      });

      it('should cleanup event listeners properly on successful completion', async () => {
        const controller = new AbortController();
        respond(textResult('Success'));

        await exec(tool, 'test', controller.signal);

        controller.abort();
        expect(controller.signal.aborted).toBe(true);
      });

      it('should cleanup event listeners properly on error', async () => {
        const controller = new AbortController();
        const expectedError = new Error('Tool execution failed');
        mockCallTool.mockRejectedValue(expectedError);

        try {
          await exec(tool, 'test', controller.signal);
        } catch (error) {
          expect(error).toBe(expectedError);
        }

        // Verify cleanup by aborting after error
        controller.abort();
        expect(controller.signal.aborted).toBe(true);
      });

      it('forwards parent abort into the combined signal passed to the direct SDK client', async () => {
        let capturedSignal: AbortSignal | undefined;
        const mockDirectCallTool = vi.fn<McpDirectClient['callTool']>(
          async (_params, options) => {
            capturedSignal = options?.signal;
            return new Promise(() => {});
          },
        );
        const controller = new AbortController();
        const promise = exec(
          mkTool({ client: { callTool: mockDirectCallTool } }),
          'test',
          controller.signal,
        );

        await vi.waitFor(() => expect(mockDirectCallTool).toHaveBeenCalled());

        controller.abort();

        expect(capturedSignal?.aborted).toBe(true);
        await expect(promise).rejects.toThrow('Tool call aborted');
      });
    });
  });

  describe('getDefaultPermission and getConfirmationDetails', () => {
    const confirm = (t = tool) =>
      t
        .build({ param: 'mock' })
        .getConfirmationDetails(new AbortController().signal);

    it('should return ask if not trusted', async () => {
      const invocation = tool.build({ param: 'mock' });
      expect(await invocation.getDefaultPermission()).toBe('ask');
    });

    it('should return confirmation details when permission is ask', async () => {
      const invocation = tool.build({ param: 'mock' });
      expect(await invocation.getDefaultPermission()).toBe('ask');
      const confirmation = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );
      expect(confirmation.type).toBe('mcp');
      if (confirmation.type === 'mcp') {
        expect(confirmation.serverName).toBe(serverName);
        expect(confirmation.toolName).toBe(serverToolName);
      }
    });

    it('should have onConfirm as a no-op', async () => {
      const confirmation = await confirm();
      expect(confirmation).toHaveProperty('onConfirm');
      if (
        'onConfirm' in confirmation &&
        typeof confirmation.onConfirm === 'function'
      ) {
        // onConfirm should not throw for any outcome
        for (const outcome of [
          ToolConfirmationOutcome.ProceedAlwaysProject,
          ToolConfirmationOutcome.ProceedAlwaysUser,
          ToolConfirmationOutcome.Cancel,
          ToolConfirmationOutcome.ProceedOnce,
        ]) {
          await confirmation.onConfirm(outcome);
        }
      }
    });

    it('should include permissionRules with mcp__server__tool format', async () => {
      const confirmation = await confirm();
      expect(confirmation.type).toBe('mcp');
      if (confirmation.type === 'mcp') {
        expect(confirmation.permissionRules).toEqual([
          `mcp__${serverName}__${serverToolName}`,
        ]);
      }
    });

    it('should use the registered provider-safe name in permission rules', async () => {
      const dottedTool = mkTool({ toolName: 'literature.search_pubmed' });
      const confirmation = await confirm(dottedTool);

      expect(dottedTool.name).not.toContain('.');
      expect(dottedTool.schema.name).toBe(dottedTool.name);
      expect(confirmation.type).toBe('mcp');
      if (confirmation.type === 'mcp') {
        expect(confirmation.permissionRules).toEqual([dottedTool.name]);
      }
    });
  });

  describe('getDefaultPermission with folder trust', () => {
    const permission = (
      trust: boolean | undefined,
      isTrusted: boolean,
      annotations?: McpToolAnnotations,
    ) =>
      mkTool({
        trust,
        config: { isTrustedFolder: () => isTrusted },
        annotations,
      })
        .build({ param: 'mock' })
        .getDefaultPermission();

    it.each([
      {
        name: 'an untrusted server with readOnlyHint',
        trust: undefined,
        isTrustedFolder: true,
        readOnlyHint: true,
        expected: 'ask',
      },
      {
        name: 'a trusted server with readOnlyHint in an untrusted folder',
        trust: true,
        isTrustedFolder: false,
        readOnlyHint: true,
        expected: 'ask',
      },
      {
        name: 'a trusted server with readOnlyHint in a trusted folder',
        trust: true,
        isTrustedFolder: true,
        readOnlyHint: true,
        expected: 'allow',
      },
      {
        name: 'an untrusted server with readOnlyHint disabled',
        trust: undefined,
        isTrustedFolder: true,
        readOnlyHint: false,
        expected: 'ask',
      },
    ])('should return $expected for $name', async (testCase) => {
      expect(
        await permission(testCase.trust, testCase.isTrustedFolder, {
          readOnlyHint: testCase.readOnlyHint,
        }),
      ).toBe(testCase.expected);
    });

    it.each([
      [
        'should return allow when trust is true and folder is trusted',
        true,
        true,
        'allow',
      ],
      [
        'should return ask if trust is true but folder is not trusted',
        true,
        false,
        'ask',
      ],
      [
        'should return ask if trust is false, even if folder is trusted',
        false,
        true,
        'ask',
      ],
    ] as const)('%s', async (_title, trust, isTrusted, expected) => {
      expect(await permission(trust, isTrusted)).toBe(expected);
    });
  });

  describe('DiscoveredMCPToolInvocation', () => {
    it('should return the stringified params from getDescription', () => {
      const params = { param: 'testValue', param2: 'anotherOne' };
      const invocation = tool.build(params);
      const description = invocation.getDescription();
      expect(description).toBe('{"param":"testValue","param2":"anotherOne"}');
    });
  });

  describe('MCP Apps display', () => {
    const createAppTool = (
      client: McpDirectClient,
      appUi?: Record<string, unknown>,
      timeout?: number,
      appResourceLimits?: DiscoveredMCPTool['appResourceLimits'],
    ) =>
      mkTool({
        client,
        appUi,
        timeout,
        appResourceLimits,
        appUri: 'ui://demo/dashboard',
      });
    const runApp = (
      client: McpDirectClient,
      appUi?: Record<string, unknown>,
      timeout?: number,
      signal?: AbortSignal,
    ) => exec(createAppTool(client, appUi, timeout), 'test', signal);

    type ReadResource = NonNullable<McpDirectClient['readResource']>;
    type AppContents = Awaited<ReturnType<ReadResource>>['contents'];
    // A client whose tool call answers 'Dashboard ready' (plus `extra`) and
    // whose resources/read is `readResource`.
    const appClient = (
      readResource: ReadResource,
      extra: Record<string, unknown> = {},
    ): McpDirectClient => ({
      callTool: vi.fn(async () => ({
        ...textResult('Dashboard ready'),
        ...extra,
      })),
      readResource,
    });
    const reading = (...contents: AppContents) =>
      vi.fn(async () => ({ contents }));
    const appHtml = (extra: Record<string, unknown> = {}) => ({
      uri: 'ui://demo/dashboard',
      mimeType: 'text/html;profile=mcp-app',
      text: '<main>Revenue</main>',
      ...extra,
    });

    it('returns App results privately without rendering or leaking them', async () => {
      const raw = {
        content: [{ type: 'text', text: 'APP_SECRET_TOKEN' }],
        structuredContent: { jwt: 'APP_SECRET_TOKEN' },
        _meta: { token: 'APP_SECRET_TOKEN' },
      };
      const client = {
        callTool: vi.fn(async () => raw),
        readResource: vi.fn(),
      };
      const received = vi.fn();
      const progress = vi.fn();
      const result = await createAppTool(client)
        .buildForApp({ param: 'test' }, received)
        .execute(new AbortController().signal, progress);
      expect(received).toHaveBeenCalledWith(raw);
      expect(JSON.stringify(result)).not.toContain('APP_SECRET_TOKEN');
      expect(client.readResource).not.toHaveBeenCalled();
      expect(result.error).toBeUndefined();
    });

    it('keeps App errors private and does not retry a transport failure', async () => {
      const received = vi.fn();
      const client = {
        callTool: vi
          .fn()
          .mockResolvedValueOnce({
            isError: true,
            content: [{ type: 'text', text: 'APP_SECRET_TOKEN' }],
          })
          .mockRejectedValueOnce(
            new Error('Connection closed APP_SECRET_TOKEN'),
          ),
      };
      const tool = createAppTool(client);
      const result = await tool
        .buildForApp({ param: 'test' }, received)
        .execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
      expect(JSON.stringify(result)).not.toContain('APP_SECRET_TOKEN');
      await expect(
        tool
          .buildForApp({ param: 'test' }, received)
          .execute(new AbortController().signal),
      ).rejects.toThrow('MCP App tool call failed.');
      expect(client.callTool).toHaveBeenCalledTimes(2);
      expect(received).toHaveBeenCalledTimes(1);
    });

    it('suppresses App progress text and promptly cancels a non-cooperative server', async () => {
      let resolveCall!: (value: { content: [] }) => void;
      const progress = vi.fn();
      const received = vi.fn();
      const client: McpDirectClient = {
        callTool: vi.fn<McpDirectClient['callTool']>((_params, options) => {
          options?.onprogress?.({ progress: 1, message: 'APP_SECRET_TOKEN' });
          return new Promise((resolve) => {
            resolveCall = resolve;
          });
        }),
      };
      const abort = new AbortController();
      const execution = createAppTool(client)
        .buildForApp({ param: 'test' }, received)
        .execute(abort.signal, progress);
      abort.abort(new Error('APP_SECRET_TOKEN'));
      await expect(execution).rejects.toThrow();
      resolveCall({ content: [] });
      await Promise.resolve();
      expect(progress).not.toHaveBeenCalled();
      expect(received).not.toHaveBeenCalled();
      expect(client.callTool).toHaveBeenCalledTimes(1);
    });

    it('preserves App visibility through resource, qualified-name and session clones', () => {
      const tool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        'ui://demo/app',
        undefined,
        undefined,
        ['app'],
      );
      for (const clone of [
        tool.asFullyQualifiedTool(),
        tool.withAppResourceUi({}),
        tool.withSessionConfig(true, true),
        tool.withTrust(true),
      ]) {
        expect(clone.isAppVisible).toBe(true);
        expect(clone.isModelVisible).toBe(false);
        expect(clone.appVisibility).toEqual(['app']);
      }
    });

    const expectDiscardedLimitWarn = (
      key: 'appResourceMaxBytes' | 'appResourceTimeoutMs',
      warned: string | undefined,
    ) => {
      // The display warning legitimately names the key too, so match on the
      // discard line's own prefix to tell the two apart.
      expect(
        mockDebugWarn.mock.calls.some(
          ([message]) =>
            String(message).includes(
              `Ignoring non-finite MCP App resource limit mcpServers.${serverName}.${key}`,
            ) &&
            (warned === undefined || String(message).includes(warned)),
        ),
      ).toBe(warned !== undefined);
    };

    const expectAppLoadWarning = (result: ToolResult, reason: string) => {
      expect(result.returnDisplay).toEqual({
        type: 'mcp_app',
        serverName,
        resourceUri: 'ui://demo/dashboard',
        html: '',
        toolResult: { content: [{ type: 'text', text: 'Dashboard ready' }] },
        toolArguments: { param: 'test' },
        fallbackText: `Warning: MCP App 'ui://demo/dashboard' from '${serverName}' could not be displayed: ${reason}\n\nDashboard ready`,
      });
      expect(result.llmContent).toEqual([{ text: 'Dashboard ready' }]);
      expect(result.error).toBeUndefined();
    };

    it('loads an MCP App resource while preserving structured tool output', async () => {
      const mcpClient = appClient(
        reading(
          appHtml({
            _meta: {
              ui: {
                csp: { connectDomains: ['https://api.example.com'] },
                permissions: { clipboardWrite: {} },
              },
            },
          }),
        ),
        { structuredContent: { revenue: 42 } },
      );

      const result = await runApp(mcpClient);

      expect(result.llmContent).toEqual([
        { text: '{"revenue":42}' },
        { text: 'Dashboard ready' },
      ]);
      expect(result.returnDisplay).toMatchObject({
        type: 'mcp_app',
        resourceUri: 'ui://demo/dashboard',
        html: '<main>Revenue</main>',
        toolArguments: { param: 'test' },
        fallbackText: '{"revenue":42}\nDashboard ready',
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      });
    });

    it('uses listing-level app metadata when resources/read omits content _meta', async () => {
      const result = await runApp(appClient(reading(appHtml())), {
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      });

      expect(result.returnDisplay).toMatchObject({
        type: 'mcp_app',
        html: '<main>Revenue</main>',
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      });
    });

    it('lets content-level app metadata win over listing-level defaults', async () => {
      const mcpClient = appClient(
        reading(
          appHtml({
            _meta: {
              ui: { csp: { connectDomains: ['https://content.example.com'] } },
            },
          }),
        ),
      );

      const result = await runApp(mcpClient, {
        csp: { connectDomains: ['https://listing.example.com'] },
        permissions: { clipboardWrite: {} },
      });

      expect(result.returnDisplay).toMatchObject({
        type: 'mcp_app',
        csp: { connectDomains: ['https://content.example.com'] },
      });
      expect(
        (result.returnDisplay as { permissions?: unknown }).permissions,
      ).toBeUndefined();
    });

    it.each([
      {
        uri: 'ui://demo/dashboard',
        mimeType: 'text/html',
        text: '<main>Wrong MIME</main>',
        reason:
          'resource must return text/html;profile=mcp-app for ui://demo/dashboard',
      },
      {
        uri: 'ui://demo/other',
        mimeType: 'text/html;profile=mcp-app',
        text: '<main>Wrong URI</main>',
        reason: 'resource ui://demo/dashboard was not returned by the server',
      },
      {
        uri: 'ui://demo/dashboard',
        mimeType: 'text/html;profile=mcp-app',
        text: '',
        reason: 'resource did not return HTML content',
      },
    ])(
      'explains an invalid app resource: $text',
      async ({ reason, ...content }) => {
        const result = await runApp(appClient(reading(content)));
        expectAppLoadWarning(result, reason);
      },
    );

    it.each([
      { bytes: 1_048_576, encoding: 'text' },
      { bytes: 1_048_577, encoding: 'text' },
      { bytes: 1_048_577, encoding: 'blob' },
    ] as const)(
      'checks the UTF-8 size of a $bytes byte $encoding resource',
      async ({ bytes, encoding }) => {
        const html = `<main>é</main>${' '.repeat(bytes - 15)}`;
        const mcpClient = appClient(
          reading({
            uri: 'ui://demo/dashboard',
            mimeType: 'text/html;profile=mcp-app',
            ...(encoding === 'text'
              ? { text: html }
              : { blob: Buffer.from(html).toString('base64') }),
          }),
        );

        const result = await runApp(mcpClient);

        if (bytes === 1_048_576) {
          expect(result.returnDisplay).toMatchObject({ type: 'mcp_app', html });
        } else {
          expectAppLoadWarning(
            result,
            `resource HTML is 1048577 bytes, exceeding the 1048576 byte host limit (mcpServers.${serverName}.appResourceMaxBytes)`,
          );
        }
        expect(result.llmContent).toEqual([{ text: 'Dashboard ready' }]);
        expect(result.error).toBeUndefined();
      },
    );

    it.each([
      {
        mcpTimeout: undefined,
        deadline: true,
        expectedTimeout: 10_000,
        expectedKey: 'appResourceTimeoutMs',
      },
      {
        mcpTimeout: 60_000,
        deadline: true,
        expectedTimeout: 10_000,
        expectedKey: 'appResourceTimeoutMs',
      },
      {
        mcpTimeout: 600_000,
        deadline: true,
        expectedTimeout: 10_000,
        expectedKey: 'appResourceTimeoutMs',
      },
      {
        mcpTimeout: 10_000,
        deadline: true,
        expectedTimeout: 10_000,
        expectedKey: 'appResourceTimeoutMs',
      },
      {
        mcpTimeout: 500,
        deadline: false,
        expectedTimeout: 500,
        expectedKey: 'timeout',
      },
      {
        mcpTimeout: 50,
        deadline: false,
        expectedTimeout: 50,
        expectedKey: 'timeout',
      },
      // An explicit App timeout owns the deadline, so the warning names it.
      {
        mcpTimeout: 60_000,
        appResourceTimeoutMs: 30_000,
        deadline: true,
        expectedTimeout: 30_000,
        expectedKey: 'appResourceTimeoutMs',
      },
    ])(
      'reports the resource timeout with MCP timeout $mcpTimeout',
      async ({
        mcpTimeout,
        appResourceTimeoutMs,
        deadline,
        expectedTimeout,
        expectedKey,
      }) => {
        const timeoutController = new AbortController();
        const timeoutSpy = vi
          .spyOn(AbortSignal, 'timeout')
          .mockReturnValue(timeoutController.signal);
        const mcpClient = appClient(
          vi.fn(async (_params, options) => {
            if (!deadline) {
              // The shape `@modelcontextprotocol/client` 2.x throws for its
              // own request timeouts — a string code, never JSON-RPC -32001.
              throw new SdkError(
                SdkErrorCode.RequestTimeout,
                'Request timed out',
                { timeout: mcpTimeout },
              );
            }
            return new Promise<never>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => {
                reject(options.signal?.reason);
              });
              timeoutController.abort(
                new DOMException('The operation timed out', 'TimeoutError'),
              );
            });
          }),
        );

        try {
          const result = await createAppTool(
            mcpClient,
            undefined,
            mcpTimeout,
            appResourceTimeoutMs === undefined
              ? undefined
              : { appResourceTimeoutMs },
          )
            .build({ param: 'test' })
            .execute(new AbortController().signal);

          expect(timeoutSpy).toHaveBeenCalledWith(expectedTimeout);
          expect(mcpClient.readResource).toHaveBeenCalledWith(
            { uri: 'ui://demo/dashboard' },
            { timeout: expectedTimeout, signal: expect.any(AbortSignal) },
          );
          expectAppLoadWarning(
            result,
            `resource read timed out (limit: ${expectedTimeout} ms; mcpServers.${serverName}.${expectedKey})`,
          );
          expect(mockDebugWarn).toHaveBeenCalledWith(
            expect.stringContaining(
              `(cause: ${deadline ? 'The operation timed out' : 'Request timed out'})`,
            ),
          );
        } finally {
          timeoutSpy.mockRestore();
        }
      },
    );

    it.each(['text', 'blob'] as const)(
      'loads larger configured %s resources through tool projections',
      async (encoding) => {
        const html = `<main>é</main>${' '.repeat(1_048_562)}`;
        const mcpClient: McpDirectClient = {
          callTool: vi.fn(async () => ({
            content: [{ type: 'text', text: 'Dashboard ready' }],
          })),
          readResource: vi.fn(async () => ({
            contents: [
              {
                uri: 'ui://demo/dashboard',
                mimeType: 'text/html;profile=mcp-app',
                ...(encoding === 'text'
                  ? { text: html }
                  : { blob: Buffer.from(html).toString('base64') }),
              },
            ],
          })),
        };
        const configured = createAppTool(mcpClient, undefined, undefined, {
          appResourceMaxBytes: 2 * 1024 * 1024,
          appResourceTimeoutMs: 30_000,
        });
        const result = await configured
          .asFullyQualifiedTool()
          .withAppResourceUi({
            csp: { connectDomains: ['https://example.com'] },
          })
          .withSessionConfig(true, true)
          .build({ param: 'test' })
          .execute(new AbortController().signal);

        expect(Buffer.byteLength(html, 'utf8')).toBe(1_048_577);
        expect(result.returnDisplay).toMatchObject({ type: 'mcp_app', html });
        expect(result.llmContent).toEqual([{ text: 'Dashboard ready' }]);
        expect(mcpClient.readResource).toHaveBeenCalledWith(
          { uri: 'ui://demo/dashboard' },
          { timeout: 30_000, signal: expect.any(AbortSignal) },
        );
      },
    );

    it.each([
      { configured: 30_000, expected: 30_000, warned: undefined },
      { configured: 1_000_000, expected: 120_000, warned: undefined },
      { configured: -1, expected: 100, warned: undefined },
      { configured: 150.9, expected: 150, warned: undefined },
      { configured: Number.NaN, expected: 500, warned: 'NaN' },
      {
        configured: Number.POSITIVE_INFINITY,
        expected: 500,
        warned: 'Infinity',
      },
      // A quoted value from a hand-edited settings.json is not a number;
      // it falls back and the drop must be logged, not silent.
      {
        configured: '30000' as unknown as number,
        expected: 500,
        warned: '"30000"',
      },
    ])(
      'bounds the configured resource timeout $configured',
      async ({ configured, expected, warned }) => {
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
        const mcpClient: McpDirectClient = {
          callTool: vi.fn(async () => ({
            content: [{ type: 'text', text: 'Dashboard ready' }],
          })),
          readResource: vi.fn(async () => ({
            contents: [
              {
                uri: 'ui://demo/dashboard',
                mimeType: 'text/html;profile=mcp-app',
                text: '<main>ok</main>',
              },
            ],
          })),
        };
        try {
          const result = await createAppTool(mcpClient, undefined, 500, {
            appResourceTimeoutMs: configured,
          })
            .build({ param: 'test' })
            .execute(new AbortController().signal);
          expect(result.returnDisplay).toMatchObject({
            html: '<main>ok</main>',
          });
          expect(timeoutSpy).toHaveBeenCalledWith(expected);
          expect(mcpClient.readResource).toHaveBeenCalledWith(
            { uri: 'ui://demo/dashboard' },
            { timeout: expected, signal: expect.any(AbortSignal) },
          );
          expectDiscardedLimitWarn('appResourceTimeoutMs', warned);
        } finally {
          timeoutSpy.mockRestore();
        }
      },
    );

    it.each([
      { configured: 2_097_152, limit: 2_097_152, warned: undefined },
      { configured: 100_000_000, limit: 4_194_304, warned: undefined },
      { configured: 0, limit: 1, warned: undefined },
      { configured: -1, limit: 1, warned: undefined },
      { configured: 100.9, limit: 100, warned: undefined },
      { configured: Number.NaN, limit: 1_048_576, warned: 'NaN' },
      {
        configured: Number.POSITIVE_INFINITY,
        limit: 1_048_576,
        warned: 'Infinity',
      },
      {
        configured: '4194304' as unknown as number,
        limit: 1_048_576,
        warned: '"4194304"',
      },
    ])(
      'enforces the configured HTML byte boundary $configured',
      async ({ configured, limit, warned }) => {
        let html = 'x'.repeat(limit);
        const mcpClient: McpDirectClient = {
          callTool: vi.fn(async () => ({
            content: [{ type: 'text', text: 'Dashboard ready' }],
          })),
          readResource: vi.fn(async () => ({
            contents: [
              {
                uri: 'ui://demo/dashboard',
                mimeType: 'text/html;profile=mcp-app',
                text: html,
              },
            ],
          })),
        };
        const tool = createAppTool(mcpClient, undefined, undefined, {
          appResourceMaxBytes: configured,
        });
        const accepted = await tool
          .build({ param: 'test' })
          .execute(new AbortController().signal);
        expect(accepted.returnDisplay).toMatchObject({ html });
        html += 'x';
        const rejected = await tool
          .build({ param: 'test' })
          .execute(new AbortController().signal);
        expectAppLoadWarning(
          rejected,
          `resource HTML is ${limit + 1} bytes, exceeding the ${limit} byte host limit (mcpServers.${serverName}.appResourceMaxBytes)`,
        );
        expectDiscardedLimitWarn('appResourceMaxBytes', warned);
      },
    );

    it.each([
      {
        provenance: { extensionName: 'demo-ext' },
        settingRef: `appResourceMaxBytes for server '${serverName}' declared by extension 'demo-ext'`,
      },
      {
        provenance: { scope: 'project' as const },
        settingRef: `appResourceMaxBytes for server '${serverName}' declared in .mcp.json`,
      },
    ])(
      'names the declaring source in the limit warning: $settingRef',
      async ({ provenance, settingRef }) => {
        // Configuration sources replace whole server objects by precedence,
        // so pointing at `mcpServers.<name>` in settings.json would shadow an
        // extension- or project-declared server rather than merge with it.
        const html = `<main>é</main>${' '.repeat(1_048_577 - 15)}`;
        const mcpClient: McpDirectClient = {
          callTool: vi.fn(async () => ({
            content: [{ type: 'text', text: 'Dashboard ready' }],
          })),
          readResource: vi.fn(async () => ({
            contents: [
              {
                uri: 'ui://demo/dashboard',
                mimeType: 'text/html;profile=mcp-app',
                text: html,
              },
            ],
          })),
        };

        const result = await createAppTool(
          mcpClient,
          undefined,
          undefined,
          provenance,
        )
          .build({ param: 'test' })
          .execute(new AbortController().signal);

        expectAppLoadWarning(
          result,
          `resource HTML is 1048577 bytes, exceeding the 1048576 byte host limit (${settingRef})`,
        );
        expect(JSON.stringify(result.returnDisplay)).not.toContain(
          `mcpServers.${serverName}`,
        );
      },
    );

    it('attributes a server-sent -32001 to the server, not the host limit', async () => {
      const mcpClient = appClient(
        vi.fn(async () => {
          // A server-sent `-32001` arrives as a ProtocolError carrying the
          // numeric code; the v2 client never emits -32001 for its own
          // timeouts, so this must not be labelled with the host's limit.
          throw coded('MCP error -32001: Unknown session');
        }),
      );

      const result = await runApp(mcpClient);

      expectAppLoadWarning(result, 'MCP error -32001: Unknown session');
      expect(mockDebugWarn).toHaveBeenCalledWith(
        `Warning: MCP App 'ui://demo/dashboard' from '${serverName}' could not be displayed: MCP error -32001: Unknown session`,
      );
    });

    it('reports an unreadable app resource without changing the tool result', async () => {
      const result = await runApp(
        appClient(vi.fn().mockRejectedValue(new Error('Resource unavailable'))),
      );
      expectAppLoadWarning(result, 'Resource unavailable');
    });

    it.each([undefined, 30_000])(
      'keeps the tool result when aborting an App read with timeout %s',
      async (appResourceTimeoutMs) => {
        const controller = new AbortController();
        const mcpClient: McpDirectClient = {
          callTool: vi.fn(async () => ({
            content: [{ type: 'text', text: 'Dashboard ready' }],
          })),
          readResource: vi.fn(
            async (_params, options) =>
              new Promise<never>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                  reject(options.signal?.reason);
                });
                controller.abort();
              }),
          ),
        };

        const result = await createAppTool(mcpClient, undefined, undefined, {
          appResourceTimeoutMs,
        })
          .build({ param: 'test' })
          .execute(controller.signal);

        expect(result.llmContent).toEqual([{ text: 'Dashboard ready' }]);
        expect(result.returnDisplay).toBe('Dashboard ready');
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('output truncation for large MCP results', () => {
    const THRESHOLD = 1000;
    const TRUNCATE_LINES = 50;
    // ~525k chars, over the 500k MCP char budget
    const largeText = 'Line of text content\n'.repeat(25000);

    const mockConfigWithTruncation = {
      getTruncateToolOutputThreshold: () => THRESHOLD,
      getTruncateToolOutputLines: () => TRUNCATE_LINES,
      getUsageStatisticsEnabled: () => false,
      storage: {
        getProjectTempDir: () => '/tmp/test-project',
      },
      isTrustedFolder: () => true,
    } as any;
    const truncTool = (client?: McpDirectClient) =>
      mkTool({ trust: true, config: mockConfigWithTruncation, client });

    const expectTruncated = (result: ToolResult) => {
      const combinedText = (result.llmContent as Part[])
        .filter((p: Part) => p.text)
        .map((p: Part) => p.text)
        .join('');
      expect(combinedText.length).toBeLessThan(largeText.length);
      expect(combinedText.length).toBeLessThan(10_000);
      expect(combinedText).toContain('CONTENT TRUNCATED');
      expect(result.persistedOutputFiles).toHaveLength(1);
      expect(result.returnDisplay).toBe(
        `${largeText}\nOutput too long and was saved to:\n- ${result.persistedOutputFiles![0]}`,
      );
    };

    it('should truncate large text results from direct client execution', async () => {
      const client = directClient([textBlock(largeText)]);
      // The text part in llmContent should be truncated
      expectTruncated(await exec(truncTool(client)));
    });

    it('should truncate large text results from callable tool execution', async () => {
      mockCallTool.mockResolvedValue([
        fnResponse(serverToolName, textResult(largeText)),
      ]);
      expectTruncated(await exec(truncTool()));
    });

    it('should not truncate small text results', async () => {
      const smallText = 'Small response';
      const result = await exec(
        truncTool(directClient([textBlock(smallText)])),
      );

      expect(result.llmContent).toEqual([{ text: smallText }]);
      expect(result.returnDisplay).not.toContain('Output too long');
    });

    it('should not truncate non-text content (images, audio)', async () => {
      // large base64 data
      const client = directClient([img('x'.repeat(5000))]);
      const result = await exec(truncTool(client));

      // Image data should not be truncated
      const inlineDataParts = (result.llmContent as Part[]).filter(
        (p: Part) => p.inlineData,
      );
      expect(inlineDataParts[0].inlineData!.data).toBe('x'.repeat(5000));
    });

    it('should truncate only text parts in mixed content', async () => {
      const client = directClient([textBlock(largeText), img('IMAGE_DATA')]);
      const parts = (await exec(truncTool(client))).llmContent as Part[];

      // Text should be truncated
      const textPart = parts.find(
        (p: Part) => p.text && !p.text.startsWith('[Tool'),
      );
      expect(textPart!.text!.length).toBeLessThan(largeText.length);
      expect(textPart!.text).toContain('CONTENT TRUNCATED');
      // Image should be preserved
      const imagePart = parts.find((p: Part) => p.inlineData);
      expect(imagePart!.inlineData!.data).toBe('IMAGE_DATA');
    });

    it('should not truncate when config is not provided', async () => {
      const text = 'Line of text content\n'.repeat(200);
      // No cliConfig provided
      const result = await exec(
        mkTool({ client: directClient([textBlock(text)]) }),
      );

      // Without config, should return untouched
      expect(result.llmContent).toEqual([{ text }]);
    });
  });

  describe('streaming progress for long-running MCP tools', () => {
    // A direct client that reports one MCP progress notification per
    // message, 10 ms apart, then returns `text`.
    const progressClient = (
      messages: string[],
      text: string,
    ): McpDirectClient => ({
      callTool: vi.fn(async (_params, options) => {
        for (let i = 0; i < messages.length; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          options?.onprogress?.({
            progress: i + 1,
            total: messages.length,
            message: messages[i],
          });
        }
        return textResult(text);
      }),
    });

    it('should have canUpdateOutput set to true so the scheduler creates liveOutputCallback', () => {
      // For long-running MCP tools (e.g., browseruse), the scheduler needs
      // canUpdateOutput=true to create a liveOutputCallback. Without this,
      // users see no progress during potentially minutes-long operations.
      expect(tool.canUpdateOutput).toBe(true);
    });

    it('should forward MCP progress notifications to updateOutput callback during execution', async () => {
      const client = progressClient(
        [1, 2, 3].map((i) => `Step ${i} of 3`),
        'Browser automation completed successfully.',
      );
      const updateOutputSpy = vi.fn();

      const result = await mkTool({ client })
        .build({ param: 'https://example.com' })
        .execute(new AbortController().signal, updateOutputSpy);

      // The final result should still be correct
      expect(result.llmContent).toEqual([
        { text: 'Browser automation completed successfully.' },
      ]);
      // Every intermediate progress update reaches the callback, so users
      // see what is happening during the long wait.
      expect(updateOutputSpy).toHaveBeenCalled();
      expect(updateOutputSpy).toHaveBeenCalledTimes(3);
      // Verify progress data contains structured MCP progress info
      for (const progress of [1, 3]) {
        expect(updateOutputSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'mcp_tool_progress',
            progress,
            total: 3,
            message: `Step ${progress} of 3`,
          }),
        );
      }
    });

    it('should show incremental progress for multi-step browser automation', async () => {
      const steps = [
        'Navigating to page...',
        'Filling username field...',
        'Filling password field...',
        'Clicking submit...',
      ];
      const receivedUpdates: unknown[] = [];

      await mkTool({ client: progressClient(steps, steps.join('\n')) })
        .build({ param: 'fill-form' })
        .execute(new AbortController().signal, (output: unknown) => {
          receivedUpdates.push(output);
        });

      // User should have received one update per step
      expect(receivedUpdates.length).toBeGreaterThan(0);
      expect(receivedUpdates).toHaveLength(steps.length);
      // Each update should be structured McpToolProgressData
      expect(receivedUpdates[0]).toEqual({
        type: 'mcp_tool_progress',
        progress: 1,
        total: steps.length,
        message: 'Navigating to page...',
      });
      expect(receivedUpdates[3]).toEqual({
        type: 'mcp_tool_progress',
        progress: 4,
        total: steps.length,
        message: 'Clicking submit...',
      });
    });
  });

  describe('auto-reconnect on connection error', () => {
    const idempotentAnnotations = { idempotentHint: true } as const;
    const readOnlyAnnotations = { readOnlyHint: true } as const;
    const unsafeReplayErrorMessage =
      'MCP tool execution may have completed before the connection failed. Automatic replay was skipped because the call could not be verified as safe to replay. Do not retry automatically; verify the outcome before trying again.';
    const noTruncation = {
      getTruncateToolOutputThreshold: () => 0,
      getTruncateToolOutputLines: () => 0,
    };

    // A trusted, idempotent tool: the only kind a reconnect may replay.
    const safeTool = (o: Parameters<typeof mkTool>[0] = {}) =>
      mkTool({ trust: true, annotations: idempotentAnnotations, ...o });
    const okClient = (): McpDirectClient => ({
      callTool: vi.fn().mockResolvedValueOnce(textResult('OK')),
    });
    const callable = (callTool: Mock) =>
      ({ tool: vi.fn(), callTool }) as unknown as Mocked<CallableTool>;
    // A config whose tool registry re-discovers the server and hands back
    // `ensured` (or nothing).
    const registry = (
      o: {
        ensured?: DiscoveredMCPTool;
        discover?: Mock;
        trusted?: () => boolean;
        extra?: Record<string, unknown>;
      } = {},
    ) => {
      const discoverToolsForServer =
        o.discover ?? vi.fn().mockResolvedValue(undefined);
      const ensureTool = o.ensured
        ? vi.fn().mockResolvedValue(o.ensured)
        : vi.fn();
      const config = {
        isTrustedFolder: o.trusted ?? (() => true),
        getToolRegistry: () => ({ discoverToolsForServer, ensureTool }),
        ...o.extra,
      };
      return { config, discoverToolsForServer, ensureTool };
    };
    const expectNoReplay = async (
      t: DiscoveredMCPTool,
      status = MCPServerStatus.CONNECTED,
    ) => {
      updateMCPServerStatus(serverName, status);
      await expect(exec(t)).rejects.toThrow(unsafeReplayErrorMessage);
    };
    // Every call fails with `error` under `status`; nothing reconnects.
    const expectNoRetry = async (status: MCPServerStatus, error: Error) => {
      const retryClient = okClient();
      const { config, discoverToolsForServer, ensureTool } = registry({
        ensured: mkTool({ client: retryClient }),
      });
      updateMCPServerStatus(serverName, status);
      const client: McpDirectClient = {
        callTool: vi.fn().mockRejectedValue(error),
      };

      await expect(exec(mkTool({ config, client }))).rejects.toThrow(
        error.message,
      );

      expect(client.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).not.toHaveBeenCalled();
      expect(ensureTool).not.toHaveBeenCalled();
      expect(retryClient.callTool).not.toHaveBeenCalled();
    };
    // The first call fails with `error` under `status`; the reconnect runs.
    const expectReconnect = async (error: Error, status: MCPServerStatus) => {
      const { config, discoverToolsForServer } = registry({
        ensured: safeTool({ client: okClient() }),
        extra: noTruncation,
      });
      updateMCPServerStatus(serverName, status);
      await exec(safeTool({ config, client: failing(error) }));
      expect(discoverToolsForServer).toHaveBeenCalled();
    };
    const sessionError = (message: string) =>
      coded(
        `Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32001,"message":"${message}"},"id":null}`,
      );

    it('should attempt reconnect and retry on connection error', async () => {
      const toolName = 'literature.search_pubmed';
      const newMockMcpClient: McpDirectClient = {
        callTool: vi
          .fn()
          .mockResolvedValueOnce(textResult('Success after reconnect')),
      };
      const { config, discoverToolsForServer, ensureTool } = registry({
        ensured: safeTool({ toolName, client: newMockMcpClient }),
        extra: noTruncation,
      });
      const mockMcpClient = failing(new Error('Connection closed'));
      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
      const reconnectTool = safeTool({
        toolName,
        config,
        client: mockMcpClient,
      });

      const result = await exec(reconnectTool);

      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(newMockMcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).toHaveBeenCalledWith(serverName, false);
      expect(ensureTool).toHaveBeenCalledWith(reconnectTool.name);
      expect(result.llmContent).toEqual([{ text: 'Success after reconnect' }]);
    });

    it('keeps configured App resource limits across a reconnect replay', async () => {
      const params = { param: 'test' };
      // 1 MiB + 1 byte: over the default limit, under the configured one.
      const htmlBytes = 1_048_577;
      const initialClient: McpDirectClient = {
        callTool: vi.fn().mockRejectedValueOnce(new Error('Connection closed')),
      };
      const reconnectedClient: McpDirectClient = {
        callTool: vi.fn().mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Dashboard ready' }],
        }),
        readResource: vi.fn(async () => ({
          contents: [
            {
              uri: 'ui://demo/dashboard',
              mimeType: 'text/html;profile=mcp-app',
              text: `<main>é</main>${' '.repeat(htmlBytes - 15)}`,
            },
          ],
        })),
      };
      const rediscoveredTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        undefined,
        reconnectedClient,
        undefined,
        undefined,
        idempotentAnnotations,
        false,
        false,
        'ui://demo/dashboard',
        undefined,
        { appResourceMaxBytes: 2_097_152 },
      );
      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const ensureTool = vi.fn().mockResolvedValue(rediscoveredTool);
      const mockConfig = {
        isTrustedFolder: () => true,
        getToolRegistry: () => ({ discoverToolsForServer, ensureTool }),
      };
      const originalTool = new DiscoveredMCPTool(
        mockCallableToolInstance,
        serverName,
        serverToolName,
        baseDescription,
        inputSchema,
        true,
        undefined,
        mockConfig as any,
        initialClient,
        undefined,
        undefined,
        idempotentAnnotations,
      );

      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
      const result = await originalTool
        .build(params)
        .execute(new AbortController().signal);

      expect(initialClient.callTool).toHaveBeenCalledTimes(1);
      expect(reconnectedClient.callTool).toHaveBeenCalledTimes(1);
      // Without the replay leg forwarding `appResourceLimits`, the replayed
      // read falls back to the 1 MiB default and rejects this resource with
      // a warning naming the setting the user already raised. Compare sizes
      // rather than the document so a failure diff stays small.
      const display = result.returnDisplay as {
        type: string;
        html: string;
        fallbackText: string;
      };
      expect(display.type).toBe('mcp_app');
      expect(Buffer.byteLength(display.html, 'utf8')).toBe(htmlBytes);
      expect(display.fallbackText).not.toContain('Warning');
    });

    it.each(['repair', 'guarded', 'cancelled'] as const)(
      'handles an App connection failure without replaying (%s)',
      async (mode) => {
        const params = { param: 'test' };
        const controller = new AbortController();
        const mockMcpClient: McpDirectClient = {
          callTool: vi.fn().mockImplementation(async () => {
            if (mode === 'cancelled') controller.abort();
            throw new Error('Connection closed');
          }),
        };
        const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
        const reconnectedClient: McpDirectClient = {
          callTool: vi.fn().mockResolvedValue({ content: [] }),
        };
        const reconnectedTool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
          undefined,
          undefined,
          undefined,
          reconnectedClient,
        );
        const ensureTool = vi.fn().mockResolvedValue(reconnectedTool);
        const received = vi.fn();
        const mockConfig = {
          isTrustedFolder: () => true,
          getToolInvocationGuard: () => (mode === 'guarded' ? {} : undefined),
          getToolRegistry: () => ({
            discoverToolsForServer,
            ensureTool,
          }),
        };

        updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);
        const appTool = new DiscoveredMCPTool(
          mockCallableToolInstance,
          serverName,
          serverToolName,
          baseDescription,
          inputSchema,
          undefined,
          undefined,
          mockConfig as unknown as Config,
          mockMcpClient,
        );

        await expect(
          appTool.buildForApp(params, received).execute(controller.signal),
        ).rejects.toThrow(
          mode === 'cancelled' ? /abort/i : 'MCP App tool call failed.',
        );

        expect(mockMcpClient.callTool).toHaveBeenCalledOnce();
        expect(discoverToolsForServer).toHaveBeenCalledTimes(
          mode === 'cancelled' ? 0 : 1,
        );
        if (mode !== 'cancelled') {
          expect(discoverToolsForServer).toHaveBeenCalledWith(serverName, true);
        }
        expect(received).not.toHaveBeenCalled();
        expect(reconnectedClient.callTool).not.toHaveBeenCalled();
      },
    );

    it('does not reconnect a guarded invocation after an ambiguous connection error', async () => {
      const mockMcpClient = failing(new Error('Connection closed'));
      const { config, discoverToolsForServer, ensureTool } = registry({
        extra: { getToolInvocationGuard: () => vi.fn() },
      });
      updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);

      await expect(
        exec(mkTool({ config, client: mockMcpClient })),
      ).rejects.toThrow('Connection closed');

      expect(mockMcpClient.callTool).toHaveBeenCalledOnce();
      expect(discoverToolsForServer).not.toHaveBeenCalled();
      expect(ensureTool).not.toHaveBeenCalled();
    });

    it.each<{
      name: string;
      trust: boolean;
      trustedFolderAfterReconnect: boolean;
      annotations: McpToolAnnotations | undefined;
    }>([
      {
        name: 'loses its annotations',
        trust: true,
        trustedFolderAfterReconnect: true,
        annotations: undefined,
      },
      {
        name: 'is no longer trusted',
        trust: false,
        trustedFolderAfterReconnect: true,
        annotations: idempotentAnnotations,
      },
      {
        name: 'is now in an untrusted workspace',
        trust: true,
        trustedFolderAfterReconnect: false,
        annotations: idempotentAnnotations,
      },
    ])(
      'should not replay when the re-discovered tool $name',
      async (testCase) => {
        const initialClient = failing(new Error('Connection closed'));
        const retryClient: McpDirectClient = {
          callTool: vi
            .fn()
            .mockResolvedValueOnce(textResult('Unexpected replay')),
        };
        const { config, discoverToolsForServer, ensureTool } = registry({
          ensured: mkTool({
            trust: testCase.trust,
            client: retryClient,
            annotations: testCase.annotations,
          }),
          trusted: vi
            .fn()
            .mockReturnValueOnce(true)
            .mockReturnValue(testCase.trustedFolderAfterReconnect),
        });

        await expectNoReplay(safeTool({ config, client: initialClient }));

        expect(initialClient.callTool).toHaveBeenCalledTimes(1);
        expect(discoverToolsForServer).toHaveBeenCalledTimes(1);
        expect(ensureTool).toHaveBeenCalledTimes(1);
        expect(retryClient.callTool).not.toHaveBeenCalled();
      },
    );

    it('should reconnect consistent read-only calls through the callable fallback', async () => {
      const initialCallable = callable(
        vi.fn().mockRejectedValueOnce(new Error('Connection closed')),
      );
      const retryCallable = callable(
        vi
          .fn()
          .mockResolvedValueOnce([
            fnResponse(serverToolName, textResult('OK')),
          ]),
      );
      const { config, discoverToolsForServer } = registry({
        ensured: mkTool({
          callable: retryCallable,
          trust: true,
          annotations: readOnlyAnnotations,
        }),
        extra: noTruncation,
      });
      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);

      const result = await exec(
        mkTool({
          callable: initialCallable,
          trust: true,
          config,
          annotations: readOnlyAnnotations,
        }),
      );

      expect(initialCallable.callTool).toHaveBeenCalledTimes(1);
      expect(retryCallable.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).toHaveBeenCalledTimes(1);
      expect(result.llmContent).toEqual([{ text: 'OK' }]);
    });

    it('should not replay unsafe calls through the callable fallback', async () => {
      const initialCallable = callable(
        vi.fn().mockRejectedValueOnce(new Error('Connection closed')),
      );
      const { config, discoverToolsForServer, ensureTool } = registry();

      await expectNoReplay(
        mkTool({
          callable: initialCallable,
          trust: true,
          config,
          annotations: { idempotentHint: false },
        }),
      );

      // The call itself is never replayed (its outcome is ambiguous)...
      expect(initialCallable.callTool).toHaveBeenCalledTimes(1);
      // ...but the dead connection is still repaired so the next call can
      // succeed (issue #9944).
      expect(discoverToolsForServer).toHaveBeenCalledTimes(1);
      expect(ensureTool).toHaveBeenCalledTimes(1);
    });

    it.each<{
      name: string;
      trust: boolean | undefined;
      trustedFolder: boolean;
      annotations: McpToolAnnotations | undefined;
    }>([
      {
        name: 'missing annotations',
        trust: true,
        trustedFolder: true,
        annotations: undefined,
      },
      {
        name: 'explicitly non-idempotent annotations',
        trust: true,
        trustedFolder: true,
        annotations: { idempotentHint: false },
      },
      {
        name: 'conflicting read-only and destructive annotations',
        trust: true,
        trustedFolder: true,
        annotations: { readOnlyHint: true, destructiveHint: true },
      },
      {
        name: 'conflicting read-only and non-idempotent annotations',
        trust: true,
        trustedFolder: true,
        annotations: { readOnlyHint: true, idempotentHint: false },
      },
      {
        name: 'an untrusted server',
        trust: false,
        trustedFolder: true,
        annotations: idempotentAnnotations,
      },
      {
        name: 'an untrusted workspace',
        trust: true,
        trustedFolder: false,
        annotations: idempotentAnnotations,
      },
    ])('should not replay $name', async (testCase) => {
      const initialClient = failing(
        new Error('Connection closed after side effect completed'),
      );
      const { config, discoverToolsForServer, ensureTool } = registry({
        trusted: () => testCase.trustedFolder,
      });

      await expectNoReplay(
        mkTool({
          trust: testCase.trust,
          config,
          client: initialClient,
          annotations: testCase.annotations,
        }),
      );

      // No replay of the ambiguous call...
      expect(initialClient.callTool).toHaveBeenCalledTimes(1);
      // ...but the connection is still repaired best-effort so the next
      // call does not inherit the dead session (issue #9944).
      expect(discoverToolsForServer).toHaveBeenCalledTimes(1);
      expect(ensureTool).toHaveBeenCalledTimes(1);
    });

    it('repairs the session of an unannotated tool after the server restarted (issue #9944)', async () => {
      // A restarted HTTP MCP server has a fresh `mcp-session-id` space and
      // answers our stale session with `-32001 "Session not found"`. With no
      // readOnlyHint/idempotentHint annotations the reconnect path never ran
      // pre-fix, leaving the tool unusable until a full session restart. The
      // ambiguous call must still not be replayed, but the session repair
      // (fresh initialize + tool reload) has to happen.
      const initialClient = failing(sessionError('Session not found'));
      const { config, discoverToolsForServer, ensureTool } = registry();

      await expectNoReplay(
        mkTool({ trust: true, config, client: initialClient }), // no annotations
        MCPServerStatus.DISCONNECTED,
      );

      expect(initialClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).toHaveBeenCalledWith(serverName, false);
      expect(ensureTool).toHaveBeenCalledTimes(1);
    });

    it.each(['Session not found', 'Session terminated', 'Session expired'])(
      'routes "%s" to the reconnect path even while the status is still CONNECTED (issue #9944)',
      async (sessionMessage) => {
        // Servers that keep no GET SSE stream never flip the client status to
        // DISCONNECTED when the session dies, so the stale `-32001` would be
        // misread as an execution timeout and the reconnect path never run.
        // The session-error carve-out must win for every dead-session
        // phrasing a server may use, so all three variants exercise it.
        const { config, discoverToolsForServer } = registry();

        // No annotations: no replay, but the repair must still run.
        await expectNoReplay(
          mkTool({
            trust: true,
            config,
            client: failing(sessionError(sessionMessage)),
          }),
        );

        expect(discoverToolsForServer).toHaveBeenCalledWith(serverName, false);
      },
    );

    it('routes an HTTP 404 dead-session response to the reconnect path even with unenumerated prose (issue #9944)', async () => {
      // Per spec, a restarted HTTP server MUST answer a POST carrying a stale
      // `mcp-session-id` with 404 (the SDK surfaces it as a
      // StreamableHTTPError whose `code` is the HTTP status), in server-defined
      // prose. "Unknown session" matches none of the enumerated
      // `MCP_DEAD_SESSION_ERROR_PATTERN` phrasings, so only the structural
      // `code: 404` can trigger recovery; without it every later call
      // re-POSTs the stale session id and fails.
      const initialClient = failing(coded('Unknown session', 404));
      const { config, discoverToolsForServer, ensureTool } = registry();

      // No annotations: no replay, but the repair must still run.
      await expectNoReplay(
        mkTool({ trust: true, config, client: initialClient }),
      );

      expect(initialClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).toHaveBeenCalledWith(serverName, false);
      expect(ensureTool).toHaveBeenCalledTimes(1);
    });

    it('should not retry on non-connection errors', async () => {
      await expectNoRetry(
        MCPServerStatus.CONNECTED,
        new Error('Invalid parameters'),
      );
    });

    it('should not retry aborted calls even when the server is disconnected', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      await expectNoRetry(MCPServerStatus.DISCONNECTED, abortError);
    });

    it('should not reconnect for an MCP isError result', async () => {
      const initialClient: McpDirectClient = {
        callTool: vi.fn().mockResolvedValueOnce({
          ...textResult('Validation failed'),
          isError: true,
        }),
      };
      const { config, discoverToolsForServer } = registry({
        discover: vi.fn(),
        extra: noTruncation,
      });

      const result = await exec(safeTool({ config, client: initialClient }));

      expect(result.error?.type).toBe(ToolErrorType.MCP_TOOL_ERROR);
      expect(initialClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).not.toHaveBeenCalled();
    });

    it('should preserve the connection error when reconnect discovery fails', async () => {
      const connectionError = new Error('Connection closed');
      const initialClient = failing(connectionError);
      const { config, discoverToolsForServer, ensureTool } = registry({
        discover: vi.fn().mockRejectedValueOnce(new Error('Discovery failed')),
      });

      await expect(
        exec(safeTool({ config, client: initialClient })),
      ).rejects.toBe(connectionError);

      expect(initialClient.callTool).toHaveBeenCalledTimes(1);
      expect(discoverToolsForServer).toHaveBeenCalledTimes(1);
      expect(ensureTool).not.toHaveBeenCalled();
    });

    it('should stop after the maximum reconnection retries', async () => {
      const secondMockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      };
      const { config, discoverToolsForServer } = registry({
        ensured: safeTool({ client: secondMockMcpClient }),
      });
      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);
      const mockMcpClient: McpDirectClient = {
        callTool: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      };

      await expect(
        exec(safeTool({ config, client: mockMcpClient })),
      ).rejects.toThrow('ECONNREFUSED');

      expect(mockMcpClient.callTool).toHaveBeenCalledTimes(1);
      expect(secondMockMcpClient.callTool).toHaveBeenCalledTimes(3);
      expect(discoverToolsForServer).toHaveBeenCalledTimes(3);
    });

    it('should detect various connection error patterns', async () => {
      for (const errorMsg of [
        'ECONNREFUSED',
        'ENOTFOUND',
        'ECONNRESET',
        'ETIMEDOUT',
        'connection closed',
        'Connection lost',
        'Not connected',
        'Disconnected',
        'Transport closed',
      ]) {
        await expectReconnect(new Error(errorMsg), MCPServerStatus.CONNECTED);
      }
    });

    it('should reconnect when MCP error occurs and server is disconnected', async () => {
      await expectReconnect(
        new Error('MCP error -32602: Invalid request'),
        MCPServerStatus.DISCONNECTED,
      );
    });

    it('reconnects instead of reporting a timeout when the server is known disconnected', async () => {
      // -32001 with a dead transport means the connection died mid-request,
      // not that the tool ran too long. Classifying it as EXECUTION_TIMEOUT
      // would strand a call the reconnect path can still recover.
      await expectReconnect(
        coded('Request timed out'),
        MCPServerStatus.DISCONNECTED,
      );
    });

    it('still reports a timeout when the server is connected', async () => {
      const discoverToolsForServer = vi.fn().mockResolvedValue(undefined);
      const client: McpDirectClient = {
        callTool: vi.fn().mockRejectedValue(coded('Request timed out')),
      };
      const mockConfig = {
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool: vi.fn(),
        }),
      };
      updateMCPServerStatus(serverName, MCPServerStatus.CONNECTED);

      await expect(
        exec(mkTool({ config: mockConfig, client })),
      ).rejects.toMatchObject({
        errorType: ToolErrorType.EXECUTION_TIMEOUT,
      });
      expect(discoverToolsForServer).not.toHaveBeenCalled();
    });
  });

  describe('MCP Tool Idle Timeout', () => {
    const idleTimeoutMs = 1000;
    const pending = () => {
      let reject!: (reason?: unknown) => void;
      const promise = new Promise((_resolve, rejectRequest) => {
        reject = rejectRequest;
      });
      return { promise, reject };
    };
    // Settles the pending request with a -32001 just before the parent
    // aborts: the raw rejection must come back unclassified.
    const expectAbortWins = async (
      t: DiscoveredMCPTool,
      request: ReturnType<typeof pending>,
      requestTimeout: Error,
    ) => {
      const abortController = new AbortController();
      const executePromise = exec(t, 'test', abortController.signal);

      request.reject(requestTimeout);
      abortController.abort();

      await expect(executePromise).rejects.toBe(requestTimeout);
    };

    it('classifies an MCP SDK request timeout without parsing its message', async () => {
      const client: McpDirectClient = {
        callTool: vi.fn().mockRejectedValue(coded('localized timeout message')),
      };

      await expect(exec(mkTool({ trust: true, client }))).rejects.toMatchObject(
        {
          message: 'localized timeout message',
          errorType: ToolErrorType.EXECUTION_TIMEOUT,
        },
      );
    });

    it('does not classify a parent abort wrapped by the MCP SDK as a timeout', async () => {
      const requestCancelled = coded('Request cancelled');
      const discoverToolsForServer = vi.fn();
      const client: McpDirectClient = {
        callTool: vi.fn().mockImplementation(
          (_params, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => reject(requestCancelled),
                { once: true },
              );
            }),
        ),
      };
      const mockConfig = {
        getToolRegistry: () => ({
          discoverToolsForServer,
          ensureTool: vi.fn(),
        }),
      };
      const abortController = new AbortController();
      const executePromise = exec(
        mkTool({ trust: true, config: mockConfig, client }),
        'test',
        abortController.signal,
      );

      updateMCPServerStatus(serverName, MCPServerStatus.DISCONNECTED);
      abortController.abort();

      const rejection = await executePromise.catch((error) => error);
      expect(rejection).toMatchObject({ name: 'AbortError' });
      expect(discoverToolsForServer).not.toHaveBeenCalled();
      expect(rejection).not.toMatchObject({
        errorType: ToolErrorType.EXECUTION_TIMEOUT,
      });
    });

    it('does not classify a direct -32001 that races with a parent abort as a timeout', async () => {
      // Once the caller has cancelled, a `-32001` is indistinguishable from
      // the SDK's own abort rejection, so a timeout that settles the race
      // first must not reclassify the cancellation — the abort side wins
      // regardless of ordering (#8180 review).
      const requestTimeout = coded('raced timeout');
      const request = pending();
      const client: McpDirectClient = {
        callTool: vi.fn().mockReturnValue(request.promise),
      };

      await expectAbortWins(
        mkTool({ trust: true, client }),
        request,
        requestTimeout,
      );
    });

    it('classifies an MCP SDK request timeout on the callable fallback', async () => {
      mockCallTool.mockRejectedValueOnce(coded('fallback timeout'));

      await expect(exec()).rejects.toMatchObject({
        message: 'fallback timeout',
        errorType: ToolErrorType.EXECUTION_TIMEOUT,
      });
    });

    it('does not classify a callable -32001 that races with a parent abort as a timeout', async () => {
      const requestTimeout = coded('raced fallback timeout');
      const request = pending();
      mockCallTool.mockReturnValueOnce(request.promise);

      await expectAbortWins(tool, request, requestTimeout);
    });

    it('should abort when MCP server does not respond within idle timeout', async () => {
      vi.useFakeTimers();

      const client: McpDirectClient = {
        callTool: vi.fn().mockImplementation(
          (_params, options) =>
            new Promise((_resolve, reject) => {
              // Simulate SDK behavior: reject when signal is aborted
              options?.signal?.addEventListener('abort', () => {
                const error = new Error(
                  (options?.signal as AbortSignal & { reason?: Error })?.reason
                    ?.message ?? 'The operation was aborted',
                );
                error.name = 'AbortError';
                reject(error);
              });
            }),
        ),
      };
      const abortController = new AbortController();
      const executePromise = exec(
        mkTool({ trust: true, client, idle: idleTimeoutMs }),
        'test',
        abortController.signal,
      );

      // Advance time to trigger the idle timeout
      vi.advanceTimersByTime(idleTimeoutMs + 100);

      await expect(executePromise).rejects.toThrow(
        /did not respond within.*idle timeout/,
      );
      await expect(executePromise).rejects.toMatchObject({
        errorType: ToolErrorType.EXECUTION_TIMEOUT,
      });
      // The external abort signal should not have been triggered
      expect(abortController.signal.aborted).toBe(false);

      vi.useRealTimers();
    });

    it('keeps an idle timeout when the parent aborts before rejection settles', async () => {
      vi.useFakeTimers();
      try {
        const client: McpDirectClient = {
          callTool: vi.fn().mockImplementation(
            (_params, options) =>
              new Promise((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                  queueMicrotask(() => reject(options.signal?.reason));
                });
              }),
          ),
        };
        const abortController = new AbortController();
        const executePromise = exec(
          mkTool({ trust: true, client, idle: idleTimeoutMs }),
          'test',
          abortController.signal,
        );

        vi.advanceTimersByTime(idleTimeoutMs);
        abortController.abort();

        await expect(executePromise).rejects.toMatchObject({
          errorType: ToolErrorType.EXECUTION_TIMEOUT,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reset idle timeout on progress updates', async () => {
      vi.useFakeTimers();

      let onProgressCallback: ((progress: any) => void) | undefined;
      const client: McpDirectClient = {
        callTool: vi.fn().mockImplementation((_params, options) => {
          onProgressCallback = options?.onprogress;
          return new Promise((resolve, reject) => {
            // Listen for abort signal to properly reject when timeout fires
            options?.signal?.addEventListener('abort', () => {
              reject(options.signal!.reason);
            });
            // Resolve after 2.5 seconds (would timeout without progress)
            setTimeout(() => resolve(textResult('Success')), 2500);
          });
        }),
      };

      const executePromise = exec(
        mkTool({ trust: true, client, idle: idleTimeoutMs }),
      );

      // Progress at 500ms, 1400ms and 2300ms, each BEFORE the 1000ms idle
      // timeout fires, resets it.
      vi.advanceTimersByTime(500);
      onProgressCallback?.({ progress: 0.25 });
      vi.advanceTimersByTime(900);
      onProgressCallback?.({ progress: 0.5 });
      vi.advanceTimersByTime(900);
      onProgressCallback?.({ progress: 0.75 });
      // Advance past the mock's 2500ms resolve time
      vi.advanceTimersByTime(200);

      const result = await executePromise;

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toBeDefined();

      vi.useRealTimers();
    });

    it('should not apply idle timeout when set to 0 or undefined', async () => {
      vi.useFakeTimers();

      const client: McpDirectClient = {
        callTool: vi.fn().mockResolvedValue(textResult('Success')),
      };
      // No idle timeout
      const result = await exec(mkTool({ trust: true, client }));

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toBeDefined();

      vi.useRealTimers();
    });
  });
});

describe('DiscoveredMCPTool AUTO-mode classifier projection', () => {
  const makeTool = (
    annotations?: McpToolAnnotations,
    config?: { getAutoModeSettings?: () => Record<string, unknown> },
  ) =>
    new DiscoveredMCPTool(
      mockCallableToolInstance,
      'slack',
      'post_message',
      'Post a message',
      { type: 'object', properties: {} },
      undefined,
      undefined,
      config as unknown as Config,
      undefined,
      undefined,
      undefined,
      annotations,
    );

  it('forwards server, tool, annotations and arguments to the classifier', () => {
    const tool = makeTool({ readOnlyHint: false, openWorldHint: true });
    expect(
      tool.toAutoClassifierInput({
        channel: '#ops',
        text: 'AWS_SECRET_ACCESS_KEY=abcd',
      }),
    ).toEqual({
      server: 'slack',
      tool: 'post_message',
      annotations: { readOnlyHint: false, openWorldHint: true },
      // The argument content is the evidence the classifier needs — a
      // secret in a chat payload is exactly the case it must catch.
      arguments: { channel: '#ops', text: 'AWS_SECRET_ACCESS_KEY=abcd' },
    });
  });

  it('forwards arguments when the config carries no autoMode.mcp settings', () => {
    const tool = makeTool(undefined, { getAutoModeSettings: () => ({}) });
    const projected = tool.toAutoClassifierInput({ text: 'hi' });
    expect(projected).toMatchObject({ arguments: { text: 'hi' } });
  });

  it('still forwards arguments when the config lacks getAutoModeSettings', () => {
    const tool = makeTool(undefined, {});
    expect(tool.toAutoClassifierInput({ text: 'hi' })).toMatchObject({
      arguments: { text: 'hi' },
    });
  });

  it('returns the name-only sentinel when forwardArguments is false', () => {
    const tool = makeTool(undefined, {
      getAutoModeSettings: () => ({ mcp: { forwardArguments: false } }),
    });
    expect(tool.toAutoClassifierInput({ text: 'hi' })).toBe('');
  });

  it('marks truncated arguments instead of dropping them silently', () => {
    const tool = makeTool();
    const projected = tool.toAutoClassifierInput({
      body: 'q'.repeat(50_000),
    }) as Record<string, unknown>;
    expect(projected['arguments_truncated']).toBe(true);
    expect(JSON.stringify(projected)).toContain('…[truncated');
  });
});
