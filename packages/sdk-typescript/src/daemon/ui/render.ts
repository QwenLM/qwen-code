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
      // Blockquote each line so multi-line
      // reasoning traces don't escape the `>` indent on newline.
      return blockquote(`*thought:* ${text(block.text)}`);
    case 'tool': {
      const header = renderToolHeader(block, opts);
      const previewMd = daemonToolPreviewToMarkdown(block.preview, opts);
      const status = `_status: ${escapeMarkdownText(block.status, opts)}_`;
      // Note: `block.details` is the
      // serialized `rawInput` JSON. When `rawInput.url` contains
      // credentials (Basic Auth in userinfo / OAuth in `#fragment` /
      // signed-URL query params), the preview path correctly sanitizes
      // via `sanitizeUrl`, but the details dump previously passed the
      // raw JSON through `text()` which only handled ANSI/bidi. HTML +
      // plaintext branches exclude details entirely; markdown's
      // asymmetry leaked credentials. When `sanitizeUrls: true`,
      // run a URL-credential-stripping pass over the details string so
      // markdown matches the other render paths' safety baseline.
      const detailsText = block.details
        ? opts.sanitizeUrls
          ? sanitizeUrlsInText(block.details)
          : block.details
        : undefined;
      const details = detailsText ? `\n\n${text(detailsText)}` : '';
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
      return blockquote(`debug: ${text(block.text)}`);
    case 'error':
      return `> [!CAUTION]\n${blockquote(text(block.text))}`;
    case 'prompt_cancelled':
      return '*Prompt cancelled*';
    default:
      return '';
  }
}

function renderToolHeader(
  block: Extract<DaemonTranscriptBlock, { kind: 'tool' }>,
  opts: DaemonRenderOptions = {},
): string {
  // Forward `opts` so `maxFieldLength` is honored for
  // tool titles / kinds (previously bypassed — a 20KB title would render
  // uncapped while every other text field hit the 8192 default).
  // `escapeMarkdownText` / `inlineCode` apply `capLength` internally when
  // `opts` is provided.
  const parts: string[] = [`### ${escapeMarkdownText(block.title, opts)}`];
  if (block.toolName) parts.push(inlineCode(block.toolName, opts));
  if (block.toolKind)
    parts.push(`(${escapeMarkdownText(block.toolKind, opts)})`);
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
        blockquote(text(preview.prompt)),
        preview.model
          ? `_model: ${escapeMarkdownText(preview.model, opts)}_`
          : null,
        preview.thumbnailUrl
          ? // Always protocol-validate image
            // URLs regardless of `sanitizeUrls` opt-in. `javascript:` /
            // `vbscript:` in `<img src>` is never legitimate; the markdown
            // pipeline will convert `![image](javascript:...)` into an
            // attacker-controlled `<img src>` in most renderers.
            // `sanitizeUrls: true` additionally strips query-param
            // tokens + Basic Auth.
            `![image](${
              opts.sanitizeUrls
                ? sanitizeUrl(preview.thumbnailUrl)
                : ensureSafeImageUrl(preview.thumbnailUrl)
            })`
          : null,
      ]
        .filter(Boolean)
        .join('\n');
    case 'subagent_delegation':
      return [
        `**Delegate -> ${inlineCode(preview.agentName, opts)}**`,
        '',
        blockquote(text(preview.task)),
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

/**
 * Prefix every line of `raw` with `> ` so a markdown blockquote stays
 * intact across newlines. The naive `> ${text}` form only quotes the
 * first line; subsequent lines render as bare markdown.
 */
function blockquote(raw: string): string {
  return raw
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
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
  // Sanitize ANSI / bidi controls in plain text
  // for parity with markdown (which calls sanitizeTerminalText via `text()`)
  // and HTML (via defaultEscapeHtml). Without this, terminal escapes and
  // bidi overrides survived into plaintext output — contradicting the
  // "for copy-paste / logs" JSDoc intent.
  const cap = capLength(opts);
  const clean = (raw: string) => cap(sanitizeTerminalText(raw));
  switch (block.kind) {
    case 'user':
      return `You: ${clean(block.text)}`;
    case 'assistant':
      return clean(block.text);
    case 'thought':
      return `(thought: ${clean(block.text)})`;
    case 'tool': {
      // Cap header fields. Markdown + HTML
      // paths cap; plainText path previously rendered uncapped titles.
      const header = [
        clean(block.title),
        block.toolName ? `[${clean(block.toolName)}]` : null,
        block.toolKind ? `(${clean(block.toolKind)})` : null,
      ]
        .filter(Boolean)
        .join(' ');
      // Forward `opts` so
      // `sanitizeUrls` + `maxFieldLength` reach the preview's URL fields
      // (web_fetch URL, image_generation thumbnailUrl). The HTML path at
      // line 509 already did this; plainText was missed in the prior
      // Fix:
      const preview = daemonToolPreviewToPlainText(block.preview, opts);
      const status = `status: ${block.status}`;
      return [header, preview, status].filter(Boolean).join('\n');
    }
    case 'shell':
      return `[shell ${block.stream ?? 'stdout'}]\n${clean(block.text)}`;
    case 'permission': {
      // Cap permission fields for parity.
      const optionList = block.options
        .map(
          (opt) =>
            `  - ${clean(opt.label)}${opt.description ? `: ${clean(opt.description)}` : ''}`,
        )
        .join('\n');
      const resolved = block.resolved
        ? `(resolved: ${clean(block.resolved)})`
        : '(awaiting decision)';
      return `Permission: ${clean(block.title)}\n${optionList}\n${resolved}`;
    }
    case 'status':
      return `[status] ${clean(block.text)}`;
    case 'debug':
      return `[debug] ${clean(block.text)}`;
    case 'error':
      return `[error] ${clean(block.text)}`;
    case 'prompt_cancelled':
      return '[cancelled] prompt cancelled';
    default:
      return '';
  }
}

function daemonToolPreviewToPlainText(
  preview: DaemonToolPreview,
  opts: DaemonRenderOptions = {},
): string {
  // Thread `sanitizeUrls` through. The HTML
  // path calls this helper to render the tool preview inside the `<pre>`
  // block, but previously the helper took no opts — so even when the
  // caller set `sanitizeUrls: true` to strip auth tokens from URLs, the
  // HTML path leaked tokens into the DOM (markdown path was already safe).
  //
  // Apply `maxFieldLength` for
  // parity with markdown's `text()` wrapper. Previously plaintext /
  // HTML preview content was uncapped while every other field hit the
  // 8192 default.
  const url = (u: string) => (opts.sanitizeUrls ? sanitizeUrl(u) : u);
  const cap = capLength(opts);
  switch (preview.kind) {
    case 'ask_user_question':
      return preview.questions
        .map((q) => `${q.header ? `${cap(q.header)}: ` : ''}${cap(q.question)}`)
        .join('\n');
    case 'command':
      return preview.cwd
        ? `$ ${cap(preview.command)} (cwd: ${cap(preview.cwd)})`
        : `$ ${cap(preview.command)}`;
    case 'file_diff':
      if (preview.patch) return cap(preview.patch);
      if (preview.newText !== undefined)
        return `${cap(preview.path)}: ${cap(preview.newText)}`;
      return cap(preview.path);
    case 'file_read':
      return preview.range
        ? `${cap(preview.path)} (lines ${preview.range[0]}-${preview.range[1]})`
        : cap(preview.path);
    case 'web_fetch':
      return `${preview.method ?? 'GET'} ${cap(url(preview.url))}`;
    case 'mcp_invocation':
      return `${cap(preview.serverId)}::${cap(preview.toolName)}${preview.argsSummary ? ` (${cap(preview.argsSummary)})` : ''}`;
    case 'code_block':
      return preview.origin
        ? `[${cap(preview.origin)}]\n${cap(preview.code)}`
        : cap(preview.code);
    case 'search':
      return [
        `search: ${cap(preview.query)}`,
        preview.resultCount !== undefined
          ? `(${preview.resultCount} results)`
          : null,
        ...(preview.top ?? []).map((r) => `  ${cap(r)}`),
      ]
        .filter(Boolean)
        .join('\n');
    case 'tabular': {
      if (preview.columns.length === 0) return '(empty table)';
      const lines = [preview.columns.map((c) => cap(c)).join('\t')];
      for (const row of preview.rows) {
        lines.push(
          preview.columns
            .map((_, idx) => cap(String(row[idx] ?? '')))
            .join('\t'),
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
        ? // Image URLs also get protocol validation even when sanitizeUrls
          // is false (XSS defense for img-src contexts).
          ` [${
            opts.sanitizeUrls
              ? sanitizeUrl(preview.thumbnailUrl)
              : ensureSafeImageUrl(preview.thumbnailUrl)
          }]`
        : '';
      return `image: "${cap(preview.prompt)}"${preview.model ? ` (${cap(preview.model)})` : ''}${thumb}`;
    }
    case 'subagent_delegation':
      return `delegate to ${cap(preview.agentName)}: ${cap(preview.task)}`;
    case 'key_value':
      return preview.rows
        .map((r) => `${cap(r.label)}: ${cap(r.value)}`)
        .join('\n');
    case 'generic':
      return preview.summary ? cap(preview.summary) : '';
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
      // Apply `cap()` for parity with every
      // other block kind in this function. The tool block's `cap(title)`
      // was added in the prior round; permission was overlooked.
      const optionList = block.options
        .map(
          (opt) =>
            `<li><strong>${sanitizer(cap(opt.label))}</strong>${opt.description ? ` — ${sanitizer(cap(opt.description))}` : ''}</li>`,
        )
        .join('');
      const resolved = block.resolved
        ? `<p class="resolved">resolved: ${sanitizer(cap(block.resolved))}</p>`
        : '<p class="pending">awaiting decision</p>';
      return `<div class="daemon-block daemon-permission"><h4>${sanitizer(cap(block.title))}</h4><ul>${optionList}</ul>${resolved}</div>`;
    }
    case 'status':
      return `<div class="daemon-block daemon-status">${sanitizer(cap(block.text))}</div>`;
    case 'debug':
      return `<div class="daemon-block daemon-debug">${sanitizer(cap(block.text))}</div>`;
    case 'error':
      return `<div class="daemon-block daemon-error" role="alert">${sanitizer(cap(block.text))}</div>`;
    case 'prompt_cancelled':
      return '<div class="daemon-block daemon-cancelled">prompt cancelled</div>';
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
  // Include `<` so consumers piping the
  // markdown output through markdown-it (with `html: true`) or any
  // HTML-backed renderer don't see raw `<script>` / `<img onerror>` /
  // etc. survive through to the DOM. The HTML render path already
  // escapes via `defaultEscapeHtml`; this brings the markdown path to
  // the same safety baseline. Pure-markdown consumers see `\<` which
  // renders as `<` — no visual change.
  return capped.replace(/([\\`*_{}[\]()#+!><-])/g, '\\$1');
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
    // Clear HTTP Basic Auth credentials.
    // URLs like `https://admin:sk-abc123@api.example.com/v1/models`
    // previously passed through with `userinfo` intact, leaking secrets
    // into rendered markdown / HTML / plaintext output. Sanitization
    // must cover both query-param tokens AND the userinfo component.
    u.username = '';
    u.password = '';
    // Widen regex to catch additional cloud
    // provider credential / signed-URL params:
    //   - AWS S3 presigned: `AWSAccessKeyId` (case-insensitive starts
    //     with `aws`), `X-Amz-*` (already covered)
    //   - GCP signed: `GoogleAccessId`, `Signature` (already), `Expires`
    //   - Azure SAS: short codes `sv`/`se`/`sr`/`sp`/`st`/`spr`/`sip`/`ss`/`srt`/`sig`
    // `Expires` is included because in signed-URL contexts it pairs with
    // the credential; non-signed URLs typically don't include it as a
    // top-level query param so the false-positive risk is bounded.
    const AZURE_SAS_KEYS = new Set([
      'sv',
      'se',
      'sr',
      'sp',
      'st',
      'spr',
      'sip',
      'ss',
      'srt',
      'sig',
      'skoid',
      'sktid',
      'skt',
      'ske',
      'sks',
      'skv',
    ]);
    for (const key of Array.from(u.searchParams.keys())) {
      const k = key.toLowerCase();
      if (
        /^(token|key|auth|signature|sig|access|secret|bearer|credential|session|api[_-]?key|x-amz-|x-goog-|aws|google|expires)/i.test(
          key,
        ) ||
        AZURE_SAS_KEYS.has(k)
      ) {
        u.searchParams.delete(key);
      }
    }
    // Clear the URL fragment. OAuth
    // 2.0 implicit-grant flow places `access_token` directly in
    // `#fragment` (e.g., `https://app/#access_token=gho_xxx&token_type=bearer`),
    // and some Azure SAS variants similarly use the fragment. The
    // previous serialization preserved `u.hash` and leaked credentials
    // even when the query path was scrubbed. The fragment is for
    // client-side state only; for rendered output, dropping it is safe
    // and removes the leak surface entirely.
    u.hash = '';
    return u.toString();
  } catch {
    return '#';
  }
}

/**
 * Run `sanitizeUrl` over every `http://` / `https://` URL embedded in a
 * free-text string (e.g., the serialized `rawInput` JSON exposed via
 * `block.details`). Bounded by URL-shaped substrings; non-URL text is
 * passed through verbatim.
 *
 * When `rawInput.url` carries credentials in
 * userinfo / `#fragment` / signed-URL query params, the preview path
 * sanitizes correctly but the details dump in markdown leaked through.
 * Apply this helper when `sanitizeUrls: true`.
 */
function sanitizeUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>\\]+/gi, (url) => sanitizeUrl(url));
}

/**
 * Protocol-only validation for URLs that need XSS defense even when the
 * caller hasn't opted into full sanitization. `javascript:` / `vbscript:`
 * URLs are never legitimate in `<img src>` / `![image]()` contexts;
 * reject them up front regardless of `sanitizeUrls`. `data:` URIs are
 * allowed ONLY when they carry an image media-type — modern browsers
 * don't execute `<img src="data:text/html,...">`, but tightening the
 * allow-list to `data:image/*` removes a defense-in-depth gap flagged
 * in the post-merge audit.
 *
 * Added because `sanitizeUrls` is opt-in and
 * defaults to false, but image-URL XSS exposure has no legitimate
 * use-case that would justify opt-in. Always run for image renderings.
 */
function ensureSafeImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:') {
      return url;
    }
    if (protocol === 'data:') {
      // Only `data:image/<subtype>[;base64],<payload>` is acceptable in
      // an `<img>` context. Other MIME types open avenues like
      // `data:text/html,<script>` which (while not directly executed by
      // browsers as `<img>` content) shouldn't be normalized as a valid
      // image source.
      const mediaType =
        parsed.pathname.split(',')[0]?.split(';')[0]?.toLowerCase() ?? '';
      if (mediaType.startsWith('image/')) {
        return url;
      }
    }
    return '#';
  } catch {
    return '#';
  }
}
