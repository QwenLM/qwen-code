/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { runForkedAgent } from '../background/forkedAgent.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { safeJsonParse } from '../utils/safeJsonParse.js';
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from './prompt.js';
import { AUTO_MEMORY_INDEX_FILENAME, getAutoMemoryRoot } from './paths.js';
import type { AutoMemoryType } from './types.js';
import type {
  AutoMemoryExtractPatch,
  AutoMemoryTranscriptMessage,
} from './extract.js';
import { scanAutoMemoryTopicDocuments } from './scan.js';

const MAX_TOPIC_SUMMARY_CHARS = 280;

const EXTRACTION_AGENT_SYSTEM_PROMPT = [
  'You are now acting as the managed memory extraction subagent for an AI coding assistant.',
  '',
  'Analyze the provided recent transcript slice and use it to update durable managed memory.',
  '',
  'You will be given current managed memory topic summaries. Improve existing memory rather than creating duplicate facts.',
  '',
  'Rules:',
  '- Output JSON only.',
  '- Follow the schema exactly.',
  '- Extract only durable facts stated by the user.',
  '- Ignore temporary, session-specific, speculative, or question content.',
  '- If the user explicitly asks the assistant to remember something durable, preserve it.',
  '- Use one of the allowed topics: user, feedback, project, reference.',
  '- Keep summaries concise and suitable for bullet points.',
  '- Do not include leading bullet markers.',
  '- You may use read-only tools to inspect topic files when the provided summaries seem insufficient.',
  '- Do not investigate the repository or verify the memory against unrelated code. Work only from the provided transcript slice and managed memory context.',
  '',
  ...TYPES_SECTION_INDIVIDUAL,
  ...WHAT_NOT_TO_SAVE_SECTION,
  '',
  'Memory file format reference:',
  ...MEMORY_FRONTMATTER_EXAMPLE,
].join('\n');

const EXTRACTION_AGENT_EXECUTION_RESPONSE_SCHEMA: Record<string, unknown> = {
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
    touchedTopics: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['user', 'feedback', 'project', 'reference'],
      },
    },
  },
  required: ['patches', 'touchedTopics'],
};

interface ExtractionAgentExecutionResponse {
  patches: AutoMemoryExtractPatch[];
  touchedTopics: AutoMemoryType[];
}

export interface AutoMemoryExtractionExecutionResult {
  patches: AutoMemoryExtractPatch[];
  touchedTopics: AutoMemoryType[];
  systemMessage?: string;
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
        `path=${doc.filePath}`,
        `title=${doc.title}`,
        `description=${doc.description || '(none)'}`,
        `current=${body || '(empty)'}`,
      ].join('\n');
    })
    .join('\n\n');
}

function buildExecutionTaskPrompt(
  memoryRoot: string,
  messages: AutoMemoryTranscriptMessage[],
  topicSummaries: string,
): string {
  return [
    `Managed memory directory: \`${memoryRoot}\``,
    '',
    'You must update durable managed memory by directly using tools to read and write files inside the managed memory directory.',
    '',
    'Available tools in this run: `read_file`, `list_directory`, `glob`, `grep_search`, `write_file`, `edit`.',
    '- Do not use any other tools.',
    '- Do not inspect repository code, git history, or unrelated files.',
    '- Work only from the transcript slice below plus the current managed memory files.',
    '- Prefer updating an existing memory file over creating a duplicate.',
    '- If you create or delete a memory file, also update the managed memory index.',
    `- The managed memory index is \`${memoryRoot}/${AUTO_MEMORY_INDEX_FILENAME}\`.`,
    '- Keep one durable memory per file under `user/`, `feedback/`, `project/`, or `reference/`.',
    '- If nothing durable should be saved, make no file changes.',
    '',
    'Memory file format reference:',
    ...MEMORY_FRONTMATTER_EXAMPLE,
    '',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    'After all tool work is complete, output JSON only matching this schema:',
    JSON.stringify(EXTRACTION_AGENT_EXECUTION_RESPONSE_SCHEMA, null, 2),
    '',
    'Transcript slice:',
    buildTranscriptBlock(messages),
    '',
    'Current topic summaries:',
    topicSummaries || '(no topics found)',
  ].join('\n');
}

function validateExtractionExecutionResponse(
  parsed: ExtractionAgentExecutionResponse,
  userOffsets: Set<number>,
): AutoMemoryExtractionExecutionResult {
  const schemaError = SchemaValidator.validate(
    EXTRACTION_AGENT_EXECUTION_RESPONSE_SCHEMA,
    parsed,
  );
  if (schemaError) {
    throw new Error(`Invalid extraction agent response: ${schemaError}`);
  }

  const patches = parsed.patches.map((patch) => {
    if (!patch.summary?.trim()) {
      throw new Error('Invalid extraction agent response: empty summary');
    }
    if (!userOffsets.has(patch.sourceOffset)) {
      throw new Error(
        'Invalid extraction agent response: invalid sourceOffset',
      );
    }

    return {
      topic: patch.topic as AutoMemoryType,
      summary: patch.summary.trim(),
      why: patch.why?.trim(),
      howToApply: patch.howToApply?.trim(),
      sourceOffset: patch.sourceOffset,
    };
  });
  const touchedTopics = Array.from(
    new Set(
      (parsed.touchedTopics ?? []).filter(
        (topic): topic is AutoMemoryType =>
          topic === 'user' ||
          topic === 'feedback' ||
          topic === 'project' ||
          topic === 'reference',
      ),
    ),
  );

  return {
    patches,
    touchedTopics,
    systemMessage:
      touchedTopics.length > 0
        ? `Managed auto-memory updated: ${touchedTopics.map((topic) => `${topic}.md`).join(', ')}`
        : undefined,
  };
}

export async function runAutoMemoryExtractionByAgent(
  config: Config,
  projectRoot: string,
  messages: AutoMemoryTranscriptMessage[],
): Promise<AutoMemoryExtractionExecutionResult> {
  if (messages.length === 0) {
    return {
      patches: [],
      touchedTopics: [],
    };
  }

  const userOffsets = new Set(
    messages
      .filter((message) => message.role === 'user')
      .map((message) => message.offset),
  );
  if (userOffsets.size === 0) {
    return {
      patches: [],
      touchedTopics: [],
    };
  }

  const topicSummaries = await buildTopicSummaryBlock(projectRoot);
  const memoryRoot = getAutoMemoryRoot(projectRoot);
  const result = await runForkedAgent({
    name: 'managed-auto-memory-extractor',
    config,
    taskPrompt: buildExecutionTaskPrompt(memoryRoot, messages, topicSummaries),
    systemPrompt: EXTRACTION_AGENT_SYSTEM_PROMPT,
    maxTurns: 5,
    maxTimeMinutes: 2,
    tools: [
      'read_file',
      'write_file',
      'edit',
      'list_directory',
      'glob',
      'grep_search',
    ],
  });

  if (result.status !== 'completed' || !result.finalText) {
    throw new Error(
      result.terminateReason ||
        'Extraction agent did not complete successfully',
    );
  }

  const parsed = safeJsonParse<ExtractionAgentExecutionResponse>(
    result.finalText,
    {
      patches: [],
      touchedTopics: [],
    },
  );
  return validateExtractionExecutionResponse(parsed, userOffsets);
}
