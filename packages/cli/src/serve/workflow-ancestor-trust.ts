/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkflowAncestorTrustHandler } from '@qwen-code/acp-bridge/workflowAncestorTrust';
import { getTrustedWorkflowAncestors } from '@qwen-code/qwen-code-core/agents/runtime/workflow-ancestors.js';
import {
  evaluateDaemonWorkflowAncestorTrust,
  type DaemonTrustPolicySnapshot,
} from '../config/daemon-trust-policy.js';
import type { WorkspaceGenerationGuard } from './workspace-registry.js';

export interface WorkflowTrustPolicyPublication {
  readonly publication: number;
  readonly snapshot?: DaemonTrustPolicySnapshot;
}

export interface WorkflowTrustAdmission {
  readonly publication: number;
  readonly snapshot: DaemonTrustPolicySnapshot;
}

export async function readWorkflowTrustAdmission(
  readSnapshot: () => Promise<DaemonTrustPolicySnapshot>,
  getPublished: () => WorkflowTrustPolicyPublication,
): Promise<WorkflowTrustAdmission> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const publication = getPublished().publication;
    const snapshot = await readSnapshot();
    if (getPublished().publication === publication) {
      return { publication, snapshot };
    }
  }
  throw new Error('Workflow trust policy changed during workspace admission.');
}

export function createWorkflowAncestorTrustHandler(options: {
  readonly generationGuard: Pick<WorkspaceGenerationGuard, 'closed'>;
  readonly admissionPolicy: WorkflowTrustAdmission;
  readonly getPublished: () => WorkflowTrustPolicyPublication;
  readonly isCurrentOwner: (sessionId: string) => boolean;
  readonly ideScopeCwd: string;
}): WorkflowAncestorTrustHandler {
  return async (context) => {
    const denied = () => ({
      trusted: context.ancestorDirs.map(() => false),
      isCurrent: () => false,
    });
    const isCurrentOwner = () =>
      !options.generationGuard.closed &&
      options.isCurrentOwner(context.sessionId);
    try {
      if (!isCurrentOwner()) return denied();
      const published = options.getPublished();
      const isCurrent = () => {
        try {
          return (
            isCurrentOwner() &&
            options.getPublished().publication === published.publication
          );
        } catch {
          return false;
        }
      };
      const snapshot =
        published.publication > options.admissionPolicy.publication
          ? published.snapshot
          : options.admissionPolicy.snapshot;
      if (!snapshot) return denied();
      const ancestors = await getTrustedWorkflowAncestors(
        context.canonicalTargetDir,
        async (directories) => directories.map(() => true),
      );
      if (
        !isCurrent() ||
        ancestors.length !== context.ancestorDirs.length ||
        ancestors.some((directory, i) => directory !== context.ancestorDirs[i])
      ) {
        return denied();
      }
      const trusted = evaluateDaemonWorkflowAncestorTrust(snapshot, {
        ...context,
        ideScopeCwd: options.ideScopeCwd,
      });
      return trusted.some(Boolean) ? { trusted, isCurrent } : denied();
    } catch {
      return denied();
    }
  };
}
