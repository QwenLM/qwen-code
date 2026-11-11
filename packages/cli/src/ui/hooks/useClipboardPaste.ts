/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { useStdout } from 'ink';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type Config,
  type PastedContent,
  isVisionSupportedModel,
  runLogger,
  escapePath,
  preparePastedImage,
} from '@qwen-code/core';
import {
  clipboardHasImage,
  readClipboardText,
} from '../utils/clipboardUtils.js';
import { startClipboardImageCapture } from '../utils/clipboardImageCapture.js';
import { escapeAtSymbols } from '../utils/atMentionUtils.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useModel } from '../contexts/ConfigContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import {
  appEvents,
  AppEvent,
  TransientMessageType,
} from '../../utils/events.js';

export interface UseClipboardPasteParams {
  buffer: TextBuffer;
  config: Config;
}

export interface ClipboardPasteOptions {
  imageOnly?: boolean;
  silentIfNoImage?: boolean;
}

function getClipboardPasteUnavailableMessage(): string {
  if (process.platform === 'linux') {
    return 'Clipboard paste unavailable. On Linux install wl-clipboard, xclip, or xsel.';
  }
  return 'Clipboard paste unavailable.';
}

type DeferredPastedImage = PastedContent & {
  type: 'image';
  preparationId: string;
};

function createDeferredPastedImage(
  id: number,
  imagePath: string,
): DeferredPastedImage {
  return {
    id,
    type: 'image',
    content: '',
    filename: path.basename(imagePath),
    sourcePath: imagePath,
    preparationId: randomUUID(),
  };
}

function createPendingClipboardImage(id: number): DeferredPastedImage {
  return {
    id,
    type: 'image',
    content: '',
    filename: 'Pasted image',
    preparationId: randomUUID(),
  };
}

/**
 * Speculatively prepare a deferred image while the user continues typing.
 * Submit-time materialization remains the authoritative fallback on failure.
 */
function startPastedImagePrewarm(
  buffer: TextBuffer,
  image: DeferredPastedImage,
): void {
  void preparePastedImage(image)
    .then((prepared) => {
      buffer.resolveImagePaste(image.id, image.preparationId, prepared);
    })
    .catch((error) => {
      runLogger.debug(
        `[clipboard] background image preparation failed for ${image.sourcePath}`,
        error,
      );
    });
}

/**
 * Consumes dragged/pasted image file paths in place. Each image path is attached
 * to an inline `[Image #N]` placeholder immediately; pixel decoding and API
 * media-limit normalization starts in the background. Non-image paths in the
 * same paste keep the @-mention rewrite behavior.
 */
export function insertPastedImageFilePaths(
  buffer: TextBuffer,
  imagePaths: string[],
  otherPaths: string[],
): void {
  const imagePasteIds = buffer.reserveImagePasteIds(imagePaths.length);

  for (const [index, imagePath] of imagePaths.entries()) {
    const id = imagePasteIds[index];
    const pastedContent = createDeferredPastedImage(id, imagePath);
    buffer.addImagePaste(id, pastedContent);
    buffer.insert(`[Image #${id}] `);
    startPastedImagePrewarm(buffer, pastedContent);
  }
  for (const otherPath of otherPaths) {
    buffer.insert(`@${escapePath(otherPath)} `);
  }
}

/**
 * Owns the clipboard paste flow:
 *   1. Image paste registers an `[Image #N]` placeholder immediately.
 *   2. General paste first checks for an image, then falls back to OSC52/text
 *      paste.
 *   3. Clipboard capture, disk persistence, and decode/resize continue in the
 *      background; submit awaits the same capture task when necessary.
 *
 * Side effect: dismisses the shortcuts-help overlay if visible.
 */
export function useClipboardPaste({
  buffer,
  config,
}: UseClipboardPasteParams): (
  options?: ClipboardPasteOptions,
) => Promise<void> {
  const { stdout } = useStdout();
  const { merged: settings } = useSettings();
  const { setShortcutsHelpVisible } = useUIActions();
  const { shortcutsHelpVisible, currentModel } = useUIState();
  const listed = useModel(config, currentModel);

  return useCallback(
    async (options: ClipboardPasteOptions = {}) => {
      if (shortcutsHelpVisible) {
        setShortcutsHelpVisible(false);
      }
      try {
        const pasteImage = () => {
          // Gate: reject image paste when the current model lacks vision support.
          // When model is not yet determined (empty string), allow the paste
          // through — consistent with read-file.ts visionGateOrNull behaviour.
          if (currentModel && !isVisionSupportedModel(listed)) {
            appEvents.emit(AppEvent.TransientMessage, {
              message:
                'The current model does not support image input. Please switch to a vision-capable model.',
              type: TransientMessageType.Warning,
            });
            return;
          }

          const id = buffer.reserveImagePasteIds(1)[0];
          const pendingImage = createPendingClipboardImage(id);
          buffer.addImagePaste(id, pendingImage);
          buffer.insert(`[Image #${id}]`);

          void startClipboardImageCapture(pendingImage, config.getTargetDir())
            .then((capturedImage) => {
              buffer.resolveImagePaste(
                id,
                pendingImage.preparationId,
                capturedImage,
              );
              startPastedImagePrewarm(buffer, capturedImage);
            })
            .catch((error) => {
              runLogger.debug(
                '[clipboard] background image capture failed',
                error,
              );
              appEvents.emit(AppEvent.TransientMessage, {
                message:
                  'Failed to read clipboard image. Delete the image placeholder and paste again.',
                type: TransientMessageType.Warning,
              });
            });
        };

        if (options.imageOnly) {
          if (await clipboardHasImage()) {
            pasteImage();
          } else if (!options.silentIfNoImage) {
            appEvents.emit(AppEvent.TransientMessage, {
              message: 'Failed to read clipboard image.',
              type: TransientMessageType.Warning,
            });
          }
          return;
        }

        if (await clipboardHasImage()) {
          pasteImage();
          return;
        }

        if (settings.experimental?.useOSC52Paste) {
          stdout.write('\x1b]52;c;?\x07');
        } else {
          const textToInsert = await readClipboardText();
          if (textToInsert === null) {
            appEvents.emit(AppEvent.TransientMessage, {
              message: getClipboardPasteUnavailableMessage(),
              type: TransientMessageType.Warning,
            });
            return;
          }
          const escapedText = settings.ui?.escapePastedAtSymbols
            ? escapeAtSymbols(textToInsert)
            : textToInsert;
          buffer.insert(escapedText, { paste: true });
        }
      } catch (error) {
        runLogger.error('Error handling paste:', error);
        appEvents.emit(AppEvent.TransientMessage, {
          message: getClipboardPasteUnavailableMessage(),
          type: TransientMessageType.Warning,
        });
      }
    },
    [
      buffer,
      config,
      stdout,
      settings,
      currentModel,
      listed,
      shortcutsHelpVisible,
      setShortcutsHelpVisible,
    ],
  );
}
