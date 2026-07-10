/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  DeviceFlowRegistry,
  setDeviceFlowRegistry,
  type DeviceFlowEventSink,
  type DeviceFlowProvider,
  type DeviceFlowProviderId,
} from '../auth/device-flow.js';
import { QwenOAuthDeviceFlowProvider } from '../auth/qwen-device-flow-provider.js';

interface SetupDeviceFlowRegistryDeps {
  app: Application;
  bridge: AcpSessionBridge;
  registry?: DeviceFlowRegistry;
  providers?: DeviceFlowProvider[];
  resolveEventBridges?: () => AcpSessionBridge[];
}

export interface ServeDeviceFlowRuntime {
  deviceFlowRegistry: DeviceFlowRegistry;
  getSupportedDeviceFlowProviders: () => DeviceFlowProviderId[];
}

export function createDeviceFlowRegistry(deps: {
  bridge: AcpSessionBridge;
  registry?: DeviceFlowRegistry;
  providers?: DeviceFlowProvider[];
  /**
   * Phase 4: the set of bridges each device-flow event should fan out to
   * (primary + trusted secondary runtimes), resolved lazily on every publish.
   * Defaults to the single `bridge` when omitted, preserving prior behavior.
   */
  resolveEventBridges?: () => AcpSessionBridge[];
}): ServeDeviceFlowRuntime {
  const deviceFlowProviderMap = new Map<
    DeviceFlowProviderId,
    DeviceFlowProvider
  >();
  for (const provider of deps.providers ?? []) {
    deviceFlowProviderMap.set(provider.providerId, provider);
  }
  if (!deviceFlowProviderMap.has('qwen-oauth')) {
    deviceFlowProviderMap.set('qwen-oauth', new QwenOAuthDeviceFlowProvider());
  }

  const deviceFlowEventSink: DeviceFlowEventSink = {
    publish(emission, originatorClientId) {
      // Phase 4: fan out to every trusted runtime's bridge (primary + trusted
      // secondaries) so a workspace-qualified ACP client sees its own flow's
      // events. The registry stays a daemon singleton; only delivery is
      // multiplexed. Best-effort per the DeviceFlowEventSink contract: one
      // bridge failing must not block the others or the registry state machine.
      const bridges = deps.resolveEventBridges
        ? deps.resolveEventBridges()
        : [deps.bridge];
      for (const bridge of bridges) {
        try {
          bridge.publishWorkspaceEvent({
            type: `auth_device_flow_${emission.type}`,
            data: emission.data,
            ...(originatorClientId ? { originatorClientId } : {}),
          });
        } catch {
          // Swallow per-bridge delivery failures; fan-out is best-effort.
        }
      }
    },
  };
  const deviceFlowRegistry =
    deps.registry ??
    new DeviceFlowRegistry({
      events: deviceFlowEventSink,
      audit: {
        record(line) {
          // Structured stderr breadcrumb; deviceFlowId truncated to first
          // 8 chars so log skimmers can follow a flow without retaining
          // full uuids.
          const id = line.deviceFlowId.slice(0, 8);
          const parts = [
            `[serve] auth.device-flow:`,
            `provider=${line.providerId}`,
            `deviceFlowId=${id}...`,
            line.clientId ? `clientId=${line.clientId}` : 'clientId=-',
            `status=${line.status}`,
          ];
          if (line.errorKind) parts.push(`errorKind=${line.errorKind}`);
          if (line.expiresInMs !== undefined) {
            parts.push(`expiresInMs=${Math.max(0, line.expiresInMs)}`);
          }
          // Include `line.hint` for operator-only breadcrumbs that aren't
          // surfaced over SSE. Bound at 1 KiB.
          if (line.hint) {
            const STDERR_HINT_MAX = 1_024;
            const hint =
              line.hint.length > STDERR_HINT_MAX
                ? `${line.hint.slice(0, STDERR_HINT_MAX)}…[+${line.hint.length - STDERR_HINT_MAX} bytes truncated]`
                : line.hint;
            // Quote the hint so multi-word values stay parseable.
            parts.push(`hint=${JSON.stringify(hint)}`);
          }
          writeStderrLine(parts.join(' '));
        },
      },
      resolveProvider: (providerId) => deviceFlowProviderMap.get(providerId),
    });

  return {
    deviceFlowRegistry,
    getSupportedDeviceFlowProviders: () =>
      Array.from(deviceFlowProviderMap.keys()),
  };
}

/**
 * Set up the primary (app-global) device-flow registry: builds the registry via
 * {@link createDeviceFlowRegistry} and exposes it on `app.locals` for the legacy
 * REST auth routes. Non-primary runtimes call {@link createDeviceFlowRegistry}
 * directly so their device-flow state stays bound to their own bridge without
 * touching `app.locals`.
 */
export function setupDeviceFlowRegistry(
  deps: SetupDeviceFlowRegistryDeps,
): ServeDeviceFlowRuntime {
  const runtime = createDeviceFlowRegistry({
    bridge: deps.bridge,
    registry: deps.registry,
    providers: deps.providers,
    resolveEventBridges: deps.resolveEventBridges,
  });
  setDeviceFlowRegistry(deps.app, runtime.deviceFlowRegistry);
  return runtime;
}
