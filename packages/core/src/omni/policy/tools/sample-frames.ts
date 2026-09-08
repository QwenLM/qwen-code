/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Part } from '@google/genai';
import type {
  MediaPolicyToolDescriptor,
  ToolInvocation,
  ToolResult,
} from '../../../tools/tools.js';
import { BaseToolInvocation, Kind } from '../../../tools/tools.js';
import { ToolNames } from '../../../tools/tool-names.js';
import { formatKeyframeTimestampLabel } from '../../disclosure.js';
import { probeMediaMetadata } from '../../ffmpeg.js';
import {
  formatClockLabel,
  parseResolution,
  sampleFramesUniform,
  scaleFilter,
} from '../../media-extraction.js';
import {
  CONTEXT_MEDIA_VISUAL_SCHEMA_PROPERTIES,
  CONTEXT_MEDIA_WINDOW_SCHEMA_PROPERTIES,
  DEFAULT_CONTEXT_MEDIA_TIER,
  MAX_CONTEXT_MEDIA_FRAMES,
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
  createPolicyToolTimeoutBudget,
  MEDIA_POLICY_INPUT_SCHEMA_PROPERTIES,
  mediaPolicyToolError,
  mediaPolicyToolFailure,
  policyOutputFileName,
  resolvePolicyToolTimeoutMs,
  type MediaPolicyToolConfigView,
} from './media-policy-tool.js';

export const SAMPLE_FRAMES_TOOL_NAME = ToolNames.SAMPLE_FRAMES;

export type SampleFramesParams = ContextMediaVisualParams;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  inputMediaTypes: ['video'],
  // Nothing lands on disk: the frames are delivered in the model's
  // context and the scratch directory is gone before the call returns.
  outputs: [],
};

class SampleFramesInvocation extends BaseToolInvocation<
  SampleFramesParams,
  ToolResult
> {
  constructor(
    params: SampleFramesParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Sample frames from ${path.basename(this.params.inputPath)} over [${this.params.start}–${this.params.end}] at ${this.params.fps}fps`;
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
      // The probe is passed in because the tier names are token budgets:
      // spending one costs area, so the long edge that buys it depends on
      // the source's aspect ratio.
      const maxDimension = parseResolution(
        this.params.resolution ?? DEFAULT_CONTEXT_MEDIA_TIER,
        probe,
      );
      const remainingTimeoutMs = createPolicyToolTimeoutBudget(this.timeoutMs);

      const sourceName = path.basename(this.params.inputPath);
      const result = await withContextMediaScratchDir(
        'omni-sample-frames-',
        async (scratchDir) => {
          const sampled = await sampleFramesUniform({
            inputPath: this.params.inputPath,
            outputDir: scratchDir,
            windowStartSec: window.startSec,
            windowEndSec: window.endSec,
            fps: this.params.fps,
            maxFrames: MAX_CONTEXT_MEDIA_FRAMES,
            scaleVf: scaleFilter(maxDimension),
            fileNameFor: (index) =>
              policyOutputFileName({
                inputPath: this.params.inputPath,
                operation: 'frame',
                variant: String(index).padStart(4, '0'),
                extension: '.jpg',
              }),
            remainingTimeoutMs,
            signal,
          });
          // Read every frame BEFORE the scratch directory is removed. Each
          // frame is preceded by its own timestamp label, which the tool-result
          // path keeps adjacent all the way into the request body — so the
          // model reads time and picture together instead of joining a list
          // against a position.
          const parts: Part[] = [];
          for (const frame of sampled.frames) {
            parts.push({
              text: formatKeyframeTimestampLabel(
                formatClockLabel(frame.timeSeconds, window.withHours),
              ),
            });
            parts.push(
              await inlineMediaPart(
                frame.filePath,
                'image/jpeg',
                frame.fileName,
              ),
            );
          }
          return { sampled, parts };
        },
      );
      const { sampled, parts } = result;
      if (sampled.aborted) {
        return mediaPolicyToolError('frame sampling aborted');
      }
      if (sampled.frames.length === 0) {
        return mediaPolicyToolError(
          `no frames could be sampled from ${sourceName} over [${formatWindowLabel(window)}]: ${
            sampled.failures[0]?.reason ?? 'unknown reason'
          }`,
        );
      }

      const delivered = formatDeliveredDimensions(
        probe.width,
        probe.height,
        maxDimension,
      );
      const failureNote =
        sampled.failures.length === 0
          ? ''
          : ` ${sampled.failures.length} of ${sampled.requested} frames failed and were not delivered: ` +
            sampled.failures
              .map(
                (failure) =>
                  `${formatClockLabel(failure.timeSeconds, window.withHours)} (${failure.reason})`,
              )
              .join(', ') +
            '.';
      const summary =
        `Sampled ${sampled.frames.length} frame(s) of ${sourceName} over [${formatWindowLabel(window)}] at ${this.params.fps}fps` +
        `${delivered ? `, delivered at ${delivered}` : ''}.` +
        `${formatClampNote(window)}${failureNote}` +
        ' Each frame is tagged with its own <timestamp> just before it.' +
        ' They are stills: motion and sound between them are not shown.';
      return {
        llmContent: [{ text: summary }, ...parts],
        returnDisplay: `Sampled ${sampled.frames.length}/${sampled.requested} frame(s) from ${sourceName} [${formatWindowLabel(window)}]`,
      };
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * Sample frames out of a video window straight into the model's context.
 *
 * The file-writing sibling (omni_extract_keyframes) leaves JPEGs in an
 * output directory and asks the model to read them back; this one hands
 * the frames over as media parts in its own result, so a window can be
 * inspected in one call.
 */
export class SampleFramesTool extends BaseMediaPolicyTool<SampleFramesParams> {
  constructor(config: MediaPolicyToolConfigView) {
    super(
      SAMPLE_FRAMES_TOOL_NAME,
      'SampleFrames',
      'Samples frames from a time window of a video and returns them as images in this conversation, ' +
        'evenly spaced at the requested frame rate. Use it to see what happens inside a span you can name.',
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
    params: SampleFramesParams,
  ): string | null {
    return validateContextMediaParams(params);
  }

  protected createInvocation(
    params: SampleFramesParams,
  ): ToolInvocation<SampleFramesParams, ToolResult> {
    return new SampleFramesInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
