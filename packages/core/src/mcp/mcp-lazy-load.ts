/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { McpRegistrationMode } from './sessionMcpManager/index.js';


export type McpLazyLoadApplication =
  | {
      readonly status: 'not-attempted-no-tools';
      readonly actualMode?: 'eager' | 'lazy';
    }
  | {
      readonly status: 'not-attempted-discovery-pending';
      readonly actualMode: 'eager' | 'lazy';
    }
  | {
      readonly status: 'bypassed-explicit';
      readonly source: 'settings' | 'environment';
      readonly actualMode: 'eager' | 'lazy';
    }
  | {
      readonly status: 'bypassed-code-mode';
      readonly actualMode: McpRegistrationMode;
    }
  | {
      readonly status: 'default-lazy';
      readonly actualMode: 'eager' | 'lazy';
    };

const applications = new WeakMap<
  Config,
  Promise<McpLazyLoadApplication>
>();

/**
 * Resolve the MCP registration mode where a TUI task is about to expose
 * discovered MCP tools to the model.
 *
 * The built-in default is lazy; explicit settings choices and environment
 * opt-ins stay authoritative and are never overridden here. The result is
 * frozen once per Config lifetime because the mode itself is process-scoped.
 */
export async function applyMcpLazyLoad(
  config: Config,
): Promise<McpLazyLoadApplication> {
  const existingApplication = applications.get(config);
  if (existingApplication) return await existingApplication;

  const manager = config.getMcpClientManager();
  if (!manager) {
    return { status: 'not-attempted-no-tools' };
  }
  const discovered = manager.getAllDiscoveredMcpTools();
  const configuredServerCount = Object.keys(manager.getMcpServers()).length;

  const application: Promise<McpLazyLoadApplication> = (async () => {
    // With CodeMode every MCP tool is deferred to scripts whatever the lazy
    // preference says, so the lazy/eager choice does not apply.
    if (config.getCodeModeExposure()) {
      const actualMode = manager.peekRegistrationMode() ?? 'eager';
      return { status: 'bypassed-code-mode', actualMode };
    }
    const source = config.getMcpLazyLoadSource();
    if (source !== 'default') {
      const actualMode = toMode(manager.peekLazyMode() === true);
      return { status: 'bypassed-explicit', source, actualMode };
    }

    const actualMode = toMode(manager.peekLazyMode() === true);
    if (discovered.length === 0) {
      const discoveryPending =
        configuredServerCount > 0 &&
        manager.getDiscoveryState() !== 'completed';
      return {
        status: discoveryPending
          ? 'not-attempted-discovery-pending'
          : 'not-attempted-no-tools',
        actualMode,
      };
    }

    return { status: 'default-lazy', actualMode };
  })();
  applications.set(config, application);
  return await application;
}

function toMode(lazy: boolean): 'eager' | 'lazy' {
  return lazy ? 'lazy' : 'eager';
}

