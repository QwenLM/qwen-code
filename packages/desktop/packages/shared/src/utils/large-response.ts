/**
 * Large Response Handling Utility
 *
 * Centralized save + prompt building + formatting for large tool results.
 * Follows the title-generator.ts pattern: pure functions only, no SDK/LLM calls.
 *
 * Callers orchestrate via their agent's runMiniCompletion() for summarization.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, relative } from 'path';
import { debug } from './debug.ts';
import {
  looksLikeBinary,
  extractBase64Binary,
  detectExtensionFromMagic,
  saveBinaryResponse,
  sanitizeFilename,
  formatBytes,
} from './binary-detection.ts';

// ============================================================
// Constants (re-exported from summarize.ts for convenience)
// ============================================================

/** Token limit for summarization trigger (roughly ~60KB of text) */
export const TOKEN_LIMIT = 15000;

/** Max tokens to send for summarization (~400KB). Beyond this, save to file + preview only. */
export const MAX_SUMMARIZATION_INPUT = 100000;

/** Canonical subfolder under session dir for full tool results */
export const LONG_RESPONSES_DIR = 'long_responses';

// ============================================================
// Token Estimation
// ============================================================

/**
 * Estimate token count from text length (rough approximation: 4 chars per token)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================================
// Save to Disk
// ============================================================

export interface SaveResult {
  /** Absolute path for Read/Grep access */
  absolutePath: string;
  /** Relative path from session dir (e.g. "long_responses/2026-02-09_gmail_users_me.txt") for transform_data */
  relativePath: string;
}

/**
 * Save large response to the session's long_responses/ folder.
 * Creates the folder if it doesn't exist.
 *
 * @param sessionPath - Path to the session folder
 * @param toolName - Name of the tool (e.g., "gmail", "api_stripe")
 * @param label - Additional label for the filename (e.g., API path)
 * @param content - The full response content to save
 * @returns Absolute and relative paths to the saved file
 */
export function saveLargeResponse(
  sessionPath: string,
  toolName: string,
  label: string,
  content: string
): SaveResult | null {
  const responsesDir = join(sessionPath, LONG_RESPONSES_DIR);
  try {
    mkdirSync(responsesDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const safeLabel = label.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
    const filename = `${timestamp}_${toolName}_${safeLabel}.txt`;
    const absolutePath = join(responsesDir, filename);

    writeFileSync(absolutePath, content, 'utf-8');

    const relativePath = relative(sessionPath, absolutePath);

    debug('large-response', `Saved ${content.length} bytes to ${relativePath}`);
    return { absolutePath, relativePath };
  } catch (error) {
    debug('large-response', `Failed to save: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ============================================================
// Structured Media Extraction (JSON payloads)
// ============================================================

interface SavedJsonArtifact extends SaveResult {
  filename: string;
}

interface SavedAsset {
  absolutePath: string;
  relativePath: string;
  mimeType: string | null;
  ext: string;
  size: number;
  sizeHuman: string;
  sha256: string;
  jsonPath: string;
  source: 'data-url' | 'raw-base64';
}

interface JsonAssetExtractionResult {
  originalJsonPath: string;
  linkedJsonPath: string;
  assets: SavedAsset[];
}

function saveJsonArtifact(
  sessionPath: string,
  toolName: string,
  suffix: string,
  content: string
): SavedJsonArtifact | null {
  const responsesDir = join(sessionPath, LONG_RESPONSES_DIR);
  try {
    mkdirSync(responsesDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    const safeTool = sanitizeFilename(toolName || 'tool_result');
    const filename = `${timestamp}_${safeTool}_${suffix}.json`;
    const absolutePath = join(responsesDir, filename);
    writeFileSync(absolutePath, content, 'utf-8');
    return {
      absolutePath,
      relativePath: relative(sessionPath, absolutePath),
      filename,
    };
  } catch (error) {
    debug('large-response', `Failed to save JSON artifact: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function inferMimeFromContext(container: unknown): string | null {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return null;
  const obj = container as Record<string, unknown>;
  const keys = ['mimeType', 'media_type', 'mime', 'contentType', 'content_type'];
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function saveExtractedAsset(
  sessionPath: string,
  toolName: string,
  buffer: Buffer,
  ext: string,
  mimeType: string | null,
  jsonPath: string,
  source: 'data-url' | 'raw-base64'
): SavedAsset | null {
  try {
    const assetsDir = join(sessionPath, 'downloads', 'assets');
    mkdirSync(assetsDir, { recursive: true });

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const safeTool = sanitizeFilename(toolName || 'tool_result');
    const safeExt = ext.startsWith('.') ? ext : `.${ext || 'bin'}`;
    const filename = `${safeTool}_${sha256.slice(0, 16)}${safeExt}`;
    const absolutePath = join(assetsDir, filename);

    if (!existsSync(absolutePath)) {
      writeFileSync(absolutePath, buffer, { flag: 'wx' });
    }

    return {
      absolutePath,
      relativePath: relative(sessionPath, absolutePath),
      mimeType,
      ext: safeExt,
      size: buffer.length,
      sizeHuman: formatBytes(buffer.length),
      sha256,
      jsonPath,
      source,
    };
  } catch (error) {
    debug('large-response', `Failed to save extracted asset: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function extractAssetsFromStructuredJson(
  text: string,
  sessionPath: string,
  toolName: string
): JsonAssetExtractionResult | null {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const linked = JSON.parse(JSON.stringify(parsed)) as unknown;
  const assets: SavedAsset[] = [];

  const walk = (node: unknown, path: string, parent: Record<string, unknown> | unknown[] | null, key: string | number | null) => {
    if (typeof node === 'string') {
      const extraction = extractBase64Binary(node);
      if (!extraction || !parent || key === null) return;

      const contextMime = inferMimeFromContext(parent);
      const mime = extraction.mimeType || contextMime;
      const ext = extraction.ext || '.bin';
      const saved = saveExtractedAsset(sessionPath, toolName, extraction.buffer, ext, mime, path, extraction.source);
      if (!saved) return;

      const replacement = {
        assetRef: {
          path: saved.absolutePath,
          relativePath: saved.relativePath,
          mimeType: saved.mimeType,
          ext: saved.ext,
          size: saved.size,
          sizeHuman: saved.sizeHuman,
          sha256: saved.sha256,
          jsonPath: saved.jsonPath,
          source: saved.source,
        },
      };

      if (Array.isArray(parent)) {
        parent[key as number] = replacement;
      } else {
        (parent as Record<string, unknown>)[String(key)] = replacement;
      }
      assets.push(saved);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, `${path}[${idx}]`, node, idx));
      return;
    }

    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const childPath = path === '$' ? `$.${k}` : `${path}.${k}`;
        walk(v, childPath, obj, k);
      }
    }
  };

  walk(linked, '$', null, null);

  if (assets.length === 0) return null;

  const originalArtifact = saveJsonArtifact(sessionPath, toolName, 'original', text);
  const linkedArtifact = saveJsonArtifact(sessionPath, toolName, 'linked', JSON.stringify(linked, null, 2));

  if (!originalArtifact || !linkedArtifact) return null;

  return {
    originalJsonPath: originalArtifact.absolutePath,
    linkedJsonPath: linkedArtifact.absolutePath,
    assets,
  };
}

function formatStructuredMediaExtractionMessage(result: JsonAssetExtractionResult): string {
  const assetsList = result.assets
    .map((asset, index) => `${index + 1}. ${asset.absolutePath} (${asset.sizeHuman}, ${asset.mimeType || asset.ext.slice(1).toUpperCase()}, from ${asset.jsonPath})`)
    .join('\n');

  return [
    '[Structured media assets extracted and saved]',
    '',
    `Original JSON: ${result.originalJsonPath}`,
    `Linked JSON: ${result.linkedJsonPath}`,
    `Assets extracted: ${result.assets.length}`,
    assetsList ? `\n${assetsList}` : '',
    '',
    'Use the linked JSON for analysis and click asset file paths to preview/open the extracted media.',
  ].join('\n');
}

// ============================================================
// Summarization Prompt Builder
// ============================================================

export interface SummarizationContext {
  /** Tool or API name */
  toolName: string;
  /** Optional endpoint/path for API calls */
  path?: string;
  /** Tool input parameters */
  input?: Record<string, unknown>;
  /** The model's stated intent before calling the tool */
  intent?: string;
  /** The user's original request (fallback context) */
  userRequest?: string;
}

/**
 * Build the prompt for summarizing a large tool result.
 * Pure function — no SDK calls.
 *
 * @param text - The large response text
 * @param context - Context about the tool call
 * @returns Prompt string ready for runMiniCompletion()
 */
export function buildSummarizationPrompt(text: string, context: SummarizationContext): string {
  // Safely stringify input
  let inputContext = 'No specific parameters provided.';
  if (context.input) {
    try {
      inputContext = `Request parameters: ${JSON.stringify(context.input)}`;
    } catch {
      inputContext = 'Request parameters: [non-serializable input]';
    }
  }

  const endpointContext = context.path ? `Endpoint: ${context.path}` : '';

  // Prefer model's stated intent, fall back to user request
  const intentContext = context.intent
    ? `The AI assistant's goal: "${context.intent.slice(0, 500)}"`
    : context.userRequest
      ? `User's original request: "${context.userRequest.slice(0, 300)}"`
      : '';

  // Truncate response to fit within summarization limits
  const maxChars = MAX_SUMMARIZATION_INPUT * 4; // ~400KB
  const truncated = text.length > maxChars;
  const responseText = truncated
    ? text.substring(0, maxChars) + '\n\n[... truncated for summarization ...]'
    : text;

  return `You are summarizing a tool result that was too large to fit in context.

Tool: ${context.toolName}
${endpointContext}
${inputContext}
${intentContext ? `\n${intentContext}` : ''}
${truncated ? '\nNote: The response was truncated before summarization due to extreme size.' : ''}

Your task:
1. Extract the MOST RELEVANT information based on the stated goal or request above
2. Preserve key data points, IDs, URLs, and actionable information that relate to the goal
3. Summarize long text content but keep essential details needed to complete the task
4. Format the output cleanly for the AI assistant to use

Tool result to summarize:
${responseText}

Provide a concise but comprehensive summary that captures the essential information needed to accomplish the stated goal.`;
}

// ============================================================
// Result Message Formatting
// ============================================================

export interface FormatOptions {
  estimatedTokens: number;
  /** Relative path from session dir (for transform_data reference) */
  relativePath: string;
  /** Absolute path (for Read/Grep reference) */
  absolutePath: string;
  /** Summary from runMiniCompletion (if available) */
  summary?: string;
  /** Fallback preview when no summary (first N chars of response) */
  preview?: string;
}

/**
 * Format the message the model sees for a large response.
 * Includes file references for both Read/Grep and transform_data access.
 */
export function formatLargeResponseMessage(opts: FormatOptions): string {
  const { estimatedTokens, relativePath, absolutePath, summary, preview } = opts;

  const fileRef = [
    `Full data saved to: ${absolutePath}`,
    `- Use Read/Grep to access specific content`,
    `- Use transform_data with inputFiles: ["${relativePath}"] for data analysis`,
  ].join('\n');

  if (summary) {
    return `[Large response (~${estimatedTokens} tokens) summarized]\n\n${fileRef}\n\n${summary}`;
  }

  if (preview) {
    return `[Response too large (~${estimatedTokens} tokens)]\n\n${fileRef}\n\nPreview:\n${preview}...`;
  }

  return `[Response too large (~${estimatedTokens} tokens)]\n\n${fileRef}`;
}

// ============================================================
// High-level Pipeline (orchestrates save + summarize + format)
// ============================================================

export interface HandleLargeResponseOptions {
  /** Full response text */
  text: string;
  /** Path to the session folder */
  sessionPath: string;
  /** Context about the tool call */
  context: SummarizationContext;
  /** Optional summarize callback — typically agent.runMiniCompletion.bind(agent) */
  summarize?: (prompt: string) => Promise<string | null>;
}

export interface HandleLargeResponseResult {
  /** Formatted message for the model */
  message: string;
  /** Absolute path to saved file */
  filePath: string;
  /** Whether the response was summarized (vs preview-only) */
  wasSummarized: boolean;
}

/**
 * Thin guard wrapper: returns the replacement text if the result is too large
 * or contains binary data, or null if the result should be passed through as-is.
 *
 * Accepts string | Buffer:
 * - Buffer: binary detection on raw bytes (preserves data integrity for file saving).
 *   Used by api-tools which has raw HTTP response buffers.
 * - string: binary detection via Buffer conversion. Used by MCP pool and backend adapters
 *   where data is already a string.
 *
 * Pipeline: binary check → (if text) size check → save + summarize.
 *
 * Shared by McpClientPool.callTool(), api-tools.ts, and backend agents.
 */
export async function guardLargeResult(
  input: string | Buffer,
  opts: {
    sessionPath: string;
    toolName: string;
    input?: Record<string, unknown>;
    intent?: string;
    summarize?: (prompt: string) => Promise<string | null>;
  }
): Promise<string | null> {
  // 1. Binary detection — check before any text processing
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf-8');
  if (looksLikeBinary(buffer)) {
    debug('large-response', `${opts.toolName}: binary content detected (${buffer.length} bytes)`);
    const ext = detectExtensionFromMagic(buffer) || '.bin';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = sanitizeFilename(opts.toolName);
    const filename = `${safeName}_${timestamp}${ext}`;
    const result = saveBinaryResponse(opts.sessionPath, filename, buffer, null);
    if (result.type === 'file_download') {
      return `[Binary content detected and saved]\n\nFile: ${result.path}\nSize: ${result.sizeHuman}\nType: ${ext.slice(1).toUpperCase() || 'unknown'}\n\nUse the Read tool or reference this path to work with the file.`;
    }
    return `[Binary content detected but save failed: ${result.error}]`;
  }

  // 2. Convert to string (no-op if already string, toString if Buffer that passed binary check)
  const text = typeof input === 'string' ? input : buffer.toString('utf-8');

  // 2b. Structured JSON extraction path — preserve original JSON, extract binary assets,
  // and emit a linked JSON that replaces base64 blobs with file references.
  const structuredExtraction = extractAssetsFromStructuredJson(text, opts.sessionPath, opts.toolName);
  if (structuredExtraction) {
    debug('large-response', `${opts.toolName}: extracted ${structuredExtraction.assets.length} media assets from structured JSON payload`);
    return formatStructuredMediaExtractionMessage(structuredExtraction);
  }

  // 2c. Inline base64-encoded binary detection (data URLs and raw base64 blobs)
  const base64Result = extractBase64Binary(text);
  if (base64Result) {
    debug('large-response', `${opts.toolName}: ${base64Result.source} binary detected (${base64Result.buffer.length} decoded bytes)`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = sanitizeFilename(opts.toolName);
    const filename = `${safeName}_${timestamp}${base64Result.ext}`;
    const result = saveBinaryResponse(opts.sessionPath, filename, base64Result.buffer, base64Result.mimeType);
    if (result.type === 'file_download') {
      return `[Base64-encoded binary detected and saved]\n\nFile: ${result.path}\nSize: ${result.sizeHuman}\nType: ${base64Result.ext.slice(1).toUpperCase() || 'unknown'}\n\nThe tool result contained base64-encoded binary data which has been decoded and saved.`;
    }
    return `[Base64-encoded binary detected but save failed: ${result.error}]`;
  }

  // 3. Existing size check + summarize flow
  if (estimateTokens(text) <= TOKEN_LIMIT) return null;
  const result = await handleLargeResponse({
    text,
    sessionPath: opts.sessionPath,
    context: { toolName: opts.toolName, input: opts.input, intent: opts.intent },
    summarize: opts.summarize,
  });
  return result?.message ?? null;
}

/**
 * Full pipeline: save to disk, optionally summarize, format result message.
 *
 * Call this when a tool result exceeds TOKEN_LIMIT.
 * If `summarize` callback is provided and tokens are within MAX_SUMMARIZATION_INPUT,
 * it will be called with the built prompt. Otherwise falls back to preview.
 *
 * @returns Formatted result, or null if the text is not large enough to handle
 */
export async function handleLargeResponse(
  opts: HandleLargeResponseOptions
): Promise<HandleLargeResponseResult | null> {
  const { text, sessionPath, context, summarize } = opts;
  const estimatedTokens = estimateTokens(text);

  if (estimatedTokens <= TOKEN_LIMIT) {
    return null; // Not large enough — caller should return as-is
  }

  debug('large-response', `${context.toolName}: ${text.length} bytes, ~${estimatedTokens} tokens`);

  // 1. Save full response to disk
  const saveResult = saveLargeResponse(
    sessionPath,
    context.toolName,
    context.path || '',
    text
  );

  if (!saveResult) {
    // File save failed — return preview without file references
    const preview = text.substring(0, 2000);
    return {
      message: `[Response too large (~${estimatedTokens} tokens)]\n\nPreview:\n${preview}...`,
      filePath: '',
      wasSummarized: false,
    };
  }

  const { absolutePath, relativePath } = saveResult;

  // 2. Try summarization if within limits and callback provided
  let summary: string | undefined;
  if (summarize && estimatedTokens <= MAX_SUMMARIZATION_INPUT) {
    try {
      const prompt = buildSummarizationPrompt(text, context);
      const result = await summarize(prompt);
      if (result) {
        summary = result;
      }
    } catch (error) {
      debug('large-response', `Summarization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3. Format message
  const message = formatLargeResponseMessage({
    estimatedTokens,
    relativePath,
    absolutePath,
    summary,
    preview: summary ? undefined : text.substring(0, 2000),
  });

  return { message, filePath: absolutePath, wasSummarized: !!summary };
}
