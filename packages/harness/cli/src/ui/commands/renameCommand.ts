/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionTitleService,
  extractConversationTitleText,
  getErrorMessage,
  sessionIdContext,
  type Message,
} from '@qwen-code/core';
import { MessageType } from '../types.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';

const USAGE = 'Usage: /rename <name>';

/** Interactive budget for generating a name; the title service's own ceiling is 180 s. */
const RENAME_GENERATE_TIMEOUT_MS = 30_000;

/** UTF-16 units — the length session-registry.ts keeps when it reads `name`. */
const SESSION_NAME_MAX_UNITS = 120;

// C0 and C1 controls, zero-width space, bidi marks/embeddings/overrides/isolates,
// word joiner and invisible operators, BOM. Deliberately NOT included: U+200C (ZWNJ)
// and U+200D (ZWJ), which Persian/Arabic/Indic orthography and emoji sequences need,
// and variation selectors U+FE00-U+FE0F and tags U+E0000-U+E007F.
const INVISIBLE_OR_CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

const graphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'grapheme' })
    : null;

/**
 * Cuts `text` so its UTF-16 length is at most `maxUnits`, never splitting a
 * grapheme cluster (surrogate pairs, ZWJ sequences, flags, combining marks).
 */
function truncateToUnits(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) {
    return text;
  }
  const clusters = graphemeSegmenter?.segment(text) ?? text;
  let result = '';
  for (const part of clusters) {
    const cluster = typeof part === 'string' ? part : part.segment;
    if (result.length + cluster.length > maxUnits) {
      break;
    }
    result += cluster;
  }
  return result;
}

function sanitizeSessionName(raw: string): string {
  const cleaned = raw
    // First, so \uFEFF, \x0B and \x0C are removed rather than turned into spaces.
    .replace(INVISIBLE_OR_CONTROL_RE, '')
    // Then tabs and newlines become one space, so words are never glued together.
    .replace(/\s+/g, ' ')
    .trim();
  return truncateToUnits(cleaned, SESSION_NAME_MAX_UNITS).trim();
}

function errorResult(content: string): SlashCommandActionReturn {
  return { type: 'message', messageType: 'error', content };
}

async function generateSessionName(
  context: CommandContext,
): Promise<{ name: string } | { result: SlashCommandActionReturn }> {
  const config = context.services.agentContext!.config;

  // Only the local TUI hands commands its conversation. `-p`, SDK stream-json
  // and ACP leave `messages` undefined, and per the startup-form convention
  // those surfaces do not inherit generation until they are evaluated
  // separately. A surface that starts populating `messages` turns this on.
  if (context.messages === undefined) {
    return {
      result: errorResult(`Name generation is not available here. ${USAGE}`),
    };
  }
  const messages = context.messages as Message[];

  if (!extractConversationTitleText(messages)) {
    return {
      result: errorResult(
        `Could not generate a name: no conversation context yet. ${USAGE}`,
      ),
    };
  }

  const sessionId = config.getSessionId();
  const titleBefore = config.topicState.getTopic();

  // Safe-concurrent commands skip the processing indicator, so say something.
  context.ui.addItem(
    { type: MessageType.INFO, text: 'Generating a session name…' },
    Date.now(),
  );

  const service = new SessionTitleService(config);

  // Esc cannot reach a safe-concurrent command, so the timeout is the only
  // abort. `context.abortSignal` is only supplied by surfaces gated off above.
  const signal = AbortSignal.timeout(RENAME_GENERATE_TIMEOUT_MS);
  const title = await sessionIdContext.run(sessionId, () =>
    service.generateTitle({
      sessionId,
      messages,
      signal,
      currentModel: config.getModel(),
      getModelPolicy: config.getModelPolicy,
    }),
  );

  if (signal.aborted) {
    return { result: errorResult(`Name generation timed out. ${USAGE}`) };
  }
  const generationFailed = errorResult(
    `Could not generate a name from the conversation. ${USAGE}`,
  );
  if (!title) {
    return { result: generationFailed };
  }
  if (config.getSessionId() !== sessionId) {
    return {
      result: errorResult(
        'Session changed while generating a name; nothing was renamed.',
      ),
    };
  }
  const currentTitle = config.topicState.getTopic();
  if (currentTitle !== titleBefore) {
    return {
      result: {
        type: 'local_command_result',
        text: `Session is named: ${currentTitle ?? ''} (a newer rename landed first)`,
      },
    };
  }

  const name = sanitizeSessionName(title);
  return name ? { name } : { result: generationFailed };
}

export const renameCommand: SlashCommand = {
  name: 'rename',
  description: 'Rename the current conversation',
  argumentHint: '[name]',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  // Title persistence is a purely local, serialized write (topic state +
  // transcript metadata), so it is safe to run while the agent is responding.
  // The no-argument path waits on a model call; it guards against a newer
  // rename or a session switch landing in the meantime.
  isSafeConcurrent: true,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return errorResult('Session context not available.');
    }

    const raw = args.trim();
    let name: string;
    if (raw) {
      name = sanitizeSessionName(raw);
      if (!name) {
        return errorResult(
          `That name is empty once invisible characters are removed. ${USAGE}`,
        );
      }
    } else {
      const generated = await generateSessionName(context);
      if ('result' in generated) {
        return generated.result;
      }
      name = generated.name;
    }

    try {
      await config.persistSessionTitle(name);
    } catch (error) {
      return errorResult(`Could not save the name: ${getErrorMessage(error)}`);
    }

    return {
      type: 'local_command_result',
      text: `Session renamed to: ${name}`,
    };
  },
};
