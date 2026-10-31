/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  chmod,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openManagedLocalState } from './managed-local-state.js';

describe.skipIf(process.platform === 'win32')(
  'Managed local persistent state',
  () => {
    let temporary: string;
    beforeEach(async () => {
      temporary = await mkdtemp(path.join(os.tmpdir(), 'managed-local-state-'));
    });
    afterEach(async () => {
      await rm(temporary, { recursive: true, force: true });
    });

    it('retains credentials, identity and ports on restart and excludes concurrent launchers', async () => {
      const directory = path.join(temporary, 'data');
      const first = await openManagedLocalState(directory);
      try {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect(
          (await stat(path.join(directory, 'state.json'))).mode & 0o777,
        ).toBe(0o600);
        expect(
          new Set([
            first.state.publicToken,
            first.state.harnessToken,
            first.state.brokerToken,
            first.state.signingKey,
            first.state.writerBindingKey,
            first.state.runtimeCredentialKey,
          ]).size,
        ).toBe(6);
        await expect(openManagedLocalState(directory)).rejects.toThrow(
          'already in use',
        );
      } finally {
        await first.release();
      }
      const second = await openManagedLocalState(directory);
      try {
        expect(second.state).toEqual(first.state);
      } finally {
        await second.release();
      }
    });

    it('does not replace corrupted or missing state alongside persisted data', async () => {
      const directory = path.join(temporary, 'data');
      const first = await openManagedLocalState(directory);
      await first.release();
      const statePath = path.join(directory, 'state.json');
      const original = await readFile(statePath, 'utf8');
      await writeFile(statePath, '{"schemaVersion":1}', { mode: 0o600 });
      await expect(openManagedLocalState(directory)).rejects.toThrow(
        'Invalid local state',
      );
      expect(await readFile(statePath, 'utf8')).toBe('{"schemaVersion":1}');
      await writeFile(statePath, original, { mode: 0o600 });
      await rm(statePath);
      await expect(openManagedLocalState(directory)).rejects.toThrow(
        'restore the original',
      );
      await expect(stat(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects public credential files and symbolic-link data directories', async () => {
      const directory = path.join(temporary, 'data');
      const first = await openManagedLocalState(directory);
      await first.release();
      await chmod(path.join(directory, 'state.json'), 0o644);
      await expect(openManagedLocalState(directory)).rejects.toThrow(
        'mode 0600',
      );
      const link = path.join(temporary, 'link');
      await symlink(directory, link);
      await expect(openManagedLocalState(link)).rejects.toThrow(
        'symbolic link',
      );
    });
  },
);
