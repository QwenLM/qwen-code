/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { keepManifestLayout } from '../keep-manifest-layout.js';

describe('keepManifestLayout', () => {
  it('keeps dependency order and empty blocks, taking only the new version', () => {
    // Shapes from the v0.24.4 bump: pnpm sorted the companion's dependencies
    // and dropped web-templates' empty block.
    const original = `{
  "name": "companion",
  "version": "0.24.3",
  "dependencies": {
    "@qwen-code/sdk": "*",
    "@modelcontextprotocol/sdk": "^1.30.0"
  },
  "optionalDependencies": {},
  "devDependencies": {
    "@types/node": "^22.0.0"
  }
}
`;
    const updated = `{
  "name": "companion",
  "version": "0.24.4",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "@qwen-code/sdk": "*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0"
  }
}
`;

    expect(keepManifestLayout(original, updated)).toBe(
      original.replace('"0.24.3"', '"0.24.4"'),
    );
  });

  it('leaves nested version fields alone', () => {
    const original = `{
  "name": "pkg",
  "engines": {
    "version": "unrelated"
  },
  "version": "1.0.0"
}
`;
    const updated = `{
  "name": "pkg",
  "engines": {
    "version": "unrelated"
  },
  "version": "1.1.0-preview.0"
}
`;

    expect(keepManifestLayout(original, updated)).toBe(updated);
  });

  it('falls back to pnpm output when the original has no top-level version', () => {
    const original = '{\n  "name": "pkg"\n}\n';
    const updated = '{\n  "name": "pkg",\n  "version": "1.0.0"\n}\n';

    expect(keepManifestLayout(original, updated)).toBe(updated);
  });
});
