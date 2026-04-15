/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { APPROVAL_MODES } from '../config/config.js';

/**
 * Descriptor for a setting that the ConfigTool is allowed to read/write.
 * Only settings listed here are accessible — this is the security boundary.
 */
export interface ConfigSettingDescriptor {
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Value type for this setting. */
  type: 'string' | 'boolean' | 'number';
  /** Whether the Agent may write this setting. */
  writable: boolean;
  /** Where this setting is stored. */
  source: 'global' | 'project';
  /** Fixed list of valid values (optional). Checked before write. */
  options?: readonly string[];
  /** Dynamic options generator (optional). Called when options is not set. */
  getOptions?: (config: Config) => string[];
  /** Async validation called before writing. Return null on success, error message on failure. */
  validateOnWrite?: (
    config: Config,
    value: string | boolean | number,
  ) => Promise<string | null>;
  /** Read the current value from Config. */
  read: (config: Config) => string | boolean | number;
  /** Write a new value. Returns null on success, error message on failure. */
  write: (
    config: Config,
    value: string | boolean | number,
  ) => Promise<string | null>;
}

/**
 * Curated allowlist of settings the Agent can access via ConfigTool.
 * Extend by adding entries here.
 */
export const SUPPORTED_CONFIG_SETTINGS: Record<
  string,
  ConfigSettingDescriptor
> = {
  // ── Model ──────────────────────────────────────────────────────────
  model: {
    description:
      'The active LLM model ID. GET returns the current model and available options. SET switches the model for this session.',
    type: 'string',
    writable: true,
    source: 'project',
    getOptions: (config) => {
      try {
        return config.getAvailableModels().map((m) => m.id);
      } catch {
        return [];
      }
    },
    read: (config) => config.getModel(),
    write: async (config, value) => {
      try {
        await config.setModel(String(value), {
          reason: 'agent-config-tool',
          context: 'ConfigTool SET',
        });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : 'Failed to set model';
      }
    },
  },

  // ── Approval Mode (read-only) ─────────────────────────────────────
  // Writing approvalMode is intentionally disabled: allowing the agent to
  // escalate its own permissions (even with 'ask' confirmation) is a prompt
  // injection risk. Users must change approval mode via slash command.
  approvalMode: {
    description:
      'The approval mode for tool calls. Controls how much user confirmation is required (read-only).',
    type: 'string',
    writable: false,
    source: 'project',
    getOptions: () => [...APPROVAL_MODES],
    read: (config) => config.getApprovalMode(),
    write: async () => 'approvalMode is read-only',
  },

  // ── Checkpointing (read-only) ─────────────────────────────────────
  checkpointing: {
    description:
      'Whether file checkpointing (code rewind) is enabled (read-only).',
    type: 'boolean',
    writable: false,
    source: 'global',
    read: (config) => config.getCheckpointingEnabled(),
    write: async () => 'checkpointing is read-only',
  },

  // ── File Filtering (read-only) ────────────────────────────────────
  respectGitIgnore: {
    description:
      'Whether to respect .gitignore rules when discovering files (read-only).',
    type: 'boolean',
    writable: false,
    source: 'project',
    read: (config) => config.getFileFilteringRespectGitIgnore(),
    write: async () => 'respectGitIgnore is read-only',
  },
  enableFuzzySearch: {
    description: 'Whether fuzzy file search is enabled (read-only).',
    type: 'boolean',
    writable: false,
    source: 'project',
    read: (config) => config.getFileFilteringEnableFuzzySearch(),
    write: async () => 'enableFuzzySearch is read-only',
  },

  // ── Read-only Settings ────────────────────────────────────────────
  debugMode: {
    description: 'Whether debug mode is enabled (read-only).',
    type: 'boolean',
    writable: false,
    source: 'global',
    read: (config) => config.getDebugMode(),
    write: async () => 'debugMode is read-only',
  },
  targetDir: {
    description: 'The project root directory (read-only).',
    type: 'string',
    writable: false,
    source: 'project',
    read: (config) => config.getTargetDir(),
    write: async () => 'targetDir is read-only',
  },
  outputFormat: {
    description:
      'The output format for the current session: text, json, or stream-json (read-only).',
    type: 'string',
    writable: false,
    source: 'global',
    read: (config) => config.getOutputFormat(),
    write: async () => 'outputFormat is read-only',
  },
};

export function isSupported(key: string): boolean {
  return Object.hasOwn(SUPPORTED_CONFIG_SETTINGS, key);
}

export function getDescriptor(
  key: string,
): ConfigSettingDescriptor | undefined {
  return Object.hasOwn(SUPPORTED_CONFIG_SETTINGS, key)
    ? SUPPORTED_CONFIG_SETTINGS[key]
    : undefined;
}

export function getAllKeys(): string[] {
  return Object.keys(SUPPORTED_CONFIG_SETTINGS);
}

/**
 * Get valid options for a setting (from static options or dynamic getOptions).
 */
export function getOptionsForSetting(
  key: string,
  config?: Config,
): string[] | undefined {
  const descriptor = Object.hasOwn(SUPPORTED_CONFIG_SETTINGS, key)
    ? SUPPORTED_CONFIG_SETTINGS[key]
    : undefined;
  if (!descriptor) return undefined;
  if (descriptor.options) return [...descriptor.options];
  if (descriptor.getOptions && config) return descriptor.getOptions(config);
  return undefined;
}
