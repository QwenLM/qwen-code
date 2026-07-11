/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeviceFlowRegistry } from './device-flow-registry.js';
import {
  brandSecret,
  type DeviceFlowProvider,
  type DeviceFlowProviderId,
} from '../auth/device-flow.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

vi.mock('../../utils/stdioHelpers.js', () => ({ writeStderrLine: vi.fn() }));

const PROVIDER_ID = 'qwen-oauth' as DeviceFlowProviderId;

// Minimal provider whose `start` resolves synchronously (no real IdP), so the
// registry emits its `started` event and the event sink fans it out.
function fakeProvider(): DeviceFlowProvider {
  return {
    providerId: PROVIDER_ID,
    async start() {
      return {
        deviceCode: brandSecret('device-code'),
        userCode: 'USER-CODE',
        verificationUri: 'https://idp.example/verify',
        expiresIn: 600,
      };
    },
    async poll(_state: unknown, _opts: { signal: AbortSignal }) {
      // Never resolves the flow — the fan-out under test happens on `start`.
      return { kind: 'pending' as const };
    },
  };
}

function fakeBridge(): AcpSessionBridge & {
  publishWorkspaceEvent: ReturnType<typeof vi.fn>;
} {
  return {
    publishWorkspaceEvent: vi.fn(),
  } as unknown as AcpSessionBridge & {
    publishWorkspaceEvent: ReturnType<typeof vi.fn>;
  };
}

describe('createDeviceFlowRegistry device-flow event fan-out', () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    // Clear the registry's poll timer so the fake `pending` poll doesn't leak.
    dispose?.();
    dispose = undefined;
  });

  it('fans a device-flow event out to every resolved bridge', async () => {
    const a = fakeBridge();
    const b = fakeBridge();
    const { deviceFlowRegistry } = createDeviceFlowRegistry({
      bridge: a,
      providers: [fakeProvider()],
      resolveEventBridges: () => [a, b],
    });
    dispose = () => deviceFlowRegistry.dispose();

    await deviceFlowRegistry.start({ providerId: PROVIDER_ID });

    for (const bridge of [a, b]) {
      expect(bridge.publishWorkspaceEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'auth_device_flow_started' }),
      );
    }
  });

  it('keeps delivering to the other bridges when one throws', async () => {
    const a = fakeBridge();
    a.publishWorkspaceEvent.mockImplementation(() => {
      throw new Error('bridge A delivery failed');
    });
    const b = fakeBridge();
    const { deviceFlowRegistry } = createDeviceFlowRegistry({
      bridge: a,
      providers: [fakeProvider()],
      resolveEventBridges: () => [a, b],
    });
    dispose = () => deviceFlowRegistry.dispose();

    // Must not reject even though bridge A throws (best-effort fan-out).
    await deviceFlowRegistry.start({ providerId: PROVIDER_ID });

    expect(a.publishWorkspaceEvent).toHaveBeenCalled();
    expect(b.publishWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'auth_device_flow_started' }),
    );
    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('bridge A delivery failed'),
    );
  });

  it('falls back to the single bridge when no resolver is provided', async () => {
    const only = fakeBridge();
    const { deviceFlowRegistry } = createDeviceFlowRegistry({
      bridge: only,
      providers: [fakeProvider()],
    });
    dispose = () => deviceFlowRegistry.dispose();

    await deviceFlowRegistry.start({ providerId: PROVIDER_ID });

    expect(only.publishWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'auth_device_flow_started' }),
    );
  });
});
