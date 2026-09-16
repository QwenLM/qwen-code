/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertPeerBundle,
  assertPeerDeclarations,
} from '../../scripts/peer-build-assertions.js';

describe('peer build assertions', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpb-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, contents: string): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it('passes declarations that only name the subpath itself', () => {
    write(
      'index.d.ts',
      "/** `@qwen-code/sdk/peer` */\nexport * from './endpoint.js';\n",
    );
    write('endpoint.d.ts', 'export declare class PeerEndpoint {}\n');
    expect(() => assertPeerDeclarations(dir)).not.toThrow();
  });

  it('reads every declaration, not only the entry that re-exports them', () => {
    write('index.d.ts', "export * from './registry.js';\n");
    write(
      'registry.d.ts',
      "import type { SessionRegistryRecord } from '@qwen-code/qwen-code-core';\n",
    );
    expect(() => assertPeerDeclarations(dir)).toThrow(/registry\.d\.ts/);
  });

  it('insists the entry declaration exists', () => {
    write('endpoint.d.ts', 'export {};\n');
    expect(() => assertPeerDeclarations(dir)).toThrow(/index\.d\.ts/);
  });

  it('refuses a bundle over budget or carrying a dependency', () => {
    const clean = write('clean.js', 'export const a = 1;\n');
    expect(() => assertPeerBundle(clean)).not.toThrow();
    expect(() => assertPeerBundle(clean, 4)).toThrow(/bytes/);
    const leaky = write('leaky.js', 'import "zod";\n');
    expect(() => assertPeerBundle(leaky)).toThrow(/zod/);
  });
});
