/**
 * SourceManager - Centralized Source State Management
 *
 * Provides a unified interface for managing external data source state that both
 * Backend agents can use. Handles source tracking, formatting for
 * context injection, and auto-activation detection.
 *
 * Key responsibilities:
 * - Track active, inactive, and intended source states
 * - Format source state for system prompt injection
 * - Detect inactive source tool errors for auto-activation
 * - Determine authentication requirements for sources
 */

import { join } from 'node:path';
import type { LoadedSource } from '../../sources/types.ts';
import { sourceNeedsAuthentication } from '../../sources/credential-manager.ts';
import type { SourceManagerConfig } from './types.ts';

/** Slugs exempt from guide.md prerequisite (internal sources) */
const GUIDE_EXEMPT_SLUGS = new Set(['session', 'craft-agents-docs']);

/**
 * SourceManager provides centralized source state tracking for agent backends.
 *
 * Usage:
 * ```typescript
 * const sourceManager = new SourceManager({
 *   onDebug: (msg) => console.log(msg),
 * });
 *
 * // Update source state when sources change
 * sourceManager.updateActiveState(['github', 'slack'], [], ['github', 'slack', 'failing-source']);
 * sourceManager.setAllSources(loadedSources);
 *
 * // Get formatted state for context injection
 * const contextBlock = sourceManager.formatSourceState();
 * ```
 */
export class SourceManager {
  private config: SourceManagerConfig;

  // Source state tracking
  private activeSlugs: Set<string> = new Set();
  private intendedSlugs: Set<string> = new Set();
  private allSources: LoadedSource[] = [];
  private knownSlugs: Set<string> = new Set();

  constructor(config: SourceManagerConfig = {}) {
    this.config = config;
  }

  // ============================================================
  // State Management
  // ============================================================

  /**
   * Update active source state based on what servers are actually running.
   *
   * @param mcpServerNames - Names of active MCP servers
   * @param apiServerNames - Names of active API servers
   * @param intendedSlugs - Source slugs that UI shows as active (may differ if build failed)
   */
  updateActiveState(
    mcpServerNames: string[],
    apiServerNames: string[],
    intendedSlugs?: string[]
  ): void {
    // Update actually active servers
    this.activeSlugs = new Set([...mcpServerNames, ...apiServerNames]);

    // Update intended active (what UI shows, even if build failed)
    this.intendedSlugs = new Set(intendedSlugs ?? [...this.activeSlugs]);

    this.config.onDebug?.(`Active sources: ${[...this.activeSlugs].join(', ') || 'none'}`);

    // Log any sources with failed builds
    if (intendedSlugs) {
      const failed = intendedSlugs.filter((s) => !this.activeSlugs.has(s));
      if (failed.length > 0) {
        this.config.onDebug?.(`Sources with failed builds: ${failed.join(', ')}`);
      }
    }
  }

  /**
   * Set all available sources (active and inactive).
   */
  setAllSources(sources: LoadedSource[]): void {
    this.allSources = sources;
  }

  /**
   * Get all sources.
   */
  getAllSources(): LoadedSource[] {
    return this.allSources;
  }

  /**
   * Check if a source slug is currently active.
   */
  isSourceActive(slug: string): boolean {
    return this.activeSlugs.has(slug);
  }

  /**
   * Check if a source slug is intended to be active (UI shows as active).
   */
  isSourceIntendedActive(slug: string): boolean {
    return this.intendedSlugs.has(slug);
  }

  /**
   * Get active source slugs (only those with working tools).
   */
  getActiveSlugs(): Set<string> {
    return new Set(this.activeSlugs);
  }

  /**
   * Get intended active source slugs (what UI shows).
   */
  getIntendedSlugs(): Set<string> {
    return new Set(this.intendedSlugs);
  }

  /**
   * Mark a source as seen (won't show introduction text again this session).
   */
  markSourceSeen(slug: string): void {
    this.knownSlugs.add(slug);
  }

  /**
   * Mark a source as unseen (will show introduction text again).
   */
  markSourceUnseen(slug: string): void {
    this.knownSlugs.delete(slug);
  }

  /**
   * Reset all "seen" markers (e.g., on session clear).
   */
  resetSeenSources(): void {
    this.knownSlugs.clear();
  }

  // ============================================================
  // Source State Formatting
  // ============================================================

  /**
   * Format source state as XML block for injection into user messages.
   * Shows active sources, inactive sources, and introduces new sources with taglines.
   *
   * @returns Formatted XML string for context injection
   */
  formatSourceState(): string {
    // Use intended active slugs (what UI shows) rather than just what built successfully
    const activeSlugs = [...this.intendedSlugs].sort();

    // Find inactive sources (in allSources but not intended-active)
    const inactiveSources = this.allSources.filter(
      (s) => !this.intendedSlugs.has(s.config.slug)
    );

    // Find sources not yet seen this session
    const unseenSources = this.allSources.filter(
      (s) => !this.knownSlugs.has(s.config.slug)
    );

    // Find active sources that need attention (needs_auth or failed status)
    const activeSources = this.allSources.filter(
      (s) => this.intendedSlugs.has(s.config.slug)
    );
    const sourcesNeedingAttention = activeSources.filter(
      (s) => s.config.connectionStatus === 'needs_auth' || s.config.connectionStatus === 'failed'
    );

    // Check if this is the first message (no sources known yet)
    const isFirstMessage = this.knownSlugs.size === 0;

    // Mark all current sources as known for next message
    this.allSources.forEach((s) => this.knownSlugs.add(s.config.slug));

    // Build output parts
    const parts: string[] = [];

    // Active sources line - include warning for sources with failed builds
    if (activeSlugs.length > 0) {
      const activeWithStatus = activeSlugs.map((slug) => {
        const hasWorkingTools = this.activeSlugs.has(slug);
        return hasWorkingTools ? slug : `${slug} (no tools)`;
      });
      parts.push(`Active: ${activeWithStatus.join(', ')}`);
    } else {
      parts.push('Active: none');
    }

    // Inactive sources with reason
    if (inactiveSources.length > 0) {
      const inactiveList = inactiveSources.map((s) => {
        const reason = !s.config.enabled
          ? 'disabled'
          : sourceNeedsAuthentication(s)
            ? 'needs auth'
            : 'inactive';
        return `${s.config.slug} (${reason})`;
      });
      parts.push(`Inactive: ${inactiveList.join(', ')}`);
    }

    // Persistent reminder: if any active source has a guide, remind the LLM every message
    const activeSourcesWithGuides = activeSources.filter(
      (s) => s.guide?.raw && !GUIDE_EXEMPT_SLUGS.has(s.config.slug)
    );
    if (activeSourcesWithGuides.length > 0) {
      parts.push('Read each source\'s guide.md before first tool use — calls are blocked until guide is read.');
    }

    // Source descriptions (shown once per session when first introduced)
    if (unseenSources.length > 0) {
      parts.push('');
      // Only show "New:" header for mid-conversation additions, not first message
      if (!isFirstMessage) {
        parts.push('New:');
      }
      let hasGuides = false;
      for (const s of unseenSources) {
        const tagline = s.config.tagline || s.config.provider;
        parts.push(`- ${s.config.slug}: ${tagline}`);
        // Add guide path for sources that have guides (excluding internal sources)
        if (s.guide?.raw && !GUIDE_EXEMPT_SLUGS.has(s.config.slug)) {
          parts.push(`  Guide: ${join(s.folderPath, 'guide.md')}`);
          hasGuides = true;
        }
      }
      if (hasGuides) {
        parts.push('');
        parts.push('IMPORTANT: You MUST read a source\'s guide with the Read tool BEFORE using any of its tools. Tool calls WILL BE REJECTED if the guide has not been read first.');
      }
    }

    let output = `<sources>\n${parts.join('\n')}\n</sources>`;

    // Inject issue context for sources needing attention
    for (const s of sourcesNeedingAttention) {
      const status = s.config.connectionStatus;
      output += `\n\n<source_issue source="${s.config.slug}" status="${status}">`;

      if (s.config.connectionError) {
        output += `\nError: ${s.config.connectionError}`;
      }

      // Provide context-aware fix instructions
      const authTool = this.getAuthToolName(s);
      if (authTool) {
        output += `\n\nThis source requires re-authentication. The user may have revoked access or the token expired.`;
        output += `\nTo fix: Re-authenticate using ${authTool}.`;
      } else if (s.config.mcp?.transport === 'stdio') {
        output += `\n\nThis is a local MCP server that is not responding. The server process may need to be restarted.`;
        output += `\nTo fix: Check if the server command/path is correct and the process can start.`;
      } else {
        output += `\n\nThis source's server is unreachable. It may be down or the URL may have changed.`;
        output += `\nTo fix: Check the server URL and network connectivity. Use WebSearch to verify the endpoint is correct.`;
      }
      output += `\n</source_issue>`;
    }

    return output;
  }

  // ============================================================
  // Inactive Source Detection
  // ============================================================

  /**
   * Detect if a tool error indicates an inactive source that could be auto-activated.
   *
   * This is used when the agent tries to call a tool from a source that exists
   * but isn't currently active. If detected, the session manager can auto-activate
   * the source and retry the tool call.
   *
   * @param toolName - The tool name that was called
   * @param errorMessage - The error message from the tool call
   * @returns Source info if this is an inactive source error, null otherwise
   */
  detectInactiveSourceToolError(
    toolName: string,
    errorMessage: string
  ): { sourceSlug: string; toolName: string } | null {
    // Extract tool name from error message patterns
    let extractedToolName: string | null = toolName;

    // Pattern 1: "No such tool available: {toolName}"
    const noSuchToolMatch = errorMessage.match(/No (?:such )?tool available:\s*([^\s<]+)/i);
    if (noSuchToolMatch?.[1]) {
      extractedToolName = noSuchToolMatch[1];
    }

    // Pattern 2: "Tool '{toolName}' not found"
    if (!extractedToolName) {
      const toolNotFoundMatch = errorMessage.match(/Tool\s+['"`]([^'"`]+)['"`]\s+not found/i);
      if (toolNotFoundMatch?.[1]) {
        extractedToolName = toolNotFoundMatch[1];
      }
    }

    if (!extractedToolName) return null;

    // Check if it's an MCP tool (mcp__{slug}__{toolname})
    if (!extractedToolName.startsWith('mcp__')) return null;

    const parts = extractedToolName.split('__');
    if (parts.length < 3) return null;

    const sourceSlug = parts[1]!;

    // Check if source exists but is inactive
    const sourceExists = this.allSources.some((s) => s.config.slug === sourceSlug);
    const isActive = this.activeSlugs.has(sourceSlug);

    if (sourceExists && !isActive) {
      return { sourceSlug, toolName: extractedToolName };
    }

    return null;
  }

  // ============================================================
  // Authentication Utilities
  // ============================================================

  /**
   * Get the correct authentication tool name for a source, or null if no auth is needed.
   *
   * @param source - The source to check
   * @returns Tool name for authentication, or null
   */
  getAuthToolName(source: LoadedSource): string | null {
    const { type, provider, mcp, api } = source.config;

    // MCP sources
    if (type === 'mcp') {
      if (mcp?.authType === 'oauth') {
        return 'source_oauth_trigger';
      }
      if (mcp?.authType === 'bearer') {
        return 'source_credential_prompt';
      }
      return null;
    }

    // API sources
    if (type === 'api') {
      if (api?.authType === 'none' || api?.authType === undefined) {
        return null;
      }

      // OAuth providers have specific triggers
      switch (provider) {
        case 'google':
          return 'source_google_oauth_trigger';
        case 'slack':
          return 'source_slack_oauth_trigger';
        case 'microsoft':
          return 'source_microsoft_oauth_trigger';
        default:
          // Generic OAuth API sources → OAuth trigger (static config or auto-discovery)
          if (api?.authType === 'oauth') {
            return 'source_oauth_trigger';
          }
          return 'source_credential_prompt';
      }
    }

    return null;
  }

  /**
   * Check if a source needs authentication.
   */
  sourceNeedsAuthentication(source: LoadedSource): boolean {
    return sourceNeedsAuthentication(source);
  }
}
