/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import {
  clipboardHasImage,
  saveClipboardImage,
  cleanupOldClipboardImages,
} from '../utils/clipboardUtils.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';

export const pasteImageCommand: SlashCommand = {
  name: 'paste-image',
  altNames: ['pi', 'clipboard-image'],
  get description() {
    return t('Paste an image from clipboard and attach it to your message');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context,
    _args: string,
  ): Promise<SlashCommandActionReturn | void> => {
    const { config } = context.services;
    const targetDir = config?.getTargetDir() || process.cwd();

    try {
      if (await clipboardHasImage()) {
        const imagePath = await saveClipboardImage(targetDir);

        if (imagePath) {
          // Clean up old images in background
          cleanupOldClipboardImages(targetDir).catch(() => {
            // Ignore cleanup errors
          });

          // Get relative path
          const relativePath = path.relative(targetDir, imagePath);

          // Get file stats
          const stats = await fs.stat(imagePath);
          const sizeKB = (stats.size / 1024).toFixed(1);

          // Generate hash
          const fileBuffer = await fs.readFile(imagePath);
          const hash = crypto
            .createHash('sha256')
            .update(fileBuffer)
            .digest('hex');

          // Build success message
          const message = [
            '📎 Clipboard image loaded',
            `• Path: ${imagePath}`,
            `• Type: image/png`,
            `• Size: ${sizeKB} KB`,
            `• Hash: ${hash.substring(0, 8)}…${hash.substring(hash.length - 4)}`,
            `• Auto-delete: 5 minutes`,
            '',
            `📌 To reference this image, type: @${relativePath}`,
          ].join('\n');

          // Import `console`? No, use `context.ui.addItem`.
          context.ui.addItem(
            {
              type: 'info',
              text: message,
            },
            Date.now(),
          );

          return {
            type: 'update_input',
            content: `@${relativePath} `,
          };
        } else {
          return {
            type: 'message',
            messageType: 'error',
            content: t('❌ Failed to save clipboard image'),
          };
        }
      } else {
        return {
          type: 'message',
          messageType: 'info',
          content: t(
            '📋 No image found in clipboard. Copy an image first, then try again.',
          ),
        };
      }
    } catch (error) {
      console.error('Error handling clipboard image:', error);
      return {
        type: 'message',
        messageType: 'error',
        content: t('❌ Error processing clipboard image'),
      };
    }
  },
};
