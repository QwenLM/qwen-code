/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part, PartUnion } from '@google/genai';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { runSideQuery } from '../utils/sideQuery.js';
import {
  MediaMemoryRecallRejection,
  type MediaMemoryCandidateSummary,
  type MediaMemoryRecallResult,
} from '../services/media-memory/index.js';
import {
  parseResourceHandleText,
  parseResourcePathText,
} from './disclosure.js';
import { createMediaMemoryRecallService } from './memory-recall.js';

const debugLogger = createDebugLogger('omni:memory');

/**
 * Passive sideQuery recall (memory design M §9.3, D10 sideQuery mode):
 * before the main model request is sent, a bounded selector model reads a
 * candidate manifest of what memory knows about the media the CURRENT
 * request explicitly references, picks the relevant entryIds, and the
 * harness materializes exactly those through the unified recall protocol.
 *
 * Constitutional bounds, enforced here and in the recall service:
 * - only resources the request explicitly carries (parsed from the
 *   【媒体资源】 handle annotations) are consulted — never a project-wide
 *   scan;
 * - the selector sees summaries (no raw media, full text, paths, or
 *   secrets) and may ONLY return manifest entryIds — an unknown id,
 *   cross-root id, or over-budget selection rejects the WHOLE selection;
 * - any failure (timeout, selector error, rejection) degrades to an empty
 *   recall with a recorded reason; the main request always proceeds.
 */

/** Outcome of one passive recall attempt (the selector ran or was
 * legitimately skipped after handles were found). */
export interface OmniMemorySideQueryOutcome {
  /** Materialized recall to inject, or null when there is nothing. */
  result: MediaMemoryRecallResult | null;
  /** Recorded reason when `result` is null (M §17: 超时/非法 → 空召回 +
   * 记录原因). */
  reason?: string;
  /** Session handles the selector consulted. */
  resourceIds: string[];
}

/** JSON face the selector must answer with: entryIds only (M §9.3 — no
 * free text, no new conclusions). */
const SELECTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    entryIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'entryIds chosen from the candidate manifest.',
    },
  },
  required: ['entryIds'],
  additionalProperties: false,
};

/** Bound on the request text handed to the selector for relevance. */
const MAX_SELECTOR_REQUEST_CHARS = 4000;

/** Extract the session resource handles a request explicitly carries:
 * every 【媒体资源】 annotation part whose handle this session's registry
 * actually issued (M §9.3 — passive recall never guesses beyond what the
 * request references). Deduplicated, in first-appearance order. */
export function extractRequestResourceIds(
  config: Config,
  parts: readonly PartUnion[],
): string[] {
  const registry = config.getOmniMediaResourceRegistry?.();
  if (!registry) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const text =
      typeof part === 'string'
        ? part
        : typeof part === 'object' && part !== null && 'text' in part
          ? (part as { text?: string }).text
          : undefined;
    if (!text) continue;
    // Annotations may be embedded per-line inside a larger flattened part.
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      // The handle form (path-less media) names the resourceId directly. The
      // path form (model-visible local media) names the absolute path, which
      // the registry maps back to the SAME session handle it issued for that
      // file (resolveByFileRef) — so passive recall keys on both forms.
      let resourceId = parseResourceHandleText(trimmed);
      if (!resourceId) {
        const filePath = parseResourcePathText(trimmed);
        resourceId = filePath
          ? registry.resolveByFileRef(filePath)?.resourceId
          : undefined;
      }
      if (!resourceId || seen.has(resourceId)) continue;
      if (!registry.resolve(resourceId)) continue;
      seen.add(resourceId);
      found.push(resourceId);
    }
  }
  return found;
}

/** Strip every `<system-reminder>…</system-reminder>` block from a text
 * part. Harness reminders are not the user's question, but they can be
 * PREPENDED INTO the user's own text part (IDE context does exactly that,
 * before the passive-recall pass runs) — dropping the whole part on a
 * leading tag would hide the question from the selector entirely. */
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}

/** Plain request text (system reminders removed, bounded) — the selector's
 * only view of what the user is asking. */
function selectorRequestText(parts: readonly PartUnion[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    const text =
      typeof part === 'string'
        ? part
        : typeof part === 'object' && part !== null && 'text' in part
          ? (part as { text?: string }).text
          : undefined;
    if (!text) continue;
    const stripped = stripSystemReminders(text).trim();
    if (stripped) texts.push(stripped);
  }
  let joined = texts.join('\n');
  if (joined.length > MAX_SELECTOR_REQUEST_CHARS) {
    joined = joined.slice(0, MAX_SELECTOR_REQUEST_CHARS);
  }
  return joined;
}

/**
 * Run the passive selector for one outgoing request. Returns null when
 * the passive path does not apply at all (memory off, mode !== sideQuery,
 * or the request references no session media); otherwise an outcome whose
 * `result` is the recall to inject (or null with a recorded reason).
 *
 * Latency is bounded by `sideQuery.timeoutMs` — the caller awaits this
 * BEFORE sending the main request (M §9.3: 选中结果必须在主请求发送前注入).
 */
export async function runOmniMemorySideQuery(params: {
  config: Config;
  requestParts: readonly PartUnion[];
  promptId?: string;
  signal?: AbortSignal;
}): Promise<OmniMemorySideQueryOutcome | null> {
  const { config } = params;
  const memoryConfig = config.getOmniMemoryConfig?.();
  if (!memoryConfig || memoryConfig.recall.mode !== 'sideQuery') return null;
  const resourceIds = extractRequestResourceIds(config, params.requestParts);
  if (resourceIds.length === 0) return null;
  const service = createMediaMemoryRecallService(config);
  if (!service) return null;
  const sideQuery = memoryConfig.recall.sideQuery;

  let manifest: MediaMemoryCandidateSummary[];
  try {
    manifest = await service.candidateSummaries(resourceIds);
  } catch (err) {
    const reason = `manifest_failed: ${err instanceof Error ? err.message : err}`;
    debugLogger.debug(`omni sideQuery recall degraded: ${reason}`);
    return { result: null, reason, resourceIds };
  }
  if (manifest.length === 0) {
    return { result: null, reason: 'no_candidates', resourceIds };
  }

  const manifestIds = new Set(manifest.map((c) => c.entryId));
  const timeoutSignal = AbortSignal.timeout(sideQuery.timeoutMs);
  const abortSignal = params.signal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : timeoutSignal;

  const contents: Content[] = [
    {
      role: 'user',
      parts: [
        {
          text: JSON.stringify(
            {
              request: selectorRequestText(params.requestParts),
              candidates: manifest,
            },
            null,
            1,
          ),
        } as Part,
      ],
    },
  ];

  let selection: { entryIds: string[] };
  try {
    selection = await runSideQuery<{ entryIds: string[] }>(config, {
      contents,
      schema: SELECTION_SCHEMA,
      abortSignal,
      ...(sideQuery.model !== null ? { model: sideQuery.model } : {}),
      systemInstruction:
        'You select which persisted media-memory entries are relevant to ' +
        'the current request. Input: {request, candidates}. Return ONLY ' +
        `{"entryIds": [...]}: at most ${sideQuery.maxSelectedEntries} ids, ` +
        'each copied verbatim from the candidates. Return an empty array ' +
        'when nothing is relevant. Never invent ids, never add other keys.',
      ...(params.promptId !== undefined ? { promptId: params.promptId } : {}),
      purpose: 'omni-memory-sidequery-selector',
      maxAttempts: sideQuery.maxAttempts,
      skipOutputLanguagePreference: true,
      validate: (response) => {
        if (!Array.isArray(response.entryIds))
          return 'entryIds must be an array';
        if (response.entryIds.length > sideQuery.maxSelectedEntries) {
          return `at most ${sideQuery.maxSelectedEntries} entryIds`;
        }
        const unknown = response.entryIds.find(
          (id) => typeof id !== 'string' || !manifestIds.has(id),
        );
        return unknown !== undefined
          ? `entryId ${String(unknown)} is not in the candidate manifest`
          : null;
      },
    });
  } catch (err) {
    // Timeout, generation failure, or a selection our `validate` refused.
    // Note the asymmetry: `maxAttempts` governs the client's own retry loop
    // (unparseable output, schema violations), while `validate` runs once
    // afterwards — so a selection that parses but names an id outside the
    // manifest throws on the first offense and is not retried. Either way:
    // empty recall, main request proceeds (M §17).
    const reason = timeoutSignal.aborted
      ? 'selector_timeout'
      : `selector_failed: ${err instanceof Error ? err.message : err}`;
    debugLogger.debug(`omni sideQuery recall degraded: ${reason}`);
    return { result: null, reason, resourceIds };
  }

  if (selection.entryIds.length === 0) {
    return { result: null, reason: 'selector_selected_nothing', resourceIds };
  }

  try {
    const result = await service.recallSelection(
      resourceIds,
      selection.entryIds,
    );
    // Every pick can drop out in the availability pass (the artifacts were
    // deleted between the walk and now). Injecting the empty shell would
    // spend the reminder on a payload that says nothing.
    if (result.entries.length === 0) {
      return { result: null, reason: 'materialized_nothing', resourceIds };
    }
    return { result, resourceIds };
  } catch (err) {
    // Defense in depth: validate() should have caught any bad selection,
    // but a whole-rejection here still degrades to an empty recall.
    const reason =
      err instanceof MediaMemoryRecallRejection
        ? `selection_rejected: ${err.reason}`
        : `materialize_failed: ${err instanceof Error ? err.message : err}`;
    debugLogger.debug(`omni sideQuery recall degraded: ${reason}`);
    return { result: null, reason, resourceIds };
  }
}

/** Model-facing injection block for a materialized passive recall. Framed
 * as a system reminder so provider converters treat it as harness text;
 * the JSON body is the same unified protocol shape the active tool
 * returns (M §9.4). */
export function formatOmniMemorySideQueryReminder(
  result: MediaMemoryRecallResult,
): string {
  return (
    '<system-reminder>\n' +
    '【媒体记忆】Recalled media memory for the resources referenced in ' +
    'this request (passive mode). Entries below were persisted by ' +
    'earlier processing; resourceIds in them are session handles you may ' +
    'pass to omni media tools.\n' +
    `${JSON.stringify(result, null, 1)}\n` +
    '</system-reminder>'
  );
}
