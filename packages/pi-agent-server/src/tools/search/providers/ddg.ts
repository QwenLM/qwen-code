/**
 * DuckDuckGo search provider — universal fallback requiring no API key.
 *
 * Uses three endpoints with cascading fallback:
 *   1. duck-duck-scrape library (JS API)
 *   2. html.duckduckgo.com (HTML endpoint)
 *   3. lite.duckduckgo.com (Lite endpoint)
 */

import * as DDG from 'duck-duck-scrape';
import { parse as parseHtml } from 'node-html-parser';
import type { WebSearchProvider, WebSearchResult } from '../types.ts';

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html',
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDdgError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('anomaly') ||
    msg.includes('too quickly') ||
    msg.includes('server error') ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  );
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const canRetry = attempt < retries && isTransientDdgError(error);
      if (!canRetry) {
        throw error;
      }

      const backoff = 250 * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 120);
      await sleep(backoff + jitter);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractUrlFromDuckDuckGoHref(href: string): string | null {
  if (!href) return null;

  const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
  const encodedUrl = uddgMatch?.[1];
  if (encodedUrl) {
    try {
      return decodeURIComponent(encodedUrl);
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(href)) {
    return href;
  }

  if (href.startsWith('//')) {
    return `https:${href}`;
  }

  return null;
}

function buildSnippetFromAnchorText(anchorText: string, containerText: string): string {
  const normalizedAnchor = normalizeWhitespace(anchorText);
  const normalizedContainer = normalizeWhitespace(containerText);

  if (!normalizedContainer) return '';
  if (!normalizedAnchor) return normalizedContainer.slice(0, 280);

  const snippet = normalizeWhitespace(
    normalizedContainer.replace(normalizedAnchor, ''),
  );

  return snippet.slice(0, 280);
}

function extractResultsFromDuckDuckGoHtml(
  html: string,
  count: number,
): WebSearchResult[] {
  const root = parseHtml(html);
  const anchors = root.querySelectorAll('a');

  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const anchor of anchors) {
    if (results.length >= count) break;

    const href = anchor.getAttribute('href') || '';
    const decodedUrl = extractUrlFromDuckDuckGoHref(href);
    if (!decodedUrl) continue;

    let parsed: URL;
    try {
      parsed = new URL(decodedUrl);
    } catch {
      continue;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) continue;

    const normalizedUrl = parsed.toString();
    if (seenUrls.has(normalizedUrl)) continue;

    const title = normalizeWhitespace(anchor.textContent || '');
    if (!title) continue;

    const containerText =
      anchor.parentNode?.textContent ||
      anchor.parentNode?.parentNode?.textContent ||
      '';

    const description = buildSnippetFromAnchorText(title, containerText);

    seenUrls.add(normalizedUrl);
    results.push({ title, url: normalizedUrl, description });
  }

  return results;
}

async function fetchDuckDuckGoHtml(url: string, endpointName: string): Promise<string> {
  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`${endpointName} returned HTTP ${response.status}`);
  }

  return response.text();
}

async function searchDDGApi(query: string, count: number): Promise<WebSearchResult[]> {
  const response = await withRetry(
    () => DDG.search(query, { safeSearch: DDG.SafeSearchType.MODERATE }),
    2,
  );

  if (response.noResults || !response.results?.length) {
    throw new Error('No DuckDuckGo results');
  }

  return response.results.slice(0, count).map((r) => ({
    title: r.title,
    url: r.url,
    description: r.rawDescription || '',
  }));
}

async function searchDDGHtml(query: string, count: number): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchDuckDuckGoHtml(url, 'DDG HTML');
  const results = extractResultsFromDuckDuckGoHtml(html, count);

  if (results.length === 0) {
    throw new Error('No results parsed from DDG HTML');
  }

  return results;
}

async function searchDDGLite(query: string, count: number): Promise<WebSearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const html = await fetchDuckDuckGoHtml(url, 'DDG Lite');
  const results = extractResultsFromDuckDuckGoHtml(html, count);

  if (results.length === 0) {
    throw new Error('No results parsed from DDG Lite HTML');
  }

  return results;
}

export class DDGSearchProvider implements WebSearchProvider {
  name = 'DuckDuckGo';

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const failurePath: string[] = [];

    try {
      return await searchDDGApi(query, count);
    } catch (err) {
      failurePath.push(`ddg_primary:${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      return await searchDDGHtml(query, count);
    } catch (err) {
      failurePath.push(`ddg_html:${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      return await searchDDGLite(query, count);
    } catch (err) {
      failurePath.push(`ddg_lite:${err instanceof Error ? err.message : String(err)}`);
    }

    throw new Error(`All DuckDuckGo endpoints failed: ${failurePath.join('; ')}`);
  }
}
