/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Extension,
  Config,
  ExtensionScope,
} from '@qwen-code/qwen-code-core';

/**
 * Top-level tabs of the extensions manager dialog, aligned with the Claude Code
 * `/plugin` command. The Errors tab is intentionally deferred per the spec.
 */
export const EXTENSIONS_TABS = {
  DISCOVER: 'discover',
  INSTALLED: 'installed',
  MARKETPLACES: 'marketplaces',
} as const;

export type ExtensionsTab =
  (typeof EXTENSIONS_TABS)[keyof typeof EXTENSIONS_TABS];

export interface ExtensionsTabDef {
  id: ExtensionsTab;
  label: string;
}

/**
 * Scope groups used to organize the Installed tab, mirroring Claude Code.
 */
export type InstalledGroup =
  | 'favorites'
  | 'local'
  | 'user'
  | 'project'
  | 'disabled';

/** Minimal display info for an MCP server shown in the Installed tab. */
export interface InstalledMcpInfo {
  name: string;
  status: string;
  scope: 'user' | 'project' | 'extension';
  isDisabled: boolean;
  transport: string;
  toolCount: number;
}

/** A single row in the Installed tab — either a plugin/extension or an MCP. */
export type InstalledItem =
  | {
      kind: 'plugin';
      key: string;
      name: string;
      extension: Extension;
      isActive: boolean;
      isFavorite: boolean;
      scope: ExtensionScope;
      group: InstalledGroup;
    }
  | {
      kind: 'mcp';
      key: string;
      name: string;
      mcp: InstalledMcpInfo;
      isActive: boolean;
      isFavorite: boolean;
      group: InstalledGroup;
    };

/**
 * Management steps for the extensions manager dialog.
 */
export const MANAGEMENT_STEPS = {
  EXTENSION_LIST: 'extension-list',
  ACTION_SELECTION: 'action-selection',
  EXTENSION_DETAIL: 'extension-detail',
  UNINSTALL_CONFIRMATION: 'uninstall-confirmation',
  DISABLE_SCOPE_SELECT: 'disable-scope-select',
  ENABLE_SCOPE_SELECT: 'enable-scope-select',
  UPDATE_PROGRESS: 'update-progress',
} as const;

/**
 * Props for step navigation.
 */
export interface StepNavigationProps {
  onNavigateToStep: (step: string) => void;
  onNavigateBack: () => void;
}

/**
 * Props for the extension list step.
 */
export interface ExtensionListStepProps extends StepNavigationProps {
  extensions: Extension[];
  extensionsUpdateState: Map<string, string>;
  onExtensionSelect: (extensionIndex: number) => void;
}

/**
 * Props for the extension detail step.
 */
export interface ExtensionDetailStepProps extends StepNavigationProps {
  selectedExtension: Extension | null;
}

/**
 * Props for the action selection step.
 */
export interface ActionSelectionStepProps extends StepNavigationProps {
  selectedExtension: Extension | null;
  hasUpdateAvailable: boolean;
  onActionSelect: (action: ExtensionAction) => void;
}

/**
 * Props for the uninstall confirmation step.
 */
export interface UninstallConfirmStepProps extends StepNavigationProps {
  selectedExtension: Extension | null;
  onConfirm: (extension: Extension) => Promise<void>;
}

/**
 * Props for the scope selection step.
 */
export interface ScopeSelectStepProps extends StepNavigationProps {
  selectedExtension: Extension | null;
  mode: 'disable' | 'enable';
  onScopeSelect: (scope: 'user' | 'workspace') => void;
}

/**
 * Available actions for an extension.
 */
export type ExtensionAction =
  | 'view'
  | 'update'
  | 'disable'
  | 'enable'
  | 'uninstall'
  | 'back';

/**
 * Props for the ExtensionsManagerDialog component.
 */
export interface ExtensionsManagerDialogProps {
  onClose: () => void;
  config: Config | null;
  initialTab?: ExtensionsTab;
}
