/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolExecutionOrigin } from '../../core/turn.js';
import type { MediaPolicyToolDescriptor } from '../../tools/tools.js';
import type {
  OmniPolicyToolModelAccessSettings,
  OmniPolicyToolsSettings,
} from './types.js';

/**
 * Shared modelAccess resolver + call gate for omni media-policy tools.
 *
 * Media-policy tools are always registered (the fixed-policy orchestrator
 * must be able to find them), but they are fixed-policy-only by default:
 * only `omni.processing.policyTools.<name>.modelAccess.enabled: true`
 * makes them callable by the model or by direct client calls. The gate
 * must hold on every surface at once — declaration lists, ToolSearch
 * keyword + select, the CoreToolScheduler, and ACP's Session.runTool() —
 * so all of them call into this module rather than re-deriving the rule.
 */

/** Minimal structural view of Config used by this module. All calls are
 * optional so partial/stub configs (tests, embedders) fail closed. */
export interface MediaPolicyConfigView {
  getOmniPolicyToolsSettings?: () => OmniPolicyToolsSettings | undefined;
}

/** Resolved modelAccess for one tool: always concrete (defaults applied). */
export interface ResolvedMediaPolicyModelAccess {
  /** Whether model/client-origin calls are allowed. Default false. */
  enabled: boolean;
  defaultArguments: Record<string, unknown>;
  lockedArguments: Record<string, unknown>;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read `omni.processing.policyTools.<toolName>.modelAccess` leniently:
 * anything absent or malformed resolves to the fail-closed default
 * (`enabled: false`, no argument projection).
 */
export function resolveMediaPolicyModelAccess(
  config: MediaPolicyConfigView,
  toolName: string,
): ResolvedMediaPolicyModelAccess {
  const entry = config.getOmniPolicyToolsSettings?.()?.[toolName];
  const modelAccess: OmniPolicyToolModelAccessSettings | undefined =
    isPlainRecord(entry) && isPlainRecord(entry['modelAccess'])
      ? (entry['modelAccess'] as OmniPolicyToolModelAccessSettings)
      : undefined;
  return {
    enabled: modelAccess?.enabled === true,
    defaultArguments: isPlainRecord(modelAccess?.defaultArguments)
      ? modelAccess.defaultArguments
      : {},
    lockedArguments: isPlainRecord(modelAccess?.lockedArguments)
      ? modelAccess.lockedArguments
      : {},
  };
}

/**
 * Whether a tool must be hidden from model-facing declaration surfaces
 * (initial declarations, subagent filtered declarations, ToolSearch
 * keyword candidates and exact-select). True iff the tool is a
 * media-policy tool whose modelAccess is not enabled.
 */
export function isMediaPolicyToolHiddenFromModel(
  config: MediaPolicyConfigView,
  tool: { name: string; mediaPolicyDescriptor?: MediaPolicyToolDescriptor },
): boolean {
  if (!tool.mediaPolicyDescriptor) return false;
  return !resolveMediaPolicyModelAccess(config, tool.name).enabled;
}

/** Outcome of {@link evaluateMediaPolicyToolCall}. */
export type MediaPolicyCallGateResult =
  | {
      outcome: 'pass';
      /** Arguments to build the invocation with. For gated model/client
       * calls this is defaults + caller args + lockedArguments; for
       * everything else it is the caller args unchanged. */
      args: Record<string, unknown>;
    }
  | {
      outcome: 'reject';
      /** 'execution_denied' → the call may not run at all;
       * 'invalid_params' → a parameter-level error the model can fix. */
      reason: 'execution_denied' | 'invalid_params';
      message: string;
    };

/**
 * Execution-time gate applied by CoreToolScheduler and ACP Session.runTool
 * before an invocation is built:
 *
 * - a `fixed_policy` origin on a NON-media-policy tool is rejected
 *   (defense in depth — origins are never deserialized, but a forged
 *   origin must not become a permission bypass for Shell/Edit/MCP);
 * - a `fixed_policy` origin on a media-policy tool passes untouched (the
 *   orchestrator already resolved its own `arguments`; modelAccess does
 *   not apply to fixed calls);
 * - a model/client-origin call of a media-policy tool requires
 *   `modelAccess.enabled`, must not name any lockedArguments key
 *   explicitly, and gets defaults + lockedArguments merged in;
 * - everything else passes untouched.
 *
 * A missing origin fails closed as `{ kind: 'model' }`.
 */
export function evaluateMediaPolicyToolCall(params: {
  config: MediaPolicyConfigView;
  tool: { name: string; mediaPolicyDescriptor?: MediaPolicyToolDescriptor };
  args: Record<string, unknown>;
  executionOrigin: ToolExecutionOrigin | undefined;
}): MediaPolicyCallGateResult {
  const { config, tool, args } = params;
  const origin = params.executionOrigin ?? { kind: 'model' };

  if (origin.kind === 'fixed_policy') {
    if (!tool.mediaPolicyDescriptor) {
      return {
        outcome: 'reject',
        reason: 'execution_denied',
        message:
          `Tool "${tool.name}" cannot run with a fixed-policy execution ` +
          `origin: it is not a media policy tool.`,
      };
    }
    return { outcome: 'pass', args };
  }

  if (!tool.mediaPolicyDescriptor) {
    return { outcome: 'pass', args };
  }

  const access = resolveMediaPolicyModelAccess(config, tool.name);
  if (!access.enabled) {
    return {
      outcome: 'reject',
      reason: 'execution_denied',
      message:
        `Tool "${tool.name}" is an omni media policy tool reserved for ` +
        `fixed-policy orchestration. Direct calls require ` +
        `"omni.processing.policyTools.${tool.name}.modelAccess.enabled": true.`,
    };
  }

  const lockedKeys = Object.keys(access.lockedArguments);
  const violations = lockedKeys.filter((key) =>
    Object.prototype.hasOwnProperty.call(args, key),
  );
  if (violations.length > 0) {
    return {
      outcome: 'reject',
      reason: 'invalid_params',
      message:
        `Invalid parameters for tool "${tool.name}": ` +
        `${violations.map((k) => `"${k}"`).join(', ')} ` +
        `${violations.length === 1 ? 'is' : 'are'} locked by configuration ` +
        `and must not be provided. Remove ${
          violations.length === 1 ? 'it' : 'them'
        } and retry.`,
    };
  }

  return {
    outcome: 'pass',
    args: { ...access.defaultArguments, ...args, ...access.lockedArguments },
  };
}
