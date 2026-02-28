/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text } from 'ink';
import {
  ExtensionListStep,
  ExtensionDetailStep,
  ActionSelectionStep,
  UninstallConfirmStep,
  ScopeSelectStep,
} from './steps/index.js';
import { MANAGEMENT_STEPS, type ExtensionAction } from './types.js';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { t } from '../../../i18n/index.js';
import type { Extension, Config } from '@qwen-code/qwen-code-core';
import { SettingScope, createDebugLogger } from '@qwen-code/qwen-code-core';
import { ExtensionUpdateState } from '../../state/extensions.js';

interface ExtensionsManagerDialogProps {
  onClose: () => void;
  config: Config | null;
}

const debugLogger = createDebugLogger('EXTENSIONS_MANAGER_DIALOG');

export function ExtensionsManagerDialog({
  onClose,
  config,
}: ExtensionsManagerDialogProps) {
  const { extensionsUpdateState } = useUIState();

  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [selectedExtensionIndex, setSelectedExtensionIndex] =
    useState<number>(-1);
  const [navigationStack, setNavigationStack] = useState<string[]>([
    MANAGEMENT_STEPS.EXTENSION_LIST,
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updateInProgress, setUpdateInProgress] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Load extensions
  const loadExtensions = useCallback(async () => {
    if (!config) return;

    const extensionManager = config.getExtensionManager();
    if (!extensionManager) {
      debugLogger.error('ExtensionManager not available');
      setLoadError(t('ExtensionManager not available'));
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      await extensionManager.refreshCache();
      const loadedExtensions = extensionManager.getLoadedExtensions();
      setExtensions(loadedExtensions);
    } catch (error) {
      debugLogger.error('Failed to load extensions:', error);
      setLoadError(
        error instanceof Error ? error.message : t('Failed to load extensions'),
      );
    } finally {
      setIsLoading(false);
    }
  }, [config]);

  // Initial load
  useEffect(() => {
    loadExtensions();
  }, [loadExtensions]);

  // Memoized selected extension
  const selectedExtension = useMemo(
    () =>
      selectedExtensionIndex >= 0 ? extensions[selectedExtensionIndex] : null,
    [extensions, selectedExtensionIndex],
  );

  // Check if update is available for selected extension
  const hasUpdateAvailable = useMemo(() => {
    if (!selectedExtension) return false;
    const state = extensionsUpdateState.get(selectedExtension.name);
    return state === ExtensionUpdateState.UPDATE_AVAILABLE;
  }, [selectedExtension, extensionsUpdateState]);

  // Helper to get current step
  const getCurrentStep = useCallback(
    () =>
      navigationStack[navigationStack.length - 1] ||
      MANAGEMENT_STEPS.EXTENSION_LIST,
    [navigationStack],
  );

  const handleSelectExtension = useCallback((extensionIndex: number) => {
    setSelectedExtensionIndex(extensionIndex);
    setSuccessMessage(null); // Clear success message when navigating
    setActionError(null); // Clear action error when navigating
    setNavigationStack((prev) => [...prev, MANAGEMENT_STEPS.ACTION_SELECTION]);
  }, []);

  const handleNavigateToStep = useCallback((step: string) => {
    setNavigationStack((prev) => [...prev, step]);
  }, []);

  const handleNavigateBack = useCallback(() => {
    setNavigationStack((prev) => {
      if (prev.length <= 1) {
        return prev;
      }
      return prev.slice(0, -1);
    });
  }, []);

  const handleUpdateExtension = useCallback(async () => {
    if (!config || !selectedExtension) return;

    setUpdateInProgress(true);
    setUpdateError(null);

    try {
      const extensionManager = config.getExtensionManager();
      if (!extensionManager) {
        throw new Error('ExtensionManager not available');
      }

      const state = extensionsUpdateState.get(selectedExtension.name);
      if (state !== ExtensionUpdateState.UPDATE_AVAILABLE) {
        throw new Error('No update available');
      }

      // Use the extension manager to update
      await extensionManager.updateExtension(
        selectedExtension,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        (name, newState) => {
          debugLogger.debug(`Update state for ${name}:`, newState);
        },
      );

      // Reload extensions after update to get new version info
      await loadExtensions();

      // Trigger a re-check of update status for all extensions
      await extensionManager.checkForAllExtensionUpdates((name, newState) => {
        debugLogger.debug(`Recheck update state for ${name}:`, newState);
      });

      // Show success message
      setSuccessMessage(
        t('Extension "{{name}}" updated successfully.', {
          name: selectedExtension.name,
        }),
      );

      // Go back to action selection
      handleNavigateBack();
    } catch (error) {
      debugLogger.error('Failed to update extension:', error);
      setUpdateError(
        error instanceof Error ? error.message : 'Unknown error occurred',
      );
    } finally {
      setUpdateInProgress(false);
    }
  }, [
    config,
    selectedExtension,
    extensionsUpdateState,
    loadExtensions,
    handleNavigateBack,
  ]);

  const handleActionSelect = useCallback(
    (action: ExtensionAction) => {
      switch (action) {
        case 'view':
          handleNavigateToStep(MANAGEMENT_STEPS.EXTENSION_DETAIL);
          break;
        case 'update':
          handleNavigateToStep(MANAGEMENT_STEPS.UPDATE_PROGRESS);
          handleUpdateExtension();
          break;
        case 'disable':
          handleNavigateToStep(MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT);
          break;
        case 'enable':
          handleNavigateToStep(MANAGEMENT_STEPS.ENABLE_SCOPE_SELECT);
          break;
        case 'uninstall':
          handleNavigateToStep(MANAGEMENT_STEPS.UNINSTALL_CONFIRMATION);
          break;
        default:
          break;
      }
    },
    [handleNavigateToStep, handleUpdateExtension],
  );

  const handleDisableExtension = useCallback(
    async (scope: 'user' | 'workspace') => {
      if (!config || !selectedExtension) return;

      setActionError(null);
      try {
        const extensionManager = config.getExtensionManager();
        if (!extensionManager) {
          throw new Error(t('ExtensionManager not available'));
        }

        const settingScope =
          scope === 'user' ? SettingScope.User : SettingScope.Workspace;

        await extensionManager.disableExtension(
          selectedExtension.name,
          settingScope,
        );

        // Update local state
        setExtensions((prev) =>
          prev.map((ext) =>
            ext.name === selectedExtension.name
              ? { ...ext, isActive: false }
              : ext,
          ),
        );

        // Show success message
        setSuccessMessage(
          t('Extension "{{name}}" disabled successfully.', {
            name: selectedExtension.name,
          }),
        );

        // Go back to extension list to show success message
        setNavigationStack([MANAGEMENT_STEPS.EXTENSION_LIST]);
      } catch (error) {
        debugLogger.error('Failed to disable extension:', error);
        setActionError(
          error instanceof Error
            ? error.message
            : t('Failed to disable extension'),
        );
      }
    },
    [config, selectedExtension],
  );

  const handleEnableExtension = useCallback(
    async (scope: 'user' | 'workspace') => {
      if (!config || !selectedExtension) return;

      setActionError(null);
      try {
        const extensionManager = config.getExtensionManager();
        if (!extensionManager) {
          throw new Error(t('ExtensionManager not available'));
        }

        const settingScope =
          scope === 'user' ? SettingScope.User : SettingScope.Workspace;

        await extensionManager.enableExtension(
          selectedExtension.name,
          settingScope,
        );

        // Update local state
        setExtensions((prev) =>
          prev.map((ext) =>
            ext.name === selectedExtension.name
              ? { ...ext, isActive: true }
              : ext,
          ),
        );

        // Show success message
        setSuccessMessage(
          t('Extension "{{name}}" enabled successfully.', {
            name: selectedExtension.name,
          }),
        );

        // Go back to extension list to show success message
        setNavigationStack([MANAGEMENT_STEPS.EXTENSION_LIST]);
      } catch (error) {
        debugLogger.error('Failed to enable extension:', error);
        setActionError(
          error instanceof Error
            ? error.message
            : t('Failed to enable extension'),
        );
      }
    },
    [config, selectedExtension],
  );

  const handleUninstallExtension = useCallback(
    async (extension: Extension) => {
      if (!config) return;

      setActionError(null);
      try {
        const extensionManager = config.getExtensionManager();
        if (!extensionManager) {
          throw new Error(t('ExtensionManager not available'));
        }

        await extensionManager.uninstallExtension(extension.name, false);

        // Reload extensions
        await loadExtensions();

        // Navigate back to extension list
        setNavigationStack([MANAGEMENT_STEPS.EXTENSION_LIST]);
        setSelectedExtensionIndex(-1);
      } catch (error) {
        debugLogger.error('Failed to uninstall extension:', error);
        setActionError(
          error instanceof Error
            ? error.message
            : t('Failed to uninstall extension'),
        );
        throw error;
      }
    },
    [config, loadExtensions],
  );

  // Centralized ESC key handling
  useKeypress(
    (key) => {
      if (key.name !== 'escape') {
        return;
      }

      const currentStep = getCurrentStep();
      // If there's a success message, clear it first instead of closing
      if (successMessage && currentStep === MANAGEMENT_STEPS.EXTENSION_LIST) {
        setSuccessMessage(null);
        return;
      }
      if (currentStep === MANAGEMENT_STEPS.EXTENSION_LIST) {
        onClose();
      } else {
        handleNavigateBack();
      }
    },
    { isActive: true },
  );

  const renderStepHeader = useCallback(() => {
    const currentStep = getCurrentStep();
    const getStepHeaderText = () => {
      switch (currentStep) {
        case MANAGEMENT_STEPS.EXTENSION_LIST:
          return t('Manage Extensions');
        case MANAGEMENT_STEPS.ACTION_SELECTION:
          return selectedExtension?.name || t('Choose Action');
        case MANAGEMENT_STEPS.EXTENSION_DETAIL:
          return t('Extension Details');
        case MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT:
          return t('Disable Extension');
        case MANAGEMENT_STEPS.ENABLE_SCOPE_SELECT:
          return t('Enable Extension');
        case MANAGEMENT_STEPS.UNINSTALL_CONFIRMATION:
          return t('Uninstall Extension');
        case MANAGEMENT_STEPS.UPDATE_PROGRESS:
          return t('Update Extension');
        default:
          return t('Unknown Step');
      }
    };

    return (
      <Box flexDirection="column">
        <Text bold>{getStepHeaderText()}</Text>
        {actionError && <Text color={theme.status.error}>{actionError}</Text>}
      </Box>
    );
  }, [getCurrentStep, selectedExtension, actionError]);

  const renderStepFooter = useCallback(() => {
    const currentStep = getCurrentStep();
    const getNavigationInstructions = () => {
      if (currentStep === MANAGEMENT_STEPS.EXTENSION_LIST) {
        if (extensions.length === 0) {
          return t('Esc to close');
        }
        return t('Enter to select, ↑↓ to navigate, Esc to close');
      }

      if (currentStep === MANAGEMENT_STEPS.EXTENSION_DETAIL) {
        return t('Esc to go back');
      }

      if (currentStep === MANAGEMENT_STEPS.UNINSTALL_CONFIRMATION) {
        return t('Y/Enter to confirm, N/Esc to cancel');
      }

      if (currentStep === MANAGEMENT_STEPS.UPDATE_PROGRESS) {
        return updateInProgress ? t('Updating...') : '';
      }

      return t('Enter to select, ↑↓ to navigate, Esc to go back');
    };

    return (
      <Box>
        <Text color={theme.text.secondary}>{getNavigationInstructions()}</Text>
      </Box>
    );
  }, [getCurrentStep, extensions.length, updateInProgress]);

  const renderStepContent = useCallback(() => {
    const currentStep = getCurrentStep();

    // Show loading state
    if (isLoading && currentStep === MANAGEMENT_STEPS.EXTENSION_LIST) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.text.secondary}>{t('Loading extensions...')}</Text>
        </Box>
      );
    }

    // Show load error
    if (loadError && currentStep === MANAGEMENT_STEPS.EXTENSION_LIST) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.status.error}>
            {t('Failed to load extensions:')}
          </Text>
          <Text>{loadError}</Text>
        </Box>
      );
    }

    // Show success message if present (only on extension list step)
    if (successMessage && currentStep === MANAGEMENT_STEPS.EXTENSION_LIST) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.status.success}>{successMessage}</Text>
        </Box>
      );
    }

    if (updateError && currentStep === MANAGEMENT_STEPS.UPDATE_PROGRESS) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color={theme.status.error}>{t('Update failed:')}</Text>
          <Text>{updateError}</Text>
        </Box>
      );
    }

    switch (currentStep) {
      case MANAGEMENT_STEPS.EXTENSION_LIST:
        return (
          <ExtensionListStep
            extensions={extensions}
            extensionsUpdateState={extensionsUpdateState}
            onExtensionSelect={handleSelectExtension}
          />
        );
      case MANAGEMENT_STEPS.ACTION_SELECTION:
        return (
          <ActionSelectionStep
            selectedExtension={selectedExtension}
            hasUpdateAvailable={hasUpdateAvailable}
            onNavigateToStep={handleNavigateToStep}
            onNavigateBack={handleNavigateBack}
            onActionSelect={handleActionSelect}
          />
        );
      case MANAGEMENT_STEPS.EXTENSION_DETAIL:
        return <ExtensionDetailStep selectedExtension={selectedExtension} />;
      case MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT:
        return (
          <ScopeSelectStep
            selectedExtension={selectedExtension}
            mode="disable"
            onScopeSelect={handleDisableExtension}
            onNavigateBack={handleNavigateBack}
          />
        );
      case MANAGEMENT_STEPS.ENABLE_SCOPE_SELECT:
        return (
          <ScopeSelectStep
            selectedExtension={selectedExtension}
            mode="enable"
            onScopeSelect={handleEnableExtension}
            onNavigateBack={handleNavigateBack}
          />
        );
      case MANAGEMENT_STEPS.UNINSTALL_CONFIRMATION:
        return (
          <UninstallConfirmStep
            selectedExtension={selectedExtension}
            onConfirm={handleUninstallExtension}
            onNavigateBack={handleNavigateBack}
          />
        );
      case MANAGEMENT_STEPS.UPDATE_PROGRESS:
        return (
          <Box flexDirection="column" gap={1}>
            <Text>
              {updateInProgress
                ? t('Updating {{name}}...', {
                    name: selectedExtension?.name || '',
                  })
                : t('Update complete!')}
            </Text>
          </Box>
        );
      default:
        return (
          <Box>
            <Text color={theme.status.error}>
              {t('Invalid step: {{step}}', { step: currentStep })}
            </Text>
          </Box>
        );
    }
  }, [
    getCurrentStep,
    extensions,
    extensionsUpdateState,
    selectedExtension,
    hasUpdateAvailable,
    updateInProgress,
    updateError,
    successMessage,
    isLoading,
    loadError,
    handleSelectExtension,
    handleNavigateToStep,
    handleNavigateBack,
    handleActionSelect,
    handleDisableExtension,
    handleEnableExtension,
    handleUninstallExtension,
  ]);

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="single"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
        width="100%"
        gap={1}
      >
        {renderStepHeader()}
        {renderStepContent()}
        {renderStepFooter()}
      </Box>
    </Box>
  );
}
