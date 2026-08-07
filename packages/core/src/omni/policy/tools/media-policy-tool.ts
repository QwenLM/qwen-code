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
import { BaseDeclarativeTool } from '../../../tools/tools.js';
import { ToolErrorType } from '../../../tools/tool-error.js';
import { SchemaValidator } from '../../../utils/schemaValidator.js';
import { projectMediaPolicyToolDeclaration } from '../model-access.js';
import type { OmniPolicyToolsSettings } from '../types.js';

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

/** Minimal structural view of Config used by policy tools. Optional so
 * partial/stub configs (tests, embedders) fall back to defaults. */
export interface MediaPolicyToolConfigView {
  getOmniPolicyToolsSettings?: () => OmniPolicyToolsSettings | undefined;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
 * Base class for omni media-policy tools (real DeclarativeTools — the
 * orchestrator executes them through the ordinary scheduler path, and
 * Stage B's modelAccess can open them to the model).
 *
 * `mediaPolicyDescriptor` is abstract: every subclass MUST declare its
 * descriptor — that code-level fact is what the modelAccess gate and the
 * orchestrator key off.
 */
export abstract class BaseMediaPolicyTool<
  TParams extends object,
> extends BaseDeclarativeTool<TParams, ToolResult> {
  constructor(
    name: string,
    displayName: string,
    description: string,
    kind: Kind,
    parameterSchema: unknown,
    /** Config view feeding the modelAccess declaration projection; tools
     * constructed without one (tests, embedders) declare their native
     * schema unchanged. */
    private readonly modelAccessView: MediaPolicyToolConfigView = {},
  ) {
    super(name, displayName, description, kind, parameterSchema);
  }

  abstract override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor;

  /**
   * Model-visible declaration (decision D6): the single projection point
   * every declaration surface reads — the native schema minus
   * `modelAccess.lockedArguments` keys, narrowed to
   * `modelAccess.parameterSchema` when configured, with the optional
   * description override applied. Validation deliberately does NOT use
   * this projection (see {@link validateToolParams}).
   */
  override get schema(): FunctionDeclaration {
    return projectMediaPolicyToolDeclaration(this.modelAccessView, {
      name: this.name,
      description: this.description,
      parametersJsonSchema: this.parameterSchema,
    });
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

/** Uniform error ToolResult for a failed policy-tool execution. */
export function mediaPolicyToolError(message: string): ToolResult {
  return {
    llmContent: `Error: ${message}`,
    returnDisplay: message,
    error: { message, type: ToolErrorType.EXECUTION_FAILED },
  };
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
    metadata: { omniDisclosure: args.disclosure },
  };
  return {
    llmContent: `${args.title}: ${args.disclosure}`,
    returnDisplay: args.disclosure,
    artifacts: [artifact],
  };
}
