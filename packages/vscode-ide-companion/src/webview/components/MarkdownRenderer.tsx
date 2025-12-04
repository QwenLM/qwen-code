/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * MarkdownRenderer component - renders markdown content with syntax highlighting and clickable file paths
 */

import type React from 'react';
import MarkdownIt from 'markdown-it';
import type { Options as MarkdownItOptions } from 'markdown-it';
import './MarkdownRenderer.css';

interface MarkdownRendererProps {
  content: string;
  onFileClick?: (filePath: string) => void;
}

/**
 * Regular expressions for parsing content
 */
const FILE_PATH_REGEX =
  /([a-zA-Z]:)?([/\\][\w\-. ]+)+\.(tsx?|jsx?|css|scss|json|md|py|java|go|rs|c|cpp|h|hpp|sh|yaml|yml|toml|xml|html|vue|svelte)/gi;
// Match file paths with optional line numbers like: path/file.ts#7-14 or path/file.ts#7
const FILE_PATH_WITH_LINES_REGEX =
  /([a-zA-Z]:)?([/\\][\w\-. ]+)+\.(tsx?|jsx?|css|scss|json|md|py|java|go|rs|c|cpp|h|hpp|sh|yaml|yml|toml|xml|html|vue|svelte)#(\d+)(?:-(\d+))?/gi;

/**
 * MarkdownRenderer component - renders markdown content with enhanced features
 */
export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  onFileClick,
}) => {
  /**
   * Initialize markdown-it with plugins
   */
  const getMarkdownInstance = (): MarkdownIt => {
    // Create markdown-it instance with options
    const md = new MarkdownIt({
      html: false, // Disable HTML for security
      xhtmlOut: false,
      breaks: true,
      linkify: true,
      typographer: true,
    } as MarkdownItOptions);

    // Add syntax highlighting for code blocks
    md.use((md) => {
      md.renderer.rules.code_block = function (
        tokens,
        idx: number,
        _options,
        _env,
      ) {
        const token = tokens[idx];
        const lang = token.info || 'plaintext';
        const content = token.content;

        // Add syntax highlighting classes
        return `<pre class="code-block language-${lang}"><code class="language-${lang}">${md.utils.escapeHtml(content)}</code></pre>`;
      };

      md.renderer.rules.fence = function (tokens, idx: number, _options, _env) {
        const token = tokens[idx];
        const lang = token.info || 'plaintext';
        const content = token.content;

        // Add syntax highlighting classes
        return `<pre class="code-block language-${lang}"><code class="language-${lang}">${md.utils.escapeHtml(content)}</code></pre>`;
      };
    });

    return md;
  };

  /**
   * Render markdown content to HTML
   */
  const renderMarkdown = (): string => {
    try {
      const md = getMarkdownInstance();

      // Process the markdown content
      let html = md.render(content);

      // Post-process to add file path click handlers
      html = processFilePaths(html);

      return html;
    } catch (error) {
      console.error('Error rendering markdown:', error);
      // Fallback to plain text if markdown rendering fails
      return escapeHtml(content);
    }
  };

  /**
   * Escape HTML characters for security
   */
  const escapeHtml = (unsafe: string): string =>
    unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

  /**
   * Process file paths in HTML to make them clickable
   */
  const processFilePaths = (html: string): string => {
    // Process file paths with line numbers
    html = html.replace(FILE_PATH_WITH_LINES_REGEX, (match) => {
      const filePath = match.split('#')[0];
      return `<button class="file-path-link" onclick="window.handleFileClick('${filePath}')" title="Open ${match}">${match}</button>`;
    });

    // Process regular file paths
    html = html.replace(FILE_PATH_REGEX, (match) => {
      // Skip if this was already processed as a path with line numbers
      if (FILE_PATH_WITH_LINES_REGEX.test(match)) {
        return match;
      }
      return `<button class="file-path-link" onclick="window.handleFileClick('${match}')" title="Open ${match}">${match}</button>`;
    });

    return html;
  };

  /**
   * Handle file click event
   */
  const handleFileClick = (filePath: string) => {
    if (onFileClick) {
      onFileClick(filePath);
    }
  };

  // Attach the handler to window for use in HTML onclick attributes
  if (typeof window !== 'undefined') {
    (
      window as { handleFileClick?: (filePath: string) => void }
    ).handleFileClick = handleFileClick;
  }

  return (
    <div
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: renderMarkdown() }}
      style={{
        wordWrap: 'break-word',
        overflowWrap: 'break-word',
        whiteSpace: 'normal',
      }}
    />
  );
};
