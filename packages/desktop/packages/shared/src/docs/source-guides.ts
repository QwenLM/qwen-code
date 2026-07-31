/**
 * Source Guides System
 *
 * Provides parsing utilities for source guides.
 * Guides are now served exclusively via the craft-agents-docs MCP server.
 *
 * The agent should search the MCP docs for setup guidance when creating sources.
 */

// ============================================================
// Types
// ============================================================

export interface SourceGuideFrontmatter {
  domains?: string[];
  providers?: string[];
}

export interface ParsedSourceGuide {
  frontmatter: SourceGuideFrontmatter;
  knowledge: string; // Service knowledge content
  setupHints: string; // Setup guidance section
  raw: string; // Original content
}

// ============================================================
// Parsing
// ============================================================

/**
 * Parse YAML frontmatter from guide content.
 * Expects format: ---\nkey: value\n---
 */
function parseFrontmatter(content: string): { frontmatter: SourceGuideFrontmatter; body: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    return { frontmatter: {}, body: content };
  }

  const [, yamlContent, body] = frontmatterMatch;
  const frontmatter: SourceGuideFrontmatter = {};

  if (!yamlContent || !body) {
    return { frontmatter: {}, body: content };
  }

  // Simple YAML parsing for our specific format
  const lines = yamlContent.split('\n');
  let currentKey: 'domains' | 'providers' | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed === 'domains:') {
      currentKey = 'domains';
      frontmatter.domains = [];
    } else if (trimmed === 'providers:') {
      currentKey = 'providers';
      frontmatter.providers = [];
    } else if (trimmed.startsWith('- ') && currentKey) {
      const value = trimmed.slice(2).trim();
      frontmatter[currentKey]?.push(value);
    }
  }

  return { frontmatter, body };
}

/**
 * Parse a source guide into its components.
 * Splits on <!-- SETUP: --> marker.
 */
export function parseSourceGuide(content: string): ParsedSourceGuide {
  const { frontmatter, body } = parseFrontmatter(content);

  // Split on setup marker
  const setupMarker = '<!-- SETUP:';
  const setupIndex = body.indexOf(setupMarker);

  let knowledge: string;
  let setupHints: string;

  if (setupIndex === -1) {
    // No setup section - all content is knowledge
    knowledge = body.trim();
    setupHints = '';
  } else {
    knowledge = body.slice(0, setupIndex).trim();
    // Remove the marker line itself
    const afterMarker = body.slice(setupIndex);
    const markerEnd = afterMarker.indexOf('-->');
    setupHints = markerEnd !== -1 ? afterMarker.slice(markerEnd + 3).trim() : afterMarker.trim();
  }

  // Also remove <!-- KNOWLEDGE: --> marker if present
  const knowledgeMarker = '<!-- KNOWLEDGE:';
  if (knowledge.includes(knowledgeMarker)) {
    const markerStart = knowledge.indexOf(knowledgeMarker);
    const markerEnd = knowledge.indexOf('-->', markerStart);
    if (markerEnd !== -1) {
      knowledge =
        knowledge.slice(0, markerStart).trim() + '\n\n' + knowledge.slice(markerEnd + 3).trim();
    }
  }

  return {
    frontmatter,
    knowledge: knowledge.trim(),
    setupHints: setupHints.trim(),
    raw: content,
  };
}

// ============================================================
// Domain Extraction
// ============================================================

/**
 * Extract the primary domain from a URL.
 * e.g., "https://mcp.linear.app/foo" -> "linear.app"
 */
export function extractDomainFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Remove common subdomains
    const parts = hostname.split('.');
    if (parts.length > 2) {
      // Handle cases like mcp.linear.app -> linear.app
      // But keep things like co.uk domains intact
      const twoPartTlds = ['co.uk', 'com.au', 'co.nz', 'com.br'];
      const lastTwo = parts.slice(-2).join('.');
      if (twoPartTlds.includes(lastTwo)) {
        return parts.slice(-3).join('.');
      }
      return parts.slice(-2).join('.');
    }
    return hostname;
  } catch {
    return null;
  }
}

/**
 * Extract domain from a source config for guide matching.
 */
export function extractDomainFromSource(source: {
  type?: string;
  provider?: string;
  mcp?: { url?: string };
  api?: { baseUrl?: string };
}): string | null {
  // Try MCP URL first
  if (source.mcp?.url) {
    const domain = extractDomainFromUrl(source.mcp.url);
    if (domain) return domain;
  }

  // Try API baseUrl
  if (source.api?.baseUrl) {
    const domain = extractDomainFromUrl(source.api.baseUrl);
    if (domain) return domain;
  }

  // Fall back to provider as domain hint
  if (source.provider) {
    // Map common providers to domains
    const providerDomains: Record<string, string> = {
      linear: 'linear.app',
      github: 'github.com',
      notion: 'notion.so',
      slack: 'slack.com',
      craft: 'craft.do',
      exa: 'exa.ai',
      google: 'google.com',
    };
    return providerDomains[source.provider.toLowerCase()] || null;
  }

  return null;
}

// ============================================================
// Guide Lookup (Deprecated - Use MCP docs instead)
// ============================================================

/**
 * @deprecated Bundled guides have been removed.
 * Use the craft-agents-docs MCP server to search for setup guides.
 *
 * Example: mcp__craft-agents-docs__SearchCraftAgents({ query: "github source setup guide" })
 */
export function getSourceGuideForDomain(_domain: string): ParsedSourceGuide | null {
  // Bundled guides removed - guides now come from MCP docs server
  return null;
}

/**
 * @deprecated Bundled guides have been removed.
 * Use the craft-agents-docs MCP server to search for setup guides.
 */
export function getSourceGuide(_source: {
  type?: string;
  provider?: string;
  mcp?: { url?: string };
  api?: { baseUrl?: string };
}): ParsedSourceGuide | null {
  // Bundled guides removed - guides now come from MCP docs server
  return null;
}

/**
 * @deprecated Bundled guides have been removed.
 * Use the craft-agents-docs MCP server to search for setup guides.
 */
export function getSourceKnowledge(_source: {
  type?: string;
  provider?: string;
  mcp?: { url?: string };
  api?: { baseUrl?: string };
}): string | null {
  // Bundled guides removed - guides now come from MCP docs server
  return null;
}
