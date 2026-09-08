/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type {
  MediaPolicyToolDescriptor,
  ToolInvocation,
  ToolResult,
} from '../../../tools/tools.js';
import { BaseToolInvocation, Kind } from '../../../tools/tools.js';
import { ToolNames } from '../../../tools/tool-names.js';
import { probeMediaMetadata } from '../../ffmpeg.js';
import { extractClipSegment, parseResolution } from '../../media-extraction.js';
import {
  CONTEXT_MEDIA_VISUAL_SCHEMA_PROPERTIES,
  CONTEXT_MEDIA_WINDOW_SCHEMA_PROPERTIES,
  DEFAULT_CONTEXT_MEDIA_TIER,
  formatClampNote,
  formatDeliveredDimensions,
  formatWindowLabel,
  inlineMediaPart,
  resolveContextMediaWindow,
  validateContextMediaParams,
  withContextMediaScratchDir,
  type ContextMediaVisualParams,
} from './context-media-tool.js';
import {
  assertMediaPolicyInput,
  BaseMediaPolicyTool,
  ffmpegFailureMessage,
  formatBytesShort,
  MEDIA_POLICY_INPUT_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  policyOutputFileName,
  resolvePolicyToolTimeoutMs,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';

export const GET_CLIP_TOOL_NAME = ToolNames.GET_CLIP;

export type GetClipParams = ContextMediaVisualParams;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  inputMediaTypes: ['video'],
  // Nothing lands on disk: the clip is delivered in the model's context
  // and the scratch directory is gone before the call returns.
  outputs: [],
};

class GetClipInvocation extends BaseToolInvocation<GetClipParams, ToolResult> {
  constructor(
    params: GetClipParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Clip ${path.basename(this.params.inputPath)} over [${this.params.start}–${this.params.end}] at ${this.params.fps}fps`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      await assertMediaPolicyInput(this.params);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'video',
        signal,
      );
      const durationSeconds =
        probe.durationMs !== undefined && probe.durationMs > 0
          ? probe.durationMs / 1000
          : undefined;
      const window = resolveContextMediaWindow(this.params, durationSeconds);
      // Tier names are per-frame token budgets, and a budget buys area —
      // so the long edge it converts to needs the source's aspect ratio.
      const maxDimension = parseResolution(
        this.params.resolution ?? DEFAULT_CONTEXT_MEDIA_TIER,
        probe,
      );

      const sourceName = path.basename(this.params.inputPath);
      const fileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: 'clip',
        variant: `${Math.round(window.startSec)}s+${Math.round(window.endSec - window.startSec)}s`,
        extension: '.mp4',
      });
      const outcome = await withContextMediaScratchDir(
        'omni-get-clip-',
        async (scratchDir) => {
          const cut = await extractClipSegment({
            inputPath: this.params.inputPath,
            outputPath: path.join(scratchDir, fileName),
            startSec: window.startSec,
            endSec: window.endSec,
            fps: this.params.fps,
            maxDimension,
            signal,
            timeoutMs: this.timeoutMs,
          });
          // Read the clip BEFORE the scratch directory is removed.
          return {
            ...cut,
            part: cut.segment
              ? await inlineMediaPart(
                  cut.segment.filePath,
                  'video/mp4',
                  fileName,
                )
              : undefined,
          };
        },
      );
      if (outcome.aborted) {
        return mediaPolicyToolError('clip extraction aborted');
      }
      if (!outcome.segment || !outcome.part) {
        return mediaPolicyToolError(
          ffmpegFailureMessage(outcome.run, 'clipping', this.params.inputPath),
        );
      }

      const delivered = formatDeliveredDimensions(
        probe.width,
        probe.height,
        maxDimension,
      );
      const label = formatWindowLabel(window);
      const summary =
        `Clip of ${sourceName} over [${label}] with its audio track, ` +
        `at ${this.params.fps}fps${delivered ? `, ${delivered}` : ''}, ` +
        `${formatBytesShort(outcome.segment.bytes)}.` +
        `${formatClampNote(window)}` +
        ' The clip follows this message; its own timeline starts at 0, ' +
        `so a moment at t in the clip is ${label.split('–')[0]}+t in the source.`;
      return {
        llmContent: [{ text: summary }, outcome.part],
        returnDisplay: `Clipped ${sourceName} [${label}] (${formatBytesShort(outcome.segment.bytes)})`,
      };
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * Cut a window out of a video — audio track intact — straight into the
 * model's context.
 *
 * Frames answer "what is there"; a clip answers "how does it move and
 * what does it sound like at the same time". That synchrony is the whole
 * point: sampling frames and pulling audio separately delivers the same
 * span with the correspondence between them lost.
 */
export class GetClipTool extends BaseMediaPolicyTool<GetClipParams> {
  constructor(config: MediaPolicyToolConfigView) {
    super(
      GET_CLIP_TOOL_NAME,
      'GetClip',
      'Cuts a time window out of a video, audio included, and returns it as a video in this conversation. ' +
        'Use it when picture and sound have to line up; sample_frames is cheaper when stills are enough.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          ...MEDIA_POLICY_INPUT_SCHEMA_PROPERTIES,
          ...CONTEXT_MEDIA_WINDOW_SCHEMA_PROPERTIES,
          ...CONTEXT_MEDIA_VISUAL_SCHEMA_PROPERTIES,
        },
        required: ['start', 'end', 'fps'],
        additionalProperties: false,
      },
      config,
    );
  }

  override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
    return DESCRIPTOR;
  }

  protected override validateToolParamValues(
    params: GetClipParams,
  ): string | null {
    return validateContextMediaParams(params);
  }

  protected createInvocation(
    params: GetClipParams,
  ): ToolInvocation<GetClipParams, ToolResult> {
    return new GetClipInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
