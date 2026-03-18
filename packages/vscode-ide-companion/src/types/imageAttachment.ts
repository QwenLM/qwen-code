/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ImageAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
  timestamp: number;
}

export interface SavedImageAttachment {
  path: string;
  name: string;
  mimeType: string;
}
