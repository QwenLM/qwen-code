/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import type { ToolExecutionOrigin } from '../../core/turn.js';
import type { MediaPolicyToolDescriptor } from '../../tools/tools.js';
import type { OmniMediaRegistryView } from '../../services/media-memory/registry.js';
import { resolveMediaReference } from '../../services/media-memory/registry.js';
import { isPlainRecord } from './types.js';
import type {
  MediaPolicyToolConfigView,
  OmniPolicyToolModelAccessSettings,
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

/** Historical name this module exported for its config view; kept as an
 * alias of the shared type so existing importers stay valid. */
export type MediaPolicyConfigView = MediaPolicyToolConfigView;

/** Resolved modelAccess for one tool: always concrete (defaults applied). */
export interface ResolvedMediaPolicyModelAccess {
  /** Whether model/client-origin calls are allowed. Default false. */
  enabled: boolean;
  defaultArguments: Record<string, unknown>;
  lockedArguments: Record<string, unknown>;
  /** Model-facing description override for the declaration projection. */
  description?: string;
  /** Narrowing-only projection over the native parameter schema. */
  parameterSchema?: Record<string, unknown>;
}

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
    description:
      typeof modelAccess?.description === 'string' &&
      modelAccess.description !== ''
        ? modelAccess.description
        : undefined,
    parameterSchema: isPlainRecord(modelAccess?.parameterSchema)
      ? modelAccess.parameterSchema
      : undefined,
  };
}

/**
 * Model-visible declaration for a media-policy tool (decision D6, policy
 * design §9.4): the projection is applied at the SINGLE `schema` getter
 * the declaration surfaces read, while validation keeps using the native
 * schema (the harness-injected arguments the projection hides must stay
 * valid).
 *
 * Shape: the native parametersJsonSchema minus every
 * `modelAccess.lockedArguments` key (removed from `properties` and
 * `required` — the model must not see arguments it is forbidden to pass),
 * then — when `modelAccess.parameterSchema` is configured — narrowed to
 * the properties it names, with each named property's constraints merged
 * over the native ones. A projection property with no native counterpart
 * is ignored (narrowing-only: the projection can never ADD surface).
 * `modelAccess.description` overrides the tool description when set.
 */
export function projectMediaPolicyToolDeclaration(
  config: MediaPolicyConfigView,
  native: {
    name: string;
    description: string;
    parametersJsonSchema: unknown;
    /** Descriptor-declared operator-only keys — hidden from the model
     * exactly like lockedArguments (the model must not see arguments the
     * gate forbids it to pass). */
    operatorOnlyParams?: readonly string[];
  },
): FunctionDeclaration {
  const access = resolveMediaPolicyModelAccess(config, native.name);
  const description = access.description ?? native.description;
  const schema = isPlainRecord(native.parametersJsonSchema)
    ? native.parametersJsonSchema
    : undefined;
  const nativeProps =
    schema && isPlainRecord(schema['properties'])
      ? schema['properties']
      : undefined;
  if (!schema || !nativeProps) {
    return {
      name: native.name,
      description,
      parametersJsonSchema: native.parametersJsonSchema,
    };
  }
  const lockedKeys = new Set([
    ...Object.keys(access.lockedArguments),
    ...(native.operatorOnlyParams ?? []),
  ]);
  const narrowProps =
    access.parameterSchema &&
    isPlainRecord(access.parameterSchema['properties'])
      ? (access.parameterSchema['properties'] as Record<string, unknown>)
      : undefined;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(nativeProps)) {
    if (lockedKeys.has(key)) continue;
    if (narrowProps && !(key in narrowProps)) continue;
    const override = narrowProps?.[key];
    properties[key] =
      isPlainRecord(override) && isPlainRecord(value)
        ? { ...value, ...override }
        : value;
  }
  const required = Array.isArray(schema['required'])
    ? (schema['required'] as unknown[]).filter(
        (key): key is string => typeof key === 'string' && key in properties,
      )
    : undefined;
  return {
    name: native.name,
    description,
    parametersJsonSchema: {
      ...schema,
      properties,
      ...(required !== undefined ? { required } : {}),
    },
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
 *   `modelAccess.enabled`, may reference its input by opaque session
 *   `resourceId` INSTEAD of `inputPath` (resolved here to the real
 *   locator — memory design M §5.2; for path-less media the model never
 *   learns the path, while a model-visible local file was shown its own
 *   path and may name it here or in `inputPath`),
 *   must not name any lockedArguments key explicitly, and gets
 *   defaults + lockedArguments merged in;
 * - everything else passes untouched.
 *
 * A missing origin fails closed as `{ kind: 'model' }`.
 */
export function evaluateMediaPolicyToolCall(params: {
  config: MediaPolicyConfigView & OmniMediaRegistryView;
  tool: { name: string; mediaPolicyDescriptor?: MediaPolicyToolDescriptor };
  args: Record<string, unknown>;
  executionOrigin: ToolExecutionOrigin | undefined;
}): MediaPolicyCallGateResult {
  const { config, tool } = params;
  let args = params.args;
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

  // Session-reference input (M §5.2): a gated caller may name its source by
  // the reference it was shown in a 【媒体资源】 annotation instead of a real
  // path — the opaque handle minted at delivery/recall, or, for a
  // model-visible local file, the absolute path itself. `resolveMediaReference`
  // accepts either form (reversing a displayed path back to its binding, same
  // as active recall). Resolution happens BEFORE the lockedArguments check so a
  // resolved inputPath cannot sidestep an operator-pinned input.
  if (typeof args['resourceId'] === 'string') {
    if (args['inputPath'] !== undefined) {
      return {
        outcome: 'reject',
        reason: 'invalid_params',
        message:
          `Invalid parameters for tool "${tool.name}": provide exactly ` +
          `one of "inputPath" or "resourceId", not both.`,
      };
    }
    const registry = config.getOmniMediaResourceRegistry?.();
    const binding = registry
      ? resolveMediaReference(registry, args['resourceId'])
      : undefined;
    if (!binding) {
      // Neither an issued handle nor the path of a file delivered this
      // session (fabricated or stale cross-session reference) — reject,
      // never guess (M §9.2 stance).
      return {
        outcome: 'reject',
        reason: 'invalid_params',
        message:
          `Invalid parameters for tool "${tool.name}": resourceId ` +
          `"${args['resourceId']}" matches no media delivered this session. ` +
          `Use a handle or the absolute path from a 【媒体资源】 annotation ` +
          `or a recall result.`,
      };
    }
    // The handle's modality must be one this tool declares consuming. The
    // fixed-policy path validates this at startup; a gated caller holds
    // only opaque handles, so mixing two up is easy — and without this the
    // mistake becomes a spawned ffmpeg that burns the tool timeout and
    // returns an opaque stderr tail, instead of an instant parameter error
    // the caller can correct.
    const accepted = tool.mediaPolicyDescriptor.inputMediaTypes;
    if (accepted !== undefined && !accepted.includes(binding.mediaType)) {
      return {
        outcome: 'reject',
        reason: 'invalid_params',
        message:
          `Invalid parameters for tool "${tool.name}": resourceId ` +
          `"${args['resourceId']}" names ${binding.mediaType} media, but ` +
          `this tool accepts ${accepted.join(', ')}. Pass a handle whose ` +
          `media type matches.`,
      };
    }
    const { resourceId: _resourceId, ...rest } = args;
    args = { ...rest, inputPath: binding.fileRef };
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

  // Operator-only parameters (descriptor-declared, e.g. endpoint base URL
  // + credential env-var name): a gated caller must never set them — a
  // model-controlled endpoint/credential pair would let injected content
  // exfiltrate arbitrary environment secrets to an attacker host. They
  // remain settable through settings / defaultArguments / lockedArguments
  // (operator-controlled surfaces only).
  const operatorViolations = (
    tool.mediaPolicyDescriptor.operatorOnlyParams ?? []
  ).filter((key) => Object.prototype.hasOwnProperty.call(args, key));
  if (operatorViolations.length > 0) {
    return {
      outcome: 'reject',
      reason: 'invalid_params',
      message:
        `Invalid parameters for tool "${tool.name}": ` +
        `${operatorViolations.map((k) => `"${k}"`).join(', ')} ` +
        `${operatorViolations.length === 1 ? 'is' : 'are'} operator-only ` +
        `(set via omni.processing.policyTools.${tool.name} configuration) ` +
        `and must not be provided by the caller. Remove ${
          operatorViolations.length === 1 ? 'it' : 'them'
        } and retry.`,
    };
  }

  return {
    outcome: 'pass',
    args: { ...access.defaultArguments, ...args, ...access.lockedArguments },
  };
}
