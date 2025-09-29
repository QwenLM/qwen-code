/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Part, PartListUnion } from '@google/genai';
import { AuthType, type Config, ApprovalMode } from '@qwen-code/qwen-code-core';

// Mock the image format functions from core package
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isSupportedImageMimeType: vi.fn((mimeType: string) =>
      [
        'image/png',
        'image/jpeg',
        'image/jpg',
        'image/gif',
        'image/webp',
      ].includes(mimeType),
    ),
    getUnsupportedImageFormatWarning: vi.fn(
      () =>
        'Only the following image formats are supported: BMP, JPEG, JPG, PNG, TIFF, WEBP, HEIC. Other formats may not work as expected.',
    ),
  };
});
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
        'vision-model',
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

    it('returns true when image parts exist in YOLO mode context', () => {
      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/png', data: '...' } },
      ];
      const result = shouldOfferVisionSwitch(
        parts,
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        true,
      );
      expect(result).toBe(true);
    });

    it('returns false when no image parts exist in YOLO mode context', () => {
      const parts: PartListUnion = [{ text: 'just text' }];
      const result = shouldOfferVisionSwitch(
        parts,
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        true,
      );
      expect(result).toBe(false);
    });

    it('returns false when already using vision model in YOLO mode context', () => {
      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/png', data: '...' } },
      ];
      const result = shouldOfferVisionSwitch(
        parts,
        AuthType.QWEN_OAUTH,
        'vision-model',
        true,
      );
      expect(result).toBe(false);
    });

    it('returns false when authType is not QWEN_OAUTH in YOLO mode context', () => {
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

    it('maps ContinueWithCurrentModel to empty result', () => {
      const result = processVisionSwitchOutcome(
        VisionSwitchOutcome.ContinueWithCurrentModel,
      );
      expect(result).toEqual({});
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

  const createMockConfig = (
    authType: AuthType,
    initialModel: string,
    approvalMode: ApprovalMode = ApprovalMode.DEFAULT,
    vlmSwitchMode?: string,
  ) => {
    let currentModel = initialModel;
    const mockConfig: Partial<Config> = {
      getModel: vi.fn(() => currentModel),
      setModel: vi.fn(async (m: string) => {
        currentModel = m;
      }),
      getApprovalMode: vi.fn(() => approvalMode),
      getVlmSwitchMode: vi.fn(() => vlmSwitchMode),
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

  it('continues with current model when dialog returns empty result', async () => {
    const config = createMockConfig(AuthType.QWEN_OAUTH, 'qwen3-coder-plus');
    const onVisionSwitchRequired = vi.fn().mockResolvedValue({}); // Empty result for ContinueWithCurrentModel
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

    // Should not add any guidance message
    expect(addItem).not.toHaveBeenCalledWith(
      { type: MessageType.INFO, text: getVisionSwitchGuidanceMessage() },
      userTs,
    );
    expect(res).toEqual({ shouldProceed: true });
    expect(config.setModel).not.toHaveBeenCalled();
  });

  it('applies a one-time override and returns originalModel, then restores', async () => {
    const initialModel = 'qwen3-coder-plus';
    const config = createMockConfig(AuthType.QWEN_OAUTH, initialModel);
    const onVisionSwitchRequired = vi
      .fn()
      .mockResolvedValue({ modelOverride: 'coder-model' });
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
    expect(config.setModel).toHaveBeenCalledWith('coder-model', {
      reason: 'vision_auto_switch',
      context: 'User-prompted vision switch (one-time override)',
    });

    // Now restore
    await act(async () => {
      await result.current.restoreOriginalModel();
    });
    expect(config.setModel).toHaveBeenLastCalledWith(initialModel, {
      reason: 'vision_auto_switch',
      context: 'Restoring original model after vision switch',
    });
  });

  it('persists session model when dialog requests persistence', async () => {
    const config = createMockConfig(AuthType.QWEN_OAUTH, 'qwen3-coder-plus');
    const onVisionSwitchRequired = vi
      .fn()
      .mockResolvedValue({ persistSessionModel: 'coder-model' });
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
    expect(config.setModel).toHaveBeenCalledWith('coder-model', {
      reason: 'vision_auto_switch',
      context: 'User-prompted vision switch (session persistent)',
    });

    // Restore should be a no-op since no one-time override was used
    await act(async () => {
      await result.current.restoreOriginalModel();
    });
    // Last call should still be the persisted model set
    expect((config.setModel as any).mock.calls.pop()?.[0]).toBe('coder-model');
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

  describe('YOLO mode behavior', () => {
    it('automatically switches to vision model in YOLO mode without showing dialog', async () => {
      const initialModel = 'qwen3-coder-plus';
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        initialModel,
        ApprovalMode.YOLO,
      );
      const onVisionSwitchRequired = vi.fn(); // Should not be called in YOLO mode
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/png', data: '...' } },
      ];

      let res: any;
      await act(async () => {
        res = await result.current.handleVisionSwitch(parts, 7070, false);
      });

      // Should automatically switch without calling the dialog
      expect(onVisionSwitchRequired).not.toHaveBeenCalled();
      expect(res).toEqual({
        shouldProceed: true,
        originalModel: initialModel,
      });
      expect(config.setModel).toHaveBeenCalledWith(getDefaultVisionModel(), {
        reason: 'vision_auto_switch',
        context: 'YOLO mode auto-switch for image content',
      });
    });

    it('does not switch in YOLO mode when no images are present', async () => {
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        ApprovalMode.YOLO,
      );
      const onVisionSwitchRequired = vi.fn();
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [{ text: 'no images here' }];

      let res: any;
      await act(async () => {
        res = await result.current.handleVisionSwitch(parts, 8080, false);
      });

      expect(res).toEqual({ shouldProceed: true });
      expect(onVisionSwitchRequired).not.toHaveBeenCalled();
      expect(config.setModel).not.toHaveBeenCalled();
    });

    it('does not switch in YOLO mode when already using vision model', async () => {
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        'vision-model',
        ApprovalMode.YOLO,
      );
      const onVisionSwitchRequired = vi.fn();
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/png', data: '...' } },
      ];

      let res: any;
      await act(async () => {
        res = await result.current.handleVisionSwitch(parts, 9090, false);
      });

      expect(res).toEqual({ shouldProceed: true });
      expect(onVisionSwitchRequired).not.toHaveBeenCalled();
      expect(config.setModel).not.toHaveBeenCalled();
    });

    it('restores original model after YOLO mode auto-switch', async () => {
      const initialModel = 'qwen3-coder-plus';
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        initialModel,
        ApprovalMode.YOLO,
      );
      const onVisionSwitchRequired = vi.fn();
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/png', data: '...' } },
      ];

      // First, trigger the auto-switch
      await act(async () => {
        await result.current.handleVisionSwitch(parts, 10100, false);
      });

      // Verify model was switched
      expect(config.setModel).toHaveBeenCalledWith(getDefaultVisionModel(), {
        reason: 'vision_auto_switch',
        context: 'YOLO mode auto-switch for image content',
      });

      // Now restore the original model
      await act(async () => {
        await result.current.restoreOriginalModel();
      });

      // Verify model was restored
      expect(config.setModel).toHaveBeenLastCalledWith(initialModel, {
        reason: 'vision_auto_switch',
        context: 'Restoring original model after vision switch',
      });
    });

    it('does not switch in YOLO mode when authType is not QWEN_OAUTH', async () => {
      const config = createMockConfig(
        AuthType.USE_GEMINI,
        'qwen3-coder-plus',
        ApprovalMode.YOLO,
      );
      const onVisionSwitchRequired = vi.fn();
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/png', data: '...' } },
      ];

      let res: any;
      await act(async () => {
        res = await result.current.handleVisionSwitch(parts, 11110, false);
      });

      expect(res).toEqual({ shouldProceed: true });
      expect(onVisionSwitchRequired).not.toHaveBeenCalled();
      expect(config.setModel).not.toHaveBeenCalled();
    });

    it('does not switch in YOLO mode when visionModelPreviewEnabled is false', async () => {
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        ApprovalMode.YOLO,
      );
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
        res = await result.current.handleVisionSwitch(parts, 12120, false);
      });

      expect(res).toEqual({ shouldProceed: true });
      expect(onVisionSwitchRequired).not.toHaveBeenCalled();
      expect(config.setModel).not.toHaveBeenCalled();
    });

    it('handles multiple image formats in YOLO mode', async () => {
      const initialModel = 'qwen3-coder-plus';
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        initialModel,
        ApprovalMode.YOLO,
      );
      const onVisionSwitchRequired = vi.fn();
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [
        { text: 'Here are some images:' },
        { inlineData: { mimeType: 'image/jpeg', data: '...' } },
        { fileData: { mimeType: 'image/png', fileUri: 'file://image.png' } },
        { text: 'Please analyze them.' },
      ];

      let res: any;
      await act(async () => {
        res = await result.current.handleVisionSwitch(parts, 13130, false);
      });

      expect(res).toEqual({
        shouldProceed: true,
        originalModel: initialModel,
      });
      expect(config.setModel).toHaveBeenCalledWith(getDefaultVisionModel(), {
        reason: 'vision_auto_switch',
        context: 'YOLO mode auto-switch for image content',
      });
      expect(onVisionSwitchRequired).not.toHaveBeenCalled();
    });
  });

  describe('VLM switch mode default behavior', () => {
    it('should automatically switch once when vlmSwitchMode is "once"', async () => {
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        ApprovalMode.DEFAULT,
        'once',
      );
      const onVisionSwitchRequired = vi.fn(); // Should not be called
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/jpeg', data: 'base64data' } },
      ];

      const switchResult = await result.current.handleVisionSwitch(
        parts,
        Date.now(),
        false,
      );

      expect(switchResult.shouldProceed).toBe(true);
      expect(switchResult.originalModel).toBe('qwen3-coder-plus');
      expect(config.setModel).toHaveBeenCalledWith('vision-model', {
        reason: 'vision_auto_switch',
        context: 'Default VLM switch mode: once (one-time override)',
      });
      expect(onVisionSwitchRequired).not.toHaveBeenCalled();
    });

    it('should switch session when vlmSwitchMode is "session"', async () => {
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        ApprovalMode.DEFAULT,
        'session',
      );
      const onVisionSwitchRequired = vi.fn(); // Should not be called
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/jpeg', data: 'base64data' } },
      ];

      const switchResult = await result.current.handleVisionSwitch(
        parts,
        Date.now(),
        false,
      );

      expect(switchResult.shouldProceed).toBe(true);
      expect(switchResult.originalModel).toBeUndefined(); // No original model for session switch
      expect(config.setModel).toHaveBeenCalledWith('vision-model', {
        reason: 'vision_auto_switch',
        context: 'Default VLM switch mode: session (session persistent)',
      });
      expect(onVisionSwitchRequired).not.toHaveBeenCalled();
    });

    it('should continue with current model when vlmSwitchMode is "persist"', async () => {
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        ApprovalMode.DEFAULT,
        'persist',
      );
      const onVisionSwitchRequired = vi.fn(); // Should not be called
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/jpeg', data: 'base64data' } },
      ];

      const switchResult = await result.current.handleVisionSwitch(
        parts,
        Date.now(),
        false,
      );

      expect(switchResult.shouldProceed).toBe(true);
      expect(switchResult.originalModel).toBeUndefined();
      expect(config.setModel).not.toHaveBeenCalled();
      expect(onVisionSwitchRequired).not.toHaveBeenCalled();
    });

    it('should fall back to user prompt when vlmSwitchMode is not set', async () => {
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        ApprovalMode.DEFAULT,
        undefined, // No default mode
      );
      const onVisionSwitchRequired = vi
        .fn()
        .mockResolvedValue({ modelOverride: 'vision-model' });
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/jpeg', data: 'base64data' } },
      ];

      const switchResult = await result.current.handleVisionSwitch(
        parts,
        Date.now(),
        false,
      );

      expect(switchResult.shouldProceed).toBe(true);
      expect(onVisionSwitchRequired).toHaveBeenCalledWith(parts);
    });

    it('should fall back to persist behavior when vlmSwitchMode has invalid value', async () => {
      const config = createMockConfig(
        AuthType.QWEN_OAUTH,
        'qwen3-coder-plus',
        ApprovalMode.DEFAULT,
        'invalid-value',
      );
      const onVisionSwitchRequired = vi.fn(); // Should not be called
      const { result } = renderHook(() =>
        useVisionAutoSwitch(
          config,
          addItem as any,
          true,
          onVisionSwitchRequired,
        ),
      );

      const parts: PartListUnion = [
        { inlineData: { mimeType: 'image/jpeg', data: 'base64data' } },
      ];

      const switchResult = await result.current.handleVisionSwitch(
        parts,
        Date.now(),
        false,
      );

      expect(switchResult.shouldProceed).toBe(true);
      expect(switchResult.originalModel).toBeUndefined();
      // For invalid values, it should continue with current model (persist behavior)
      expect(config.setModel).not.toHaveBeenCalled();
      expect(onVisionSwitchRequired).not.toHaveBeenCalled();
    });
  });
});
