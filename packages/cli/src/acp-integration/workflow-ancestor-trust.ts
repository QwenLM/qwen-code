/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkflowAncestorTrustProvider } from '@qwen-code/qwen-code-core/config/config.js';
import {
  WORKFLOW_ANCESTOR_TRUST_METHOD,
  isWorkflowAncestorTrustResponse,
  parseWorkflowAncestorTrustRequest,
} from '@qwen-code/acp-bridge/workflowAncestorTrust';

export const WORKFLOW_ANCESTOR_TRUST_TIMEOUT_MS = 2000;

export function createParentWorkflowAncestorTrustProvider(
  connection: {
    extMethod(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  },
  options: {
    readonly isParentTrusted: () => boolean;
    readonly getSessionId: () => string | undefined;
  },
): WorkflowAncestorTrustProvider {
  return async (ancestorDirs, canonicalTargetDir) => {
    const denied = () => ancestorDirs.map(() => false);
    const sessionId = options.getSessionId();
    if (!options.isParentTrusted() || !sessionId) return denied();
    const request = parseWorkflowAncestorTrustRequest({
      v: 1,
      sessionId,
      canonicalTargetDir,
      ancestorDirs: [...ancestorDirs],
    });
    if (!request) return denied();
    if (ancestorDirs.length === 0) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        connection.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, { ...request }),
        new Promise<Record<string, unknown>>((resolve) => {
          timer = setTimeout(
            () => resolve({}),
            WORKFLOW_ANCESTOR_TRUST_TIMEOUT_MS,
          );
        }),
      ]);
      if (
        !options.isParentTrusted() ||
        options.getSessionId() !== sessionId ||
        !isWorkflowAncestorTrustResponse(response, ancestorDirs.length)
      ) {
        return denied();
      }
      return response.trusted;
    } catch {
      return denied();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
