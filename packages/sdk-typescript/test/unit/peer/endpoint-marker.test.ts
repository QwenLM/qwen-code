/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerEndpoint } from '../../../src/peer/endpoint.js';
import { resolveQwenHome } from '../../../src/peer/registry.js';
import { makeTempRoot } from './helpers.js';

// This package's workers do not pass a stubbed HOME on to os.homedir().
const fakeHome = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome.dir ?? actual.homedir() };
});

// The XDG directory is a Linux default, and a Linux record needs the real
// process identity, so this runs on Linux only.
describe.skipIf(process.platform !== 'linux')(
  'PeerEndpoint in a new Linux home',
  () => {
    const saved = {
      QWEN_HOME: process.env['QWEN_HOME'],
      XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
    };
    let root: string;
    let home: string;
    const xdgDir = () => path.join(home, '.config', 'qwen');
    const start = (qwenHome?: string) =>
      PeerEndpoint.start({
        name: 'marker',
        ...(qwenHome !== undefined ? { qwenHome } : {}),
        socketPath: path.join(root, 'inbox.sock'),
        closeOnExit: false,
        keepAlive: false,
      });

    beforeEach(() => {
      root = makeTempRoot();
      home = path.join(root, 'home');
      fs.mkdirSync(home);
      fakeHome.dir = home;
      delete process.env['QWEN_HOME'];
      delete process.env['XDG_CONFIG_HOME'];
    });

    afterEach(() => {
      fakeHome.dir = undefined;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('claims the XDG directory it registers in', async () => {
      const endpoint = await start();
      try {
        expect(fs.readdirSync(path.join(xdgDir(), 'sessions'))).not.toEqual([]);
        expect(fs.existsSync(path.join(xdgDir(), '.qwen-global-dir'))).toBe(
          true,
        );
        // A ~/.qwen created later no longer moves new peers away.
        fs.mkdirSync(path.join(home, '.qwen'));
        expect(resolveQwenHome()).toBe(xdgDir());
      } finally {
        await endpoint.close();
      }
    });

    it('claims nothing with an explicit home, as under QWEN_HOME', async () => {
      const endpoint = await start(xdgDir());
      try {
        expect(fs.existsSync(path.join(xdgDir(), 'sessions'))).toBe(true);
        expect(fs.existsSync(path.join(xdgDir(), '.qwen-global-dir'))).toBe(
          false,
        );
      } finally {
        await endpoint.close();
      }
    });
  },
);
