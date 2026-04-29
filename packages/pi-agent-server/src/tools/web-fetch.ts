import { Type } from '@sinclair/typebox';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import TurndownService from 'turndown';
import { parse as parseHtml } from 'node-html-parser';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';

const schema = Type.Object({
  url: Type.String({ description: 'URL to fetch' }),
  prompt: Type.Optional(
    Type.String({
      description:
        'Context hint included in the output prefix (e.g. "find the pricing table"). The full page content is always returned — use this to annotate what you were looking for.',
    }),
  ),
});

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

const NOISE_ELEMENTS = ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'iframe', 'svg'];
turndown.remove(NOISE_ELEMENTS);

const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_TEXT_LENGTH = 50_000;

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

// ============================================================
// SSRF protection
// ============================================================

const PRIVATE_IP_PATTERNS = [
  /^127\./,                                   // IPv4 loopback
  /^10\./,                                    // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./,              // Class B private
  /^192\.168\./,                              // Class C private
  /^169\.254\./,                              // link-local
  /^0\./,                                     // "this" network
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,       // Carrier-grade NAT (100.64.0.0/10)
  /^::1$/,                                    // IPv6 loopback
  /^fe80:/i,                                  // IPv6 link-local
  /^f[cd]/i,                                  // IPv6 unique local (fc00::/7)
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some(r => r.test(ip));
}

/**
 * Validate URL before fetching — blocks non-HTTP schemes and private/reserved IPs.
 *
 * Always resolves through dns.lookup() (getaddrinfo) to get the canonical IP form,
 * which normalizes IPv6 (0:0:0:0:0:0:0:1 → ::1) and platform-specific IPv4 forms
 * (octal 0177.0.0.1, hex 0x7f.0.0.1 → 127.0.0.1). This avoids regex-bypass attacks
 * using non-standard IP representations.
 *
 * Note: there is an inherent TOCTOU gap between this DNS check and the subsequent
 * fetch(). This is defense-in-depth, not a complete SSRF mitigation.
 */
async function validateUrl(url: string): Promise<void> {
  const parsed = new URL(url);

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: unsupported protocol "${parsed.protocol}"`);
  }

  const hostname = parsed.hostname;

  // Resolve to canonical IP — works for both hostnames and IP literals.
  try {
    const { address } = await lookup(hostname);
    if (isPrivateIp(address)) {
      throw new Error('Blocked: resolves to private/reserved IP address');
    }
  } catch (err: any) {
    if (err.code === 'ENOTFOUND') {
      throw new Error(`Blocked: hostname "${hostname}" could not be resolved`);
    }
    throw err;
  }
}

// ============================================================
// Streaming size-limited reader
// ============================================================

/**
 * Read the full response body while enforcing a byte-size limit.
 * Unlike checking Content-Length (which can be absent or lie),
 * this actually caps how many bytes we buffer.
 */
async function readResponseBytes(response: Response, maxSize: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback for runtimes without streaming body
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxSize) {
      throw new Error(`Response exceeded ${Math.round(maxSize / 1024 / 1024)}MB limit`);
    }
    return Buffer.from(ab);
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > maxSize) {
        throw new Error(`Response exceeded ${Math.round(maxSize / 1024 / 1024)}MB limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(combined.buffer, combined.byteOffset, combined.byteLength);
}

/**
 * Read the full response body as text while enforcing a byte-size limit.
 */
async function readResponseText(response: Response, maxSize: number): Promise<string> {
  const buffer = await readResponseBytes(response, maxSize);
  return buffer.toString('utf-8');
}

// ============================================================
// Helpers
// ============================================================

function result(text: string, isError = false): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{ type: 'text', text }],
    details: isError ? { isError: true } : {},
  };
}

function truncate(text: string, maxLen: number = MAX_TEXT_LENGTH): string {
  return text.length > maxLen
    ? text.slice(0, maxLen) + '\n\n[Content truncated]'
    : text;
}

// ============================================================
// Content-type handlers
// ============================================================

function ensurePdfjsPolyfills(): void {
  // pdfjs-dist uses browser-only APIs at module scope (e.g. `const SCALE_MATRIX = new DOMMatrix()`).
  // Provide minimal stubs so it can load in Node.js — only text extraction is used, not rendering.
  if (typeof globalThis.DOMMatrix === 'undefined') {
    (globalThis as any).DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      m11 = 1; m12 = 0; m13 = 0; m14 = 0;
      m21 = 0; m22 = 1; m23 = 0; m24 = 0;
      m31 = 0; m32 = 0; m33 = 1; m34 = 0;
      m41 = 0; m42 = 0; m43 = 0; m44 = 1;
      is2D = true;
      constructor(init?: any) {
        if (Array.isArray(init) && init.length >= 6) {
          this.a = init[0]; this.b = init[1]; this.c = init[2];
          this.d = init[3]; this.e = init[4]; this.f = init[5];
        }
      }
      multiply() { return new (globalThis as any).DOMMatrix(); }
      preMultiplySelf() { return this; }
      invertSelf() { return this; }
      translate() { return new (globalThis as any).DOMMatrix(); }
      scale() { return new (globalThis as any).DOMMatrix(); }
      transformPoint(p: any) { return p || { x: 0, y: 0 }; }
      static fromMatrix() { return new (globalThis as any).DOMMatrix(); }
    };
  }
  if (typeof globalThis.Path2D === 'undefined') {
    (globalThis as any).Path2D = class Path2D {
      addPath() {}
    };
  }
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  ensurePdfjsPolyfills();
  // Pre-load worker on the main thread so pdfjs-dist doesn't try to resolve
  // pdf.worker.mjs from disk (fails when externalized via bun build).
  if (!(globalThis as any).pdfjsWorker) {
    (globalThis as any).pdfjsWorker = await import('pdfjs-dist/build/pdf.worker.mjs');
  }
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item: any) => 'str' in item)
      .map((item: any) => item.str)
      .join(' ');
    if (text.trim()) pages.push(`--- Page ${i} ---\n${text}`);
  }
  return pages.join('\n\n');
}

async function handlePdf(
  buffer: Buffer,
  url: string,
  saveBinary: (buffer: Buffer, url: string, ext: string) => Promise<string>,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  let savedPath: string;
  try {
    savedPath = await saveBinary(buffer, url, '.pdf');
  } catch {
    savedPath = '(failed to save)';
  }

  try {
    const text = await extractPdfText(buffer);
    if (!text.trim()) {
      return result(
        `PDF from ${url} (saved to ${savedPath})\n\nNo extractable text (likely scanned/image-based).`,
      );
    }
    return result(`PDF content from ${url} (saved to ${savedPath}):\n\n${truncate(text)}`);
  } catch (err) {
    return result(
      `PDF from ${url} (saved to ${savedPath})\n\nFailed to extract text: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
}

async function handleImage(
  buffer: Buffer,
  url: string,
  contentType: string,
  saveBinary: (buffer: Buffer, url: string, ext: string) => Promise<string>,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const ext = MIME_TO_EXT[contentType] || '.bin';
  const savedPath = await saveBinary(buffer, url, ext);
  const sizeKb = Math.round(buffer.length / 1024);

  return result(
    `Image downloaded from ${url}\nType: ${contentType}, Size: ${sizeKb}KB\n` +
      `Saved to: ${savedPath}\n\nUse the Read tool to view this image.`,
  );
}

function handleHtml(
  html: string,
  url: string,
  prompt: string | undefined,
): AgentToolResult<{ isError?: boolean }> {
  const root = parseHtml(html);
  // Strip noise elements from the DOM before selecting mainContent.
  root
    .querySelectorAll(NOISE_ELEMENTS.join(', '))
    .forEach((el) => el.remove());

  const mainContent =
    root.querySelector('main, article, [role="main"], .content, #content') ||
    root.querySelector('body') ||
    root;

  const markdown = turndown.turndown(mainContent.innerHTML);

  const prefix = prompt
    ? `Content from ${url} (asked: "${prompt}"):\n\n`
    : `Content from ${url}:\n\n`;

  return result(prefix + truncate(markdown));
}

function handleJson(
  raw: string,
  url: string,
): AgentToolResult<{ isError?: boolean }> {
  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    formatted = raw;
  }
  return result(`JSON from ${url}:\n\n${truncate(formatted)}`);
}

function handleText(
  raw: string,
  url: string,
): AgentToolResult<{ isError?: boolean }> {
  return result(`Content from ${url}:\n\n${truncate(raw)}`);
}

// ============================================================
// Factory
// ============================================================

export function createWebFetchTool(
  getSessionPath: () => string | null,
): ToolDefinition<typeof schema> {
  async function saveBinary(buffer: Buffer, url: string, ext: string): Promise<string> {
    const sessionPath = getSessionPath();
    if (!sessionPath) throw new Error('No active session — cannot save file to disk');
    const dir = join(sessionPath, 'long_responses');
    await mkdir(dir, { recursive: true });
    let urlName = '';
    try { urlName = new URL(url).pathname.split('/').pop() || ''; } catch { /* malformed URL */ }
    const safe =
      urlName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'download';
    const file = `${randomUUID()}_${safe}${ext}`;
    const abs = join(dir, file);
    await writeFile(abs, buffer);
    return abs;
  }

  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch a URL and extract its content. Handles HTML (→ markdown), PDF (→ extracted text), images (→ saved to disk), JSON (→ pretty-printed), and plain text.',
    promptSnippet:
      'Use web_fetch to retrieve and extract content from a URL. Supports HTML (converted to markdown), PDF (text extraction), images (saved to disk), JSON (pretty-printed), and plain text. Pass url (required) and optional prompt to focus extraction.',
    parameters: schema,
    async execute(toolCallId, params) {
      const { url, prompt } = params;

      // SSRF protection: block non-HTTP schemes and private/reserved IPs
      try {
        await validateUrl(url);
      } catch (err) {
        return result(
          `Refused to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }

      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; CraftAgent/1.0)',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        return result(
          `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }

      if (!response.ok) {
        return result(
          `Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`,
          true,
        );
      }

      // Use the final URL after redirects for all output messages
      const finalUrl = response.url || url;

      const [rawContentType = ''] = (response.headers.get('content-type') || '')
        .toLowerCase()
        .split(';');
      const contentType = rawContentType.trim();

      // Binary content types — stream with size limit
      if (contentType === 'application/pdf') {
        const buffer = await readResponseBytes(response, MAX_DOWNLOAD_SIZE);
        return handlePdf(buffer, finalUrl, saveBinary);
      }

      if (contentType.startsWith('image/')) {
        const buffer = await readResponseBytes(response, MAX_DOWNLOAD_SIZE);
        return handleImage(buffer, finalUrl, contentType, saveBinary);
      }

      // Text content types — stream with size limit then decode
      const text = await readResponseText(response, MAX_DOWNLOAD_SIZE);

      if (contentType.includes('html')) {
        return handleHtml(text, finalUrl, prompt);
      }

      if (
        contentType === 'application/json' ||
        contentType.endsWith('+json')
      ) {
        return handleJson(text, finalUrl);
      }

      return handleText(text, finalUrl);
    },
  };
}
