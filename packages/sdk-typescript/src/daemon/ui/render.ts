/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PR-D — Render contract.
 *
 * Three helpers that project a `DaemonTranscriptBlock` (or a single
 * `DaemonToolPreview`) into a renderable string:
 *
 * - `daemonBlockToMarkdown` — GFM-compatible markdown for web / docs
 * - `daemonBlockToHtml` — sanitized HTML for SSR / webview surfaces
 * - `daemonBlockToPlainText` — plain text for copy-paste / logs
 * - `daemonToolPreviewToMarkdown` — preview-to-markdown helper used by all
 *   higher-level renderers (consumers can compose freely)
 *
 * The render contract is the missing piece behind "any adapter (TUI / web
 * / IDE / channel) renders the same transcript identically." TUI uses
 * `terminal.ts`'s ANSI projection; this module is the equivalent for the
 * other surfaces.
 */

import type {
  DaemonToolPreview,
  DaemonTranscriptBlock,
  DaemonTranscriptQuestion,
} from './types.js';
import { sanitizeTerminalText } from './utils.js';

export interface DaemonRenderOptions {
  /**
   * When true, image / file URLs are stripped of authentication tokens
   * before rendering. Default: false (caller responsibility).
   */
  sanitizeUrls?: boolean;
  /**
   * Locale for date formatting in any embedded timestamps. Default:
   * runtime default.
   */
  locale?: string;
  /**
   * Max length of any single rendered text field. Strings longer than this
   * are truncated with an ellipsis. Default: 8192. Set to `Infinity` to
   * disable.
   */
  maxFieldLength?: number;
}

const DEFAULT_MAX_FIELD_LENGTH = 8192;

/* ──────────────────────────────────────────────────────────────────────────
 * Markdown
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Render a single transcript block as GFM-compatible markdown.
 *
 * Producers should call this per block and join with `\n\n` between blocks
 * to produce a full transcript document.
 */
export function daemonBlockToMarkdown(
  block: DaemonTranscriptBlock,
  opts: DaemonRenderOptions = {},
): string {
  const cap = capLength(opts);
  const text = (value: string) => cap(sanitizeTerminalText(value));
  switch (block.kind) {
    case 'user':
      return `**You**\n\n${text(block.text)}`;
    case 'assistant':
      return text(block.text);
    case 'thought':
      return `> *thought:* ${text(block.text)}`;
    case 'tool': {
      const header = renderToolHeader(block, opts);
      const previewMd = daemonToolPreviewToMarkdown(block.preview, opts);
      const status = `_status: ${escapeMarkdownText(block.status, opts)}_`;
      const details = block.details ? `\n\n${text(block.details)}` : '';
      return `${header}\n\n${previewMd}\n\n${status}${details}`;
    }
    case 'shell': {
      const lang = block.stream === 'stderr' ? 'shellsession-stderr' : 'shell';
      return markdownFence(lang, text(block.text));
    }
    case 'permission': {
      const optionList = block.options
        .map(
          (opt) =>
            `- **${escapeMarkdownText(opt.label, opts)}**${
              opt.description
                ? ` - ${escapeMarkdownText(opt.description, opts)}`
                : ''
            }`,
        )
        .join('\n');
      const resolved = block.resolved
        ? `\n\n_resolved: ${escapeMarkdownText(block.resolved, opts)}_`
        : '\n\n_awaiting decision_';
      const previewMd = daemonToolPreviewToMarkdown(block.preview, opts);
      return `### Permission: ${escapeMarkdownText(
        block.title,
        opts,
      )}\n\n${previewMd}\n\n${optionList}${resolved}`;
    }
    case 'status':
      return `*${text(block.text)}*`;
    case 'debug':
      return `> debug: ${text(block.text)}`;
    case 'error':
      return `> [!CAUTION]\n> ${text(block.text)}`;
    default:
      return '';
  }
}

function renderToolHeader(
  block: Extract<DaemonTranscriptBlock, { kind: 'tool' }>,
  opts: DaemonRenderOptions = {},
): string {
  // doudouOUC review: forward `opts` so `maxFieldLength` is honored for
  // tool titles / kinds (previously bypassed — a 20KB title would render
  // uncapped while every other text field hit the 8192 default).
  // `escapeMarkdownText` / `inlineCode` apply `capLength` internally when
  // `opts` is provided.
  const parts: string[] = [`### ${escapeMarkdownText(block.title, opts)}`];
  if (block.toolName) parts.push(inlineCode(block.toolName, opts));
  if (block.toolKind) parts.push(`(${escapeMarkdownText(block.toolKind, opts)})`);
  return parts.join(' ');
}

/**
 * Project a `DaemonToolPreview` into markdown. Each kind gets a dedicated
 * shape — diffs become fenced unified-diff blocks, file reads become
 * `path:line-range` lines, etc.
 */
export function daemonToolPreviewToMarkdown(
  preview: DaemonToolPreview,
  opts: DaemonRenderOptions = {},
): string {
  const cap = capLength(opts);
  const text = (value: string) => cap(sanitizeTerminalText(value));
  switch (preview.kind) {
    case 'ask_user_question':
      return preview.questions.map((q) => renderQuestion(q, opts)).join('\n\n');
    case 'command':
      return markdownFence(
        'bash',
        [
          preview.cwd ? `# cwd: ${text(preview.cwd)}` : null,
          text(preview.command),
        ]
          .filter(Boolean)
          .join('\n'),
      );
    case 'file_diff':
      if (preview.patch) {
        return markdownFence('diff', text(preview.patch));
      }
      if (preview.oldText !== undefined && preview.newText !== undefined) {
        return [
          `**Edit ${inlineCode(preview.path, opts)}**`,
          '',
          markdownFence(
            'diff',
            [
              ...text(preview.oldText)
                .split('\n')
                .map((line) => `- ${line}`),
              ...text(preview.newText)
                .split('\n')
                .map((line) => `+ ${line}`),
            ].join('\n'),
          ),
        ].join('\n');
      }
      if (preview.newText !== undefined) {
        return [
          `**Write ${inlineCode(preview.path, opts)}**`,
          '',
          markdownFence('', text(preview.newText)),
        ].join('\n');
      }
      return `**Edit ${inlineCode(preview.path, opts)}**`;
    case 'file_read':
      if (preview.range) {
        return `Read ${inlineCode(preview.path, opts)} (lines ${preview.range[0]}-${preview.range[1]})`;
      }
      return `Read ${inlineCode(preview.path, opts)}`;
    case 'web_fetch': {
      const url = opts.sanitizeUrls ? sanitizeUrl(preview.url) : preview.url;
      return `${escapeMarkdownText(preview.method ?? 'GET', opts)} ${inlineCode(
        url,
        opts,
      )}`;
    }
    case 'mcp_invocation':
      return [
        `**MCP** ${inlineCode(
          `${preview.serverId}::${preview.toolName}`,
          opts,
        )}`,
        preview.argsSummary
          ? `_args:_ ${inlineCode(preview.argsSummary, opts)}`
          : null,
      ]
        .filter(Boolean)
        .join('\n');
    case 'code_block':
      return [
        preview.origin ? `_${escapeMarkdownText(preview.origin, opts)}_` : null,
        markdownFence(
          escapeFenceLanguage(preview.language ?? ''),
          text(preview.code),
        ),
      ]
        .filter(Boolean)
        .join('\n');
    case 'search': {
      const lines = [
        `**Search** ${inlineCode(preview.query, opts)}`,
        preview.resultCount !== undefined
          ? `_${preview.resultCount} result${preview.resultCount === 1 ? '' : 's'}_`
          : null,
      ];
      if (preview.top && preview.top.length > 0) {
        for (const result of preview.top) {
          lines.push(`- ${escapeMarkdownText(result, opts)}`);
        }
      }
      return lines.filter(Boolean).join('\n');
    }
    case 'tabular': {
      if (preview.columns.length === 0) return '_(empty table)_';
      const headerRow = `| ${preview.columns
        .map((column) => escapeTableCell(column, opts))
        .join(' | ')} |`;
      const sepRow = `| ${preview.columns.map(() => '---').join(' | ')} |`;
      const bodyRows = preview.rows.map(
        (row) =>
          `| ${preview.columns
            .map((_, idx) => escapeTableCell(String(row[idx] ?? ''), opts))
            .join(' | ')} |`,
      );
      const lines = [headerRow, sepRow, ...bodyRows];
      if (
        preview.totalRows !== undefined &&
        preview.totalRows > preview.rows.length
      ) {
        lines.push(
          `_… ${preview.totalRows - preview.rows.length} more row(s) not shown_`,
        );
      }
      return lines.join('\n');
    }
    case 'image_generation':
      return [
        `**Image generation**`,
        `> ${text(preview.prompt)}`,
        preview.model
          ? `_model: ${escapeMarkdownText(preview.model, opts)}_`
          : null,
        preview.thumbnailUrl
          ? `![image](${opts.sanitizeUrls ? sanitizeUrl(preview.thumbnailUrl) : preview.thumbnailUrl})`
          : null,
      ]
        .filter(Boolean)
        .join('\n');
    case 'subagent_delegation':
      return [
        `**Delegate -> ${inlineCode(preview.agentName, opts)}**`,
        '',
        `> ${text(preview.task)}`,
        preview.parentDelegationId
          ? `_(chained from ${escapeMarkdownText(
              preview.parentDelegationId,
              opts,
            )})_`
          : null,
      ]
        .filter(Boolean)
        .join('\n');
    case 'key_value':
      return preview.rows
        .map(
          (row) =>
            `- **${escapeMarkdownText(row.label, opts)}:** ${escapeMarkdownText(
              row.value,
              opts,
            )}`,
        )
        .join('\n');
    case 'generic':
      return preview.summary
        ? `_${escapeMarkdownText(preview.summary, opts)}_`
        : '';
    default:
      return '';
  }
}

function markdownFence(language: string, raw: string): string {
  const maxRun = Math.max(
    2,
    ...Array.from(raw.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(maxRun + 1);
  return [`${fence}${language}`, raw, fence].join('\n');
}

function renderQuestion(
  question: DaemonTranscriptQuestion,
  opts: DaemonRenderOptions,
): string {
  const heading = question.header
    ? `**${escapeMarkdownText(question.header, opts)}**\n\n`
    : '';
  const options = question.options
    .map(
      (opt) =>
        `- ${escapeMarkdownText(opt.label, opts)}${
          opt.description
            ? ` - ${escapeMarkdownText(opt.description, opts)}`
            : ''
        }`,
    )
    .join('\n');
  return `${heading}${escapeMarkdownText(question.question, opts)}\n\n${options}`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Plain text
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Render a transcript block as plain text (no markdown formatting, no
 * ANSI). Use for copy-paste, log lines, accessibility-friendly output.
 */
export function daemonBlockToPlainText(
  block: DaemonTranscriptBlock,
  opts: DaemonRenderOptions = {},
): string {
  const cap = capLength(opts);
  switch (block.kind) {
    case 'user':
      return `You: ${cap(block.text)}`;
    case 'assistant':
      return cap(block.text);
    case 'thought':
      return `(thought: ${cap(block.text)})`;
    case 'tool': {
      const header = [
        block.title,
        block.toolName ? `[${block.toolName}]` : null,
        block.toolKind ? `(${block.toolKind})` : null,
      ]
        .filter(Boolean)
        .join(' ');
      // wenshao review (review 4350741340): forward `opts` so
      // `sanitizeUrls` + `maxFieldLength` reach the preview's URL fields
      // (web_fetch URL, image_generation thumbnailUrl). The HTML path at
      // line 509 already did this; plainText was missed in the prior
      // doudouOUC fix.
      const preview = daemonToolPreviewToPlainText(block.preview, opts);
      const status = `status: ${block.status}`;
      return [header, preview, status].filter(Boolean).join('\n');
    }
    case 'shell':
      return `[shell ${block.stream ?? 'stdout'}]\n${cap(block.text)}`;
    case 'permission': {
      const optionList = block.options
        .map(
          (opt) =>
            `  - ${opt.label}${opt.description ? `: ${opt.description}` : ''}`,
        )
        .join('\n');
      const resolved = block.resolved
        ? `(resolved: ${block.resolved})`
        : '(awaiting decision)';
      return `Permission: ${block.title}\n${optionList}\n${resolved}`;
    }
    case 'status':
      return `[status] ${cap(block.text)}`;
    case 'debug':
      return `[debug] ${cap(block.text)}`;
    case 'error':
      return `[error] ${cap(block.text)}`;
    default:
      return '';
  }
}

function daemonToolPreviewToPlainText(
  preview: DaemonToolPreview,
  opts: DaemonRenderOptions = {},
): string {
  // doudouOUC review (Important): thread `sanitizeUrls` through. The HTML
  // path calls this helper to render the tool preview inside the `<pre>`
  // block, but previously the helper took no opts — so even when the
  // caller set `sanitizeUrls: true` to strip auth tokens from URLs, the
  // HTML path leaked tokens into the DOM (markdown path was already safe).
  const url = (u: string) => (opts.sanitizeUrls ? sanitizeUrl(u) : u);
  switch (preview.kind) {
    case 'ask_user_question':
      return preview.questions
        .map((q) => `${q.header ? `${q.header}: ` : ''}${q.question}`)
        .join('\n');
    case 'command':
      return preview.cwd
        ? `$ ${preview.command} (cwd: ${preview.cwd})`
        : `$ ${preview.command}`;
    case 'file_diff':
      if (preview.patch) return preview.patch;
      if (preview.newText !== undefined)
        return `${preview.path}: ${preview.newText}`;
      return preview.path;
    case 'file_read':
      return preview.range
        ? `${preview.path} (lines ${preview.range[0]}-${preview.range[1]})`
        : preview.path;
    case 'web_fetch':
      return `${preview.method ?? 'GET'} ${url(preview.url)}`;
    case 'mcp_invocation':
      return `${preview.serverId}::${preview.toolName}${preview.argsSummary ? ` (${preview.argsSummary})` : ''}`;
    case 'code_block':
      return preview.origin
        ? `[${preview.origin}]\n${preview.code}`
        : preview.code;
    case 'search':
      return [
        `search: ${preview.query}`,
        preview.resultCount !== undefined
          ? `(${preview.resultCount} results)`
          : null,
        ...(preview.top ?? []).map((r) => `  ${r}`),
      ]
        .filter(Boolean)
        .join('\n');
    case 'tabular': {
      if (preview.columns.length === 0) return '(empty table)';
      const lines = [preview.columns.join('\t')];
      for (const row of preview.rows) {
        lines.push(
          preview.columns.map((_, idx) => String(row[idx] ?? '')).join('\t'),
        );
      }
      if (
        preview.totalRows !== undefined &&
        preview.totalRows > preview.rows.length
      ) {
        lines.push(
          `... ${preview.totalRows - preview.rows.length} more row(s)`,
        );
      }
      return lines.join('\n');
    }
    case 'image_generation': {
      const thumb = preview.thumbnailUrl
        ? ` [${url(preview.thumbnailUrl)}]`
        : '';
      return `image: "${preview.prompt}"${preview.model ? ` (${preview.model})` : ''}${thumb}`;
    }
    case 'subagent_delegation':
      return `delegate to ${preview.agentName}: ${preview.task}`;
    case 'key_value':
      return preview.rows.map((r) => `${r.label}: ${r.value}`).join('\n');
    case 'generic':
      return preview.summary ?? '';
    default:
      return '';
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * HTML (with conservative sanitization)
 * ──────────────────────────────────────────────────────────────────────── */

export interface DaemonHtmlRenderOptions extends DaemonRenderOptions {
  /**
   * Custom HTML sanitizer. If omitted, the default escapes `<`, `>`, `&`,
   * `'`, `"` and rejects `javascript:` URLs. Consumers wanting markdown→
   * HTML should pre-render via `daemonBlockToMarkdown` and pass a real
   * markdown→HTML pipeline (e.g., markdown-it + DOMPurify).
   */
  sanitizer?: (raw: string) => string;
}

/**
 * Render a transcript block as conservatively escaped HTML. The default
 * implementation does NOT parse markdown — it only escapes special chars
 * and wraps content in semantic tags. For markdown→HTML, use
 * `daemonBlockToMarkdown` + a markdown pipeline of your choice.
 *
 * Renderers that want richer HTML (collapsible code blocks, syntax
 * highlighting, image rendering) should layer those on top — this is the
 * safe baseline shared across SSR / webview / dashboard surfaces.
 */
export function daemonBlockToHtml(
  block: DaemonTranscriptBlock,
  opts: DaemonHtmlRenderOptions = {},
): string {
  const sanitizer = opts.sanitizer ?? defaultEscapeHtml;
  const cap = capLength(opts);
  switch (block.kind) {
    case 'user':
      return `<div class="daemon-block daemon-user"><strong>You</strong><p>${sanitizer(cap(block.text))}</p></div>`;
    case 'assistant':
      return `<div class="daemon-block daemon-assistant"><p>${sanitizer(cap(block.text))}</p></div>`;
    case 'thought':
      return `<div class="daemon-block daemon-thought"><em>${sanitizer(cap(block.text))}</em></div>`;
    case 'tool': {
      const previewHtml = sanitizer(
        daemonToolPreviewToPlainText(block.preview, opts),
      );
      const safeTitle = sanitizer(cap(block.title));
      const safeStatus = sanitizer(block.status);
      return `<div class="daemon-block daemon-tool" data-status="${safeStatus}"><div class="title">${safeTitle}</div><pre>${previewHtml}</pre></div>`;
    }
    case 'shell':
      return `<pre class="daemon-block daemon-shell" data-stream="${sanitizer(block.stream ?? 'stdout')}">${sanitizer(cap(block.text))}</pre>`;
    case 'permission': {
      const optionList = block.options
        .map(
          (opt) =>
            `<li><strong>${sanitizer(opt.label)}</strong>${opt.description ? ` — ${sanitizer(opt.description)}` : ''}</li>`,
        )
        .join('');
      const resolved = block.resolved
        ? `<p class="resolved">resolved: ${sanitizer(block.resolved)}</p>`
        : '<p class="pending">awaiting decision</p>';
      return `<div class="daemon-block daemon-permission"><h4>${sanitizer(block.title)}</h4><ul>${optionList}</ul>${resolved}</div>`;
    }
    case 'status':
      return `<div class="daemon-block daemon-status">${sanitizer(cap(block.text))}</div>`;
    case 'debug':
      return `<div class="daemon-block daemon-debug">${sanitizer(cap(block.text))}</div>`;
    case 'error':
      return `<div class="daemon-block daemon-error" role="alert">${sanitizer(cap(block.text))}</div>`;
    default:
      return '';
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Internal utilities
 * ──────────────────────────────────────────────────────────────────────── */

function capLength(opts: DaemonRenderOptions): (s: string) => string {
  const max = opts.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;
  if (!Number.isFinite(max) || max <= 0) return (s) => s;
  return (s) => (s.length <= max ? s : `${s.slice(0, max)}… [truncated]`);
}

function escapeMarkdownText(
  raw: string,
  opts: DaemonRenderOptions = {},
): string {
  const capped = capLength(opts)(sanitizeTerminalText(raw));
  return capped.replace(/([\\`*_{}[\]()#+!>-])/g, '\\$1');
}

function inlineCode(raw: string, opts: DaemonRenderOptions = {}): string {
  const value = capLength(opts)(sanitizeTerminalText(raw));
  const maxRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const delimiter = '`'.repeat(maxRun + 1);
  const padded =
    value.startsWith('`') ||
    value.endsWith('`') ||
    value.startsWith(' ') ||
    value.endsWith(' ')
      ? ` ${value} `
      : value;
  return `${delimiter}${padded}${delimiter}`;
}

function escapeTableCell(raw: string, opts: DaemonRenderOptions = {}): string {
  return escapeMarkdownText(raw, opts).replace(/\|/g, '\\|');
}

function escapeFenceLanguage(raw: string): string {
  return sanitizeTerminalText(raw).replace(/[^A-Za-z0-9_+.-]/g, '');
}

function defaultEscapeHtml(raw: string): string {
  // Strip any ANSI / control chars first (defense against agents emitting
  // terminal escapes into HTML); then HTML-escape special characters.
  const sanitized = sanitizeTerminalText(raw);
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip auth query params commonly used in image / CDN URLs and reject
 * non-web protocols. Best-effort — opts-in via `sanitizeUrls`.
 */
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const protocol = u.protocol.toLowerCase();
    if (
      protocol !== 'http:' &&
      protocol !== 'https:' &&
      protocol !== 'mailto:'
    ) {
      return '#';
    }
    for (const key of Array.from(u.searchParams.keys())) {
      if (
        /^(token|key|auth|signature|sig|access|secret|bearer|credential|session|api[_-]?key|x-amz-|x-goog-)/i.test(
          key,
        )
      ) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return '#';
  }
}
