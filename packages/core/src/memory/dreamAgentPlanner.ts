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
import {
  AUTO_MEMORY_TYPES,
  type AutoMemoryType,
} from './types.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';

const MAX_TOPIC_BODY_CHARS = 2_000;

const DREAM_AGENT_SYSTEM_PROMPT = `You are a background memory consolidation agent for an AI coding assistant.

Your job is to consolidate managed memory topic documents into cleaner, deduplicated topic bodies.

Rules:
- Output JSON only.
- Follow the schema exactly.
- Only rewrite topics that benefit from consolidation.
- Preserve durable information.
- Remove duplicates and obvious clutter.
- Keep topic headings.
- If a topic has no durable entries, use the standard placeholder: _No entries yet._`;

const DREAM_AGENT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    rewrites: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: [...AUTO_MEMORY_TYPES],
          },
          body: {
            type: 'string',
          },
        },
        required: ['topic', 'body'],
      },
    },
  },
  required: ['rewrites'],
};

export interface AutoMemoryDreamRewrite {
  topic: AutoMemoryType;
  body: string;
}

interface DreamAgentResponse {
  rewrites: AutoMemoryDreamRewrite[];
}

interface BackgroundAgentRunnerLike {
  run(request: Parameters<BackgroundAgentRunner['run']>[0]): Promise<BackgroundAgentResult>;
}

function truncate(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

async function buildTopicDocumentBlock(projectRoot: string): Promise<string> {
  const docs = await scanAutoMemoryTopicDocuments(projectRoot);
  return docs
    .map((doc) =>
      [
        `topic=${doc.type}`,
        `title=${doc.title}`,
        `description=${doc.description || '(none)'}`,
        'body:',
        truncate(doc.body, MAX_TOPIC_BODY_CHARS),
      ].join('\n'),
    )
    .join('\n\n');
}

function buildTaskPrompt(topicBlock: string): string {
  return [
    'Return a JSON object matching this schema:',
    JSON.stringify(DREAM_AGENT_RESPONSE_SCHEMA, null, 2),
    '',
    'Managed memory topic documents:',
    topicBlock || '(no topics found)',
  ].join('\n');
}

function validateDreamAgentResponse(
  parsed: DreamAgentResponse,
): AutoMemoryDreamRewrite[] {
  const schemaError = SchemaValidator.validate(
    DREAM_AGENT_RESPONSE_SCHEMA,
    parsed,
  );
  if (schemaError) {
    throw new Error(`Invalid dream agent response: ${schemaError}`);
  }

  const seen = new Set<AutoMemoryType>();
  for (const rewrite of parsed.rewrites) {
    if (!rewrite.body.trim()) {
      throw new Error('Invalid dream agent response: empty body');
    }
    if (seen.has(rewrite.topic)) {
      throw new Error('Invalid dream agent response: duplicate topic rewrite');
    }
    seen.add(rewrite.topic);
  }

  return parsed.rewrites.map((rewrite) => ({
    topic: rewrite.topic,
    body: rewrite.body.trim(),
  }));
}

export async function planManagedAutoMemoryDreamByAgent(
  config: Config,
  projectRoot: string,
  runner: BackgroundAgentRunnerLike = new BackgroundAgentRunner(),
): Promise<AutoMemoryDreamRewrite[]> {
  const topicBlock = await buildTopicDocumentBlock(projectRoot);
  const result = await runner.run({
    taskType: 'managed-auto-memory-dream-agent',
    title: 'Managed auto-memory dream agent',
    description: 'Consolidate managed memory topic files into cleaner summaries.',
    projectRoot,
    sessionId: config.getSessionId(),
    dedupeKey: `managed-auto-memory-dream-agent:${projectRoot}`,
    name: 'managed-auto-memory-dreamer',
    runtimeContext: config,
    taskPrompt: buildTaskPrompt(topicBlock),
    promptConfig: {
      systemPrompt: DREAM_AGENT_SYSTEM_PROMPT,
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
      planner: 'dream-agent',
    },
  });

  if (result.status !== 'completed' || !result.finalText) {
    throw new Error(result.error || 'Dream agent did not complete successfully');
  }

  const parsed = safeJsonParse<DreamAgentResponse>(result.finalText, {
    rewrites: [],
  });
  return validateDreamAgentResponse(parsed);
}
