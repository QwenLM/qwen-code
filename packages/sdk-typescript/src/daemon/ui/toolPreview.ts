/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonToolPreview,
  DaemonTranscriptQuestion,
  DaemonTranscriptQuestionOption,
} from './types.js';
import {
  getFirstString,
  isRecord,
  isSensitiveKey,
  stringifyJson,
  stringifyRedactedJson,
} from './utils.js';

const MAX_TOOL_PREVIEW_DEPTH = 8;

export function createDaemonToolPreview(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string } = {},
  depth = 0,
): DaemonToolPreview {
  if (depth > MAX_TOOL_PREVIEW_DEPTH) {
    const summary = opts.title ?? opts.toolName ?? opts.toolKind;
    return { kind: 'generic', ...(summary ? { summary } : {}) };
  }

  if (isRecord(input)) {
    const nestedInput = input['rawInput'] ?? input['input'] ?? input['args'];
    if (nestedInput !== undefined && nestedInput !== input) {
      const nested = createDaemonToolPreview(
        nestedInput,
        {
          title: opts.title ?? getFirstString(input, ['title']),
          toolName:
            opts.toolName ?? getFirstString(input, ['toolName', 'name']),
          toolKind: opts.toolKind ?? getFirstString(input, ['kind']),
        },
        depth + 1,
      );
      if (nested.kind !== 'generic' || !nested.summary) return nested;
    }
  }

  const askUserQuestions = extractAskUserQuestions(input);
  if (askUserQuestions.length > 0) {
    return { kind: 'ask_user_question', questions: askUserQuestions };
  }

  // PR-C / PR-F: try specific tool-shape detectors before falling back to
  // generic command / key_value detection. Detector order matters —
  // most specific wins.
  const mcpPreview = detectMcpInvocation(input, opts);
  if (mcpPreview) return mcpPreview;

  // PR-F detectors (subagent_delegation / search / image_generation
  // before file_diff because some sub-agent tool calls embed file ops
  // in their payload — provenance still wins for MCP though).
  const subagent = detectSubagentDelegation(input, opts);
  if (subagent) return subagent;

  const search = detectSearch(input, opts);
  if (search) return search;

  const imageGeneration = detectImageGeneration(input, opts);
  if (imageGeneration) return imageGeneration;

  const fileDiff = detectFileDiff(input, opts);
  if (fileDiff) return fileDiff;

  const fileRead = detectFileRead(input, opts);
  if (fileRead) return fileRead;

  const webFetch = detectWebFetch(input);
  if (webFetch) return webFetch;

  const codeBlock = detectCodeBlock(input, opts);
  if (codeBlock) return codeBlock;

  const tabular = detectTabular(input);
  if (tabular) return tabular;

  if (isRecord(input)) {
    const command = getFirstString(input, ['command', 'cmd']);
    if (command) {
      const cwd = getFirstString(input, [
        'cwd',
        'directory',
        'workingDirectory',
      ]);
      return { kind: 'command', command, ...(cwd ? { cwd } : {}) };
    }

    const rows = collectPreviewRows(input);
    if (rows.length > 0) {
      return { kind: 'key_value', rows };
    }
  }

  const summary = opts.title ?? opts.toolName ?? opts.toolKind;
  return { kind: 'generic', ...(summary ? { summary } : {}) };
}

/**
 * Detect file-edit tool calls by signature. Matches:
 *
 * - Anthropic-style: `oldText` + `newText` (or `old_str` + `new_str`)
 * - Aider-style: `patch` text
 * - All variants require a `path` / `filePath` field.
 */
function detectFileDiff(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string } = {},
): DaemonToolPreview | undefined {
  if (!isRecord(input)) return undefined;
  const path = getFirstString(input, [
    'path',
    'filePath',
    'file_path',
    'absolutePath',
  ]);
  if (!path) return undefined;
  const oldText = getFirstString(input, [
    'oldText',
    'old_text',
    'old_str',
    'oldString',
  ]);
  // wenshao R4 (qwen3.7-max): `content` is too ambiguous as a newText
  // alias — `{ path, content }` is a common shape for both file writes
  // AND read assertions / search queries / file_read results echoed in
  // rawInput. Since `detectFileDiff` runs BEFORE `detectFileRead` in the
  // detector chain, accepting `content` would mis-classify reads as
  // writes. Restrict bare `content` to tools whose name signals a write
  // (`write` / `create` / `edit` / `replace` / `save`); otherwise
  // require an explicit `newText` / `new_str` / `newString` alias OR
  // co-occurrence with `oldText` (edit shape).
  const explicitNewText = getFirstString(input, [
    'newText',
    'new_text',
    'new_str',
    'newString',
  ]);
  const toolNameLower = (opts.toolName ?? '').toLowerCase();
  // wenshao R5 (deepseek-v4-pro): use `_`/`-`/start/end boundaries
  // instead of `\b`. `\b` doesn't match between `write` and `_` in
  // `write_file` (both are `\w` in regex), so it failed to recognize
  // the canonical write-tool naming convention. The custom anchor
  // catches `write_file`/`write-file`/`write` but rejects
  // `prewrite_check`/`downloader`.
  const writeIntent =
    /(?:^|[_-])(write|create|edit|replace|save|update|overwrite|modify|patch|generate)(?:$|[_-])/.test(
      toolNameLower,
    ) || !!oldText;
  const contentField =
    explicitNewText === undefined && writeIntent
      ? getFirstString(input, ['content'])
      : undefined;
  const newText = explicitNewText ?? contentField;
  const patch = getFirstString(input, ['patch', 'diff', 'unified_diff']);
  // Require at least one of: oldText+newText pair (edit), patch (apply),
  // newText (write). Pure path with no diff content → not a diff preview.
  if (!oldText && !newText && !patch) return undefined;
  return {
    kind: 'file_diff',
    path,
    ...(oldText ? { oldText } : {}),
    ...(newText ? { newText } : {}),
    ...(patch ? { patch } : {}),
  };
}

/**
 * Detect file-read tool calls. Requires a path-like field and either an
 * explicit read intent (toolName matches /read/i) OR optional range
 * fields (lineRange / offset+limit).
 */
function detectFileRead(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string },
): DaemonToolPreview | undefined {
  if (!isRecord(input)) return undefined;
  const path = getFirstString(input, [
    'path',
    'filePath',
    'file_path',
    'absolutePath',
  ]);
  if (!path) return undefined;
  const toolName = opts.toolName ?? getFirstString(input, ['toolName', 'name']);
  const looksLikeRead =
    toolName !== undefined && /read|view|cat/i.test(toolName);
  // Range extraction: prefer explicit lineRange tuple, fall back to
  // offset+limit pair.
  const rangeArr = input['lineRange'] ?? input['line_range'] ?? input['range'];
  let range: readonly [number, number] | undefined;
  if (
    Array.isArray(rangeArr) &&
    rangeArr.length === 2 &&
    typeof rangeArr[0] === 'number' &&
    typeof rangeArr[1] === 'number'
  ) {
    range = [rangeArr[0], rangeArr[1]] as const;
  } else {
    const offset = input['offset'];
    const limit = input['limit'];
    if (typeof offset === 'number' && typeof limit === 'number' && limit > 0) {
      // wenshao R4 (qwen3.7-max): convert 0-based offset+limit pair to
      // 1-based inclusive range, matching the documented `range` type
      // (`Optional [startLine, endLine] 1-based inclusive`).
      // For offset=0, limit=10 the old formula produced [0, 9] which
      // displayed as "lines 0-9" — line 0 doesn't exist in 1-based.
      range = [offset + 1, offset + limit] as const;
    }
  }
  if (!looksLikeRead && !range) return undefined;
  return {
    kind: 'file_read',
    path,
    ...(range ? { range } : {}),
  };
}

/**
 * Detect web_fetch tool calls. Matches a URL field plus optional method.
 */
function detectWebFetch(input: unknown): DaemonToolPreview | undefined {
  if (!isRecord(input)) return undefined;
  const url = getFirstString(input, ['url', 'uri', 'href']);
  if (!url) return undefined;
  // Require a `url` scheme to avoid false positives on relative paths.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return undefined;
  const method = getFirstString(input, ['method', 'httpMethod']);
  return {
    kind: 'web_fetch',
    url,
    ...(method ? { method } : {}),
  };
}

/**
 * Detect MCP-invocation tool calls. Uses the `mcp__<server>__<tool>`
 * naming convention from the provenance heuristic — same one introduced
 * for `DaemonUiToolUpdateEvent.provenance` in PR-A. Lets the preview
 * carry server + tool name structurally instead of as a generic title.
 */
function detectMcpInvocation(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string },
): DaemonToolPreview | undefined {
  const toolName =
    opts.toolName ??
    (isRecord(input) ? getFirstString(input, ['toolName', 'name']) : undefined);
  if (!toolName || !toolName.startsWith('mcp__')) return undefined;
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return undefined;
  const serverId = rest.slice(0, sep);
  const toolPart = rest.slice(sep + 2);
  // Summarize args for inline display — first key=value when possible.
  let argsSummary: string | undefined;
  if (isRecord(input)) {
    const args = input['arguments'] ?? input['args'] ?? input;
    if (isRecord(args)) {
      const firstEntry = Object.entries(args)
        .filter(([key]) => key !== 'name' && key !== 'toolName')
        .slice(0, 1)
        .map(([key, value]) => {
          const v = typeof value === 'string' ? value : JSON.stringify(value);
          const trimmed = v.length > 60 ? `${v.slice(0, 60)}…` : v;
          return `${key}=${trimmed}`;
        })[0];
      if (firstEntry) argsSummary = firstEntry;
    }
  }
  return {
    kind: 'mcp_invocation',
    serverId,
    toolName: toolPart,
    ...(argsSummary ? { argsSummary } : {}),
  };
}

function extractAskUserQuestions(input: unknown): DaemonTranscriptQuestion[] {
  if (!isRecord(input) || !Array.isArray(input['questions'])) return [];
  return input['questions'].filter(isRecord).map((question) => {
    const header = getFirstString(question, ['header', 'title', 'label']);
    const prompt =
      getFirstString(question, ['question', 'prompt', 'text']) ?? 'Question';
    const options = Array.isArray(question['options'])
      ? question['options'].filter(isRecord).map(normalizeQuestionOption)
      : [];
    return {
      ...(header ? { header } : {}),
      question: prompt,
      options,
      raw: question,
    };
  });
}

function normalizeQuestionOption(
  option: Record<string, unknown>,
): DaemonTranscriptQuestionOption {
  const label = getFirstString(option, ['label', 'title', 'value']) ?? 'Option';
  const description = getFirstString(option, ['description', 'detail', 'text']);
  return {
    label,
    ...(description ? { description } : {}),
    raw: option,
  };
}

function collectPreviewRows(
  input: Record<string, unknown>,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const candidates: Array<[string, readonly string[]]> = [
    ['Path', ['path', 'filePath', 'file_path', 'absolutePath']],
    ['Cwd', ['cwd', 'directory', 'workingDirectory']],
    ['Query', ['query', 'pattern', 'search']],
    ['Note', ['description', 'reason']],
  ];

  for (const [label, keys] of candidates) {
    const value = getFirstString(input, keys);
    if (value) rows.push({ label, value });
  }

  if (rows.length > 0) return rows;

  for (const [key, value] of Object.entries(input).slice(0, 4)) {
    if (value === undefined || value === null || Array.isArray(value)) continue;
    if (isRecord(value)) continue;
    rows.push({
      label: key,
      value: isSensitiveKey(key) ? '[redacted]' : stringifyRedactedJson(value),
    });
  }
  return rows;
}

/* ──────────────────────────────────────────────────────────────────────────
 * PR-F detectors — long-tail preview kinds
 * ──────────────────────────────────────────────────────────────────────── */

const MAX_TABULAR_ROWS = 50;
const MAX_SEARCH_TOP_RESULTS = 5;

/**
 * Detect sub-agent delegation. Matches toolName containing "delegate" /
 * "subagent" / "spawn-task" / "Task" (Anthropic-style) plus an explicit
 * agent name or prompt-like field.
 */
function detectSubagentDelegation(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string },
): DaemonToolPreview | undefined {
  const toolName = opts.toolName ?? '';
  // wenshao R3 (claude-opus-4-7): `task` was previously matched in either
  // `^|_` position, which falsely caught `edit_task`, `list_task`,
  // `create_task`, etc. — common tool names that have nothing to do with
  // sub-agent delegation. The Anthropic-style delegation tool is
  // literally named `Task` (no prefix), so restrict the bare-`task`
  // match to whole-name only. `delegate` / `subagent` / `spawn_task`
  // are specific enough to keep the `^|_` prefix.
  const looksLikeDelegate =
    /^task$/i.test(toolName) ||
    /(?:^|_)(?:delegate|subagent|spawn[_-]?task)$/i.test(toolName) ||
    /agent/i.test(opts.toolKind ?? '');
  if (!looksLikeDelegate) return undefined;
  if (!isRecord(input)) return undefined;
  const agentName = getFirstString(input, [
    'subagent_type',
    'agent',
    'agentName',
    'agent_name',
    'subagent',
  ]);
  const task = getFirstString(input, [
    'prompt',
    'task',
    'description',
    'instruction',
    'query',
  ]);
  if (!agentName && !task) return undefined;
  const parentDelegationId = getFirstString(input, [
    'parentDelegationId',
    'parent_delegation_id',
    'parent_id',
  ]);
  return {
    kind: 'subagent_delegation',
    agentName: agentName ?? 'subagent',
    task: task ?? '(no task description)',
    ...(parentDelegationId ? { parentDelegationId } : {}),
  };
}

/**
 * Detect search / grep tools. Requires a `query` / `pattern` / `search`
 * field plus tool name hinting at search, OR an explicit result count.
 */
function detectSearch(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string },
): DaemonToolPreview | undefined {
  if (!isRecord(input)) return undefined;
  const query = getFirstString(input, ['query', 'pattern', 'search', 'q']);
  if (!query) return undefined;
  const toolName = opts.toolName ?? '';
  const looksLikeSearch =
    /(grep|search|find|ripgrep|rg|glob|lookup)/i.test(toolName) ||
    typeof input['resultCount'] === 'number' ||
    Array.isArray(input['results']) ||
    Array.isArray(input['matches']);
  if (!looksLikeSearch) return undefined;
  const resultCount =
    typeof input['resultCount'] === 'number'
      ? (input['resultCount'] as number)
      : typeof input['total'] === 'number'
        ? (input['total'] as number)
        : Array.isArray(input['results'])
          ? (input['results'] as unknown[]).length
          : Array.isArray(input['matches'])
            ? (input['matches'] as unknown[]).length
            : undefined;
  let top: string[] | undefined;
  const rawResults =
    (input['results'] as unknown) ?? (input['matches'] as unknown);
  if (Array.isArray(rawResults)) {
    top = rawResults
      .slice(0, MAX_SEARCH_TOP_RESULTS)
      .map((item) => {
        if (typeof item === 'string') return item;
        if (isRecord(item)) {
          return (
            getFirstString(item, ['path', 'file', 'name', 'title', 'text']) ??
            stringifyJson(item).slice(0, 120)
          );
        }
        return String(item);
      })
      .filter(Boolean);
    if (top.length === 0) top = undefined;
  }
  return {
    kind: 'search',
    query,
    ...(resultCount !== undefined ? { resultCount } : {}),
    ...(top ? { top } : {}),
  };
}

/**
 * Detect image generation tools. Matches toolName like `image` / `diffusion`
 * / `dalle` / `imagen` / `flux` plus a `prompt` field.
 */
function detectImageGeneration(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string },
): DaemonToolPreview | undefined {
  const toolName = opts.toolName ?? '';
  const looksLikeImageGen =
    /(image[_-]?gen|generate[_-]?image|diffusion|dalle|imagen|flux|stable[_-]?diffusion|midjourney|sora)/i.test(
      toolName,
    );
  if (!looksLikeImageGen) return undefined;
  if (!isRecord(input)) return undefined;
  const prompt = getFirstString(input, ['prompt', 'description', 'query']);
  if (!prompt) return undefined;
  const thumbnailUrl = getFirstString(input, [
    'thumbnailUrl',
    'thumbnail',
    'url',
    'imageUrl',
    'preview',
  ]);
  const model = getFirstString(input, ['model', 'modelId', 'model_name']);
  return {
    kind: 'image_generation',
    prompt,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * Detect code-block style output. Matches an explicit `code` / `language`
 * pair (often used by REPL / formatter / generator tools), or a `language`
 * + `text` combo. Heuristic-only — falls through when ambiguous.
 */
function detectCodeBlock(
  input: unknown,
  opts: { title?: string; toolName?: string; toolKind?: string },
): DaemonToolPreview | undefined {
  if (!isRecord(input)) return undefined;
  const code = getFirstString(input, ['code', 'snippet', 'source']);
  if (!code) return undefined;
  const language = getFirstString(input, [
    'language',
    'lang',
    'codeLanguage',
    'syntax',
  ]);
  // Require either an explicit language OR a tool name that suggests
  // code (formatter/repl/generator) to avoid grabbing every `code: '...'`
  // field on unrelated tools.
  const toolName = opts.toolName ?? '';
  const codeTool =
    /(repl|format|prettier|eslint|tsc|compile|exec[_-]?code)/i.test(toolName);
  if (!language && !codeTool) return undefined;
  const origin = getFirstString(input, ['origin', 'source_location', 'path']);
  return {
    kind: 'code_block',
    code,
    ...(language ? { language } : {}),
    ...(origin ? { origin } : {}),
  };
}

/**
 * Detect tabular output. Matches `columns: string[]` + `rows: unknown[][]`
 * exact shape, or `data: Array<Record<string, unknown>>` legacy shape.
 */
function detectTabular(input: unknown): DaemonToolPreview | undefined {
  if (!isRecord(input)) return undefined;
  // Strict shape: columns + rows
  const explicitColumns = input['columns'];
  const explicitRows = input['rows'];
  if (Array.isArray(explicitColumns) && Array.isArray(explicitRows)) {
    const columns = explicitColumns
      .filter((c): c is string => typeof c === 'string')
      .slice(0, 30);
    if (columns.length === 0) return undefined;
    const rows = explicitRows
      .slice(0, MAX_TABULAR_ROWS)
      .map((row) =>
        Array.isArray(row)
          ? row.map((cell) =>
              typeof cell === 'string'
                ? cell
                : stringifyJson(cell).slice(0, 80),
            )
          : [],
      );
    return {
      kind: 'tabular',
      columns,
      rows,
      ...(explicitRows.length > rows.length
        ? { totalRows: explicitRows.length }
        : {}),
    };
  }
  // Legacy shape: array of objects (each row a record). Infer columns from
  // the first row's keys.
  const data = input['data'] ?? input['records'];
  if (Array.isArray(data) && data.length > 0 && isRecord(data[0])) {
    const columns = Object.keys(data[0] as Record<string, unknown>).slice(
      0,
      30,
    );
    if (columns.length === 0) return undefined;
    const rows = data.slice(0, MAX_TABULAR_ROWS).map((row) => {
      const r = row as Record<string, unknown>;
      return columns.map((col) => {
        const v = r[col];
        return typeof v === 'string' ? v : stringifyJson(v).slice(0, 80);
      });
    });
    return {
      kind: 'tabular',
      columns,
      rows,
      ...(data.length > rows.length ? { totalRows: data.length } : {}),
    };
  }
  return undefined;
}
