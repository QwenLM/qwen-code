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
): void {
  const hasMountedRef = useRef(false);

  useEffect(() => {
    if (version === undefined || !active) return;
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    void reload();
  }, [active, reload, version]);
}
