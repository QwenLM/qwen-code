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
 * the tool's ONLY permitted output location). `inputPath` is guaranteed
 * present by the time an invocation is built: fixed-policy calls always
 * carry it, and gated model/client calls that passed `resourceId` instead
 * had it resolved by the call gate (model-access.ts) before validation. */
export interface MediaPolicyIoParams {
  /** Absolute path of the source media file. */
  inputPath: string;
  /** Absolute path of the directory the tool must write into. */
  outputDir: string;
}

/** JSON-schema fragments for the shared io parameters. `resourceId` is
 * the model-facing alternative to `inputPath` (memory design M §5.2):
 * the model references delivered media by its opaque session handle and
 * the call gate resolves the handle to the real locator — it never
 * appears in the arguments an invocation is built with. */
export const MEDIA_POLICY_IO_SCHEMA_PROPERTIES = {
  inputPath: {
    type: 'string',
    description:
      'Absolute path of the source media file. Provide exactly one of ' +
      'inputPath or resourceId.',
  },
  resourceId: {
    type: 'string',
    description:
      'Opaque session media handle (from a 【媒体资源】 annotation or a ' +
      'recall result) naming the source media. Provide exactly one of ' +
      'inputPath or resourceId.',
  },
  outputDir: {
    type: 'string',
    description:
      'Absolute path of an existing directory the output file is written into; it is not created automatically.',
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

  /**
   * The other half of the Write/Edit permission posture these tools adopt:
   * without this override, the AUTO-mode classifier sees the empty-string
   * sentinel (`Arguments: {}`) and its path-based block rules can never
   * fire on a model-origin call. Project exactly the fields those rules
   * key on — the two filesystem paths carry no secrets.
   */
  override toAutoClassifierInput(params: TParams): Record<string, unknown> {
    return { inputPath: params.inputPath, outputDir: params.outputDir };
  }
}

/** Longest source stem kept in a generated output name: long enough to
 * stay recognizable, short enough that a deep outputDir plus a variant
 * suffix cannot approach the filesystem's per-component limit. */
const MAX_OUTPUT_STEM_LENGTH = 48;

/**
 * Build a self-describing output filename for a policy artifact.
 *
 * These tools used to write fixed names (`clip.mp4`, `downsampled.jpg`,
 * `transcript.txt`). Under fixed-policy orchestration that is safe: every
 * invocation gets its own staging directory. But `modelAccess` lets a
 * caller pick a PERSISTENT `outputDir`, and there two calls collide — the
 * second silently destroys the first artifact. Observed in a real
 * multi-session run: a clip cut on day one was overwritten by a different
 * clip on day three, and the commentary written against the first clip
 * silently began describing the wrong footage.
 *
 * The name carries the two axes that actually distinguish artifacts: the
 * SOURCE it came from, and — where the operation has one — a natural
 * VARIANT (a clip's time range, a frame's index). Same source and same
 * variant deliberately resolve to the same name: re-running one operation
 * replaces its own output with identical bytes, which is idempotent
 * rather than destructive.
 *
 * Residual case, documented rather than defended against: one operation
 * run twice on one source with DIFFERENT tuning and no natural variant —
 * two downscales at different heights — still resolves to one name and
 * the later result supersedes. That is an operation superseding itself,
 * not one artifact destroying an unrelated one.
 */
/**
 * The sanitized source stem that {@link policyOutputFileName} prefixes onto
 * every artifact derived from `inputPath`. Exposed so a tool can reconstruct
 * the exact prefix of its own outputs (e.g. to count prior artifacts of one
 * source on disk) without duplicating the sanitization rule.
 */
export function policyOutputStem(inputPath: string): string {
  const raw = path.basename(inputPath, path.extname(inputPath));
  // Collapse anything outside a conservative portable set (`+` is kept:
  // it is portable everywhere and appears in this scheme's own variants,
  // e.g. a clip's `123s+40s`, so derived artifacts of a clip keep a stem
  // that still round-trips). The stem comes
  // from user-supplied media names (spaces, quotes, CJK, shell
  // metacharacters) and is about to become a real path component.
  return (
    raw
      .replace(/[^A-Za-z0-9._+-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_OUTPUT_STEM_LENGTH) || 'media'
  );
}

export function policyOutputFileName(params: {
  /** Source the artifact was derived from. */
  inputPath: string;
  /** Operation label, e.g. 'clip', 'audio', 'keyframe'. */
  operation: string;
  /** Distinguishing detail within the operation, e.g. '90s+75s', '0007'. */
  variant?: string;
  /** Extension WITH the leading dot, e.g. '.mp4'. */
  extension: string;
}): string {
  const stem = policyOutputStem(params.inputPath);
  const variant = params.variant ? `-${params.variant}` : '';
  return `${stem}-${params.operation}${variant}${params.extension}`;
}

/** Shared structural validation for the io params (schema has already
 * checked types/required-ness). Returns an error message or null.
 * `inputPath` is checked for presence here rather than in the schema's
 * `required` list: the model-facing alternative is `resourceId`, which
 * the call gate resolves into `inputPath` BEFORE validation — so a
 * missing inputPath at this point means the caller supplied neither. */
export function validateMediaPolicyIoParams(
  params: MediaPolicyIoParams,
): string | null {
  if ((params.inputPath as string | undefined) === undefined) {
    return (
      'provide exactly one of inputPath (absolute path) or resourceId ' +
      '(opaque session media handle)'
    );
  }
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
 *
 * Input errors name only the file's basename: these messages reach the
 * model, and a resourceId-resolved call must not leak the real locator
 * the handle stands in for (M §5.2) — the basename matches the
 * displayName the model already saw at delivery. `outputDir` errors keep
 * the full path (the caller chose it).
 */
export async function assertMediaPolicyIo(
  params: MediaPolicyIoParams,
): Promise<{ inputSizeBytes: number }> {
  let inputStat;
  try {
    inputStat = await fs.lstat(params.inputPath);
  } catch {
    throw new Error(`input file not found: ${path.basename(params.inputPath)}`);
  }
  if (!inputStat.isFile()) {
    throw new Error(
      `input is not a regular file: ${path.basename(params.inputPath)}`,
    );
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
 * Successful policy-tool result: a model-facing summary plus the absolute
 * output path, and exactly one lossy media artifact whose
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
  const outputPath = path.join(args.outputDir, args.outputFileName);
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
    llmContent:
      `${args.title}: ${args.disclosure}\n` +
      `Output file: ${outputPath}\n` +
      'Use read_file with this absolute path to inspect the result.',
    returnDisplay: args.disclosure,
    artifacts: [artifact],
  };
}
