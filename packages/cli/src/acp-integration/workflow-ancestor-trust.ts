/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Workflow ancestor trust for an ACP child a daemon spawned.
 * Such a child does not judge folder trust itself: the daemon owns the
 * published trust policy, so the child asks its authenticated parent which of
 * a session's ancestor directories are trusted. Until the parent proves its
 * private capability, and after the connection closes, every ancestor is
 * denied; the session keeps its own project and user workflows.
 */

import type { ConfigParameters } from '@qwen-code/qwen-code-core';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';

export type WorkflowAncestorTrustProvider = NonNullable<
  ConfigParameters['workflowAncestorTrustProvider']
>;

/** How long one lookup waits for the parent before denying every ancestor. */
export const WORKFLOW_ANCESTOR_TRUST_TIMEOUT_MS = 2_000;

const denyAll: WorkflowAncestorTrustProvider = async (dirs) =>
  dirs.map(() => false);

/**
 * The provider a private child's Configs share. Denies until {@link set} binds
 * the parent query, and again after it is cleared.
 */
export class WorkflowAncestorTrustHolder {
  private current: WorkflowAncestorTrustProvider | undefined;

  readonly provider: WorkflowAncestorTrustProvider = (dirs) =>
    (this.current ?? denyAll)(dirs);

  set(provider: WorkflowAncestorTrustProvider | undefined): void {
    this.current = provider;
  }
}

/**
 * Ask the parent over `extMethod`. Any failure — an older parent without the
 * method, a closed connection, a timeout, a reply of the wrong shape — denies
 * every ancestor in the batch.
 */
export function createParentWorkflowAncestorTrustProvider(connection: {
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}): WorkflowAncestorTrustProvider {
  return async (dirs) => {
    const denied = dirs.map(() => false);
    if (dirs.length === 0) return denied;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        connection.extMethod(SERVE_CONTROL_EXT_METHODS.workflowAncestorTrust, {
          ancestorDirs: [...dirs],
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('workflow ancestor trust timed out')),
            WORKFLOW_ANCESTOR_TRUST_TIMEOUT_MS,
          );
        }),
      ]);
      const trusted = response['trusted'];
      if (
        Object.keys(response).length !== 1 ||
        !Array.isArray(trusted) ||
        trusted.length !== dirs.length ||
        !trusted.every((value) => typeof value === 'boolean')
      ) {
        return denied;
      }
      return trusted as boolean[];
    } catch {
      return denied;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
