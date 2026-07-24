/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface IconvLite {
  decode(buffer: Buffer, encoding: string): string;
  encode(content: string, encoding: string): Buffer;
  encodingExists(encoding: string): boolean;
}

let iconvLiteModulePromise: Promise<IconvLite> | undefined;

export function loadIconvLite(): Promise<IconvLite> {
  iconvLiteModulePromise ??= import('iconv-lite').then(
    (module) => module.default as unknown as IconvLite,
  );
  return iconvLiteModulePromise;
}
