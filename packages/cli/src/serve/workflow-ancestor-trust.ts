/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkflowAncestorTrustHandler } from '@qwen-code/acp-bridge';
import {
  evaluateDaemonWorkflowAncestorTrust,
  type DaemonTrustPolicySnapshot,
} from '../config/daemon-trust-policy.js';
import type { WorkspaceGenerationGuard } from './workspace-registry.js';

/** The daemon's most recently published trust policy, with its sequence. */
export interface PublishedTrustPolicy {
  /** Increases by one with every snapshot the trust monitor publishes. */
  readonly publications: number;
  readonly snapshot: DaemonTrustPolicySnapshot;
}

/**
 * One runtime's saved-workflow ancestor trust, answered for its own ACP
 * child. Each request is judged against one snapshot: the runtime's admission
 * snapshot until the monitor publishes a newer one, then the latest published
 * — so revoking a parent folder's rule applies to the next lookup even while
 * the runtime itself stays trusted, and a runtime built from a fresh snapshot
 * is never judged by an older boot one. A request is refused once the
 * runtime's generation closes; there is no fallback to another runtime.
 */
export function createWorkflowAncestorTrustHandler(options: {
  generationGuard: WorkspaceGenerationGuard;
  admissionSnapshot: DaemonTrustPolicySnapshot;
  getPublished: () => PublishedTrustPolicy;
}): WorkflowAncestorTrustHandler {
  const publicationsAtAdmission = options.getPublished().publications;
  return async (ancestorDirs) => {
    options.generationGuard.assertOpen();
    const published = options.getPublished();
    const snapshot =
      published.publications > publicationsAtAdmission
        ? published.snapshot
        : options.admissionSnapshot;
    const trusted = ancestorDirs.map((dir) =>
      evaluateDaemonWorkflowAncestorTrust(snapshot, dir),
    );
    options.generationGuard.assertOpen();
    return trusted;
  };
}
