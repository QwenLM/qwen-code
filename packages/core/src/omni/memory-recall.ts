/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  MediaMemoryService,
  MediaMemoryRecallService,
  type MediaMemoryNextPolicyAction,
  type MediaMemoryRecallAdvisor,
} from '../services/media-memory/index.js';
import { formatResourceHandleText } from './disclosure.js';
import { resolveMediaPolicyModelAccess } from './policy/model-access.js';
import { OmniObjectStore } from './storage.js';
import type { MediaChannel } from '../services/media-memory/index.js';
import type { OmniModality } from './recognition.js';

/**
 * Session wiring for media-memory recall (M §9): both recall surfaces —
 * the active `omni_recall_media_memory` tool and the passive sideQuery
 * selector — build their service through this one module, so the advisor
 * and root-dir derivation cannot drift between them.
 */

/** First evidence-gathering step for one uncovered channel of a media
 * type. Only DIRECT steps are suggested (a video's speech_text gap
 * suggests extracting the audio track, not the audio-input transcribe
 * tool — the model chains from there). */
const GAP_STEP: ReadonlyArray<{
  mediaType: OmniModality;
  channels: readonly MediaChannel[];
  toolName: string;
  reason: string;
}> = [
  {
    mediaType: 'video',
    channels: ['visual'],
    toolName: ToolNames.OMNI_EXTRACT_KEYFRAMES,
    reason: 'no visual evidence collected yet: extract keyframes',
  },
  {
    mediaType: 'video',
    // 'acoustic' ONLY. Extracting the track covers `acoustic`, which
    // leaves `speech_text` open — so matching on speech_text too made the
    // advisor re-suggest extraction in the very payload that returns the
    // extracted audio. A wholly unprocessed video still matches (its gap
    // contains acoustic) and the model chains to transcription from there.
    channels: ['acoustic'],
    toolName: ToolNames.OMNI_EXTRACT_AUDIO,
    reason: 'no audio-track evidence collected yet: extract the audio track',
  },
  {
    mediaType: 'audio',
    channels: ['speech_text'],
    toolName: ToolNames.OMNI_TRANSCRIBE_AUDIO,
    reason: 'no transcript collected yet: transcribe the audio',
  },
];

/**
 * Advisor mapping recall gaps to `nextPolicyActions` (M §9.4): only tools
 * that are BOTH registered in this session and opened to the model via
 * `modelAccess.enabled` are ever suggested — recall must not steer the
 * model into calls the media-policy gate would reject.
 */
export function buildMediaMemoryRecallAdvisor(
  config: Config,
): MediaMemoryRecallAdvisor {
  const callable = (toolName: string): boolean =>
    config.getToolRegistry().getTool(toolName) !== undefined &&
    resolveMediaPolicyModelAccess(config, toolName).enabled;

  return ({ resourceId, mediaType, gap }) => {
    // Nothing can be gathered from a file that is gone.
    if (gap.reason === 'artifact_unavailable') return [];
    // `partial_coverage` means sampled evidence already exists, and by
    // design it stays sampled: keyframes deliberately never report
    // complete visual coverage. Suggesting the step that produced it would
    // advise work that CANNOT close the gap, forever.
    if (gap.reason === 'partial_coverage') return [];
    const actions: MediaMemoryNextPolicyAction[] = [];
    for (const step of GAP_STEP) {
      if (step.mediaType !== mediaType) continue;
      if (!gap.channels.some((c) => step.channels.includes(c))) continue;
      if (!callable(step.toolName)) continue;
      actions.push({
        toolName: step.toolName,
        resourceId,
        arguments: {},
        reason: step.reason,
      });
    }
    return actions;
  };
}

/**
 * Build the session recall service, or undefined when media memory is not
 * configured on this Config (omni off, initialize skipped, stub configs).
 */
export function createMediaMemoryRecallService(
  config: Config,
): MediaMemoryRecallService | undefined {
  const memoryConfig = config.getOmniMemoryConfig?.();
  if (!memoryConfig) return undefined;
  const omniRootDir = new OmniObjectStore(
    config.storage.getQwenDir(),
  ).getOmniRootDir();
  return new MediaMemoryRecallService(
    omniRootDir,
    memoryConfig.recall,
    config.getOmniMediaResourceRegistry(),
    { advise: buildMediaMemoryRecallAdvisor(config) },
  );
}

/**
 * Re-anchor a remembered file into this session (design M §9.2.1).
 *
 * A handle is only minted at delivery, and delivery needs the bytes — so a
 * file memory knows about but that is gone from disk had no way back into
 * a session, and its transcripts and keyframes were stranded. The same
 * friction hits an audit that does not want to re-deliver a 2.4 GB film
 * just to ask what work was recorded: without a handle, recall rejects
 * everything, and the natural next move (passing the filename as a
 * resourceId) is correctly refused.
 *
 * The user's own `@`-reference is the authorization here — the same
 * authorization a normal delivery carries — so this mints a handle from
 * the RECORDED identity without needing the bytes. Returns undefined when
 * memory is off or has never seen this locator.
 */
export function reanchorRememberedMedia(
  config: Config,
  absolutePath: string,
): Promise<{ resourceId: string; annotation: string } | undefined> {
  const memoryConfig = config.getOmniMemoryConfig?.();
  if (!memoryConfig) return Promise.resolve(undefined);
  const registry = config.getOmniMediaResourceRegistry?.();
  if (!registry) return Promise.resolve(undefined);
  const store = new OmniObjectStore(config.storage.getQwenDir());
  return new MediaMemoryService(store.getOmniRootDir())
    .findBindingByFileRef(absolutePath)
    .then((found) => {
      if (!found) return undefined;
      const { resourceId } = registry.bind({
        ...found.binding,
        fileRef: absolutePath,
        mediaType: found.mediaType,
      });
      return {
        resourceId,
        annotation: formatResourceHandleText(
          path.basename(absolutePath),
          resourceId,
        ),
      };
    });
}
