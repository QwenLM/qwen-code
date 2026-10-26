/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #13800: the answers a recovery-blocked turn's mount handback may
 * legitimately meet on `:release-mount`. The busy refusal is a turn whose
 * own operation still reads active, which the owed handback retries; the
 * rest are final — the Runtime Session was already evicted, a later
 * acquire superseded the claim, a lifecycle drain frees the mount itself,
 * or a capture never proved its writer stopped.
 *
 * A proxy forwards these with their real status: flattened to 200, a
 * refusal reads as an unconfirmed release, which the daemon re-sends.
 */
export function isLegitimateMountRelease(
  status: number,
  code: unknown,
): boolean {
  if (status === 200) return true;
  if (status === 503) return code === 'runtime_reconciliation_required';
  return (
    status === 409 &&
    (code === 'runtime_session_busy' ||
      code === 'runtime_session_conflict' ||
      code === 'runtime_admission_closed' ||
      code === 'workspace_writer_unproven')
  );
}
