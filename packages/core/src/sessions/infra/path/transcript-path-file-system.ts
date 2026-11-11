/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TranscriptPathFileSystem {
  realpath(path: string): Promise<string>;
}
