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
import {
  AUDIO_SEGMENT_DEFAULTS,
  extractAudioSegment,
} from '../../media-extraction.js';
import {
  CONTEXT_MEDIA_WINDOW_SCHEMA_PROPERTIES,
  formatClampNote,
  formatWindowLabel,
  inlineMediaPart,
  resolveContextMediaWindow,
  validateContextMediaParams,
  withContextMediaScratchDir,
  type ContextMediaParams,
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

export const GET_AUDIO_TOOL_NAME = ToolNames.GET_AUDIO;

export type GetAudioParams = ContextMediaParams;

const DESCRIPTOR: MediaPolicyToolDescriptor = {
  kind: 'media_policy',
  inputMediaTypes: ['video', 'audio'],
  // Nothing lands on disk: the segment is delivered in the model's
  // context and the scratch directory is gone before the call returns.
  outputs: [],
};

class GetAudioInvocation extends BaseToolInvocation<
  GetAudioParams,
  ToolResult
> {
  constructor(
    params: GetAudioParams,
    private readonly timeoutMs: number,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Get audio of ${path.basename(this.params.inputPath)} over [${this.params.start}–${this.params.end}]`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      await assertMediaPolicyInput(this.params);
      const sourceName = path.basename(this.params.inputPath);
      const probe = await probeMediaMetadata(
        this.params.inputPath,
        'audio',
        signal,
      );
      // Refused before any ffmpeg runs: a silent file yields a valid,
      // silent WAV, and the model cannot tell that apart from a segment
      // where nobody happens to be speaking.
      if (probe.hasAudioStream === false) {
        return mediaPolicyToolError(`${sourceName} has no audio track`);
      }
      const durationSeconds =
        probe.durationMs !== undefined && probe.durationMs > 0
          ? probe.durationMs / 1000
          : undefined;
      const window = resolveContextMediaWindow(this.params, durationSeconds);

      const fileName = policyOutputFileName({
        inputPath: this.params.inputPath,
        operation: 'audio',
        variant: `${Math.round(window.startSec)}s+${Math.round(window.endSec - window.startSec)}s`,
        extension: '.wav',
      });
      const outcome = await withContextMediaScratchDir(
        'omni-get-audio-',
        async (scratchDir) => {
          const cut = await extractAudioSegment({
            inputPath: this.params.inputPath,
            outputPath: path.join(scratchDir, fileName),
            startSec: window.startSec,
            endSec: window.endSec,
            signal,
            timeoutMs: this.timeoutMs,
          });
          // Read the segment BEFORE the scratch directory is removed.
          return {
            ...cut,
            part: cut.segment
              ? await inlineMediaPart(
                  cut.segment.filePath,
                  'audio/wav',
                  fileName,
                )
              : undefined,
          };
        },
      );
      if (outcome.aborted) {
        return mediaPolicyToolError('audio extraction aborted');
      }
      if (!outcome.segment || !outcome.part) {
        return mediaPolicyToolError(
          ffmpegFailureMessage(
            outcome.run,
            'extracting audio from',
            this.params.inputPath,
          ),
        );
      }

      const label = formatWindowLabel(window);
      const summary =
        `Audio of ${sourceName} over [${label}], ` +
        `${AUDIO_SEGMENT_DEFAULTS.sampleRateHz / 1000}kHz mono WAV, ` +
        `${formatBytesShort(outcome.segment.bytes)}.` +
        `${formatClampNote(window)}` +
        ' The audio follows this message; its own timeline starts at 0, ' +
        `so a moment at t in it is ${label.split('–')[0]}+t in the source.`;
      return {
        llmContent: [{ text: summary }, outcome.part],
        returnDisplay: `Got audio of ${sourceName} [${label}] (${formatBytesShort(outcome.segment.bytes)})`,
      };
    } catch (error) {
      return mediaPolicyToolFailure(error);
    }
  }
}

/**
 * Pull a window of a media file's audio track straight into the model's
 * context, as the 16 kHz mono WAV the audio encoder expects.
 *
 * Refuses a source with no audio track rather than delivering silence:
 * that refusal is the answer to "is there sound here", and it costs one
 * probe instead of an encode plus an upload.
 */
export class GetAudioTool extends BaseMediaPolicyTool<GetAudioParams> {
  constructor(config: MediaPolicyToolConfigView) {
    super(
      GET_AUDIO_TOOL_NAME,
      'GetAudio',
      'Returns the audio of a time window of a video or audio file as listenable audio in this conversation. ' +
        'Use it for speech, music and sound effects. Fails if the source has no audio track.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          ...MEDIA_POLICY_INPUT_SCHEMA_PROPERTIES,
          ...CONTEXT_MEDIA_WINDOW_SCHEMA_PROPERTIES,
        },
        required: ['start', 'end'],
        additionalProperties: false,
      },
      config,
    );
  }

  override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
    return DESCRIPTOR;
  }

  protected override validateToolParamValues(
    params: GetAudioParams,
  ): string | null {
    return validateContextMediaParams(params);
  }

  protected createInvocation(
    params: GetAudioParams,
  ): ToolInvocation<GetAudioParams, ToolResult> {
    return new GetAudioInvocation(
      params,
      resolvePolicyToolTimeoutMs(this.configView, this.name),
    );
  }
}
