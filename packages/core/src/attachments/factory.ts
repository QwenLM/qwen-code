/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Factory function for creating AttachmentMessage instances.
 *
 * createAttachmentMessage() is the ONLY way to create AttachmentMessages.
 * It adds uuid and timestamp automatically.
 */

import { randomUUID } from 'node:crypto';
import type { Attachment, AttachmentMessage } from './types.js';

/**
 * Create an AttachmentMessage wrapping the given attachment.
 *
 * This is the sole factory for AttachmentMessage objects. The uuid is
 * cryptographically random and the timestamp is the current UTC time.
 */
export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  const prepared = attachment.prepareForTranscript();
  return {
    type: 'attachment',
    attachment: prepared.toTranscript(),
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}
