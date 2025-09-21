/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Part, PartListUnion } from '@google/genai';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import {
  shouldOfferVisionSwitch,
  processVisionSwitchOutcome,
  getVisionSwitchGuidanceMessage,
  useVisionAutoSwitch,
} from './useVisionAutoSwitch.js';
import { VisionSwitchOutcome } from '../components/ModelSwitchDialog.js';
import { MessageType } from '../types.js';
import { getDefaultVisionModel } from '../models/availableModels.js';

describe('useVisionAutoSwitch helpers', () => {
  describe('shouldOfferVisionSwitch', () => {
    it('returns false when authType is not QWEN_OAUTH', () => {
      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/png', data: '...' } },
      ];
      const result = shouldOfferVisionSwitch(
        parts,
        AuthType.USE_GEMINI,
        'qwen3-coder-plus',
        true,
      );
      expect(result).toBe(false);
    });

    it('returns false when current model is already a vision model', () => {
      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/png', data: '...' } },
      ];
      const result = shouldOfferVisionSwitch(
        parts,
        AuthType.QWEN_OAUTH,
        'qwen-vl-max-latest',
        true,
      );
      expect(result).toBe(false);
    });

    it('returns true when image parts exist, QWEN_OAUTH, and model is not vision', () => {
      const parts: PartListUnion = [
        { text: 'hello' },
        { inlineData: { mimeType: 'image/jpeg', data: '...' } },
      ];
      const result = shouldOfferVisionSwitch(
        parts,
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        true,
      );
      expect(result).toBe(true);
    });

    it('detects image when provided as a single Part object (non-array)', () => {
      const singleImagePart: PartListUnion = {
        fileData: { mimeType: 'image/gif', fileUri: 'file://image.gif' },
      } as Part;
      const result = shouldOfferVisionSwitch(
        singleImagePart,
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        true,
      );
      expect(result).toBe(true);
    });

    it('returns false when parts contain no images', () => {
      const parts: PartListUnion = [{ text: 'just text' }];
      const result = shouldOfferVisionSwitch(
        parts,
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        true,
      );
      expect(result).toBe(false);
    });

    it('returns false when parts is a plain string', () => {
      const parts: PartListUnion = 'plain text';
      const result = shouldOfferVisionSwitch(
        parts,
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        true,
      );
      expect(result).toBe(false);
    });

    it('returns false when visionModelPreviewEnabled is false', () => {
      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/png', data: '...' } },
      ];
      const result = shouldOfferVisionSwitch(
        parts,
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        false,
      );
      expect(result).toBe(false);
    });
  });

  describe('processVisionSwitchOutcome', () => {
    it('maps SwitchOnce to a one-time model override', () => {
      const vl = getDefaultVisionModel();
      const result = processVisionSwitchOutcome(VisionSwitchOutcome.SwitchOnce);
      expect(result).toEqual({ modelOverride: vl });
    });

    it('maps SwitchSessionToVL to a persistent session model', () => {
      const vl = getDefaultVisionModel();
      const result = processVisionSwitchOutcome(
        VisionSwitchOutcome.SwitchSessionToVL,
      );
      expect(result).toEqual({ persistSessionModel: vl });
    });

    it('maps DisallowWithGuidance to showGuidance', () => {
      const result = processVisionSwitchOutcome(
        VisionSwitchOutcome.DisallowWithGuidance,
      );
      expect(result).toEqual({ showGuidance: true });
    });
  });

  describe('getVisionSwitchGuidanceMessage', () => {
    it('returns the expected guidance message', () => {
      const vl = getDefaultVisionModel();
      const expected =
        'To use images with your query, you can:\n' +
        `• Use /model set ${vl} to switch to a vision-capable model\n` +
        '• Or remove the image and provide a text description instead';
      expect(getVisionSwitchGuidanceMessage()).toBe(expected);
    });
  });
});

describe('useVisionAutoSwitch hook', () => {
  type AddItemFn = (
    item: { type: MessageType; text: string },
    ts: number,
  ) => any;

  const createMockConfig = (authType: AuthType, initialModel: string) => {
    let currentModel = initialModel;
    const mockConfig: Partial<Config> = {
      getModel: vi.fn(() => currentModel),
      setModel: vi.fn((m: string) => {
        currentModel = m;
      }),
      getContentGeneratorConfig: vi.fn(() => ({
        authType,
        model: currentModel,
        apiKey: 'test-key',
        vertexai: false,
      })),
    };
    return mockConfig as Config;
  };

  let addItem: AddItemFn;

  beforeEach(() => {
    vi.clearAllMocks();
    addItem = vi.fn();
  });

  it('returns shouldProceed=true immediately for continuations', async () => {
    const config = createMockConfig(AuthType.QWEN_OAUTH, 'qwen3-coder-plus');
    const { result } = renderHook(() =>
      useVisionAutoSwitch(config, addItem as any, true, vi.fn()),
    );

    const parts: PartListUnion = [
      { inlineData: { mimeType: 'image/png', data: '...' } },
    ];
    let res: any;
    await act(async () => {
      res = await result.current.handleVisionSwitch(parts, Date.now(), true);
    });
    expect(res).toEqual({ shouldProceed: true });
    expect(addItem).not.toHaveBeenCalled();
  });

  it('does nothing when authType is not QWEN_OAUTH', async () => {
    const config = createMockConfig(AuthType.USE_GEMINI, 'qwen3-coder-plus');
    const onVisionSwitchRequired = vi.fn();
    const { result } = renderHook(() =>
      useVisionAutoSwitch(config, addItem as any, true, onVisionSwitchRequired),
    );

    const parts: PartListUnion = [
      { inlineData: { mimeType: 'image/png', data: '...' } },
    ];
    let res: any;
    await act(async () => {
      res = await result.current.handleVisionSwitch(parts, 123, false);
    });
    expect(res).toEqual({ shouldProceed: true });
    expect(onVisionSwitchRequired).not.toHaveBeenCalled();
  });

  it('does nothing when there are no image parts', async () => {
    const config = createMockConfig(AuthType.QWEN_OAUTH, 'qwen3-coder-plus');
    const onVisionSwitchRequired = vi.fn();
    const { result } = renderHook(() =>
      useVisionAutoSwitch(config, addItem as any, true, onVisionSwitchRequired),
    );

    const parts: PartListUnion = [{ text: 'no images here' }];
    let res: any;
    await act(async () => {
      res = await result.current.handleVisionSwitch(parts, 456, false);
    });
    expect(res).toEqual({ shouldProceed: true });
    expect(onVisionSwitchRequired).not.toHaveBeenCalled();
  });

  it('shows guidance and blocks when dialog returns showGuidance', async () => {
    const config = createMockConfig(AuthType.QWEN_OAUTH, 'qwen3-coder-plus');
    const onVisionSwitchRequired = vi
      .fn()
      .mockResolvedValue({ showGuidance: true });
    const { result } = renderHook(() =>
      useVisionAutoSwitch(config, addItem as any, true, onVisionSwitchRequired),
    );

    const parts: PartListUnion = [
      { inlineData: { mimeType: 'image/png', data: '...' } },
    ];

    const userTs = 1010;
    let res: any;
    await act(async () => {
      res = await result.current.handleVisionSwitch(parts, userTs, false);
    });

    expect(addItem).toHaveBeenCalledWith(
      { type: MessageType.INFO, text: getVisionSwitchGuidanceMessage() },
      userTs,
    );
    expect(res).toEqual({ shouldProceed: false });
    expect(config.setModel).not.toHaveBeenCalled();
  });

  it('applies a one-time override and returns originalModel, then restores', async () => {
    const initialModel = 'qwen3-coder-plus';
    const config = createMockConfig(AuthType.QWEN_OAUTH, initialModel);
    const onVisionSwitchRequired = vi
      .fn()
      .mockResolvedValue({ modelOverride: 'qwen-vl-max-latest' });
    const { result } = renderHook(() =>
      useVisionAutoSwitch(config, addItem as any, true, onVisionSwitchRequired),
    );

    const parts: PartListUnion = [
      { inlineData: { mimeType: 'image/png', data: '...' } },
    ];

    let res: any;
    await act(async () => {
      res = await result.current.handleVisionSwitch(parts, 2020, false);
    });

    expect(res).toEqual({ shouldProceed: true, originalModel: initialModel });
    expect(config.setModel).toHaveBeenCalledWith('qwen-vl-max-latest');

    // Now restore
    act(() => {
      result.current.restoreOriginalModel();
    });
    expect(config.setModel).toHaveBeenLastCalledWith(initialModel);
  });

  it('persists session model when dialog requests persistence', async () => {
    const config = createMockConfig(AuthType.QWEN_OAUTH, 'qwen3-coder-plus');
    const onVisionSwitchRequired = vi
      .fn()
      .mockResolvedValue({ persistSessionModel: 'qwen-vl-max-latest' });
    const { result } = renderHook(() =>
      useVisionAutoSwitch(config, addItem as any, true, onVisionSwitchRequired),
    );

    const parts: PartListUnion = [
      { inlineData: { mimeType: 'image/png', data: '...' } },
    ];

    let res: any;
    await act(async () => {
      res = await result.current.handleVisionSwitch(parts, 3030, false);
    });

    expect(res).toEqual({ shouldProceed: true });
    expect(config.setModel).toHaveBeenCalledWith('qwen-vl-max-latest');

    // Restore should be a no-op since no one-time override was used
    act(() => {
      result.current.restoreOriginalModel();
    });
    // Last call should still be the persisted model set
    expect((config.setModel as any).mock.calls.pop()?.[0]).toBe(
      'qwen-vl-max-latest',
    );
  });

  it('returns shouldProceed=true when dialog returns no special flags', async () => {
    const config = createMockConfig(AuthType.QWEN_OAUTH, 'qwen3-coder-plus');
    const onVisionSwitchRequired = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() =>
      useVisionAutoSwitch(config, addItem as any, true, onVisionSwitchRequired),
    );

    const parts: PartListUnion = [
      { inlineData: { mimeType: 'image/png', data: '...' } },
    ];
    let res: any;
    await act(async () => {
      res = await result.current.handleVisionSwitch(parts, 4040, false);
    });
    expect(res).toEqual({ shouldProceed: true });
    expect(config.setModel).not.toHaveBeenCalled();
  });

  it('blocks when dialog throws or is cancelled', async () => {
    const config = createMockConfig(AuthType.QWEN_OAUTH, 'qwen3-coder-plus');
    const onVisionSwitchRequired = vi.fn().mockRejectedValue(new Error('x'));
    const { result } = renderHook(() =>
      useVisionAutoSwitch(config, addItem as any, true, onVisionSwitchRequired),
    );

    const parts: PartListUnion = [
      { inlineData: { mimeType: 'image/png', data: '...' } },
    ];
    let res: any;
    await act(async () => {
      res = await result.current.handleVisionSwitch(parts, 5050, false);
    });
    expect(res).toEqual({ shouldProceed: false });
    expect(config.setModel).not.toHaveBeenCalled();
  });

  it('does nothing when visionModelPreviewEnabled is false', async () => {
    const config = createMockConfig(AuthType.QWEN_OAUTH, 'qwen3-coder-plus');
    const onVisionSwitchRequired = vi.fn();
    const { result } = renderHook(() =>
      useVisionAutoSwitch(
        config,
        addItem as any,
        false,
        onVisionSwitchRequired,
      ),
    );

    const parts: PartListUnion = [
      { inlineData: { mimeType: 'image/png', data: '...' } },
    ];
    let res: any;
    await act(async () => {
      res = await result.current.handleVisionSwitch(parts, 6060, false);
    });
    expect(res).toEqual({ shouldProceed: true });
    expect(onVisionSwitchRequired).not.toHaveBeenCalled();
  });
});
