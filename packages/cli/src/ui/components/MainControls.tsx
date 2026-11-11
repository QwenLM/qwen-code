/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { memo, useLayoutEffect, useRef } from 'react';
import { Box, useApp } from 'ink';
import { DialogManager } from './DialogManager.js';
import { Composer } from './Composer.js';
import { ExitWarning } from './ExitWarning.js';
import { useRegisterKeyboardContext } from '../contexts/KeyboardContextRegistry.js';
import { PermissionQueue } from '../permissions/PermissionQueue.js';
import { usePermissionQueueItems } from '../permissions/usePermissionQueue.js';
import { PendingToolConfirmationQueue } from './PendingToolConfirmationQueue.js';
import { usePendingHistory } from '../contexts/PendingHistoryContext.js';
import { useSessionGate } from '../contexts/SessionGateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import type { UIState } from '../contexts/UIStateContext.js';

/**
 * Activates the Dialog keyboard context for dialogs that bypass DialogManager
 * (e.g. /about and full-screen command panels).
 */
export function DialogContextBridge({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  useRegisterKeyboardContext('Dialog', true);
  return <>{children}</>;
}

/**
 * Dialogs live outside MainContent, so they do not pass through MessageSlot's
 * inter-message spacing. Keep the feed-to-dialog boundary consistent here
 * instead of requiring every dialog implementation to add its own margin.
 */
function DialogSurface({
  children,
  addTopSpacing = true,
}: {
  children: React.ReactNode;
  addTopSpacing?: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={addTopSpacing ? 1 : 0}>
      {children}
    </Box>
  );
}

/**
 * Mounts the product session gate above every other control. It stays mounted
 * whether or not it shows anything, so its state survives hiding.
 */
function SessionGateMount({
  visible,
}: {
  visible: boolean;
}): React.JSX.Element | null {
  const Gate = useSessionGate();
  const { onSessionGateStateChange } = useUIActions();
  useRegisterKeyboardContext('Dialog', visible);
  if (!Gate) return null;
  return (
    <Box flexDirection="column" marginTop={visible ? 1 : 0}>
      <Gate onStateChange={onSessionGateStateChange} />
    </Box>
  );
}

function PendingToolConfirmationQueueFromContext(): React.JSX.Element {
  const { pendingHistoryItems } = usePendingHistory();
  return (
    <PendingToolConfirmationQueue pendingHistoryItems={pendingHistoryItems} />
  );
}

export function useMainControlsMode(uiState: UIState) {
  const { requestViewportReset } = useApp();

  // Permission pipeline queue — rendered in the controls area so it
  // participates in the same mutual-exclusion ternary as customDialog,
  // DialogManager, and Composer.  Priority order:
  //   fullScreenDialog > customDialog > PermissionQueue >
  //   DialogManager > Composer
  const permissionQueueItems = usePermissionQueueItems();
  const showPermissionQueue = permissionQueueItems.length > 0;
  // Deliberately reads the published boolean rather than subscribing to the
  // pending items: MainControls wraps an un-memoized Composer, and a
  // per-delta subscription here would re-render it on every streaming chunk.
  const showPendingToolConfirmationFallback =
    !showPermissionQueue && uiState.hasPendingToolConfirmation;
  const controlsMode = uiState.sessionGateVisible
    ? 'session-gate'
    : uiState.customDialog
      ? 'custom-dialog'
      : showPermissionQueue
        ? 'permission-queue'
        : showPendingToolConfirmationFallback
          ? 'pending-confirmation'
          : uiState.dialogsVisible
            ? 'dialog-manager'
            : 'composer';
  const previousControlsModeRef = useRef<typeof controlsMode | null>(null);

  useLayoutEffect(() => {
    const previous = previousControlsModeRef.current;
    previousControlsModeRef.current = controlsMode;

    if (
      previous !== null &&
      previous !== 'composer' &&
      controlsMode === 'composer'
    ) {
      requestViewportReset?.();
    }
  }, [controlsMode, requestViewportReset]);

  return controlsMode;
}

/** Shared dialog and permission surfaces, rendered instead of a composer. */
export const MainControlsDialogs = ({
  uiState,
}: {
  uiState: UIState;
}): React.JSX.Element => {
  const permissionQueueItems = usePermissionQueueItems();
  const showPermissionQueue = permissionQueueItems.length > 0;
  const showPendingToolConfirmationFallback =
    !showPermissionQueue && uiState.hasPendingToolConfirmation;
  return (
    <>
      {uiState.sessionGateVisible ? null : uiState.customDialog ? (
        <DialogSurface>
          <DialogContextBridge>{uiState.customDialog}</DialogContextBridge>
        </DialogSurface>
      ) : showPermissionQueue ? (
        <PermissionQueue items={permissionQueueItems} />
      ) : showPendingToolConfirmationFallback ? (
        <PendingToolConfirmationQueueFromContext />
      ) : uiState.dialogsVisible ? (
        // FolderTrustDialog keeps its own top margin because that row is part
        // of its overflow-height calculation. All other managed dialogs use
        // the shared feed-to-dialog spacing.
        <DialogSurface addTopSpacing={!uiState.isFolderTrustDialogOpen}>
          <DialogManager terminalWidth={uiState.terminalWidth} />
        </DialogSurface>
      ) : null}
    </>
  );
};

export const MainControlsBody = ({
  uiState,
}: {
  uiState: UIState;
}): React.JSX.Element => {
  const controlsMode = useMainControlsMode(uiState);
  return (
    <>
      <SessionGateMount visible={uiState.sessionGateVisible} />
      {controlsMode === 'composer' ? (
        <Composer isFocused={true} />
      ) : (
        <MainControlsDialogs uiState={uiState} />
      )}
      <ExitWarning />
    </>
  );
};

const MainControlsComponent = ({ uiState }: { uiState: UIState }) => (
  <Box
    flexDirection="column"
    ref={uiState.mainControlsRef}
    flexShrink={0}
    flexGrow={0}
    width={uiState.terminalWidth}
  >
    <MainControlsBody uiState={uiState} />
  </Box>
);
MainControlsComponent.displayName = 'MainControls';

export const MainControls = memo(MainControlsComponent);
