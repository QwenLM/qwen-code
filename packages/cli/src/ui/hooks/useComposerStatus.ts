/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { useUIState } from '../contexts/UIStateContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import {
  permissionModeColor,
  isYoloMode,
  isDontAskMode,
  isAcceptEditsMode,
} from '@qwen-code/core';
import { usePermissionQueueItems } from '../permissions/usePermissionQueue.js';
import {
  isContextUsageHigh,
  isAtBlockingLimit,
} from '../utils/contextUsage.js';
import { resolveThemeColor } from '../semantic-colors.js';
import { shouldShowLoadingIndicator } from './streamingUtils.js';
import { useConfig, useModel } from '../contexts/ConfigContext.js';
import {
  getLocalizedPermissionModeShortTitle,
  useI18nService,
} from '../i18n/index.js';

/**
 * A hook that encapsulates complex status and action-required logic for the Composer.
 */
export const useComposerStatus = () => {
  const uiState = useUIState();
  const settings = useSettings();
  const config = useConfig();
  const i18n = useI18nService();
  const getUiText = i18n.get;

  // Guard against the async gap between queue clearance (synchronous) and
  // tool status transitions to Cancelled (async): without this, the Composer
  // stays hidden even with no active permission dialog.
  const permissionQueueItems = usePermissionQueueItems();

  // Reads the boolean uiState publishes rather than the pending array, so
  // Composer and StatusRow do not re-render on every streaming delta.
  const hasPendingToolConfirmation =
    permissionQueueItems.length > 0 && uiState.hasPendingToolConfirmation;

  const hasPendingActionRequired =
    hasPendingToolConfirmation ||
    Boolean(uiState.commandConfirmationRequest) ||
    Boolean(uiState.authConsentRequest) ||
    (uiState.confirmUpdateExtensionRequests?.length ?? 0) > 0 ||
    Boolean(uiState.customDialog);

  const showLoadingIndicator = shouldShowLoadingIndicator(
    uiState.streamingState,
    uiState.isModelTurnActive,
    uiState.isCommandProgressActive,
    hasPendingActionRequired,
  );

  const showPermissionModeIndicator = uiState.showPermissionModeIndicator;

  const modeContentObj = useMemo(() => {
    const hideMinimalModeHintWhileBusy =
      !uiState.cleanUiDetailsVisible &&
      (showLoadingIndicator || uiState.activeHooks.length > 0);

    if (hideMinimalModeHintWhileBusy) return null;

    if (
      isYoloMode(showPermissionModeIndicator) ||
      isDontAskMode(showPermissionModeIndicator) ||
      isAcceptEditsMode(showPermissionModeIndicator)
    ) {
      return {
        text: getLocalizedPermissionModeShortTitle(
          showPermissionModeIndicator,
          getUiText,
        ),
        color: resolveThemeColor(
          permissionModeColor(showPermissionModeIndicator),
        ),
      };
    }
    return null;
  }, [
    uiState.cleanUiDetailsVisible,
    showLoadingIndicator,
    uiState.activeHooks.length,
    showPermissionModeIndicator,
    getUiText,
  ]);

  const contextModel = uiState.currentModel || config.getModel();
  const listed = useModel(config, contextModel);
  const effectiveContextWindow = config.getEffectiveContextWindow(
    listed,
    contextModel,
  );
  const showMinimalContext = isContextUsageHigh(
    uiState.sessionStats.lastPromptTokenCount,
    listed,
    effectiveContextWindow,
  );

  const atBlockingLimit = isAtBlockingLimit(
    uiState.sessionStats.lastPromptTokenCount,
    listed,
    effectiveContextWindow,
  );

  const loadingPhrases = settings.merged.ui.loadingPhrases;
  const showTips = loadingPhrases === 'tips' || loadingPhrases === 'all';
  const showWit = loadingPhrases === 'witty' || loadingPhrases === 'all';

  /**
   * Use the setting if provided, otherwise default to true for the new UX.
   * This allows tests to override the collapse behavior.
   */
  const shouldCollapseDuringApproval =
    settings.merged.ui.collapseDrawerDuringApproval !== false;

  return {
    hasPendingActionRequired,
    shouldCollapseDuringApproval,
    showLoadingIndicator,
    showTips,
    showWit,
    modeContentObj,
    showMinimalContext,
    atBlockingLimit,
  };
};
