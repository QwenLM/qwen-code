/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Extension, Config } from '@qwen-code/qwen-code-core';

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
}
