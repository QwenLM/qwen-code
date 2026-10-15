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

let fixture: string;
let workspace: string;
let home: string;
const markerKeys = [
  'SANDBOX',
  'sandbox',
  'Sandbox',
  'SANDBOX_ENFORCEMENT',
  'sandbox_enforcement',
  'Sandbox_Enforcement',
] as const;

beforeEach(() => {
  fixture = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-markers-')),
  );
  workspace = path.join(fixture, 'workspace');
  home = path.join(fixture, 'home');
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('QWEN_HOME', path.join(home, '.qwen'));
  vi.stubEnv('CLOUD_SHELL', undefined);
  vi.stubEnv('BOUNDARY_REGRESSION_VALUE', undefined);
  for (const key of markerKeys) vi.stubEnv(key, undefined);
  resetEnvironmentTrackingForTesting();
});

afterEach(() => {
  resetEnvironmentTrackingForTesting();
  vi.unstubAllEnvs();
  fs.rmSync(fixture, { recursive: true, force: true });
});

function installFixture(source: string): Settings {
  const values = {
    ...Object.fromEntries(markerKeys.map((key) => [key, 'fixture-marker'])),
    BOUNDARY_REGRESSION_VALUE: 'ordinary-value',
  };
  const settings = { advanced: { excludedEnvVars: [] } } as Settings;
  if (source === 'settings.env') {
    settings.env = values;
  } else {
    const base = source.startsWith('home:') ? home : workspace;
    const file = path.join(base, source.split(':')[1]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
  }
  return settings;
}

describe('sandbox runtime markers', () => {
  for (const source of [
    'project:.env',
    'project:.qwen/.env',
    'home:.env',
    'home:.qwen/.env',
    'settings.env',
  ]) {
    it(`rejects file-sourced markers from ${source} on every application path`, () => {
      const settings = installFixture(source);
      loadEnvironment(settings, workspace);
      for (const key of markerKeys)
        expect.soft(process.env[key], `initial load ${key}`).toBeUndefined();
      expect
        .soft(process.env['BOUNDARY_REGRESSION_VALUE'])
        .toBe('ordinary-value');
      reloadEnvironment(settings, workspace, true);
      for (const key of markerKeys)
        expect.soft(process.env[key], `reload ${key}`).toBeUndefined();
      const snapshot = buildRuntimeEnvironment(settings, workspace, {}, true);
      for (const key of markerKeys)
        expect
          .soft(snapshot.effectiveEnv[key], `snapshot ${key}`)
          .toBeUndefined();
      expect
        .soft(snapshot.effectiveEnv['BOUNDARY_REGRESSION_VALUE'])
        .toBe('ordinary-value');
    });

    it(`preserves launcher markers when ${source} contains other values`, () => {
      const settings = installFixture(source);
      vi.stubEnv('SANDBOX', 'bwrap');
      vi.stubEnv('SANDBOX_ENFORCEMENT', 'full');
      loadEnvironment(settings, workspace);
      reloadEnvironment(settings, workspace, true);
      expect(process.env['SANDBOX']).toBe('bwrap');
      expect(process.env['SANDBOX_ENFORCEMENT']).toBe('full');
      const snapshot = buildRuntimeEnvironment(
        settings,
        workspace,
        {
          SANDBOX: 'bwrap',
          SANDBOX_ENFORCEMENT: 'full',
        },
        true,
      );
      expect(snapshot.effectiveEnv['SANDBOX']).toBe('bwrap');
      expect(snapshot.effectiveEnv['SANDBOX_ENFORCEMENT']).toBe('full');
    });
  }
});
