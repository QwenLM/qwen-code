/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The rule set and trusted directories the attachment channel matches paths
 * against.
 *
 * An `@` reference reads a file without being a tool call — there is no
 * toolUseId and nothing to prompt about — so the generators consult the rules
 * directly instead of `checkPermission`. The context they consult comes from
 * here: an explicit snapshot wins when the caller pins one, otherwise it is
 * derived live from the permission module, because rules change inside a
 * session (session grants, remembered approvals) and a stale snapshot would
 * miss the change.
 */

import type { PathPermissionContext } from '../tools/tool-checkers/checker-reasons.js';
import type { SessionPermissionManager as PermissionManager } from '../permissions/manager/session-permission-manager.js';

/** What an attachment context offers the guard. */
export interface PathPermissionSource {
  permissionPaths?: PathPermissionContext;
  permission?: PermissionManager;
}

export function pathPermissionContextOf(
  ctx: PathPermissionSource,
): PathPermissionContext | undefined {
  const permission = ctx.permission;
  const local =
    ctx.permissionPaths ??
    (permission
      ? {
          rules: permission.getRules(),
          additionalDirectories: permission.getAdditionalDirectories(),
        }
      : undefined);
  if (!local) return undefined;
  const managedRules = permission?.getManagedRules();
  return managedRules
    ? {
        ...local,
        globalRules: managedRules,
      }
    : local;
}
