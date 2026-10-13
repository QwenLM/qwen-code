/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeEnvironment,
  loadEnvironment,
  reloadEnvironment,
  resetEnvironmentTrackingForTesting,
} from './environment.js';
import type { Settings } from './settingsSchema.js';

const flags = '--volume /deployment/managed:/tmp/alias';

describe('operator-only managed sandbox flags', () => {
  let root: string;
  let workspace: string;
  beforeEach(() => {
    root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-flags-boundary-')),
    );
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(root, 'home'));
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.stubEnv('USERPROFILE', path.join(root, 'home'));
    vi.stubEnv('QWEN_HOME', path.join(root, 'home', '.qwen'));
    vi.stubEnv('SANDBOX_FLAGS', '');
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
    resetEnvironmentTrackingForTesting();
  });
  afterEach(() => {
    resetEnvironmentTrackingForTesting();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(
    ['.env', '.qwen/.env', 'settings.env'].flatMap((source) =>
      ['load', 'reload', 'snapshot'].map((operation) => ({
        source,
        operation,
      })),
    ),
  )(
    'rejects project $source flags during $operation',
    ({ source, operation }) => {
      const settings = {} as Settings;
      if (source === 'settings.env') settings.env = { SANDBOX_FLAGS: flags };
      else {
        const file = path.join(workspace, source);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `SANDBOX_FLAGS=${flags}\n`);
      }
      if (operation === 'load') loadEnvironment(settings, workspace);
      else if (operation === 'reload')
        reloadEnvironment(settings, workspace, true);
      else {
        const snapshot = buildRuntimeEnvironment(settings, workspace, {}, true);
        expect(snapshot.effectiveEnv['SANDBOX_FLAGS']).toBeUndefined();
        return;
      }
      expect(process.env['SANDBOX_FLAGS']).toBe('');
    },
  );

  it.each(['launch environment', 'home .env'])(
    'preserves the advanced override supplied by the %s',
    (source) => {
      if (source === 'launch environment') vi.stubEnv('SANDBOX_FLAGS', flags);
      else
        fs.writeFileSync(
          path.join(root, 'home', '.env'),
          `SANDBOX_FLAGS=${flags}\n`,
        );
      const settings = {} as Settings;
      loadEnvironment(settings, workspace);
      expect(process.env['SANDBOX_FLAGS']).toBe(flags);
      reloadEnvironment(settings, workspace, true);
      expect(process.env['SANDBOX_FLAGS']).toBe(flags);
      expect(
        buildRuntimeEnvironment(settings, workspace, process.env, true)
          .effectiveEnv['SANDBOX_FLAGS'],
      ).toBe(flags);
    },
  );
});
