/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  E2E_RENDERER_ENV_VAR,
  e2eRendererEnv,
  pickE2eRenderer,
  resolveE2eCliCommand,
} from './renderer-matrix.js';

describe('renderer-matrix', () => {
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
  });
});
