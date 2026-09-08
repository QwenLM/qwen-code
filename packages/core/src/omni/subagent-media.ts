/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import type { ToolResult } from '../tools/tools.js';
import { ToolNames } from '../tools/tool-names.js';
import { isMediaSubagentType } from '../subagents/builtin-agents.js';
import { resolveMediaPolicyModelAccess } from './policy/model-access.js';
import { processToolResultOmniMedia } from './tool-result-media.js';

/**
 * Seeds media into a media subagent's first turn.
 *
 * The parent extracts and uploads BEFORE the child is spawned rather than
 * letting the child call the tool itself: one round trip less, a child
 * that cannot forget to fetch its own subject, and a malformed window
 * costs a validation error instead of a whole wasted sub-session.
 */

export interface MediaSubagentRequest {
  /** One of the three media subagent types (same names as the tools). */
  subagentType: string;
  inputPath: string;
  start: string;
  end: string;
  fps?: number;
  resolution?: string;
}

function requireFps(request: MediaSubagentRequest): number {
  if (typeof request.fps !== 'number') {
    throw new Error(`${request.subagentType} requires fps`);
  }
  return request.fps;
}

/**
 * The extraction below IS a call of the tool of the same name, made
 * in-process — so it goes through the same `modelAccess.enabled` switch
 * rather than around it. A type that is not one of the three falls through
 * to the switch's own error.
 */
function assertModelAccessEnabled(subagentType: string, config: Config): void {
  const type = subagentType.toLowerCase();
  if (!isMediaSubagentType(type)) return;
  if (resolveMediaPolicyModelAccess(config, type).enabled) return;
  throw new Error(
    `${subagentType} is reserved for fixed-policy orchestration; seeding it ` +
      `requires "omni.processing.policyTools.${type}.modelAccess.enabled": true`,
  );
}

/**
 * Run the matching tool in-process. Its `build` validates the window and
 * the resolution, so a bad argument throws here — before a child exists.
 */
async function runExtraction(
  request: MediaSubagentRequest,
  config: Config,
  signal: AbortSignal,
): Promise<ToolResult> {
  const { inputPath, start, end, resolution } = request;
  assertModelAccessEnabled(request.subagentType, config);
  switch (request.subagentType) {
    case ToolNames.SAMPLE_FRAMES: {
      const { SampleFramesTool } = await import(
        './policy/tools/sample-frames.js'
      );
      return new SampleFramesTool(config)
        .build({ inputPath, start, end, fps: requireFps(request), resolution })
        .execute(signal);
    }
    case ToolNames.GET_CLIP: {
      const { GetClipTool } = await import('./policy/tools/get-clip.js');
      return new GetClipTool(config)
        .build({ inputPath, start, end, fps: requireFps(request), resolution })
        .execute(signal);
    }
    case ToolNames.GET_AUDIO: {
      const { GetAudioTool } = await import('./policy/tools/get-audio.js');
      return new GetAudioTool(config)
        .build({ inputPath, start, end })
        .execute(signal);
    }
    default:
      throw new Error(
        `${request.subagentType} is not a media subagent type and cannot be seeded with media`,
      );
  }
}

/**
 * Extract the requested window and return the Parts to append to the
 * child's first user message: one summary followed by the uploaded media,
 * each frame still preceded by its own timestamp label.
 *
 * Throws rather than degrade. An empty-handed media subagent would answer
 * from the prompt alone and read like a real analysis.
 */
export async function buildMediaSubagentSeed(
  request: MediaSubagentRequest,
  config: Config,
  signal: AbortSignal,
): Promise<Part[]> {
  const result = await runExtraction(request, config, signal);
  if (result.error) {
    throw new Error(result.error.message);
  }
  // Uploading through the tool-result funnel instead of a second copy of
  // it: same recognize → guard → store → upload path, same per-tool upload
  // budget (keyed on this very name), same withhold-rather-than-inline
  // verdict. A seed is a user message, so nothing invokes the funnel for
  // us — the funnel shape here is what selects the budget.
  const converted = await processToolResultOmniMedia(
    [
      {
        functionResponse: {
          id: `seed_${request.subagentType}`,
          name: request.subagentType,
          response: { output: '' },
          parts: result.llmContent as Part[],
        },
      } as Part,
    ],
    config,
    signal,
  );
  const parts = (converted[0]?.functionResponse?.parts ?? []) as Part[];
  if (parts.length === 0 || parts.some((part) => part.inlineData)) {
    throw new Error(
      `${request.subagentType} media was extracted but not uploaded — the media subagent types require omni media delivery to be enabled for this modality`,
    );
  }
  // The summary only names the basename; the child needs the absolute path to
  // extract a second window with the tool in its own allowlist.
  return [
    { text: `The media below was extracted from ${request.inputPath}.` },
    ...parts,
  ];
}
