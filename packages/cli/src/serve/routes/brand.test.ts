/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerBrandRoutes } from './brand.js';
import { loadSettings } from '../../config/settings.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return { ...actual, loadSettings: vi.fn() };
});

vi.mock('../../utils/stdioHelpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/stdioHelpers.js')>();
  return { ...actual, writeStderrLine: vi.fn() };
});

function stubSettings(scopes: {
  system?: Record<string, unknown>;
  systemDefaults?: Record<string, unknown>;
  user?: Record<string, unknown>;
}): void {
  vi.mocked(loadSettings).mockReturnValue({
    system: { settings: scopes.system ?? {} },
    systemDefaults: { settings: scopes.systemDefaults ?? {} },
    user: { settings: scopes.user ?? {} },
    workspace: { settings: {} },
  } as never);
}

function makeApp() {
  const app = express();
  registerBrandRoutes(app, { boundWorkspace: '/workspace' });
  return app;
}

describe('GET /brand', () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-route-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers an empty brand when nothing is configured', async () => {
    stubSettings({});
    const response = await request(makeApp()).get('/brand');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
  });

  it('answers the configured name', async () => {
    stubSettings({ user: { ui: { brand: { name: 'QiuQiu Code' } } } });
    const response = await request(makeApp()).get('/brand');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ name: 'QiuQiu Code' });
  });

  it('resolves a logo file into a data URI', async () => {
    const logoPath = path.join(dir, 'logo.svg');
    fs.writeFileSync(logoPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    stubSettings({ user: { ui: { brand: { logoPath } } } });
    const response = await request(makeApp()).get('/brand');
    expect(response.status).toBe(200);
    expect(response.body.logoDataUri).toBe(
      `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')}`,
    );
  });

  it('never loads workspace settings', async () => {
    stubSettings({});
    await request(makeApp()).get('/brand');
    expect(loadSettings).toHaveBeenCalledWith('/workspace', {
      skipLoadEnvironment: true,
      skipWorkspaceSettings: true,
    });
  });

  it('keeps the name and reports the rejection when the logo cannot be read', async () => {
    stubSettings({
      user: {
        ui: {
          brand: {
            name: 'QiuQiu Code',
            logoPath: path.join(dir, 'missing.svg'),
          },
        },
      },
    });
    const response = await request(makeApp()).get('/brand');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ name: 'QiuQiu Code' });
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('does not exist'),
    );
  });

  it('degrades to an empty brand instead of failing when settings cannot load', async () => {
    vi.mocked(loadSettings).mockImplementation(() => {
      throw new Error('settings exploded');
    });
    const response = await request(makeApp()).get('/brand');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({});
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('settings exploded'),
    );
  });
});
