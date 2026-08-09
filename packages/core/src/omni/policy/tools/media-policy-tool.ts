/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { FunctionDeclaration } from '@google/genai';
import type {
  MediaPolicyToolDescriptor,
  ToolArtifact,
  ToolArtifactKind,
  ToolResult,
} from '../../../tools/tools.js';
import type { Kind } from '../../../tools/tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
} from '../../../tools/tools.js';
import type { PermissionDecision } from '../../../permissions/types.js';
import { ToolErrorType } from '../../../tools/tool-error.js';
import { getErrorMessage } from '../../../utils/errors.js';
import { SchemaValidator } from '../../../utils/schemaValidator.js';
import { projectMediaPolicyToolDeclaration } from '../model-access.js';
import { isPlainRecord } from '../types.js';
import type { MediaPolicyToolConfigView } from '../types.js';

/** Re-exported for the many tool modules that already import the config
 * view from here; the definition lives in types.ts. */
export type { MediaPolicyToolConfigView };

/** Default transcode timeout when `policyTools.<tool>.runtime.timeoutMs`
 * is not configured (mapping doc §6). */
export const DEFAULT_POLICY_TOOL_TIMEOUT_MS = 600_000;

/** Parameters every media-policy degradation tool shares: one input file,
 * one harness-injected output directory (the invocation's staging dir —
 * the tool's ONLY permitted output location). */
export interface MediaPolicyIoParams {
  /** Absolute path of the source media file. */
  inputPath: string;
  /** Absolute path of the directory the tool must write into. */
  outputDir: string;
}

/** JSON-schema fragments for the shared io parameters. */
export const MEDIA_POLICY_IO_SCHEMA_PROPERTIES = {
  inputPath: {
    type: 'string',
    description: 'Absolute path of the source media file.',
  },
  outputDir: {
    type: 'string',
    description:
      'Absolute path of the directory the output file is written into.',
  },
} as const;

/** Read `omni.processing.policyTools.<toolName>.runtime.timeoutMs`
 * leniently; anything absent or malformed resolves to the default. */
export function resolvePolicyToolTimeoutMs(
  config: MediaPolicyToolConfigView,
  toolName: string,
): number {
  const entry = config.getOmniPolicyToolsSettings?.()?.[toolName];
  const runtime =
    isPlainRecord(entry) && isPlainRecord(entry['runtime'])
      ? entry['runtime']
      : undefined;
  const timeoutMs = runtime?.['timeoutMs'];
  return typeof timeoutMs === 'number' &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
    ? timeoutMs
    : DEFAULT_POLICY_TOOL_TIMEOUT_MS;
}

/**
 * Read `omni.processing.policyTools.<toolName>.settings` leniently. The
 * map is raw settings input (values may be null tombstones or malformed),
 * so anything non-conforming reads as "no defaults" rather than throwing
 * mid-run.
 */
export function resolvePolicyToolSettings(
  config: MediaPolicyToolConfigView,
  toolName: string,
): Record<string, unknown> {
  const entry = config.getOmniPolicyToolsSettings?.()?.[toolName];
  const settings = isPlainRecord(entry) ? entry['settings'] : undefined;
  return isPlainRecord(settings) ? settings : {};
}

/**
 * Shared wall-clock budget for tools that may run MORE than one ffmpeg
 * pass (copy→aac audio fallback, scene→uniform sampling fallback): each
 * pass receives the time REMAINING, so the invocation's total transcode
 * time stays within the configured `runtime.timeoutMs` instead of
 * timeoutMs × passes. The first call returns the full budget
 * (deterministic — the clock starts at that call, not at construction);
 * later calls return what is left, floored at 1ms so runFfmpeg still
 * receives a positive timeout and the exhausted pass fails fast.
 */
export function createPolicyToolTimeoutBudget(totalMs: number): () => number {
  let deadline: number | undefined;
  return () => {
    const now = Date.now();
    deadline ??= now + totalMs;
    return Math.max(1, deadline - now);
  };
}

/**
 * Convert a runtime.timeoutMs into sharp's whole-second `timeout()` unit,
 * rounding up and flooring at 1s so a small-but-positive budget still
 * bounds libvips instead of disabling the timeout (sharp treats 0 as
 * "no limit"). The ffmpeg tools get the same bound via runFfmpeg's
 * process timeout.
 */
export function sharpTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

/**
 * Base invocation for media-policy tools. These invocations spawn
 * ffmpeg/sharp and WRITE files (with overwrite) at the caller-chosen
 * `outputDir`, so they are side-effecting: a model-origin call must be
 * confirmation-gated like Write/Edit rather than inherit the read-only
 * `'allow'` default. The fixed-policy path is unaffected — the scheduler
 * skips the permission flow entirely for `fixed_policy` origin, and the
 * orchestrator pins `outputDir` to the invocation's staging directory.
 */
export abstract class BaseMediaPolicyToolInvocation<
  TParams extends object,
> extends BaseToolInvocation<TParams, ToolResult> {
  override getDefaultPermission(): Promise<PermissionDecision> {
    return Promise.resolve('ask');
  }
}

/**
 * Base class for omni media-policy tools (real DeclarativeTools — the
 * orchestrator executes them through the ordinary scheduler path, and
 * Stage B's modelAccess can open them to the model).
 *
 * `mediaPolicyDescriptor` is abstract: every subclass MUST declare its
 * descriptor — that code-level fact is what the modelAccess gate and the
 * orchestrator key off.
 */
export abstract class BaseMediaPolicyTool<
  TParams extends MediaPolicyIoParams,
> extends BaseDeclarativeTool<TParams, ToolResult> {
  constructor(
    name: string,
    displayName: string,
    description: string,
    kind: Kind,
    parameterSchema: unknown,
    /** Config view feeding the modelAccess declaration projection and the
     * subclasses' timeout/settings resolution; tools constructed without
     * one (tests, embedders) declare their native schema unchanged and use
     * built-in defaults. */
    protected readonly configView: MediaPolicyToolConfigView = {},
  ) {
    super(name, displayName, description, kind, parameterSchema);
  }

  abstract override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor;

  /** Memoized projection result, keyed on the settings-object identity it
   * was computed from ({@link schema}). */
  private projectedSchema?: {
    settings: unknown;
    declaration: FunctionDeclaration;
  };

  /**
   * Model-visible declaration (decision D6): the single projection point
   * every declaration surface reads — the native schema minus
   * `modelAccess.lockedArguments` keys, narrowed to
   * `modelAccess.parameterSchema` when configured, with the optional
   * description override applied. Validation deliberately does NOT use
   * this projection (see {@link validateToolParams}).
   *
   * The projection is pure over (native schema, settings object), and the
   * config stores one normalized settings object per initialize() — so the
   * result is memoized on that object's identity, and a re-initialize
   * (which swaps the object) recomputes naturally.
   */
  override get schema(): FunctionDeclaration {
    const settings = this.configView.getOmniPolicyToolsSettings?.();
    if (!this.projectedSchema || this.projectedSchema.settings !== settings) {
      this.projectedSchema = {
        settings,
        declaration: projectMediaPolicyToolDeclaration(this.configView, {
          name: this.name,
          description: this.description,
          parametersJsonSchema: this.parameterSchema,
          operatorOnlyParams: this.mediaPolicyDescriptor.operatorOnlyParams,
        }),
      };
    }
    return this.projectedSchema.declaration;
  }

  /**
   * Validate against the tool's NATIVE parameter schema, never the
   * model-visible `schema` getter: Stage B's modelAccess projection makes
   * `schema` a narrowed view (lockedArguments removed), while validation
   * must keep accepting the harness-injected arguments the projection
   * hides (policy design §9.4).
   */
  override validateToolParams(params: TParams): string | null {
    const errors = SchemaValidator.validate(this.parameterSchema, params);
    if (errors) {
      return errors;
    }
    return this.validateToolParamValues(params);
  }

  /** Every media-policy tool shares the io params; tools with extra
   * value-level rules override this and layer them on top. */
  protected override validateToolParamValues(params: TParams): string | null {
    return validateMediaPolicyIoParams(params);
  }
}

/** Shared structural validation for the io params (schema has already
 * checked types/required-ness). Returns an error message or null. */
export function validateMediaPolicyIoParams(
  params: MediaPolicyIoParams,
): string | null {
  if (!path.isAbsolute(params.inputPath)) {
    return `inputPath must be an absolute path (got ${JSON.stringify(params.inputPath)})`;
  }
  if (!path.isAbsolute(params.outputDir)) {
    return `outputDir must be an absolute path (got ${JSON.stringify(params.outputDir)})`;
  }
  return null;
}

/**
 * Execution-time io checks (validateToolParams is synchronous, so
 * filesystem state is asserted here): the input must be an existing
 * REGULAR file (lstat — a symlink is refused, the tool must never read
 * through a link planted in its input position) and the output directory
 * an existing real directory. Returns the input size in bytes.
 */
export async function assertMediaPolicyIo(
  params: MediaPolicyIoParams,
): Promise<{ inputSizeBytes: number }> {
  let inputStat;
  try {
    inputStat = await fs.lstat(params.inputPath);
  } catch {
    throw new Error(`input file not found: ${params.inputPath}`);
  }
  if (!inputStat.isFile()) {
    throw new Error(`input is not a regular file: ${params.inputPath}`);
  }
  let outStat;
  try {
    outStat = await fs.lstat(params.outputDir);
  } catch {
    throw new Error(`output directory not found: ${params.outputDir}`);
  }
  if (!outStat.isDirectory()) {
    throw new Error(`output path is not a real directory: ${params.outputDir}`);
  }
  return { inputSizeBytes: inputStat.size };
}

/** Compact human-readable byte count for disclosure texts ("8.2MB",
 * "0.9MB", "2GB", "180MB", "512KB"). */
export function formatBytesShort(bytes: number): string {
  const trim = (n: number): string =>
    (Math.round(n * 10) / 10).toString().replace(/\.0$/, '');
  if (bytes >= 1024 ** 3) return `${trim(bytes / 1024 ** 3)}GB`;
  if (bytes >= 1024 ** 2) return `${trim(bytes / 1024 ** 2)}MB`;
  if (bytes >= 1024) return `${trim(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** "立体声" / "单声道" / "N声道" for disclosure texts (leading space so
 * an unknown channel count renders as nothing). */
export function describeChannels(channels: number | undefined): string {
  if (channels === undefined) return '';
  if (channels === 1) return ' 单声道';
  if (channels === 2) return ' 立体声';
  return ` ${channels}声道`;
}

/** Uniform error ToolResult for a failed policy-tool execution. */
export function mediaPolicyToolError(message: string): ToolResult {
  return {
    llmContent: `Error: ${message}`,
    returnDisplay: message,
    error: { message, type: ToolErrorType.EXECUTION_FAILED },
  };
}

/** Shared catch-tail: turn whatever a policy tool threw into the uniform
 * error ToolResult. */
export function mediaPolicyToolFailure(error: unknown): ToolResult {
  return mediaPolicyToolError(getErrorMessage(error));
}

/** Uniform "ffmpeg failed" message: exit code, the action underway, the
 * input's basename (never its full path), and the stderr tail. */
export function ffmpegFailureMessage(
  run: { code: number | null; stderr: string },
  action: string,
  inputPath: string,
): string {
  return `ffmpeg failed (exit ${run.code}) ${action} ${path.basename(inputPath)}: ${run.stderr.slice(-500)}`;
}

/**
 * Successful policy-tool result: a one-line summary for the model-facing
 * channel and exactly one lossy media artifact whose
 * `metadata.omniDisclosure` carries the disclosure text the orchestrator
 * validates and delivers adjacent to the media (decision D8).
 */
export function mediaPolicyToolSuccess(args: {
  outputDir: string;
  outputFileName: string;
  artifactKind: ToolArtifactKind;
  title: string;
  mimeType: string;
  sizeBytes: number;
  disclosure: string;
  /** `metadata.omniRole` label (e.g. 'transcript' for the §6.2 transcript
   * protocol); omitted for plain media derivatives. */
  role?: string;
}): ToolResult {
  const artifact: ToolArtifact = {
    kind: args.artifactKind,
    storage: 'workspace',
    title: args.title,
    // Relative to the invocation's staging directory — the orchestrator
    // resolves and re-validates containment before promotion.
    workspacePath: args.outputFileName,
    mimeType: args.mimeType,
    sizeBytes: args.sizeBytes,
    metadata:
      args.role === undefined
        ? { omniDisclosure: args.disclosure }
        : { omniDisclosure: args.disclosure, omniRole: args.role },
  };
  return {
    llmContent: `${args.title}: ${args.disclosure}`,
    returnDisplay: args.disclosure,
    artifacts: [artifact],
  };
}
