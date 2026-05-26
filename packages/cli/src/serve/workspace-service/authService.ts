/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AuthService — thin delegation layer wrapping DeviceFlowRegistry.
 *
 * Accepts `WorkspaceRequestContext` and maps to the appropriate
 * `DeviceFlowRegistry` calls, threading `ctx.originatorClientId`
 * as the clientId parameter where needed.
 */

import type { DeviceFlowRegistry } from '../auth/deviceFlow.js';

import type {
  AuthService,
  AuthStartDeviceFlowParams,
  AuthStartDeviceFlowResult,
  AuthCancelDeviceFlowResult,
  WorkspaceRequestContext,
} from './types.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface AuthServiceDeps {
  registry: DeviceFlowRegistry;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { registry } = deps;

  return {
    async startDeviceFlow(
      ctx: WorkspaceRequestContext,
      params: AuthStartDeviceFlowParams,
    ): Promise<AuthStartDeviceFlowResult> {
      const result = await registry.start({
        providerId: params.providerId,
        ...(ctx.originatorClientId !== undefined
          ? { initiatorClientId: ctx.originatorClientId }
          : {}),
      });
      return { view: result.view, attached: result.attached };
    },

    getDeviceFlow(_ctx: WorkspaceRequestContext, deviceFlowId: string) {
      return registry.get(deviceFlowId);
    },

    cancelDeviceFlow(
      ctx: WorkspaceRequestContext,
      deviceFlowId: string,
    ): AuthCancelDeviceFlowResult | undefined {
      return registry.cancel(deviceFlowId, ctx.originatorClientId);
    },

    listPendingDeviceFlows(_ctx: WorkspaceRequestContext) {
      return registry.listPending();
    },

    async getAuthStatus(_ctx: WorkspaceRequestContext) {
      const pendingFlows = registry.listPending();
      return { authenticated: false, pendingFlows };
    },
  };
}
