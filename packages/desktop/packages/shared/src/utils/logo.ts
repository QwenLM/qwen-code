/**
 * Logo URL utility
 *
 * Returns Google Favicon URLs for APIs and MCP servers.
 * Browser handles caching - no need to save files locally.
 */

import { debug } from './debug.ts';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { readJsonFileSync } from './files.ts';

// Cache path for persisted provider domains
const CRAFT_AGENT_DIR = join(homedir(), '.craft-agent');
const PROVIDER_DOMAINS_CACHE_PATH = join(CRAFT_AGENT_DIR, 'provider-domains.json');

// Google Favicon V2 API - free, reliable, no API key needed
// Updated URL: Google migrated from /s2/favicons to faviconV2
const GOOGLE_FAVICON_URL = 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=';

/**
 * Canonical domains for known providers.
 * Maps provider names to their canonical domain for proper favicon resolution.
 * This fixes issues like api.gmail.com returning a globe icon instead of Gmail logo.
 */
/**
 * Direct icon URLs for providers that need explicit URLs.
 * These take precedence over domain-based favicon fetching.
 */
export const PROVIDER_ICON_URLS: Record<string, string> = {
  // Docs and Sheets need direct URLs - their domains return generic Google logo
  docs: 'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico',
  sheets: 'https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico',
  // Microsoft services need direct URLs - Microsoft domains return generic favicons
  outlook: 'https://res.cdn.office.net/files/fabric-cdn-prod_20241209.001/assets/brand-icons/product/svg/outlook_48x1.svg',
  'microsoft-calendar': 'https://res.cdn.office.net/files/fabric-cdn-prod_20241209.001/assets/brand-icons/product/svg/outlook_48x1.svg',
  teams: 'https://res.cdn.office.net/files/fabric-cdn-prod_20241209.001/assets/brand-icons/product/svg/teams_48x1.svg',
  sharepoint: 'https://res.cdn.office.net/files/fabric-cdn-prod_20241209.001/assets/brand-icons/product/svg/sharepoint_48x1.svg',
};

/**
 * Static canonical domains for known providers (immutable).
 * Maps provider names to their canonical domain for proper favicon resolution.
 */
const STATIC_PROVIDER_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  // Google services - map both short names and full slugs
  'gmail': 'mail.google.com',
  'google-calendar': 'calendar.google.com',
  'calendar': 'calendar.google.com',
  'google-drive': 'drive.google.com',
  'drive': 'drive.google.com',
  'google-docs': 'docs.google.com',
  'google-sheets': 'sheets.google.com',
  // Microsoft services
  'outlook': 'outlook.live.com',
  'microsoft-calendar': 'outlook.live.com',
  'onedrive': 'onedrive.live.com',
  'teams': 'teams.microsoft.com',
  'sharepoint': 'sharepoint.com',
  // Common MCP providers - their MCP URLs differ from their main domain
  'github': 'github.com',
  'linear': 'linear.app',
  'slack': 'slack.com',
  'notion': 'notion.so',
});

// Re-export browser-safe utility from service-url
export { deriveServiceUrl } from './service-url.ts';

/**
 * Cache structure for persisted provider domains
 */
interface ProviderDomainsCache {
  version: 1;
  domains: Record<string, string>;
  updatedAt: number;
}

/**
 * Load cached provider domains from filesystem
 */
function loadProviderDomainsCache(): Record<string, string> {
  try {
    if (!existsSync(PROVIDER_DOMAINS_CACHE_PATH)) return {};
    const cache = readJsonFileSync<ProviderDomainsCache>(PROVIDER_DOMAINS_CACHE_PATH);
    return cache.domains || {};
  } catch {
    return {};
  }
}

/**
 * Memoized merged provider domains (module-private).
 * Merges user-cached domains with static domains on first access.
 */
let _mergedProviderDomains: Record<string, string> | null = null;

/**
 * Get canonical domain for a provider.
 * Merges static domains with user-cached domains (static takes precedence).
 *
 * @param provider - Provider name (case-insensitive)
 * @returns Canonical domain or undefined if not found
 */
export function getProviderDomain(provider: string): string | undefined {
  if (!_mergedProviderDomains) {
    const cached = loadProviderDomainsCache();
    _mergedProviderDomains = { ...cached, ...STATIC_PROVIDER_DOMAINS };
    if (Object.keys(cached).length > 0) {
      debug(`[logo] Loaded ${Object.keys(cached).length} cached provider domains`);
    }
  }
  return _mergedProviderDomains[provider.toLowerCase()];
}

/**
 * Reset the provider domain cache (for testing).
 * Allows tests to clear cached state between test cases.
 */
export function _resetProviderDomainCache(): void {
  _mergedProviderDomains = null;
}

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Extract root domain from hostname (strips subdomains like api., www., etc.)
 * e.g., "api.github.com" -> "github.com"
 *       "mcp.linear.app" -> "linear.app"
 */
export function extractRootDomain(hostname: string): string {
  const parts = hostname.split('.');

  // Handle special TLDs like .co.uk, .com.au, etc.
  const specialTlds = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.in'];
  const lastTwo = parts.slice(-2).join('.');

  if (specialTlds.includes(lastTwo) && parts.length > 2) {
    // Return last 3 parts: example.co.uk
    return parts.slice(-3).join('.');
  }

  // Return last 2 parts: github.com
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }

  return hostname;
}

/**
 * Common high-resolution favicon paths to try (in order of preference)
 */
const HIGH_RES_FAVICON_PATHS = [
  '/favicon.svg',              // SVG - best quality, scalable
  '/apple-touch-icon.png',     // Usually 180x180
  '/favicon.png',              // Common high-res PNG
  '/android-chrome-512x512.png', // Often 512x512
  '/fluidicon.png',            // GitHub-specific, 512x512
  '/icon.svg',                 // Alternative SVG path
];

/**
 * Check if a URL exists and returns an image (returns true for 2xx status codes with image content-type)
 */
async function urlExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) return false;

    // Verify it's actually an image, not HTML
    const contentType = response.headers.get('content-type');
    if (!contentType) return false;

    // Accept image types (svg, png, ico, etc.)
    return contentType.startsWith('image/');
  } catch {
    return false;
  }
}

/**
 * Parse favicon links from HTML <head> section
 * Returns array of {href: string, sizes: string | null} objects
 */
async function parseFaviconsFromHtml(url: string): Promise<Array<{href: string, sizes: string | null}>> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' } // Some sites block headless requests
    });

    if (!response.ok) return [];

    const html = await response.text();

    // Extract <head> section (basic regex - good enough for favicon parsing)
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (!headMatch || !headMatch[1]) return [];

    const head = headMatch[1];

    // Find all <link> tags with rel containing "icon"
    const linkRegex = /<link\s+([^>]*rel=["'](?:[^"']*\s)?(?:icon|apple-touch-icon)(?:\s[^"']*)?["'][^>]*)>/gi;
    const favicons: Array<{href: string, sizes: string | null}> = [];

    let match;
    while ((match = linkRegex.exec(head)) !== null) {
      const attrs = match[1];
      if (!attrs) continue;

      // Extract href attribute
      const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch || !hrefMatch[1]) continue;

      let href = hrefMatch[1];

      // Convert relative URLs to absolute
      if (href.startsWith('//')) {
        href = `https:${href}`;
      } else if (href.startsWith('/')) {
        const origin = new URL(url).origin;
        href = `${origin}${href}`;
      } else if (!href.startsWith('http')) {
        const baseUrl = new URL(url);
        href = `${baseUrl.origin}/${href}`;
      }

      // Extract sizes attribute (e.g., "180x180", "512x512")
      const sizesMatch = attrs.match(/sizes=["']([^"']+)["']/i);
      const sizes = sizesMatch && sizesMatch[1] ? sizesMatch[1] : null;

      favicons.push({ href, sizes });
    }

    return favicons;
  } catch {
    return [];
  }
}

/**
 * Pick the best favicon from parsed HTML links
 * Prefers SVG, then largest PNG/ICO by size attribute
 */
function pickBestFavicon(favicons: Array<{href: string, sizes: string | null}>): string | null {
  if (favicons.length === 0) return null;

  // Prefer SVG (scalable, always best quality)
  const svg = favicons.find(f => f.href.endsWith('.svg'));
  if (svg) return svg.href;

  // Sort by size (largest first)
  const withSizes = favicons
    .filter(f => f.sizes && f.sizes !== 'any')
    .map(f => {
      const sizeMatch = f.sizes?.match(/(\d+)x(\d+)/);
      const size = sizeMatch && sizeMatch[1] ? parseInt(sizeMatch[1], 10) : 0;
      return { ...f, sizeNum: size };
    })
    .sort((a, b) => b.sizeNum - a.sizeNum);

  const largestWithSize = withSizes[0];
  if (largestWithSize && largestWithSize.sizeNum >= 128) {
    return largestWithSize.href;
  }

  // Fall back to first available
  return favicons[0]?.href ?? null;
}

/**
 * Get high-quality logo URL for a service
 * Tries direct favicon paths, then parses HTML <head>, before falling back to Google API
 *
 * This function makes HTTP requests to find the best quality favicon.
 * Results should be cached (stored in source config) to avoid repeated requests.
 *
 * @param serviceUrl - The service URL to get logo for
 * @param provider - Optional provider name (e.g., 'gmail') to use canonical domain mapping
 */
export async function getHighQualityLogoUrl(serviceUrl: string, provider?: string): Promise<string | null> {
  // Check if provider has a direct icon URL (highest priority)
  if (provider) {
    const directIconUrl = PROVIDER_ICON_URLS[provider.toLowerCase()];
    if (directIconUrl) {
      // Validate the hardcoded URL still works (Google changes these periodically)
      if (await urlExists(directIconUrl)) {
        return directIconUrl;
      }
      // URL is broken - remove from map so we don't retry this session
      delete PROVIDER_ICON_URLS[provider.toLowerCase()];
      debug(`[logo] Direct icon URL broken for "${provider}", falling back to favicon API`);
    }

    // Check if provider has a canonical domain mapping (includes cached domains)
    const canonicalDomain = getProviderDomain(provider);
    if (canonicalDomain) {
      // Use canonical domain for favicon resolution
      return getHighQualityLogoUrl(`https://${canonicalDomain}`);
    }
  }

  const fullDomain = extractDomain(serviceUrl);
  if (!fullDomain) {
    return null;
  }

  // Skip internal domains
  if (fullDomain === 'localhost' || fullDomain.endsWith('.local') || /^[\d.]+$/.test(fullDomain)) {
    return null;
  }

  const rootDomain = extractRootDomain(fullDomain);
  const hasSubdomain = fullDomain !== rootDomain;

  // Helper to try favicon paths on a domain
  async function tryFaviconPaths(domain: string): Promise<string | null> {
    const origin = `https://${domain}`;

    // Try high-res favicon paths
    for (const path of HIGH_RES_FAVICON_PATHS) {
      const url = `${origin}${path}`;
      if (await urlExists(url)) {
        return url;
      }
    }

    // Parse HTML <head> for favicon links
    const favicons = await parseFaviconsFromHtml(origin);
    if (favicons.length > 0) {
      const bestFavicon = pickBestFavicon(favicons);
      if (bestFavicon && await urlExists(bestFavicon)) {
        return bestFavicon;
      }
    }

    return null;
  }

  // Step 1: Try full domain first (e.g., mail.google.com)
  if (hasSubdomain) {
    const result = await tryFaviconPaths(fullDomain);
    if (result) {
      return result;
    }
  }

  // Step 2: Try root domain (e.g., google.com)
  const result = await tryFaviconPaths(rootDomain);
  if (result) {
    return result;
  }

  // Step 3: Fall back to Google Favicon V2 API (uses full domain for better results)
  return `${GOOGLE_FAVICON_URL}128&url=https://${fullDomain}`;
}

/**
 * Get logo URL for a service (synchronous, uses Google Favicon API)
 * Returns Google Favicon URL or null for internal domains.
 *
 * Use getHighQualityLogoUrl() when possible for better quality icons.
 *
 * @param serviceUrl - The service URL to get logo for
 * @param provider - Optional provider name (e.g., 'gmail') to use canonical domain mapping
 */
export function getLogoUrl(serviceUrl: string, provider?: string): string | null {
  // Check if provider has a direct icon URL (highest priority)
  if (provider) {
    const directIconUrl = PROVIDER_ICON_URLS[provider.toLowerCase()];
    if (directIconUrl) {
      return directIconUrl;
    }

    // Check if provider has a canonical domain mapping
    const canonicalDomain = getProviderDomain(provider);
    if (canonicalDomain) {
      return `${GOOGLE_FAVICON_URL}128&url=https://${canonicalDomain}`;
    }
  }

  const fullDomain = extractDomain(serviceUrl);
  if (!fullDomain) {
    return null;
  }

  // Skip internal domains
  if (fullDomain === 'localhost' || fullDomain.endsWith('.local') || /^[\d.]+$/.test(fullDomain)) {
    return null;
  }

  // Extract root domain (strips subdomains like api., www., etc.)
  const rootDomain = extractRootDomain(fullDomain);

  // Return Google Favicon V2 URL - browser handles caching
  return `${GOOGLE_FAVICON_URL}128&url=https://${rootDomain}`;
}
