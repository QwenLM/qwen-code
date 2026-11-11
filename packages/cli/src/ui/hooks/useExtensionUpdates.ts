/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extension update hooks have been removed as part of the Plugin migration.
 * The shared confirmation queue remains active because local TUI features use
 * it independently of extension updates.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ConfirmationRequest } from '../types.js';
import type {
  ExtensionUpdateStatus,
  ExtensionUpdateState,
} from '../state/extensions.js';

// ---------- useConfirmUpdateRequests ----------

export const useConfirmUpdateRequests = () => {
  const [confirmUpdateExtensionRequests, setConfirmUpdateExtensionRequests] =
    useState<ConfirmationRequest[]>([]);
  const addConfirmUpdateExtensionRequest = useCallback(
    (request: ConfirmationRequest | null) => {
      setConfirmUpdateExtensionRequests((current) =>
        request === null ? current.slice(1) : [...current, request],
      );
    },
    [],
  );
  const dispatchConfirmUpdateExtensionRequests = useCallback(
    (_action: unknown) => {
      // no-op
    },
    [],
  );
  return {
    addConfirmUpdateExtensionRequest,
    confirmUpdateExtensionRequests,
    dispatchConfirmUpdateExtensionRequests,
  };
};

// ---------- useExtensionUpdates ----------

export const useExtensionUpdates = (
  _addItem: unknown,
  _enableExtensionReloading: boolean,
) => {
  const extensionsUpdateState = useMemo(
    () => new Map<string, ExtensionUpdateState>(),
    [],
  );
  const extensionsUpdateStateInternal = useMemo(
    () => new Map<string, ExtensionUpdateStatus>(),
    [],
  );
  const dispatchExtensionStateUpdate = useCallback((_action: unknown) => {
    // no-op
  }, []);

  return {
    extensionsUpdateState,
    extensionsUpdateStateInternal,
    dispatchExtensionStateUpdate,
  };
};
