/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Progressive media understanding guidance (system-prompt layer).
 *
 * The delivery pipeline degrades media to fit transport/context limits and
 * discloses each transformation next to the media Part (decision D8). The
 * disclosures state WHAT was done; this module supplies the missing WHY
 * and the follow-up contract: degradation is a context-budget-driven
 * progressive-understanding strategy, the degraded delivery is an
 * overview/entry point rather than the complete content, and the model
 * should proactively fetch higher-fidelity / more complete evidence with
 * the media policy tools when the task needs it.
 *
 * Injected once per session as a STABLE system-prompt layer (see
 * client.ts getMainSessionSystemInstruction): the disclosure texts arrive
 * mid-conversation at unpredictable points, so per-delivery preambles
 * would repeat across three assembly sites (atCommandProcessor,
 * fileUtils, tool-result-media) and would still miss the reactive
 * server-reject swaps; one durable contract in the prompt covers all of
 * them. Kept as a leaf module (no pipeline imports) so prompt assembly
 * stays lightweight.
 */

import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { isOmniDeliveryActive } from './delivery-gate.js';
import { resolveMediaPolicyModelAccess } from './policy/model-access.js';
import {
  OMNI_DISCLOSURE_TEXT_PREFIX,
  OMNI_RESOURCE_HANDLE_TEXT_PREFIX,
  OMNI_OMISSION_TEXT_PREFIX,
  OMNI_TRANSCRIPT_TEXT_PREFIX,
} from './disclosure.js';

/** One-line capability summaries for the model-callable media tools.
 * Deliberately terse: the full parameter schema ships with the tool
 * declaration; this list only tells the model WHEN to reach for each. */
const MEDIA_TOOL_CAPABILITIES: ReadonlyArray<[string, string]> = [
  [
    ToolNames.OMNI_CLIP_VIDEO,
    'cut a specific time range out of a video (startSec/durationSec) — the primary way to inspect parts of a long video that were not delivered',
  ],
  [
    ToolNames.OMNI_UNDERSTAND_VIDEO_SEGMENTS,
    'understand a long video end to end: fixed-length segments described in parallel by an omni model, assembled into a time-labeled text summary',
  ],
  [
    ToolNames.OMNI_EXTRACT_KEYFRAMES,
    'extract still frames from a video (clip a range first to sample frames from a specific segment)',
  ],
  [
    ToolNames.OMNI_DOWNSCALE_VIDEO,
    're-encode a video at lower resolution / frame rate to fit transport limits',
  ],
  [
    ToolNames.OMNI_EXTRACT_AUDIO,
    'extract the audio track from a video for listening or transcription',
  ],
  [
    ToolNames.OMNI_TRANSCRIBE_AUDIO,
    'transcribe speech in an audio file to text',
  ],
  [
    ToolNames.OMNI_CAPTION_AUDIO,
    'describe an audio file semantically (speech gist, timbre, sound events, mood) — understanding, not verbatim transcription',
  ],
  [
    ToolNames.OMNI_CLIP_AUDIO,
    'cut a specific time range out of an audio file (startMs/durationMs)',
  ],
  [
    ToolNames.OMNI_DOWNSAMPLE_AUDIO,
    're-encode audio at a lower bitrate/sample rate',
  ],
  [ToolNames.OMNI_DOWNSAMPLE_IMAGE, 'shrink an image to a smaller resolution'],
  [ToolNames.OMNI_CONVERT_IMAGE, 'convert an image to another format'],
  [
    ToolNames.OMNI_CLIP_IMAGE,
    'crop a pixel rectangle (x/y/width/height) out of an image',
  ],
  [
    ToolNames.OMNI_CAPTION_IMAGE,
    'describe an image with a VL model under a custom prompt, turning visual content into text',
  ],
  [
    ToolNames.OMNI_OCR_IMAGE,
    'extract the text visible in an image (OCR), with automatic language detection',
  ],
];

/**
 * Model-facing descriptions of the configured fixed policies, in the order
 * they run (priority desc, id asc — the orchestrator's own ordering), each
 * a single bullet. A policy contributes only when its config carries a
 * `description`; policies without one stay silent. Empty when no policy is
 * described, so the guidance section omits the block entirely.
 *
 * This lets the active preprocessing contract (e.g. the token threshold
 * below which a video is delivered un-degraded, and how to stay under it)
 * be authored right next to the policy in settings — like a tool
 * description — and flow into the prompt automatically, rather than being
 * restated in this module.
 */
function collectPolicyDescriptions(config: Config): string[] {
  const policies = config.getOmniProcessingConfig?.()?.fixedPolicies;
  if (!policies) return [];
  return [...policies]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .map((p) => p.description)
    .filter((d): d is string => typeof d === 'string' && d.length > 0);
}

/**
 * Build the progressive media understanding section for the system
 * prompt, or `null` when omni delivery is inactive (no disclosures will
 * ever reach the model, so the contract would be noise).
 *
 * The tool list only names tools whose
 * `omni.processing.policyTools.<name>.modelAccess.enabled` is true —
 * directing the model at tools the scheduler would reject teaches it a
 * dead end. With no tools enabled, the section instead instructs the
 * model to state what evidence is missing rather than extrapolate.
 */
export function buildOmniMediaGuidanceSection(config: Config): string | null {
  if (!isOmniDeliveryActive(config)) return null;

  const enabledTools = MEDIA_TOOL_CAPABILITIES.filter(
    ([name]) => resolveMediaPolicyModelAccess(config, name).enabled,
  );

  // Active-mode recall guidance. The handle annotation is emitted with
  // every memory-known delivery, but the tool that consumes it is deferred
  // (it surfaces via ToolSearch), so without this the model can receive
  // 【媒体资源】 markers with no explanation anywhere in context — and the
  // rest of this section actively tells it to gather evidence with the
  // policy tools, i.e. to reprocess from scratch what memory already holds.
  // Only stated when recall.mode is 'active': in sideQuery mode the harness
  // injects recalled memory itself and the model must not call the tool.
  const recallGuidance =
    config.getOmniMemoryConfig?.()?.recall.mode === 'active'
      ? `
- ${OMNI_RESOURCE_HANDLE_TEXT_PREFIX}<file>: an opaque session handle for that media. It is the ONLY identity you can use to reference the file — you will never be given its real path.
- BEFORE reprocessing media (extracting frames, transcribing, clipping), call \`${ToolNames.OMNI_RECALL_MEDIA_MEMORY}\` with that handle: earlier sessions may already have produced the transcript, keyframes or excerpt you need, and it returns instantly. It also reports honest gaps — which channels were never processed — and can suggest which tool closes them.
- Handles also work as the \`resourceId\` argument of the media tools below, in place of a path.`
      : '';

  // Active preprocessing contract, authored per policy in settings and
  // collected here (like tool descriptions): each configured policy that
  // carries a `description` explains what it does / when it triggers, so
  // the model can work with the pipeline (e.g. shrink a clip under the
  // native-delivery token threshold) instead of guessing at it.
  const policyDescriptions = collectPolicyDescriptions(config);
  const policyGuidance =
    policyDescriptions.length > 0
      ? `

The media reaching you is shaped by these automatic preprocessing policies (they run in this order):
${policyDescriptions.map((d) => `- ${d}`).join('\n')}`
      : '';

  const toolGuidance =
    enabledTools.length > 0
      ? `- When the task needs evidence beyond what was delivered — later time ranges, finer visual detail, more frames, a fuller transcript — do not stop at the delivered subset: fetch the evidence yourself with the media tools below, then read the produced file(s) to bring them into context. Work in targeted excerpts (a specific time range or region at a time) so each request stays within limits, and iterate until you have seen enough to complete the task.
- Available media tools:
${enabledTools.map(([name, capability]) => `  - ${name}: ${capability}`).join('\n')}`
      : `- No media tools are enabled in this session. When the delivered evidence does not cover what the task needs, say explicitly which part of the media you could not observe instead of extrapolating from the delivered subset.`;

  return `# Media Delivery (Progressive Understanding)

Media files in this session reach you through a preprocessing pipeline that must fit them into transport and context-window limits. Large or long media is therefore delivered in reduced form on purpose: this is a progressive-understanding strategy — you first get an affordable overview, then fetch the specific higher-fidelity evidence the task needs. Every transformation is disclosed in a text part placed immediately BEFORE the media it describes:

- ${OMNI_DISCLOSURE_TEXT_PREFIX}<file>: the adjacent media is a degraded derivative (clipped, downscaled, resampled, or keyframes); the marker states exactly what was reduced.
- ${OMNI_OMISSION_TEXT_PREFIX}<file>: the media could not be delivered at all; the notice stands in its place.
- ${OMNI_TRANSCRIPT_TEXT_PREFIX}<file>: text derived from the media (e.g. a speech transcript), possibly delivered instead of the media itself.

${recallGuidance}

Interpret delivered media under this contract:

- A degraded delivery is an OVERVIEW or entry point, not the complete content. The original file on disk is untouched and remains fully available for further processing.
- Never conclude that content outside the delivered portion does not exist, and never present conclusions drawn from a partial delivery as covering the whole file. Read each disclosure quantitatively: a clip marker covering [0s–600s] of a 4882s video means 4282s exist that you have NOT seen; a keyframe marker tells you which timestamps you actually saw.${policyGuidance}
${toolGuidance}`;
}
