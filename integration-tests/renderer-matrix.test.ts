/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  E2E_RENDERER_ENV_VAR,
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
    vi.restoreAllMocks();
  });

  it('defaults to ink so node-only runners keep their behavior', () => {
    expect(pickE2eRenderer({})).toBe('ink');
    expect(pickE2eRenderer({ [E2E_RENDERER_ENV_VAR]: '' })).toBe('ink');
    expect(pickE2eRenderer({ [E2E_RENDERER_ENV_VAR]: 'garbage' })).toBe('ink');
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
    expect(resolveE2eCliCommand('ink')).toBe('node');
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('uses bun for opentui when bun is on PATH', () => {
    mockSpawnSync.mockReturnValueOnce({ error: null, status: 0 });

    expect(resolveE2eCliCommand('opentui')).toBe('bun');
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

    expect(() => resolveE2eCliCommand('opentui')).toThrow(
      /QWEN_E2E_RENDERER=opentui requires bun/,
    );
  });
});
