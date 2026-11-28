/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  createContext,
  useContext,
  useCallback,
} from 'react';
import {
  ToolConfirmationOutcome,
  type ToolConfirmationPayload,
  runLogger,
} from '@qwen-code/core';
import { settlePromptFromOutcome } from '../permissions/settleFromOutcome.js';
import type { QueuedPermissionPrompt } from '../permissions/permissionQueueStore.js';
import type { IndividualToolCallDisplay } from '../types.js';

interface ToolActionsContextValue {
  confirm: (
    callId: string,
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ) => Promise<void>;
  cancel: (callId: string) => Promise<void>;
  isExpanded: (callId: string) => boolean;
  toggleExpansion: (callId: string) => void;
  toggleAllExpansion: (callIds: string[]) => void;
}

const ToolActionsContext = createContext<ToolActionsContextValue | null>(null);

export const useToolActions = (): ToolActionsContextValue => {
  const context = useContext(ToolActionsContext);
  if (!context) {
    throw new Error('useToolActions must be used within a ToolActionsProvider');
  }
  return context;
};

interface ToolActionsProviderProps {
  children: React.ReactNode;
  toolCalls: IndividualToolCallDisplay[];
  isExpanded: (callId: string) => boolean;
  toggleExpansion: (callId: string) => void;
  toggleAllExpansion: (callIds: string[]) => void;
  /**
   * Optional lookup function that resolves a callId (or correlationId) to a
   * PermissionRequestItem. When provided, the confirm() flow uses direct
   * item.onAllow/onReject callbacks.
   */
  permissionQueueLookup?: (id: string) => QueuedPermissionPrompt | undefined;
}

export const ToolActionsProvider: React.FC<ToolActionsProviderProps> = (
  props: ToolActionsProviderProps,
) => {
  const {
    children,
    toolCalls,
    isExpanded,
    toggleExpansion,
    toggleAllExpansion,
    permissionQueueLookup,
  } = props;

  const confirm = useCallback(
    async (
      callId: string,
      outcome: ToolConfirmationOutcome,
      payload?: ToolConfirmationPayload,
    ) => {
      const tool = toolCalls.find((t) => t.callId === callId);
      if (!tool) {
        runLogger.warn(`ToolActions: Tool ${callId} not found`);
        return;
      }

      // Settle the prompt the module raised for this call.
      if (permissionQueueLookup) {
        const lookupId = tool.correlationId ?? callId;
        const prompt = permissionQueueLookup(lookupId);
        if (prompt) {
          settlePromptFromOutcome(prompt, outcome, payload);
          return;
        }
      }

      runLogger.warn(`ToolActions: No correlationId or callback for ${callId}`);
    },
    [toolCalls, permissionQueueLookup],
  );

  const cancel = useCallback(
    async (callId: string) => {
      await confirm(callId, ToolConfirmationOutcome.Cancel);
    },
    [confirm],
  );

  return (
    <ToolActionsContext.Provider
      value={{
        confirm,
        cancel,
        isExpanded,
        toggleExpansion,
        toggleAllExpansion,
      }}
    >
      {children}
    </ToolActionsContext.Provider>
  );
};
