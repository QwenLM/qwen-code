/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { learnCommand } from './learn-command.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { SubmitPromptActionReturn } from './types.js';
import { CommandKind } from './types.js';

const mockReadPathFromWorkspace = vi.hoisted(() => vi.fn());
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original = await importOriginal<object>();
  return {
    ...original,
    readPathFromWorkspace: mockReadPathFromWorkspace,
  };
});

function createVideoCapableContext() {
  return createMockCommandContext({
    services: {
      config: {
        getProjectRoot: () => '/tmp/test-project',
        getEffectiveInputModalities: () => ({ video: true }),
        getContentGeneratorConfig: () => ({
          authType: AuthType.USE_OPENAI,
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    },
  });
}

describe('learnCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPathFromWorkspace.mockResolvedValue([
      {
        inlineData: {
          data: 'AAAA',
          mimeType: 'video/mp4',
          displayName: 'tutorial.mp4',
        },
      },
    ]);
  });

  it('has correct metadata', () => {
    expect(learnCommand.name).toBe('learn');
    expect(learnCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(learnCommand.supportedModes).toContain('interactive');
    expect(learnCommand.supportedModes).toContain('acp');
    expect(learnCommand.argumentHint).toMatch(/path|URL|text/i);
  });

  it('returns an error when no args are provided', async () => {
    const ctx = createMockCommandContext();
    const result = await learnCommand.action!(ctx, '');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });
  });

  it('returns an error when config is not loaded', async () => {
    const ctx = createMockCommandContext({ services: { config: null } });
    const result = await learnCommand.action!(ctx, 'https://example.com/docs');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringMatching(/config/i),
    });
  });

  it('returns submit_prompt when config is available', async () => {
    const ctx = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: () => '/tmp/test-project',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    });
    const result = await learnCommand.action!(ctx, 'https://example.com/docs');
    expect(result).toMatchObject({
      type: 'submit_prompt',
    });
    expect((result as SubmitPromptActionReturn).content).toContain(
      'https://example.com/docs',
    );
  });

  it.each([AuthType.USE_OPENAI, AuthType.QWEN_OAUTH])(
    'submits a native video part through %s',
    async (authType) => {
      const ctx = createMockCommandContext({
        services: {
          config: {
            getProjectRoot: () => '/tmp/test-project',
            getEffectiveInputModalities: () => ({ video: true }),
            getContentGeneratorConfig: () => ({ authType }),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        },
      });
      const result = await learnCommand.action!(
        ctx,
        'https://cdn.example.com/tutorial.mp4 focus on visual verification',
      );
      const content = (result as SubmitPromptActionReturn).content;

      expect(result).toMatchObject({ type: 'submit_prompt' });
      expect(content).toEqual([
        {
          fileData: {
            fileUri: 'https://cdn.example.com/tutorial.mp4',
            mimeType: 'video/mp4',
            displayName: 'tutorial-video',
          },
        },
        { text: expect.stringContaining('focus on visual verification') },
      ]);
    },
  );

  it('attaches a local video through the video-specific /learn path', async () => {
    const ctx = createVideoCapableContext();
    const result = await learnCommand.action!(
      ctx,
      './tutorial.mp4 focus on the hover animation',
    );

    expect(mockReadPathFromWorkspace).toHaveBeenCalledWith(
      './tutorial.mp4',
      ctx.services.config,
    );
    expect(result).toMatchObject({
      type: 'submit_prompt',
      content: [
        { inlineData: { mimeType: 'video/mp4', data: 'AAAA' } },
        { text: expect.stringContaining('references/source.md') },
      ],
    });
  });

  it('falls back to the parser MIME type when mime/lite does not recognise the extension', async () => {
    mockReadPathFromWorkspace.mockResolvedValueOnce([
      {
        inlineData: {
          data: 'BBBB',
          mimeType: 'application/octet-stream',
          displayName: 'tutorial.m4v',
        },
      },
    ]);
    const ctx = createVideoCapableContext();
    const result = await learnCommand.action!(ctx, './tutorial.m4v');

    expect(result).toMatchObject({
      type: 'submit_prompt',
      content: [
        { inlineData: { mimeType: 'video/x-m4v', data: 'BBBB' } },
        { text: expect.stringContaining('references/source.md') },
      ],
    });
  });

  it('surfaces text diagnostics when the read succeeds but returns no video part', async () => {
    mockReadPathFromWorkspace.mockResolvedValueOnce([
      'File exceeds the 10MB data URI limit after base64 encoding (12.34MB encoded).',
    ]);
    const ctx = createVideoCapableContext();
    const result = await learnCommand.action!(ctx, './large-video.mp4');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('10MB data URI limit'),
    });
  });

  it('rejects a YouTube page URL with local-file guidance', async () => {
    const ctx = createVideoCapableContext();
    const result = await learnCommand.action!(ctx, 'https://youtu.be/abc123');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringMatching(/download.*local video/i),
    });
  });

  it('rejects a YouTube URL with the capability error on a text-only model', async () => {
    const ctx = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: () => '/tmp/test-project',
          getEffectiveInputModalities: () => ({ video: false }),
          getContentGeneratorConfig: () => ({
            authType: AuthType.USE_OPENAI,
          }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    });
    const result = await learnCommand.action!(ctx, 'https://youtu.be/abc123');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringMatching(/native video input/i),
    });
  });

  it('rejects a local video that cannot be attached', async () => {
    mockReadPathFromWorkspace.mockRejectedValueOnce(
      new Error('Absolute path is outside of the allowed workspace'),
    );
    const ctx = createVideoCapableContext();
    const result = await learnCommand.action!(ctx, '/tmp/tutorial.mp4');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringMatching(/could not be attached.*outside/i),
    });
  });

  it.each([
    ['a text-only model', AuthType.USE_OPENAI, false],
    ['a non-OpenAI-compatible provider', AuthType.USE_ANTHROPIC, true],
  ])('rejects native video input for %s', async (_label, authType, video) => {
    const ctx = createMockCommandContext({
      services: {
        config: {
          getProjectRoot: () => '/tmp/test-project',
          getEffectiveInputModalities: () => ({ video }),
          getContentGeneratorConfig: () => ({ authType }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    });
    const result = await learnCommand.action!(
      ctx,
      'https://cdn.example.com/tutorial.mp4',
    );

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringMatching(/native video input/i),
    });
  });
});
