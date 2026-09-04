/**
 * Parses Qwen Code JSONL transcript files into structured stats records.
 *
 * Qwen transcripts contain telemetry events with these event names:
 * - `qwen-code.api_response` — successful API call
 * - `qwen-code.api_error` — failed API call
 * - `qwen-code.tool_call` — tool invocation
 *
 * Each event is embedded in a transcript entry's `systemPayload.uiEvent`.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type {
  ApiRequestRecord,
  ParseSessionResult,
  ToolCallRecord,
  TranscriptEntry,
} from './types.js';

/** Extract folder name from session file path. */
function extractFolder(sessionFile: string): string {
  // Path format: ~/.qwen/projects/<encoded-path>/chats/<session>.jsonl
  // The encoded path replaces / with -, which is lossy (e.g. github.com → github-com).
  // We use it as a fallback; the real cwd comes from transcript entries.
  const match = sessionFile.match(/projects\/(.+?)\/chats\//);
  if (!match) return 'unknown';
  return match[1].replace(/-/g, '/');
}

/** Derive provider from model name. */
function deriveProvider(model: string): string {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('qwen')) return 'alibaba';
  if (model.startsWith('deepseek')) return 'deepseek';
  return 'unknown';
}

/** Parse a single transcript entry into stats records. */
function parseEntry(
  entry: TranscriptEntry,
  sessionFile: string,
  sessionId: string,
  folder: string,
  lineIndex: number,
): { apiRequest?: ApiRequestRecord; toolCall?: ToolCallRecord } {
  const uiEvent = entry.systemPayload?.uiEvent;
  if (!uiEvent) return {};

  const eventName = uiEvent['event.name'] as string | undefined;
  if (!eventName) return {};

  const timestamp = new Date(entry.timestamp ?? Date.now()).getTime();
  const model = (uiEvent['model'] as string) || entry.model || 'unknown';
  const provider = deriveProvider(model);
  const promptId = (uiEvent['prompt_id'] as string) || null;

  if (eventName === 'qwen-code.api_response') {
    // Token counts come from uiEvent fields, not a nested usage object
    return {
      apiRequest: {
        id: `${sessionId}:${lineIndex}`,
        sessionFile,
        sessionId,
        folder,
        model,
        provider,
        timestamp,
        durationMs: (uiEvent['duration_ms'] as number) ?? null,
        ttftMs: null, // Not available in qwen telemetry
        inputTokens: (uiEvent['input_token_count'] as number) ?? 0,
        outputTokens: (uiEvent['output_token_count'] as number) ?? 0,
        cachedTokens: (uiEvent['cached_content_token_count'] as number) ?? 0,
        thoughtsTokens: (uiEvent['thoughts_token_count'] as number) ?? 0,
        totalTokens: (uiEvent['total_token_count'] as number) ?? 0,
        isError: false,
        errorType: null,
        errorStatus: null,
        responseId: (uiEvent['response_id'] as string) || null,
        promptId,
      },
    };
  }

  if (eventName === 'qwen-code.api_error') {
    return {
      apiRequest: {
        id: `${sessionId}:${lineIndex}`,
        sessionFile,
        sessionId,
        folder,
        model,
        provider,
        timestamp,
        durationMs: (uiEvent['duration_ms'] as number) ?? null,
        ttftMs: null,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 0,
        isError: true,
        errorType: (uiEvent['error_type'] as string) || null,
        errorStatus: (uiEvent['status_code'] as number) || null,
        responseId: null,
        promptId,
      },
    };
  }

  if (eventName === 'qwen-code.tool_call') {
    return {
      toolCall: {
        id: `${sessionId}:${lineIndex}`,
        sessionFile,
        sessionId,
        folder,
        toolName: (uiEvent['function_name'] as string) || 'unknown',
        model,
        timestamp,
        durationMs: (uiEvent['duration_ms'] as number) ?? null,
        success: (uiEvent['success'] as boolean) ?? true,
        decision: (uiEvent['decision'] as string) || null,
        promptId,
      },
    };
  }

  return {};
}

/**
 * Parse a session JSONL file, optionally from a byte offset for incremental sync.
 */
export async function parseSessionFile(
  sessionFile: string,
  fromOffset = 0,
): Promise<ParseSessionResult> {
  const apiRequests: ApiRequestRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];

  let sessionId = '';
  let folder = '';
  let lineIndex = 0;
  let bytesProcessed = 0;

  const rl = createInterface({
    input: createReadStream(sessionFile, {
      start: fromOffset > 0 ? fromOffset : undefined,
    }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    bytesProcessed += Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
    lineIndex++;

    if (!line.trim()) continue;

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue; // Skip malformed lines
    }

    // Capture session metadata from first entry
    if (!sessionId && entry.sessionId) {
      sessionId = entry.sessionId;
      folder = extractFolder(sessionFile);
    }

    const result = parseEntry(entry, sessionFile, sessionId, folder, lineIndex);
    if (result.apiRequest) apiRequests.push(result.apiRequest);
    if (result.toolCall) toolCalls.push(result.toolCall);
  }

  return {
    apiRequests,
    toolCalls,
    lastOffset: fromOffset + bytesProcessed,
    linesProcessed: lineIndex,
  };
}
