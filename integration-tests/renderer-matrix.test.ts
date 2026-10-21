/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  E2E_RENDERER_ENV_VAR,
  E2E_RUNTIME_ENV_VAR,
  e2eRendererEnv,
  pickE2eRenderer,
  resolveE2eCliCommand,
} from './renderer-matrix.js';

const mockSpawnSync = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: mockSpawnSync,
  };
});

describe('renderer-matrix', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('defaults to ink so node-only runners keep their behavior', () => {
    expect(pickE2eRenderer({})).toBe('ink');
    expect(pickE2eRenderer({ [E2E_RENDERER_ENV_VAR]: '' })).toBe('ink');
  });

  it('rejects a misspelled renderer instead of silently testing Ink', () => {
    expect(() => pickE2eRenderer({ [E2E_RENDERER_ENV_VAR]: 'openui' })).toThrow(
      /QWEN_E2E_RENDERER must be ink or opentui/,
    );
  });

  it('opts into opentui via QWEN_E2E_RENDERER', () => {
    expect(pickE2eRenderer({ [E2E_RENDERER_ENV_VAR]: 'opentui' })).toBe(
      'opentui',
    );
    // Whitespace and case are tolerated — humans type these by hand.
    expect(pickE2eRenderer({ [E2E_RENDERER_ENV_VAR]: '  OpenTUI ' })).toBe(
      'opentui',
    );
  });

  it('pins the renderer through the product env var', () => {
    expect(e2eRendererEnv('ink')).toEqual({ QWEN_TUI_RENDERER: 'ink' });
    expect(e2eRendererEnv('opentui')).toEqual({
      QWEN_TUI_RENDERER: 'opentui',
      QWEN_TUI_RENDERER_STRICT: '1',
    });
  });

  it('uses node for ink', () => {
    expect(resolveE2eCliCommand('ink', {})).toBe('node');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('uses bun for opentui when bun is on PATH', () => {
    mockSpawnSync.mockReturnValueOnce({ error: null, status: 0 });

    expect(resolveE2eCliCommand('opentui', {})).toBe('bun');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'bun',
      ['--version'],
      expect.anything(),
    );
  });

  it('fails with an actionable error for opentui without bun', () => {
    mockSpawnSync.mockReturnValueOnce({
      error: new Error('spawn bun ENOENT'),
      status: null,
    });

    expect(() => resolveE2eCliCommand('opentui', {})).toThrow(
      /bun\+opentui E2E leg requires bun/,
    );
  });

  it('runs Ink on Bun when explicitly requested', () => {
    mockSpawnSync.mockReturnValueOnce({ status: 0 });
    expect(
      resolveE2eCliCommand('ink', { [E2E_RUNTIME_ENV_VAR]: '  Bun ' }),
    ).toBe('bun');
    expect(mockSpawnSync).toHaveBeenCalledOnce();
  });

  it.each([{ error: new Error('ENOENT'), status: null }, { status: 1 }])(
    'fails the Bun+Ink leg when the runtime probe fails: %j',
    (result) => {
      mockSpawnSync.mockReturnValueOnce(result);
      expect(() =>
        resolveE2eCliCommand('ink', { [E2E_RUNTIME_ENV_VAR]: 'bun' }),
      ).toThrow(/bun\+ink E2E leg requires bun/);
    },
  );

  it('rejects unknown runtimes and unsupported combinations', () => {
    expect(() =>
      resolveE2eCliCommand('ink', { [E2E_RUNTIME_ENV_VAR]: 'deno' }),
    ).toThrow(/QWEN_E2E_RUNTIME must be node or bun/);
    expect(() =>
      resolveE2eCliCommand('opentui', { [E2E_RUNTIME_ENV_VAR]: 'node' }),
    ).toThrow(/opentui requires bun in the E2E matrix/);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
