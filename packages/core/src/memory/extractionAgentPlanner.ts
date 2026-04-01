/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  BackgroundAgentRunner,
  type BackgroundAgentResult,
} from '../background/backgroundAgentRunner.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { safeJsonParse } from '../utils/safeJsonParse.js';
import type { AutoMemoryType } from './types.js';
import type {
  AutoMemoryExtractPatch,
  AutoMemoryTranscriptMessage,
} from './extract.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';

const MAX_TOPIC_SUMMARY_CHARS = 280;

const EXTRACTION_AGENT_SYSTEM_PROMPT = `You are a background memory extraction agent for an AI coding assistant.

Your job is to read the provided transcript slice and current managed memory topic summaries, then return only durable memory patches worth saving long-term.

Rules:
- Output JSON only.
- Follow the schema exactly.
- Extract only durable facts stated by the user.
- Ignore temporary, session-specific, speculative, or question content.
- Use one of the allowed topics: user, feedback, project, reference.
- Keep summaries concise and suitable for bullet points.
- Do not include leading bullet markers.`;

const EXTRACTION_AGENT_RESPONSE_SCHEMA: Record<string, unknown> = {
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

interface ExtractionAgentResponse {
  patches: AutoMemoryExtractPatch[];
}

interface BackgroundAgentRunnerLike {
  run(request: Parameters<BackgroundAgentRunner['run']>[0]): Promise<BackgroundAgentResult>;
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

async function buildTopicSummaryBlock(projectRoot: string): Promise<string> {
  const docs = await scanAutoMemoryTopicDocuments(projectRoot);
  return docs
    .map((doc) => {
      const body = truncate(
        doc.body === '_No entries yet._' ? '' : doc.body,
        MAX_TOPIC_SUMMARY_CHARS,
      );
      return [
        `topic=${doc.type}`,
        `title=${doc.title}`,
        `description=${doc.description || '(none)'}`,
        `current=${body || '(empty)'}`,
      ].join('\n');
    })
    .join('\n\n');
}

function buildTaskPrompt(
  messages: AutoMemoryTranscriptMessage[],
  topicSummaries: string,
): string {
  return [
    'Return a JSON object that matches this schema:',
    JSON.stringify(EXTRACTION_AGENT_RESPONSE_SCHEMA, null, 2),
    '',
    'Transcript slice:',
    buildTranscriptBlock(messages),
    '',
    'Current topic summaries:',
    topicSummaries || '(no topics found)',
  ].join('\n');
}

function validateExtractionAgentResponse(
  parsed: ExtractionAgentResponse,
  userOffsets: Set<number>,
): AutoMemoryExtractPatch[] {
  const schemaError = SchemaValidator.validate(
    EXTRACTION_AGENT_RESPONSE_SCHEMA,
    parsed,
  );
  if (schemaError) {
    throw new Error(`Invalid extraction agent response: ${schemaError}`);
  }

  for (const patch of parsed.patches) {
    if (!patch.summary?.trim()) {
      throw new Error('Invalid extraction agent response: empty summary');
    }
    if (!userOffsets.has(patch.sourceOffset)) {
      throw new Error(
        'Invalid extraction agent response: invalid sourceOffset',
      );
    }
  }

  return parsed.patches.map((patch) => ({
    topic: patch.topic as AutoMemoryType,
    summary: patch.summary.trim(),
    sourceOffset: patch.sourceOffset,
  }));
}

export async function planAutoMemoryExtractionPatchesByAgent(
  config: Config,
  projectRoot: string,
  messages: AutoMemoryTranscriptMessage[],
  runner: BackgroundAgentRunnerLike = new BackgroundAgentRunner(),
): Promise<AutoMemoryExtractPatch[]> {
  if (messages.length === 0) {
    return [];
  }

  const userOffsets = new Set(
    messages
      .filter((message) => message.role === 'user')
      .map((message) => message.offset),
  );
  if (userOffsets.size === 0) {
    return [];
  }

  const topicSummaries = await buildTopicSummaryBlock(projectRoot);
  const result = await runner.run({
    taskType: 'managed-auto-memory-extraction-agent',
    title: 'Managed auto-memory extraction agent',
    description: 'Extract durable managed memory patches from transcript history.',
    projectRoot,
    sessionId: config.getSessionId(),
    dedupeKey: `managed-auto-memory-extraction-agent:${projectRoot}`,
    name: 'managed-auto-memory-extractor',
    runtimeContext: config,
    taskPrompt: buildTaskPrompt(messages, topicSummaries),
    promptConfig: {
      systemPrompt: EXTRACTION_AGENT_SYSTEM_PROMPT,
    },
    modelConfig: {
      model: config.getModel(),
      temp: 0,
    },
    runConfig: {
      max_turns: 2,
      max_time_minutes: 1,
    },
    toolConfig: {
      tools: [],
    },
    metadata: {
      planner: 'extraction-agent',
    },
  });

  if (result.status !== 'completed' || !result.finalText) {
    throw new Error(result.error || 'Extraction agent did not complete successfully');
  }

  const parsed = safeJsonParse<ExtractionAgentResponse>(result.finalText, {
    patches: [],
  });
  return validateExtractionAgentResponse(parsed, userOffsets);
}
