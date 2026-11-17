/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeerEndpoint } from '../../../src/peer/endpoint.js';
import * as identity from '../../../src/peer/identity.js';
import { makeTempRoot } from './helpers.js';

vi.mock('../../../src/peer/identity.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/peer/identity.js')>();
  return {
    ...actual,
    readPidNamespaceId: vi.fn(actual.readPidNamespaceId),
    readProcStartToken: vi.fn(actual.readProcStartToken),
  };
});

describe.skipIf(process.platform !== 'linux')(
  'PeerEndpoint on Linux without its identity',
  () => {
    const roots: string[] = [];

    afterEach(() => {
      vi.mocked(identity.readPidNamespaceId).mockReset();
      vi.mocked(identity.readProcStartToken).mockReset();
      for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it.each([
      ['PID namespace', () => vi.mocked(identity.readPidNamespaceId)],
      ['start token', () => vi.mocked(identity.readProcStartToken)],
    ] as const)(
      'refuses to publish a record without its %s',
      async (_label, reader) => {
        const root = makeTempRoot();
        roots.push(root);
        const home = path.join(root, 'home');
        const socketPath = path.join(root, 'inbox.sock');
        reader().mockReturnValue(null);

        await expect(
          PeerEndpoint.start({
            name: 'x',
            qwenHome: home,
            socketPath,
            closeOnExit: false,
            keepAlive: false,
          }),
        ).rejects.toMatchObject({ code: 'registry-unwritable' });
        expect(fs.existsSync(home)).toBe(false);
        expect(fs.existsSync(socketPath)).toBe(false);
      },
    );
  },
);
