/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import {
  serializeStreamJsonEnvelope,
  type StreamJsonOutputEnvelope,
  type StreamJsonUserEnvelope,
} from './types.js';

export function writeStreamJsonEnvelope(
  envelope: StreamJsonOutputEnvelope,
): void {
  process.stdout.write(`${serializeStreamJsonEnvelope(envelope)}\n`);
}

export function extractUserMessageText(
  envelope: StreamJsonUserEnvelope,
): string {
  const content = envelope.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && 'type' in block) {
          if (block.type === 'text' && 'text' in block) {
            return block.text ?? '';
          }
          return JSON.stringify(block);
        }
        return '';
      })
      .join('\n');
  }
  return '';
}
