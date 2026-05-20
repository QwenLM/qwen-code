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
  switch (block.kind) {
    case 'user':
      return `**You**\n\n${cap(block.text)}`;
    case 'assistant':
      return cap(block.text);
    case 'thought':
      return `> *thought:* ${cap(block.text)}`;
    case 'tool': {
      const header = renderToolHeader(block);
      const previewMd = daemonToolPreviewToMarkdown(block.preview, opts);
      const status = `_status: ${block.status}_`;
      const details = block.details ? `\n\n${cap(block.details)}` : '';
      return `${header}\n\n${previewMd}\n\n${status}${details}`;
    }
    case 'shell': {
      const lang = block.stream === 'stderr' ? 'shellsession-stderr' : 'shell';
      return ['```' + lang, cap(block.text), '```'].join('\n');
    }
    case 'permission': {
      const optionList = block.options
        .map((opt) => `- **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`)
        .join('\n');
      const resolved = block.resolved
        ? `\n\n_resolved: ${block.resolved}_`
        : '\n\n_awaiting decision_';
      const previewMd = daemonToolPreviewToMarkdown(block.preview, opts);
      return `### Permission: ${block.title}\n\n${previewMd}\n\n${optionList}${resolved}`;
    }
    case 'status':
      return `*${cap(block.text)}*`;
    case 'debug':
      return `> debug: ${cap(block.text)}`;
    case 'error':
      return `> [!CAUTION]\n> ${cap(block.text)}`;
    default:
      return '';
  }
}

function renderToolHeader(
  block: Extract<DaemonTranscriptBlock, { kind: 'tool' }>,
): string {
  const parts: string[] = [`### ${block.title}`];
  if (block.toolName) parts.push(`\`${block.toolName}\``);
  if (block.toolKind) parts.push(`(${block.toolKind})`);
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
  switch (preview.kind) {
    case 'ask_user_question':
      return preview.questions.map(renderQuestion).join('\n\n');
    case 'command':
      return [
        '```bash',
        preview.cwd ? `# cwd: ${preview.cwd}` : null,
        preview.command,
        '```',
      ]
        .filter(Boolean)
        .join('\n');
    case 'file_diff':
      if (preview.patch) {
        return ['```diff', cap(preview.patch), '```'].join('\n');
      }
      if (preview.oldText !== undefined && preview.newText !== undefined) {
        return [
          `**Edit \`${preview.path}\`**`,
          '',
          '```diff',
          ...preview.oldText.split('\n').map((line) => `- ${line}`),
          ...preview.newText.split('\n').map((line) => `+ ${line}`),
          '```',
        ].join('\n');
      }
      if (preview.newText !== undefined) {
        return [
          `**Write \`${preview.path}\`**`,
          '',
          '```',
          cap(preview.newText),
          '```',
        ].join('\n');
      }
      return `**Edit \`${preview.path}\`**`;
    case 'file_read':
      if (preview.range) {
        return `Read \`${preview.path}\` (lines ${preview.range[0]}–${preview.range[1]})`;
      }
      return `Read \`${preview.path}\``;
    case 'web_fetch': {
      const url = opts.sanitizeUrls ? sanitizeUrl(preview.url) : preview.url;
      return `${preview.method ?? 'GET'} ${url}`;
    }
    case 'mcp_invocation':
      return [
        `**MCP** \`${preview.serverId}::${preview.toolName}\``,
        preview.argsSummary ? `_args:_ \`${preview.argsSummary}\`` : null,
      ]
        .filter(Boolean)
        .join('\n');
    case 'key_value':
      return preview.rows
        .map((row) => `- **${row.label}:** ${cap(row.value)}`)
        .join('\n');
    case 'generic':
      return preview.summary ? `_${preview.summary}_` : '';
    default:
      return '';
  }
}

function renderQuestion(question: DaemonTranscriptQuestion): string {
  const heading = question.header ? `**${question.header}**\n\n` : '';
  const options = question.options
    .map(
      (opt) =>
        `- ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`,
    )
    .join('\n');
  return `${heading}${question.question}\n\n${options}`;
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
      const preview = daemonToolPreviewToPlainText(block.preview);
      const status = `status: ${block.status}`;
      return [header, preview, status].filter(Boolean).join('\n');
    }
    case 'shell':
      return `[shell ${block.stream ?? 'stdout'}]\n${cap(block.text)}`;
    case 'permission': {
      const optionList = block.options
        .map((opt) => `  - ${opt.label}${opt.description ? `: ${opt.description}` : ''}`)
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

function daemonToolPreviewToPlainText(preview: DaemonToolPreview): string {
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
      if (preview.newText !== undefined) return `${preview.path}: ${preview.newText}`;
      return preview.path;
    case 'file_read':
      return preview.range
        ? `${preview.path} (lines ${preview.range[0]}-${preview.range[1]})`
        : preview.path;
    case 'web_fetch':
      return `${preview.method ?? 'GET'} ${preview.url}`;
    case 'mcp_invocation':
      return `${preview.serverId}::${preview.toolName}${preview.argsSummary ? ` (${preview.argsSummary})` : ''}`;
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
        daemonToolPreviewToPlainText(block.preview),
      );
      const safeTitle = sanitizer(block.title);
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
 * Strip `?<token>=...` query params commonly used for auth in image / CDN
 * URLs. Best-effort — opts-in via `sanitizeUrls`.
 */
function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^(token|key|auth|signature|sig|x-amz-|x-goog-)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}
