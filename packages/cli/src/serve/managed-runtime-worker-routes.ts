/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MANAGED_TOOL_RESULT_ROUTES } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import { OWNED_MANAGED_RUNTIME_ROUTES } from './managed-runtime-attestation-contract.js';
import { MANAGED_CONTEXT_WORKER_ROUTES } from './managed-context-worker.js';
import { MANAGED_RUNTIME_PROVIDER_ROUTE } from './managed-runtime-provider-protocol.js';
import { MANAGED_RUNTIME_TOOL_V4_ROUTES } from './managed-runtime-tool-v4-routes.js';
import {
  MANAGED_EXTENSION_RETIRE_ROUTE,
  MANAGED_EXTENSION_RUNTIME_ROUTE,
  MANAGED_EXTENSION_UPLOAD_ROUTE,
} from './managed-extension-runtime.js';
import { MANAGED_EXTENSION_COMMAND_ROUTE } from './managed-extension-command-runtime.js';
import {
  MANAGED_CSI_ATTEST_ROUTE,
  MANAGED_CSI_DRAIN_ROUTE,
  MANAGED_CSI_ACK_ROUTE,
} from './managed-csi-worker.js';
import { MANAGED_SHELL_PUBLISHER_ROUTE } from './managed-shell-publisher.js';
import { PUBLICATION_INSTALL_ROUTE } from './remote-shell-result-publication.js';
import {
  MEASURED_WORKSPACE_CAPABILITY_DIGEST,
  resolveManagedShellPublisherMode,
} from './managed-workspace-activation.js';

export interface ManagedRuntimeWorkerRouteInput {
  readonly bootVersion: 1 | 2;
  readonly capabilityDigest: string;
  readonly managedExtensions: boolean;
  readonly csi: boolean;
  readonly sshRoute?: { readonly method: string; readonly path: string };
  readonly capturePublisher: boolean;
  readonly remotePublishers: boolean;
  readonly publication: boolean;
}

export interface ManagedRuntimeWorkerRoutePlan {
  readonly routes: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
  }>;
  readonly toolV4: boolean;
  readonly toolResult: boolean;
  readonly publicationInstall: boolean;
}

/**
 * The single derivation of the Managed Runtime worker's route surface. The
 * outer gate admits exactly `routes`; the context worker's mounts consume the
 * same publisher-mode derivation, so a route cannot be mounted without being
 * gated. See docs/design/2026-11-10-managed-runtime-route-single-source.md.
 */
export function resolveManagedRuntimeWorkerRoutePlan(
  input: ManagedRuntimeWorkerRouteInput,
): ManagedRuntimeWorkerRoutePlan {
  if (input.bootVersion === 1) {
    return {
      routes: [...OWNED_MANAGED_RUNTIME_ROUTES, MANAGED_RUNTIME_PROVIDER_ROUTE],
      toolV4: false,
      toolResult: false,
      publicationInstall: false,
    };
  }
  const mode = resolveManagedShellPublisherMode({
    capabilityDigest: input.capabilityDigest,
    managedExtensions: input.managedExtensions,
    capturePublisher: input.capturePublisher || input.publication,
    remotePublishers: input.remotePublishers,
  });
  const toolV4 =
    input.capabilityDigest === MEASURED_WORKSPACE_CAPABILITY_DIGEST;
  return {
    routes: [
      ...MANAGED_CONTEXT_WORKER_ROUTES,
      ...(toolV4 ? MANAGED_RUNTIME_TOOL_V4_ROUTES : []),
      ...(input.managedExtensions
        ? [
            MANAGED_EXTENSION_RUNTIME_ROUTE,
            MANAGED_EXTENSION_UPLOAD_ROUTE,
            MANAGED_EXTENSION_RETIRE_ROUTE,
            MANAGED_EXTENSION_COMMAND_ROUTE,
          ]
        : []),
      ...(input.csi
        ? [
            MANAGED_CSI_ATTEST_ROUTE,
            MANAGED_CSI_DRAIN_ROUTE,
            MANAGED_CSI_ACK_ROUTE,
          ]
        : []),
      ...(mode.publisher ? MANAGED_TOOL_RESULT_ROUTES : []),
      ...(input.sshRoute ? [input.sshRoute] : []),
      ...(input.remotePublishers ? [MANAGED_SHELL_PUBLISHER_ROUTE] : []),
      ...(mode.installRoute ? [PUBLICATION_INSTALL_ROUTE] : []),
    ],
    toolV4,
    toolResult: mode.publisher,
    publicationInstall: mode.installRoute,
  };
}
