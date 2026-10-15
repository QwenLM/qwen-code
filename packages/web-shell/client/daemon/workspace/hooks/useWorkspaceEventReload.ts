/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';

export function useWorkspaceEventReload(
  version: number | undefined,
  reload: () => Promise<unknown>,
  active: boolean,
  autoLoad = false,
): void {
  const hasMountedRef = useRef(false);
  const previousRef = useRef({ active, reload, version, autoLoad });

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { active, reload, version, autoLoad };
    if (version === undefined || !active) return;
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    if (
      previous.active === active &&
      previous.reload === reload &&
      previous.version === version
    )
      return;
    // The resource's auto-load effect already reads on activation or a new
    // loader; an event in that same render must not start a second request.
    if (
      autoLoad &&
      (!previous.active || !previous.autoLoad || previous.reload !== reload)
    )
      return;
    void reload();
  }, [active, autoLoad, reload, version]);
}
