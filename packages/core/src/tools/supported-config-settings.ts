/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';

/**
 * Descriptor for a setting that the ConfigTool is allowed to read/write.
 * Only settings listed here are accessible — this is the security boundary.
 */
export interface ConfigSettingDescriptor {
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Value type for validation and coercion. */
  type: 'string' | 'boolean';
  /** Whether the Agent may write this setting. */
  writable: boolean;
  /** Read the current value from Config. */
  read: (config: Config) => string;
  /** Write a new value. Returns null on success, error message on failure. */
  write: (config: Config, value: string) => Promise<string | null>;
}

/**
 * Curated allowlist of settings the Agent can access via ConfigTool.
 * Phase 1: model only. Extend by adding entries here.
 */
export const SUPPORTED_CONFIG_SETTINGS: Record<
  string,
  ConfigSettingDescriptor
> = {
  model: {
    description:
      'The active LLM model ID. GET returns the current model and available options. SET switches the model for this session.',
    type: 'string',
    writable: true,
    read: (config) => config.getModel(),
    write: async (config, value) => {
      try {
        await config.setModel(value, {
          reason: 'agent-config-tool',
          context: 'ConfigTool SET',
        });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  },
};

export function isSupported(key: string): boolean {
  return key in SUPPORTED_CONFIG_SETTINGS;
}

export function getDescriptor(
  key: string,
): ConfigSettingDescriptor | undefined {
  return SUPPORTED_CONFIG_SETTINGS[key];
}

export function getAllKeys(): string[] {
  return Object.keys(SUPPORTED_CONFIG_SETTINGS);
}
