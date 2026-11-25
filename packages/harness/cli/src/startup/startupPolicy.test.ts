/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildStartupPolicy } from './startupPolicy.js';

describe('buildStartupPolicy', () => {
  it('uses after-render cleanup for interactive startup', () => {
    expect(buildStartupPolicy({ kind: 'interactive' })).toMatchObject({
      mcpInitializationWait: 'none',
      preload: {
        interactiveUI: true,
        headlessSession: false,
        terminalCapabilityModule: true,
      },
      cleanup: {
        phase: 'afterFirstRender',
        delayMs: 5000,
        ref: false,
      },
    });
  });

  it('uses budgeted MCP for headless startup', () => {
    expect(
      buildStartupPolicy({ kind: 'headless' }),
    ).toMatchObject({
      mcpInitializationWait: 'budget',
      preload: {
        interactiveUI: false,
        headlessSession: true,
      },
      cleanup: {
        phase: 'afterModeEntry',
        delayMs: 5000,
        ref: false,
      },
    });
  });

  it('models daemon startup without runtime preload', () => {
    expect(buildStartupPolicy({ kind: 'daemon' })).toMatchObject({
      mcpInitializationWait: 'none',
      preload: {
        interactiveUI: false,
        headlessSession: false,
        terminalCapabilityModule: false,
      },
    });
  });

  it('models ACP startup with budgeted MCP', () => {
    expect(buildStartupPolicy({ kind: 'acp' })).toMatchObject({
      mcpInitializationWait: 'budget',
      preload: {
        interactiveUI: false,
        headlessSession: false,
      },
      cleanup: {
        phase: 'afterModeEntry',
        delayMs: 5000,
        ref: false,
      },
    });
  });

});
