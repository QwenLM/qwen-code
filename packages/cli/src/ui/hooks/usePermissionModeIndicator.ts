/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook that tracks the current permission mode.
 * Subscribes to PermissionModeChanged events for reactive updates.
 */

import { useState, useEffect } from 'react';
import {
  type Config,
  type PermissionMode,
  coreEvents,
  CoreEvent,
  type PermissionModeChangedPayload,
} from '@qwen-code/core';

export interface UsePermissionModeIndicatorArgs {
  config: Config;
}

export function usePermissionModeIndicator({
  config,
}: UsePermissionModeIndicatorArgs): PermissionMode {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() =>
    config.getPermissionMode(),
  );

  useEffect(() => {
    setPermissionMode(config.getPermissionMode());

    const onModeChanged = ({ mode }: PermissionModeChangedPayload) => {
      setPermissionMode(mode);
    };

    coreEvents.on(CoreEvent.PermissionModeChanged, onModeChanged);
    return () => {
      coreEvents.off(CoreEvent.PermissionModeChanged, onModeChanged);
    };
  }, [config]);

  return permissionMode;
}
