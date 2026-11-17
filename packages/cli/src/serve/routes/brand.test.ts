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
import type {
  LoadedSettings,
  Settings,
  SettingsFile,
} from '../../config/settings.js';
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

// The resolver reads the pre-substitution snapshot, so the stub must carry
// every field a real SettingsFile has — omitting `originalSettings` hid
// that dependency behind the `as never` until the placeholder guard moved
// the read. The return type is annotated so a future field the resolver
// needs fails typecheck here instead of silently reverting to `{}` bodies.
const file = (settings: Record<string, unknown>): SettingsFile => ({
  settings: settings as Settings,
  originalSettings: structuredClone(settings) as Settings,
  path: '/stub/settings.json',
});

function stubSettings(scopes: {
  system?: Record<string, unknown>;
  systemDefaults?: Record<string, unknown>;
  user?: Record<string, unknown>;
}): void {
  vi.mocked(loadSettings).mockReturnValue({
    system: file(scopes.system ?? {}),
    systemDefaults: file(scopes.systemDefaults ?? {}),
    user: file(scopes.user ?? {}),
    workspace: file({}),
  } as unknown as LoadedSettings);
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
    fs.writeFileSync(
      logoPath,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
    );
    stubSettings({ user: { ui: { brand: { logoPath } } } });
    const response = await request(makeApp()).get('/brand');
    expect(response.status).toBe(200);
    expect(response.body.logoDataUri).toBe(
      `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')}`,
    );
    // A well-formed logo produces no advisory: the operator's stderr stays
    // clean unless something actually needs their attention.
    expect(writeStderrLine).not.toHaveBeenCalled();
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
    // The protocol reference publishes this exact line as the operator's only
    // channel for "my logo was refused", so both prefixes are pinned: the
    // route's `qwen serve: GET /brand: ` and the resolver's `ui.brand.logoPath `.
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringMatching(
        /^qwen serve: GET \/brand: ui\.brand\.logoPath does not exist: /,
      ),
    );
  });

  it('writes one stderr line per misconfigured brand key', () => {
    // A name placeholder AND a missing logo in the same layer must each get
    // their own line — a joined line would displace one reason and break a
    // log rule keyed on either prefix. The user layer is built as the loader
    // actually produces it: substituted `settings` over a pre-substitution
    // `originalSettings` snapshot.
    vi.mocked(loadSettings).mockReturnValue({
      system: file({}),
      systemDefaults: file({}),
      user: {
        settings: {
          ui: {
            brand: {
              name: 'Repo Supplied Name',
              logoPath: path.join(dir, 'missing.svg'),
            },
          },
        },
        originalSettings: {
          ui: {
            brand: {
              name: '${PRODUCT_NAME}',
              logoPath: path.join(dir, 'missing.svg'),
            },
          },
        },
        path: '/stub/settings.json',
      },
      workspace: file({}),
    } as unknown as LoadedSettings);

    return request(makeApp())
      .get('/brand')
      .expect(200)
      .then(() => {
        expect(writeStderrLine).toHaveBeenCalledTimes(2);
        expect(writeStderrLine).toHaveBeenCalledWith(
          expect.stringMatching(/^qwen serve: GET \/brand: ui\.brand\.name /),
        );
        expect(writeStderrLine).toHaveBeenCalledWith(
          expect.stringMatching(
            /^qwen serve: GET \/brand: ui\.brand\.logoPath /,
          ),
        );
      });
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
