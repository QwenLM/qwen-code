/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StartupMode } from './determineStartupMode.js';

export type StartupMcpInitializationWait = 'none' | 'budget' | 'full';

export type StartupCleanupPhase =
  | 'disabled'
  | 'afterModeEntry'
  | 'afterSdkInitialize'
  | 'afterFirstRender';

export interface StartupCleanupPolicy {
  phase: StartupCleanupPhase;
  delayMs?: number;
  ref: boolean;
}

export interface StartupPreloadPolicy {
  interactiveUI: boolean;
  headlessSession: boolean;
  terminalCapabilityModule: boolean;
}

export interface StartupPolicy {
  mode: StartupMode;
  mcpInitializationWait: StartupMcpInitializationWait;
  preload: StartupPreloadPolicy;
  cleanup: StartupCleanupPolicy;
}

const NON_INTERACTIVE_DEFAULTS = {
  mcpInitializationWait: 'budget',
  preload: {
    interactiveUI: false,
    headlessSession: false,
    terminalCapabilityModule: false,
  },
  cleanup: {
    phase: 'afterModeEntry',
    delayMs: 5000,
    ref: false,
  },
} satisfies Pick<
  StartupPolicy,
  'mcpInitializationWait' | 'preload' | 'cleanup'
>;

export function buildStartupPolicy(mode: StartupMode): StartupPolicy {
  switch (mode.kind) {
    case 'interactive':
      return {
        mode,
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
      };
    case 'headless':
      return {
        ...NON_INTERACTIVE_DEFAULTS,
        mode,
        preload: {
          ...NON_INTERACTIVE_DEFAULTS.preload,
          headlessSession: true,
        },
      };
    case 'daemon':
      return {
        ...NON_INTERACTIVE_DEFAULTS,
        mode,
        mcpInitializationWait: 'none',
      };
    case 'acp':
      return {
        ...NON_INTERACTIVE_DEFAULTS,
        mode,
      };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
