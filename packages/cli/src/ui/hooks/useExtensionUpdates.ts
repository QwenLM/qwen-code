/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionManager } from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../utils/errors.js';
import {
  ExtensionUpdateState,
  extensionUpdatesReducer,
  initialExtensionUpdatesState,
} from '../state/extensions.js';
import { useCallback, useEffect, useMemo, useReducer } from 'react';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import {
  MessageType,
  type ConfirmationRequest,
  type SettingInputRequest,
  type PluginChoiceRequest,
} from '../types.js';
import { checkExhaustive } from '../../utils/checks.js';

type ConfirmationRequestWrapper = {
  prompt: React.ReactNode;
  onConfirm: (confirmed: boolean) => void;
};

type ConfirmationRequestAction =
  | { type: 'add'; request: ConfirmationRequestWrapper }
  | { type: 'remove'; request: ConfirmationRequestWrapper };

function confirmationRequestsReducer(
  state: ConfirmationRequestWrapper[],
  action: ConfirmationRequestAction,
): ConfirmationRequestWrapper[] {
  switch (action.type) {
    case 'add':
      return [...state, action.request];
    case 'remove':
      return state.filter((r) => r !== action.request);
    default:
      checkExhaustive(action);
      return state;
  }
}

export const useConfirmUpdateRequests = () => {
  const [
    confirmUpdateExtensionRequests,
    dispatchConfirmUpdateExtensionRequests,
  ] = useReducer(confirmationRequestsReducer, []);
  const addConfirmUpdateExtensionRequest = useCallback(
    (original: ConfirmationRequest) => {
      const wrappedRequest = {
        prompt: original.prompt,
        onConfirm: (confirmed: boolean) => {
          // Remove it from the outstanding list of requests by identity.
          dispatchConfirmUpdateExtensionRequests({
            type: 'remove',
            request: wrappedRequest,
          });
          original.onConfirm(confirmed);
        },
      };
      dispatchConfirmUpdateExtensionRequests({
        type: 'add',
        request: wrappedRequest,
      });
    },
    [dispatchConfirmUpdateExtensionRequests],
  );
  return {
    addConfirmUpdateExtensionRequest,
    confirmUpdateExtensionRequests,
    dispatchConfirmUpdateExtensionRequests,
  };
};

type SettingInputRequestWrapper = {
  settingName: string;
  settingDescription: string;
  sensitive: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

type SettingInputRequestAction =
  | { type: 'add'; request: SettingInputRequestWrapper }
  | { type: 'remove'; request: SettingInputRequestWrapper };

function settingInputRequestsReducer(
  state: SettingInputRequestWrapper[],
  action: SettingInputRequestAction,
): SettingInputRequestWrapper[] {
  switch (action.type) {
    case 'add':
      return [...state, action.request];
    case 'remove':
      return state.filter((r) => r !== action.request);
    default:
      checkExhaustive(action);
      return state;
  }
}

export const useSettingInputRequests = () => {
  const [settingInputRequests, dispatchSettingInputRequests] = useReducer(
    settingInputRequestsReducer,
    [],
  );
  const addSettingInputRequest = useCallback(
    (original: SettingInputRequest) => {
      const wrappedRequest: SettingInputRequestWrapper = {
        settingName: original.settingName,
        settingDescription: original.settingDescription,
        sensitive: original.sensitive,
        onSubmit: (value: string) => {
          // Remove it from the outstanding list of requests by identity.
          dispatchSettingInputRequests({
            type: 'remove',
            request: wrappedRequest,
          });
          original.onSubmit(value);
        },
        onCancel: () => {
          dispatchSettingInputRequests({
            type: 'remove',
            request: wrappedRequest,
          });
          original.onCancel();
        },
      };
      dispatchSettingInputRequests({
        type: 'add',
        request: wrappedRequest,
      });
    },
    [dispatchSettingInputRequests],
  );
  return {
    addSettingInputRequest,
    settingInputRequests,
    dispatchSettingInputRequests,
  };
};

type PluginChoiceRequestWrapper = {
  marketplaceName: string;
  plugins: Array<{ name: string; description?: string }>;
  onSelect: (pluginName: string) => void;
  onCancel: () => void;
};

type PluginChoiceRequestAction =
  | { type: 'add'; request: PluginChoiceRequestWrapper }
  | { type: 'remove'; request: PluginChoiceRequestWrapper };

function pluginChoiceRequestsReducer(
  state: PluginChoiceRequestWrapper[],
  action: PluginChoiceRequestAction,
): PluginChoiceRequestWrapper[] {
  switch (action.type) {
    case 'add':
      return [...state, action.request];
    case 'remove':
      return state.filter((r) => r !== action.request);
    default:
      checkExhaustive(action);
      return state;
  }
}

export const usePluginChoiceRequests = () => {
  const [pluginChoiceRequests, dispatchPluginChoiceRequests] = useReducer(
    pluginChoiceRequestsReducer,
    [],
  );
  const addPluginChoiceRequest = useCallback(
    (original: PluginChoiceRequest) => {
      const wrappedRequest: PluginChoiceRequestWrapper = {
        marketplaceName: original.marketplaceName,
        plugins: original.plugins,
        onSelect: (pluginName: string) => {
          dispatchPluginChoiceRequests({
            type: 'remove',
            request: wrappedRequest,
          });
          original.onSelect(pluginName);
        },
        onCancel: () => {
          dispatchPluginChoiceRequests({
            type: 'remove',
            request: wrappedRequest,
          });
          original.onCancel();
        },
      };
      dispatchPluginChoiceRequests({
        type: 'add',
        request: wrappedRequest,
      });
    },
    [dispatchPluginChoiceRequests],
  );
  return {
    addPluginChoiceRequest,
    pluginChoiceRequests,
    dispatchPluginChoiceRequests,
  };
};

export const useExtensionUpdates = (
  extensionManager: ExtensionManager,
  addItem: UseHistoryManagerReturn['addItem'],
  cwd: string,
) => {
  const [extensionsUpdateState, dispatchExtensionStateUpdate] = useReducer(
    extensionUpdatesReducer,
    initialExtensionUpdatesState,
  );
  const extensions = extensionManager.getLoadedExtensions();

  useEffect(() => {
    (async () => {
      const extensionsToCheck = extensions.filter((extension) => {
        const currentStatus = extensionsUpdateState.extensionStatuses.get(
          extension.name,
        );
        if (!currentStatus) return true;
        const currentState = currentStatus.status;
        return !currentState || currentState === ExtensionUpdateState.UNKNOWN;
      });
      if (extensionsToCheck.length === 0) return;
      dispatchExtensionStateUpdate({ type: 'BATCH_CHECK_START' });
      await extensionManager.checkForAllExtensionUpdates(
        (extensionName: string, state: ExtensionUpdateState) => {
          dispatchExtensionStateUpdate({
            type: 'SET_STATE',
            payload: { name: extensionName, state },
          });
        },
      );
      dispatchExtensionStateUpdate({ type: 'BATCH_CHECK_END' });
    })();
  }, [
    extensions,
    extensionManager,
    extensionsUpdateState.extensionStatuses,
    dispatchExtensionStateUpdate,
  ]);

  useEffect(() => {
    if (extensionsUpdateState.batchChecksInProgress > 0) {
      return;
    }

    let extensionsWithUpdatesCount = 0;
    for (const extension of extensions) {
      const currentState = extensionsUpdateState.extensionStatuses.get(
        extension.name,
      );
      if (
        !currentState ||
        currentState.processed ||
        currentState.status !== ExtensionUpdateState.UPDATE_AVAILABLE
      ) {
        continue;
      }

      // Mark as processed immediately to avoid re-triggering.
      dispatchExtensionStateUpdate({
        type: 'SET_PROCESSED',
        payload: { name: extension.name, processed: true },
      });

      if (extension.installMetadata?.autoUpdate) {
        extensionManager
          .updateExtension(
            extension,
            currentState.status,
            (extensionName, state) => {
              dispatchExtensionStateUpdate({
                type: 'SET_STATE',
                payload: { name: extensionName, state },
              });
            },
          )
          .then((result) => {
            if (!result) return;
            addItem(
              {
                type: MessageType.INFO,
                text: `Extension "${extension.name}" successfully updated: ${result.originalVersion} → ${result.updatedVersion}.`,
              },
              Date.now(),
            );
          })
          .catch((error) => {
            addItem(
              {
                type: MessageType.ERROR,
                text: getErrorMessage(error),
              },
              Date.now(),
            );
          });
      } else {
        extensionsWithUpdatesCount++;
      }
    }
    if (extensionsWithUpdatesCount > 0) {
      const s = extensionsWithUpdatesCount > 1 ? 's' : '';
      addItem(
        {
          type: MessageType.INFO,
          text: `You have ${extensionsWithUpdatesCount} extension${s} with an update available, run "/extensions list" for more information.`,
        },
        Date.now(),
      );
    }
  }, [extensions, extensionManager, extensionsUpdateState, addItem, cwd]);

  const extensionsUpdateStateComputed = useMemo(() => {
    const result = new Map<string, ExtensionUpdateState>();
    for (const [
      key,
      value,
    ] of extensionsUpdateState.extensionStatuses.entries()) {
      result.set(key, value.status);
    }
    return result;
  }, [extensionsUpdateState]);

  return {
    extensionsUpdateState: extensionsUpdateStateComputed,
    extensionsUpdateStateInternal: extensionsUpdateState.extensionStatuses,
    dispatchExtensionStateUpdate,
  };
};
