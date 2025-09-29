/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { type PartListUnion, type Part } from '@google/genai';
import { AuthType, type Config, ApprovalMode } from '@qwen-code/qwen-code-core';
import { useCallback, useRef } from 'react';
import { VisionSwitchOutcome } from '../components/ModelSwitchDialog.js';
import {
  getDefaultVisionModel,
  isVisionModel,
} from '../models/availableModels.js';
import { MessageType } from '../types.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import {
  isSupportedImageMimeType,
  getUnsupportedImageFormatWarning,
} from '@qwen-code/qwen-code-core';

/**
 * Checks if a PartListUnion contains image parts
 */
function hasImageParts(parts: PartListUnion): boolean {
  if (typeof parts === 'string') {
    return false;
  }

  if (Array.isArray(parts)) {
    return parts.some((part) => {
      // Skip string parts
      if (typeof part === 'string') return false;
      return isImagePart(part);
    });
  }

  // If it's a single Part (not a string), check if it's an image
  if (typeof parts === 'object') {
    return isImagePart(parts);
  }

  return false;
}

/**
 * Checks if a single Part is an image part
 */
function isImagePart(part: Part): boolean {
  // Check for inlineData with image mime type
  if ('inlineData' in part && part.inlineData?.mimeType?.startsWith('image/')) {
    return true;
  }

  // Check for fileData with image mime type
  if ('fileData' in part && part.fileData?.mimeType?.startsWith('image/')) {
    return true;
  }

  return false;
}

/**
 * Checks if image parts have supported formats and returns unsupported ones
 */
function checkImageFormatsSupport(parts: PartListUnion): {
  hasImages: boolean;
  hasUnsupportedFormats: boolean;
  unsupportedMimeTypes: string[];
} {
  const unsupportedMimeTypes: string[] = [];
  let hasImages = false;

  if (typeof parts === 'string') {
    return {
      hasImages: false,
      hasUnsupportedFormats: false,
      unsupportedMimeTypes: [],
    };
  }

  const partsArray = Array.isArray(parts) ? parts : [parts];

  for (const part of partsArray) {
    if (typeof part === 'string') continue;

    let mimeType: string | undefined;

    // Check inlineData
    if (
      'inlineData' in part &&
      part.inlineData?.mimeType?.startsWith('image/')
    ) {
      hasImages = true;
      mimeType = part.inlineData.mimeType;
    }

    // Check fileData
    if ('fileData' in part && part.fileData?.mimeType?.startsWith('image/')) {
      hasImages = true;
      mimeType = part.fileData.mimeType;
    }

    // Check if the mime type is supported
    if (mimeType && !isSupportedImageMimeType(mimeType)) {
      unsupportedMimeTypes.push(mimeType);
    }
  }

  return {
    hasImages,
    hasUnsupportedFormats: unsupportedMimeTypes.length > 0,
    unsupportedMimeTypes,
  };
}

/**
 * Determines if we should offer vision switch for the given parts, auth type, and current model
 */
export function shouldOfferVisionSwitch(
  parts: PartListUnion,
  authType: AuthType,
  currentModel: string,
  visionModelPreviewEnabled: boolean = true,
): boolean {
  // Only trigger for qwen-oauth
  if (authType !== AuthType.QWEN_OAUTH) {
    return false;
  }

  // If vision model preview is disabled, never offer vision switch
  if (!visionModelPreviewEnabled) {
    return false;
  }

  // If current model is already a vision model, no need to switch
  if (isVisionModel(currentModel)) {
    return false;
  }

  // Check if the current message contains image parts
  return hasImageParts(parts);
}

/**
 * Interface for vision switch result
 */
export interface VisionSwitchResult {
  modelOverride?: string;
  persistSessionModel?: string;
  showGuidance?: boolean;
}

/**
 * Processes the vision switch outcome and returns the appropriate result
 */
export function processVisionSwitchOutcome(
  outcome: VisionSwitchOutcome,
): VisionSwitchResult {
  const vlModelId = getDefaultVisionModel();

  switch (outcome) {
    case VisionSwitchOutcome.SwitchOnce:
      return { modelOverride: vlModelId };

    case VisionSwitchOutcome.SwitchSessionToVL:
      return { persistSessionModel: vlModelId };

    case VisionSwitchOutcome.ContinueWithCurrentModel:
      return {}; // Continue with current model, no changes needed

    default:
      return {}; // Default to continuing with current model
  }
}

/**
 * Gets the guidance message for when vision switch is disallowed
 */
export function getVisionSwitchGuidanceMessage(): string {
  const vlModelId = getDefaultVisionModel();
  return `To use images with your query, you can:
• Use /model set ${vlModelId} to switch to a vision-capable model
• Or remove the image and provide a text description instead`;
}

/**
 * Interface for vision switch handling result
 */
export interface VisionSwitchHandlingResult {
  shouldProceed: boolean;
  originalModel?: string;
}

/**
 * Custom hook for handling vision model auto-switching
 */
export function useVisionAutoSwitch(
  config: Config,
  addItem: UseHistoryManagerReturn['addItem'],
  visionModelPreviewEnabled: boolean = true,
  onVisionSwitchRequired?: (query: PartListUnion) => Promise<{
    modelOverride?: string;
    persistSessionModel?: string;
    showGuidance?: boolean;
  }>,
) {
  const originalModelRef = useRef<string | null>(null);

  const handleVisionSwitch = useCallback(
    async (
      query: PartListUnion,
      userMessageTimestamp: number,
      isContinuation: boolean,
    ): Promise<VisionSwitchHandlingResult> => {
      // Skip vision switch handling for continuations or if no handler provided
      if (isContinuation || !onVisionSwitchRequired) {
        return { shouldProceed: true };
      }

      const contentGeneratorConfig = config.getContentGeneratorConfig();

      // Only handle qwen-oauth auth type
      if (contentGeneratorConfig?.authType !== AuthType.QWEN_OAUTH) {
        return { shouldProceed: true };
      }

      // Check image format support first
      const formatCheck = checkImageFormatsSupport(query);

      // If there are unsupported image formats, show warning
      if (formatCheck.hasUnsupportedFormats) {
        addItem(
          {
            type: MessageType.INFO,
            text: getUnsupportedImageFormatWarning(),
          },
          userMessageTimestamp,
        );
        // Continue processing but with warning shown
      }

      // Check if vision switch is needed
      if (
        !shouldOfferVisionSwitch(
          query,
          contentGeneratorConfig.authType,
          config.getModel(),
          visionModelPreviewEnabled,
        )
      ) {
        return { shouldProceed: true };
      }

      // In YOLO mode, automatically switch to vision model without user interaction
      if (config.getApprovalMode() === ApprovalMode.YOLO) {
        const vlModelId = getDefaultVisionModel();
        originalModelRef.current = config.getModel();
        await config.setModel(vlModelId, {
          reason: 'vision_auto_switch',
          context: 'YOLO mode auto-switch for image content',
        });
        return {
          shouldProceed: true,
          originalModel: originalModelRef.current,
        };
      }

      // Check if there's a default VLM switch mode configured
      const defaultVlmSwitchMode = config.getVlmSwitchMode();
      if (defaultVlmSwitchMode) {
        // Convert string value to VisionSwitchOutcome enum
        let outcome: VisionSwitchOutcome;
        switch (defaultVlmSwitchMode) {
          case 'once':
            outcome = VisionSwitchOutcome.SwitchOnce;
            break;
          case 'session':
            outcome = VisionSwitchOutcome.SwitchSessionToVL;
            break;
          case 'persist':
            outcome = VisionSwitchOutcome.ContinueWithCurrentModel;
            break;
          default:
            // Invalid value, fall back to prompting user
            outcome = VisionSwitchOutcome.ContinueWithCurrentModel;
        }

        // Process the default outcome
        const visionSwitchResult = processVisionSwitchOutcome(outcome);

        if (visionSwitchResult.modelOverride) {
          // One-time model override
          originalModelRef.current = config.getModel();
          await config.setModel(visionSwitchResult.modelOverride, {
            reason: 'vision_auto_switch',
            context: `Default VLM switch mode: ${defaultVlmSwitchMode} (one-time override)`,
          });
          return {
            shouldProceed: true,
            originalModel: originalModelRef.current,
          };
        } else if (visionSwitchResult.persistSessionModel) {
          // Persistent session model change
          await config.setModel(visionSwitchResult.persistSessionModel, {
            reason: 'vision_auto_switch',
            context: `Default VLM switch mode: ${defaultVlmSwitchMode} (session persistent)`,
          });
          return { shouldProceed: true };
        }

        // For ContinueWithCurrentModel or any other case, proceed with current model
        return { shouldProceed: true };
      }

      try {
        const visionSwitchResult = await onVisionSwitchRequired(query);

        if (visionSwitchResult.modelOverride) {
          // One-time model override
          originalModelRef.current = config.getModel();
          await config.setModel(visionSwitchResult.modelOverride, {
            reason: 'vision_auto_switch',
            context: 'User-prompted vision switch (one-time override)',
          });
          return {
            shouldProceed: true,
            originalModel: originalModelRef.current,
          };
        } else if (visionSwitchResult.persistSessionModel) {
          // Persistent session model change
          await config.setModel(visionSwitchResult.persistSessionModel, {
            reason: 'vision_auto_switch',
            context: 'User-prompted vision switch (session persistent)',
          });
          return { shouldProceed: true };
        }

        // For ContinueWithCurrentModel or any other case, proceed with current model
        return { shouldProceed: true };
      } catch (_error) {
        // If vision switch dialog was cancelled or errored, don't proceed
        return { shouldProceed: false };
      }
    },
    [config, addItem, visionModelPreviewEnabled, onVisionSwitchRequired],
  );

  const restoreOriginalModel = useCallback(async () => {
    if (originalModelRef.current) {
      await config.setModel(originalModelRef.current, {
        reason: 'vision_auto_switch',
        context: 'Restoring original model after vision switch',
      });
      originalModelRef.current = null;
    }
  }, [config]);

  return {
    handleVisionSwitch,
    restoreOriginalModel,
  };
}
