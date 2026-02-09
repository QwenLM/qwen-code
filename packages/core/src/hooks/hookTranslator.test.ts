/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  HookTranslatorGenAIv1,
  defaultHookTranslator,
  type LLMRequest,
  type LLMResponse,
  type HookToolConfig,
} from './hookTranslator.js';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
  ToolConfig,
} from '@google/genai';

describe('HookTranslator', () => {
  const translator = defaultHookTranslator;

  describe('toHookLLMRequest', () => {
    it('should convert SDK request to hook request format', () => {
      const sdkRequest: GenerateContentParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Hi there!' }],
          },
        ],
        config: {
          temperature: 0.7,
          maxOutputTokens: 100,
        },
      };

      const hookRequest = translator.toHookLLMRequest(sdkRequest);

      expect(hookRequest.model).toBe('test-model');
      expect(hookRequest.messages).toHaveLength(2);
      expect(hookRequest.messages[0]).toEqual({
        role: 'user',
        content: 'Hello',
      });
      expect(hookRequest.messages[1]).toEqual({
        role: 'model',
        content: 'Hi there!',
      });
      expect(hookRequest.config?.temperature).toBe(0.7);
      expect(hookRequest.config?.maxOutputTokens).toBe(100);
    });

    it('should handle string content', () => {
      const sdkRequest: GenerateContentParameters = {
        model: 'test-model',
        contents: ['Hello world'],
      };

      const hookRequest = translator.toHookLLMRequest(sdkRequest);

      expect(hookRequest.messages).toHaveLength(1);
      expect(hookRequest.messages[0]).toEqual({
        role: 'user',
        content: 'Hello world',
      });
    });

    it('should filter out non-text parts', () => {
      const sdkRequest: GenerateContentParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Hello' },
              { inlineData: { mimeType: 'image/png', data: 'base64data' } },
              { text: ' world' },
            ],
          },
        ],
      };

      const hookRequest = translator.toHookLLMRequest(sdkRequest);

      expect(hookRequest.messages).toHaveLength(1);
      expect(hookRequest.messages[0].content).toBe('Hello world');
    });

    it('should use default model when not specified', () => {
      const sdkRequest: GenerateContentParameters = {
        model: '',
        contents: [],
      };

      const hookRequest = translator.toHookLLMRequest(sdkRequest);

      expect(hookRequest.model).toBe('coder-model'); // DEFAULT_QWEN_FLASH_MODEL
    });
  });

  describe('fromHookLLMRequest', () => {
    it('should convert hook request back to SDK format', () => {
      const hookRequest: LLMRequest = {
        model: 'test-model',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'model', content: 'Hi!' },
        ],
        config: {
          temperature: 0.5,
          maxOutputTokens: 200,
        },
      };

      const sdkRequest = translator.fromHookLLMRequest(hookRequest);

      expect(sdkRequest.model).toBe('test-model');
      expect(sdkRequest.contents).toHaveLength(2);
      expect(
        (sdkRequest.contents as Array<{ role: string; parts: unknown }>)[0],
      ).toEqual({
        role: 'user',
        parts: [{ text: 'Hello' }],
      });
      expect(sdkRequest.config).toBeDefined();
    });

    it('should merge with base request', () => {
      const hookRequest: LLMRequest = {
        model: 'override-model',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const baseRequest: GenerateContentParameters = {
        model: 'base-model',
        contents: [],
        config: {
          temperature: 0.3,
        },
      };

      const sdkRequest = translator.fromHookLLMRequest(
        hookRequest,
        baseRequest,
      );

      expect(sdkRequest.model).toBe('override-model');
      // Should preserve base config values
      expect(sdkRequest.config).toBeDefined();
    });
  });

  describe('toHookLLMResponse', () => {
    it('should convert SDK response to hook response format', () => {
      const sdkResponse: GenerateContentResponse = {
        text: () => 'Hello world',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Hello world' }],
            },
            finishReason: 'STOP',
            index: 0,
            safetyRatings: [
              { category: 'HARM_CATEGORY', probability: 'NEGLIGIBLE' },
            ],
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      } as unknown as GenerateContentResponse;

      const hookResponse = translator.toHookLLMResponse(sdkResponse);

      expect(hookResponse.text).toBe('Hello world');
      expect(hookResponse.candidates).toHaveLength(1);
      expect(hookResponse.candidates[0].content.parts).toEqual(['Hello world']);
      expect(hookResponse.candidates[0].finishReason).toBe('STOP');
      expect(hookResponse.usageMetadata?.promptTokenCount).toBe(10);
    });

    it('should handle response without text', () => {
      const sdkResponse: GenerateContentResponse = {
        candidates: [],
      } as unknown as GenerateContentResponse;

      const hookResponse = translator.toHookLLMResponse(sdkResponse);

      expect(hookResponse.candidates).toHaveLength(0);
    });
  });

  describe('fromHookLLMResponse', () => {
    it('should convert hook response to SDK format', () => {
      const hookResponse: LLMResponse = {
        text: 'Hello world',
        candidates: [
          {
            content: {
              role: 'model',
              parts: ['Hello world'],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      };

      const sdkResponse = translator.fromHookLLMResponse(hookResponse);

      expect(sdkResponse.text).toBe('Hello world');
      expect(sdkResponse.candidates).toHaveLength(1);
      expect(sdkResponse.candidates?.[0].content?.parts).toEqual([
        { text: 'Hello world' },
      ]);
      expect(sdkResponse.usageMetadata?.totalTokenCount).toBe(15);
    });
  });

  describe('toHookToolConfig', () => {
    it('should convert SDK tool config to hook format', () => {
      const sdkToolConfig = {
        functionCallingConfig: {
          mode: 'ANY' as const,
          allowedFunctionNames: ['tool1', 'tool2'],
        },
      } as unknown as ToolConfig;

      const hookToolConfig = translator.toHookToolConfig(sdkToolConfig);

      expect(hookToolConfig.mode).toBe('ANY');
      expect(hookToolConfig.allowedFunctionNames).toEqual(['tool1', 'tool2']);
    });

    it('should handle empty tool config', () => {
      const sdkToolConfig: ToolConfig = {};

      const hookToolConfig = translator.toHookToolConfig(sdkToolConfig);

      expect(hookToolConfig.mode).toBeUndefined();
      expect(hookToolConfig.allowedFunctionNames).toBeUndefined();
    });
  });

  describe('fromHookToolConfig', () => {
    it('should convert hook tool config to SDK format', () => {
      const hookToolConfig: HookToolConfig = {
        mode: 'AUTO',
        allowedFunctionNames: ['tool1'],
      };

      const sdkToolConfig = translator.fromHookToolConfig(hookToolConfig);

      expect(sdkToolConfig.functionCallingConfig?.mode).toBe('AUTO');
      expect(sdkToolConfig.functionCallingConfig?.allowedFunctionNames).toEqual(
        ['tool1'],
      );
    });

    it('should return empty config when no mode or allowed names', () => {
      const hookToolConfig: HookToolConfig = {};

      const sdkToolConfig = translator.fromHookToolConfig(hookToolConfig);

      expect(sdkToolConfig.functionCallingConfig).toBeUndefined();
    });
  });

  describe('round-trip conversion', () => {
    it('should preserve data through round-trip for requests', () => {
      const originalRequest: GenerateContentParameters = {
        model: 'test-model',
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        ],
        config: {
          temperature: 0.7,
        },
      };

      const hookRequest = translator.toHookLLMRequest(originalRequest);
      const convertedBack = translator.fromHookLLMRequest(hookRequest);

      expect(convertedBack.model).toBe(originalRequest.model);
      // Contents should be preserved in some form
      expect(convertedBack.contents).toBeDefined();
    });

    it('should preserve data through round-trip for responses', () => {
      const originalResponse: LLMResponse = {
        text: 'Test response',
        candidates: [
          {
            content: {
              role: 'model',
              parts: ['Test response'],
            },
            finishReason: 'STOP',
          },
        ],
      };

      const sdkResponse = translator.fromHookLLMResponse(originalResponse);
      const convertedBack = translator.toHookLLMResponse(sdkResponse);

      expect(convertedBack.text).toBe(originalResponse.text);
      expect(convertedBack.candidates).toHaveLength(1);
    });
  });
});

describe('HookTranslatorGenAIv1', () => {
  it('should be instantiable', () => {
    const translator = new HookTranslatorGenAIv1();
    expect(translator).toBeDefined();
    expect(translator).toBeInstanceOf(HookTranslatorGenAIv1);
  });
});
