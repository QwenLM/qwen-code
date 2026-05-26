/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createAuthService, type AuthServiceDeps } from '../authService.js';
import type { WorkspaceRequestContext } from '../types.js';
import type {
  DeviceFlowRegistry,
  DeviceFlowPublicView,
} from '../../auth/deviceFlow.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeView(overrides?: Partial<DeviceFlowPublicView>): DeviceFlowPublicView {
  return {
    deviceFlowId: 'df-1',
    providerId: 'qwen-oauth',
    status: 'pending',
    userCode: 'ABCD-1234',
    verificationUri: 'https://example.com/device',
    createdAt: 1000,
    ...overrides,
  };
}

function makeMockRegistry(): DeviceFlowRegistry {
  return {
    start: vi.fn().mockResolvedValue({ view: makeView(), attached: false }),
    get: vi.fn().mockReturnValue(makeView()),
    cancel: vi.fn().mockReturnValue({ alreadyTerminal: false }),
    listPending: vi.fn().mockReturnValue([makeView()]),
    dispose: vi.fn(),
  } as unknown as DeviceFlowRegistry;
}

function makeDeps(registry?: DeviceFlowRegistry): AuthServiceDeps {
  return { registry: registry ?? makeMockRegistry() };
}

function makeCtx(overrides?: Partial<WorkspaceRequestContext>): WorkspaceRequestContext {
  return {
    originatorClientId: 'client-1',
    sessionId: 'session-1',
    route: 'POST /workspace/auth/device-flow',
    workspaceCwd: '/workspace',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthService', () => {
  describe('startDeviceFlow', () => {
    it('delegates to registry.start with providerId and initiatorClientId', async () => {
      const registry = makeMockRegistry();
      const svc = createAuthService(makeDeps(registry));
      const ctx = makeCtx();

      const result = await svc.startDeviceFlow(ctx, { providerId: 'qwen-oauth' });

      expect(registry.start).toHaveBeenCalledWith({
        providerId: 'qwen-oauth',
        initiatorClientId: 'client-1',
      });
      expect(result.view.deviceFlowId).toBe('df-1');
      expect(result.attached).toBe(false);
    });

    it('omits initiatorClientId when ctx has no originatorClientId', async () => {
      const registry = makeMockRegistry();
      const svc = createAuthService(makeDeps(registry));
      const ctx = makeCtx({ originatorClientId: undefined });

      await svc.startDeviceFlow(ctx, { providerId: 'qwen-oauth' });

      expect(registry.start).toHaveBeenCalledWith({
        providerId: 'qwen-oauth',
      });
    });

    it('returns attached: true when registry reports take-over', async () => {
      const registry = makeMockRegistry();
      (registry.start as ReturnType<typeof vi.fn>).mockResolvedValue({
        view: makeView(),
        attached: true,
      });
      const svc = createAuthService(makeDeps(registry));

      const result = await svc.startDeviceFlow(makeCtx(), { providerId: 'qwen-oauth' });

      expect(result.attached).toBe(true);
    });
  });

  describe('getDeviceFlow', () => {
    it('delegates to registry.get and returns the view', () => {
      const registry = makeMockRegistry();
      const svc = createAuthService(makeDeps(registry));

      const result = svc.getDeviceFlow(makeCtx(), 'df-1');

      expect(registry.get).toHaveBeenCalledWith('df-1');
      expect(result?.deviceFlowId).toBe('df-1');
    });

    it('returns undefined for unknown id', () => {
      const registry = makeMockRegistry();
      (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const svc = createAuthService(makeDeps(registry));

      const result = svc.getDeviceFlow(makeCtx(), 'unknown');

      expect(result).toBeUndefined();
    });
  });

  describe('cancelDeviceFlow', () => {
    it('delegates to registry.cancel with deviceFlowId and originatorClientId', () => {
      const registry = makeMockRegistry();
      const svc = createAuthService(makeDeps(registry));
      const ctx = makeCtx();

      const result = svc.cancelDeviceFlow(ctx, 'df-1');

      expect(registry.cancel).toHaveBeenCalledWith('df-1', 'client-1');
      expect(result).toEqual({ alreadyTerminal: false });
    });

    it('returns undefined for unknown id', () => {
      const registry = makeMockRegistry();
      (registry.cancel as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const svc = createAuthService(makeDeps(registry));

      const result = svc.cancelDeviceFlow(makeCtx(), 'unknown');

      expect(result).toBeUndefined();
    });

    it('returns alreadyTerminal: true for terminal flows', () => {
      const registry = makeMockRegistry();
      (registry.cancel as ReturnType<typeof vi.fn>).mockReturnValue({ alreadyTerminal: true });
      const svc = createAuthService(makeDeps(registry));

      const result = svc.cancelDeviceFlow(makeCtx(), 'df-1');

      expect(result).toEqual({ alreadyTerminal: true });
    });
  });

  describe('listPendingDeviceFlows', () => {
    it('delegates to registry.listPending', () => {
      const registry = makeMockRegistry();
      const svc = createAuthService(makeDeps(registry));

      const result = svc.listPendingDeviceFlows(makeCtx());

      expect(registry.listPending).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]!.deviceFlowId).toBe('df-1');
    });

    it('returns empty array when no pending flows', () => {
      const registry = makeMockRegistry();
      (registry.listPending as ReturnType<typeof vi.fn>).mockReturnValue([]);
      const svc = createAuthService(makeDeps(registry));

      const result = svc.listPendingDeviceFlows(makeCtx());

      expect(result).toEqual([]);
    });
  });

  describe('getAuthStatus', () => {
    it('returns pending flows from registry', async () => {
      const registry = makeMockRegistry();
      const svc = createAuthService(makeDeps(registry));

      const result = await svc.getAuthStatus(makeCtx());

      expect(result.pendingFlows).toHaveLength(1);
      expect(result.pendingFlows[0]!.deviceFlowId).toBe('df-1');
    });

    it('returns authenticated: false (baseline — no token check yet)', async () => {
      const registry = makeMockRegistry();
      const svc = createAuthService(makeDeps(registry));

      const result = await svc.getAuthStatus(makeCtx());

      expect(result.authenticated).toBe(false);
    });
  });
});
