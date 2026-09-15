/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What the `@qwen-code/sdk/peer` build must never ship.
 *
 * The subpath is a standalone implementation of the cross-session protocol:
 * a bundle carrying one of the SDK's runtime dependencies, or Qwen Code's
 * own sources, would no longer be one, and a declaration that imports an
 * internal package would not resolve for anyone who installs the SDK. Kept
 * in its own module so the build and a test share one definition.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Measured with `npm run build && wc -c dist/peer/*`: about 24 KiB (esm)
// and 25 KiB (cjs) at introduction. The headroom is for growth, not for a
// dependency slipping in; the token check below catches that separately.
export const MAX_PEER_BUNDLE_BYTES = 40 * 1024;

const FORBIDDEN_BUNDLE_TOKENS = [
  '@modelcontextprotocol',
  'zod',
  'qwen-code-core',
  'acp-bridge',
];

// Not a bare `@qwen-code/` prefix: the module's own doc comment names
// `@qwen-code/sdk/peer`, and the compiler keeps comments.
const FORBIDDEN_DECLARATION_TOKENS = [
  '@qwen-code/qwen-code-core',
  '@qwen-code/acp-bridge',
];

export function assertPeerBundle(filePath, maxBytes = MAX_PEER_BUNDLE_BYTES) {
  const size = statSync(filePath).size;
  if (size > maxBytes) {
    throw new Error(
      `Peer bundle ${filePath} is ${size} bytes; expected <= ${maxBytes}`,
    );
  }
  const contents = readFileSync(filePath, 'utf8');
  const found = FORBIDDEN_BUNDLE_TOKENS.find((token) =>
    contents.includes(token),
  );
  if (found) {
    throw new Error(`Peer bundle ${filePath} contains a dependency: ${found}`);
  }
}

/**
 * Every declaration the compiler emitted for the subpath, not just the
 * entry: the entry only re-exports, and a type import from an internal
 * package would land in whichever module used it.
 */
export function assertPeerDeclarations(dir) {
  const declarations = readdirSync(dir).filter((name) =>
    name.endsWith('.d.ts'),
  );
  if (!declarations.includes('index.d.ts')) {
    throw new Error(`Peer declarations in ${dir} have no index.d.ts`);
  }
  for (const name of declarations) {
    const contents = readFileSync(join(dir, name), 'utf8');
    const found = FORBIDDEN_DECLARATION_TOKENS.find((token) =>
      contents.includes(token),
    );
    if (found) {
      throw new Error(
        `Peer declaration ${name} references an internal package: ${found}`,
      );
    }
  }
}
