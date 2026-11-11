/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reading and writing the live rule set from a React tree.
 *
 * The permissions dialog used to be handed a frozen `ToolPermissionContext` plus a
 * setter, and kept its own `useState` copy so that adding or deleting a rule
 * showed up immediately. That copy existed because the prop was a snapshot taken
 * when the dialog's JSX was built.
 *
 * The module is stateful, so there is nothing to copy — but React still has to be
 * told that something changed, and the module has no rule-change notification (it
 * only reports re-checks of *pending* calls). Hence a version counter: the writer
 * bumps it, and every read is derived from it. One owner per dialog, passed down;
 * two owners would each miss the other's writes.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  applyUpdatesToModule,
  type SessionPermissionManager,
  type PermissionRules,
  type PermissionUpdate,
} from '@qwen-code/core';

export interface PermissionRulesHandle {
  /** The rule set as it stands now. */
  rules: PermissionRules;
  /** The directories trusted beyond the workspace root. */
  directories: string[];
  /**
   * Apply updates and re-render. A `setMode` update is ignored here — the dialog
   * has no business changing the mode, and doing it without Config's Auto
   * handling would leave the rule set inconsistent.
   */
  apply: (...updates: PermissionUpdate[]) => void;
}

export function usePermissionRules(
  permission: SessionPermissionManager,
): PermissionRulesHandle {
  const [version, setVersion] = useState(0);

  const rules = useMemo(
    () => permission.getRules(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the point
    [permission, version],
  );
  const directories = useMemo(
    () => permission.getAdditionalDirectories(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the point
    [permission, version],
  );

  const apply = useCallback(
    (...updates: PermissionUpdate[]) => {
      applyUpdatesToModule(permission, updates);
      setVersion((v) => v + 1);
    },
    [permission],
  );

  return { rules, directories, apply };
}
