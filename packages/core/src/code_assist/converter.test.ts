/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ServiceTier } from '@google/genai';
import { describe, expect, it } from 'vitest';
import {
  fromGenerateContentResponse,
  toGenerateContentRequest,
} from './converter.js';

describe('Code Assist converter', () => {
  it('wraps the existing Gemini request and unwraps the response', async () => {
    const request = await toGenerateContentRequest(
      {
        model: 'gemini-2.5-pro',
        contents: 'hello',
        config: {
          systemInstruction: 'system',
          temperature: 0.2,
          tools: [],
        },
      },
      'prompt-1',
      'project-1',
      'session-1',
    );

    expect(request).toMatchObject({
      model: 'gemini-2.5-pro',
      project: 'project-1',
      user_prompt_id: 'prompt-1',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        systemInstruction: { role: 'user', parts: [{ text: 'system' }] },
        generationConfig: { temperature: 0.2 },
        session_id: 'session-1',
        tools: [],
      },
    });

    const response = fromGenerateContentResponse({
      traceId: 'trace-1',
      response: {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'answer' }] } },
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 2,
          totalTokenCount: 5,
        },
        modelVersion: 'gemini-2.5-pro',
      },
    });

    expect(response.responseId).toBe('trace-1');
    expect(response.candidates?.[0]?.content?.parts?.[0]?.text).toBe('answer');
    expect(response.usageMetadata?.totalTokenCount).toBe(5);
    expect(response.modelVersion).toBe('gemini-2.5-pro');
  });

  it('turns part-only content into one user message with ordered parts', async () => {
    const request = await toGenerateContentRequest(
      {
        model: 'gemini-2.5-pro',
        contents: [{ text: 'first' }, { text: 'second' }],
      },
      'prompt-1',
    );
    expect(request.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'first' }, { text: 'second' }] },
    ]);
  });

  it('strips client metadata and foreign reasoning signatures', async () => {
    const original = {
      text: 'reasoning',
      partMetadata: { reattach: true },
      thoughtSignature: '{"id":"response-1","encrypted_content":"opaque"}',
    };
    const request = await toGenerateContentRequest(
      { model: 'gemini-4-argon', contents: [original] },
      'prompt-1',
    );
    expect(request.request.contents[0]?.parts?.[0]).toEqual({
      text: 'reasoning',
    });
    expect(original.thoughtSignature).toContain('encrypted_content');
    expect(original.partMetadata).toEqual({ reattach: true });
  });

  it('removes redundant display names and converts nested unsupported media', async () => {
    const request = await toGenerateContentRequest(
      {
        model: 'gemini-4-argon',
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/mpeg',
                  displayName: 'clip',
                  data: 'eQ==',
                },
              },
              {
                functionResponse: {
                  name: 'read_audio',
                  response: { ok: true },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'Audio/MPEG',
                        displayName: 'clip',
                        data: 'eQ==',
                      },
                    },
                    {
                      fileData: {
                        mimeType: 'video/mp4',
                        displayName: 'movie',
                        fileUri: 'https://media.test/movie',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      'prompt-1',
    );
    const parts = request.request.contents[0]?.parts;
    expect(parts?.[0]?.inlineData).toEqual({
      mimeType: 'audio/mpeg',
      data: 'eQ==',
    });
    expect(parts?.[1]?.functionResponse?.parts).toEqual([
      { text: 'Unsupported media type for Gemini: Audio/MPEG (clip).' },
      { text: 'Unsupported media type for Gemini: video/mp4 (movie).' },
    ]);
  });

  it('keeps native thought flags instead of inventing Thought:true text', async () => {
    const request = await toGenerateContentRequest(
      {
        model: 'gemini-4-argon',
        contents: [
          {
            role: 'model',
            parts: [
              { text: 'weighing the options', thought: true },
              { thought: true },
              {
                functionCall: { name: 'lookup', args: { q: 'value' } },
                thought: true,
              },
            ],
          },
        ],
      },
      'prompt-1',
    );
    expect(request.request.contents[0]?.parts).toEqual([
      { text: 'weighing the options', thought: true },
      { thought: true },
      {
        functionCall: { name: 'lookup', args: { q: 'value' } },
        thought: true,
      },
    ]);
  });

  it('resolves CallableTool declarations before JSON serialization', async () => {
    const request = await toGenerateContentRequest(
      {
        model: 'gemini-4-argon',
        contents: 'look up a value',
        config: {
          tools: [
            {
              tool: async () => ({
                functionDeclarations: [
                  { name: 'lookup', description: 'Lookup' },
                ],
              }),
              callTool: async () => [],
            },
          ],
        },
      },
      'prompt-1',
    );
    expect(request.request.tools).toEqual([
      { functionDeclarations: [{ name: 'lookup', description: 'Lookup' }] },
    ]);
  });

  it('maps speech, image and generator sampling preferences', async () => {
    const request = await toGenerateContentRequest(
      {
        model: 'gemini-4-argon',
        contents: 'draw',
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          speechConfig: 'Kore',
          imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
          maxOutputTokens: 80,
        },
      },
      'prompt-1',
      undefined,
      undefined,
      { temperature: 0.1, top_p: 0.2, max_tokens: 128 },
    );
    expect(request.request.generationConfig).toMatchObject({
      temperature: 0.1,
      topP: 0.2,
      maxOutputTokens: 80,
      imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
      },
    });
  });

  it('fails explicitly for Vertex-only options and service error envelopes', async () => {
    await expect(
      toGenerateContentRequest(
        {
          model: 'gemini-4-argon',
          contents: 'hello',
          config: { serviceTier: ServiceTier.FLEX },
        },
        'prompt-1',
      ),
    ).rejects.toThrow('Code Assist does not support serviceTier');
    expect(() =>
      fromGenerateContentResponse({
        error: { code: 500, message: 'backend failed' },
      }),
    ).toThrow('backend failed');
  });
});
