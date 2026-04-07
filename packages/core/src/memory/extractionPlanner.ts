/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { runSideQuery } from '../auxiliary/sideQuery.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';
import type { AutoMemoryType } from './types.js';
import type {
  AutoMemoryExtractPatch,
  AutoMemoryTranscriptMessage,
} from './extract.js';

const MAX_TOPIC_SUMMARY_CHARS = 280;

const SYSTEM_PROMPT = `You are acting as the managed memory extraction planner for an AI coding assistant.

Analyze only the provided recent transcript slice and the existing managed memory topic summaries, then return durable memory patches worth keeping beyond the current task.

Save only information that is likely to matter in future sessions.

Allowed topics:
- user: stable user preferences, habits, background, recurring requirements
- feedback: lasting instructions about how the assistant should respond or work
- project: stable project constraints, environments, releases, architecture facts
- reference: durable links, dashboards, tickets, docs, runbooks, identifiers

Extract only durable facts stated by the user.

Do not extract:
- temporary task steps
- session-only instructions
- speculative conclusions
- questions
- assistant-only plans not stated by the user
- content that only makes sense relative to “today”, “this task”, or “right now”

If the user explicitly asks the assistant to remember something durable, prefer to keep it.

Return concise summaries suitable for bullet points. Do not include leading bullet markers. Output must match the provided JSON schema exactly.`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    patches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: ['user', 'feedback', 'project', 'reference'],
          },
          summary: {
            type: 'string',
          },
          why: {
            type: 'string',
          },
          howToApply: {
            type: 'string',
          },
          sourceOffset: {
            type: 'integer',
          },
        },
        required: ['topic', 'summary', 'sourceOffset'],
      },
    },
  },
  required: ['patches'],
};

interface ExtractionPlannerResponse {
  patches: AutoMemoryExtractPatch[];
}

function truncate(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

function buildTranscriptBlock(messages: AutoMemoryTranscriptMessage[]): string {
  return messages
    .map(
      (message) =>
        `- offset=${message.offset} role=${message.role} text=${message.text}`,
    )
    .join('\n');
}

function buildTopicSummaryBlock(projectRoot: string): Promise<string> {
  return scanAutoMemoryTopicDocuments(projectRoot).then((docs) =>
    docs
      .map((doc) => {
        const body = truncate(doc.body === '_No entries yet._' ? '' : doc.body, MAX_TOPIC_SUMMARY_CHARS);
        return [
          `topic=${doc.type}`,
          `title=${doc.title}`,
          `description=${doc.description || '(none)'}`,
          `current=${body || '(empty)'}`,
        ].join('\n');
      })
      .join('\n\n'),
  );
}

export async function planAutoMemoryExtractionPatchesByModel(
  config: Config,
  projectRoot: string,
  messages: AutoMemoryTranscriptMessage[],
): Promise<AutoMemoryExtractPatch[]> {
  if (messages.length === 0) {
    return [];
  }

  const userOffsets = new Set(
    messages.filter((message) => message.role === 'user').map((message) => message.offset),
  );
  if (userOffsets.size === 0) {
    return [];
  }

  const topicSummaries = await buildTopicSummaryBlock(projectRoot);
  const contents: Content[] = [
    {
      role: 'user',
      parts: [
        {
          text: [
            'Transcript slice:',
            buildTranscriptBlock(messages),
            '',
            'Current topic summaries:',
            topicSummaries || '(no topics found)',
          ].join('\n'),
        },
      ],
    },
  ];

  const response = await runSideQuery<ExtractionPlannerResponse>(config, {
    purpose: 'auto-memory-extract',
    contents,
    schema: RESPONSE_SCHEMA,
    abortSignal: AbortSignal.timeout(7_500),
    systemInstruction: SYSTEM_PROMPT,
    config: {
      temperature: 0,
    },
    validate: (value) => {
      if (!Array.isArray(value.patches)) {
        return 'Extraction planner must return patches array';
      }
      for (const patch of value.patches) {
        if (!patch.summary?.trim()) {
          return 'Extraction planner returned empty summary';
        }
        if (!userOffsets.has(patch.sourceOffset)) {
          return 'Extraction planner returned invalid sourceOffset';
        }
      }
      return null;
    },
  });

  return response.patches.map((patch) => ({
    topic: patch.topic as AutoMemoryType,
    summary: patch.summary,
    why: patch.why,
    howToApply: patch.howToApply,
    sourceOffset: patch.sourceOffset,
  }));
}
