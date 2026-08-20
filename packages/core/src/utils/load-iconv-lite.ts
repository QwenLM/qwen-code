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

function isIconvLite(candidate: Partial<IconvLite>): candidate is IconvLite {
  return (
    'decode' in candidate &&
    typeof candidate.decode === 'function' &&
    'encode' in candidate &&
    typeof candidate.encode === 'function' &&
    'encodingExists' in candidate &&
    typeof candidate.encodingExists === 'function'
  );
}

export function loadIconvLite(): Promise<IconvLite> {
  iconvLiteModulePromise ??= import('iconv-lite').then((module) => {
    const imported = module as unknown as Partial<IconvLite> & {
      default?: IconvLite;
    };
    const candidate =
      'default' in imported && imported.default ? imported.default : imported;
    if (!isIconvLite(candidate)) {
      throw new Error('iconv-lite module does not match the expected API');
    }
    return candidate;
  });
  return iconvLiteModulePromise;
}
