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
  /** When false, do not convert file paths into clickable links. Default: true */
  enableFileLinks?: boolean;
}

/**
 * Regular expressions for parsing content
 */
// Match absolute file paths like: /path/to/file.ts or C:\path\to\file.ts
const FILE_PATH_REGEX =
  /(?:[a-zA-Z]:)?[/\\](?:[\w\-. ]+[/\\])+[\w\-. ]+\.(tsx?|jsx?|css|scss|json|md|py|java|go|rs|c|cpp|h|hpp|sh|yaml|yml|toml|xml|html|vue|svelte)/gi;
// Match file paths with optional line numbers like: /path/to/file.ts#7-14 or C:\path\to\file.ts#7
const FILE_PATH_WITH_LINES_REGEX =
  /(?:[a-zA-Z]:)?[/\\](?:[\w\-. ]+[/\\])+[\w\-. ]+\.(tsx?|jsx?|css|scss|json|md|py|java|go|rs|c|cpp|h|hpp|sh|yaml|yml|toml|xml|html|vue|svelte)#(\d+)(?:-(\d+))?/gi;

/**
 * MarkdownRenderer component - renders markdown content with enhanced features
 */
export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  onFileClick,
  enableFileLinks = true,
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

      // Post-process to add file path click handlers unless disabled
      if (enableFileLinks) {
        html = processFilePaths(html);
      }

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
    // If DOM is not available, bail out to avoid breaking SSR
    if (typeof document === 'undefined') {
      return html;
    }

    // Build non-global variants to avoid .test() statefulness
    const FILE_PATH_NO_G = new RegExp(
      FILE_PATH_REGEX.source,
      FILE_PATH_REGEX.flags.replace('g', ''),
    );
    const FILE_PATH_WITH_LINES_NO_G = new RegExp(
      FILE_PATH_WITH_LINES_REGEX.source,
      FILE_PATH_WITH_LINES_REGEX.flags.replace('g', ''),
    );
    // Match a bare file name like README.md (no leading slash)
    const BARE_FILE_REGEX =
      /[\w\-. ]+\.(tsx?|jsx?|css|scss|json|md|py|java|go|rs|c|cpp|h|hpp|sh|ya?ml|toml|xml|html|vue|svelte)/i;

    // Parse HTML into a DOM tree so we don't replace inside attributes
    const container = document.createElement('div');
    container.innerHTML = html;

    const union = new RegExp(
      `${FILE_PATH_WITH_LINES_REGEX.source}|${FILE_PATH_REGEX.source}|${BARE_FILE_REGEX.source}`,
      'gi',
    );

    // Convert a "path#fragment" into VS Code friendly "path:line" (we only keep the start line)
    const normalizePathAndLine = (
      raw: string,
    ): { displayText: string; dataPath: string } => {
      const displayText = raw;
      let base = raw;
      // Extract hash fragment like #12, #L12 or #12-34 and keep only the first number
      const hashIndex = raw.indexOf('#');
      if (hashIndex >= 0) {
        const frag = raw.slice(hashIndex + 1);
        // Accept L12, 12 or 12-34
        const m = frag.match(/^L?(\d+)(?:-\d+)?$/i);
        if (m) {
          const line = parseInt(m[1], 10);
          base = raw.slice(0, hashIndex);
          return { displayText, dataPath: `${base}:${line}` };
        }
      }
      return { displayText, dataPath: base };
    };

    const makeLink = (text: string) => {
      const link = document.createElement('a');
      // Pass base path (with optional :line) to the handler; keep the full text as label
      const { dataPath } = normalizePathAndLine(text);
      link.className = 'file-path-link';
      link.textContent = text;
      link.setAttribute('href', '#');
      link.setAttribute('title', `Open ${text}`);
      // Carry file path via data attribute; click handled by event delegation
      link.setAttribute('data-file-path', dataPath);
      return link;
    };

    const upgradeAnchorIfFilePath = (a: HTMLAnchorElement) => {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').trim();

      // Helper: identify dot-chained code refs (e.g. vscode.commands.register)
      // but DO NOT treat filenames/paths as code refs.
      const isCodeReference = (str: string): boolean => {
        if (BARE_FILE_REGEX.test(str)) {
          return false; // looks like a filename
        }
        if (/[/\\]/.test(str)) {
          return false; // contains a path separator
        }
        const codeRefPattern = /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)+$/;
        return codeRefPattern.test(str);
      };

      // If linkify turned a bare filename (e.g. README.md) into http://<filename>, convert it back
      const httpMatch = href.match(/^https?:\/\/(.+)$/i);
      if (httpMatch) {
        try {
          const url = new URL(href);
          const host = url.hostname || '';
          const pathname = url.pathname || '';
          const noPath = pathname === '' || pathname === '/';

          // Case 1: anchor text itself is a bare filename and equals the host (e.g. README.md)
          if (
            noPath &&
            BARE_FILE_REGEX.test(text) &&
            host.toLowerCase() === text.toLowerCase()
          ) {
            const { dataPath } = normalizePathAndLine(text);
            a.classList.add('file-path-link');
            a.setAttribute('href', '#');
            a.setAttribute('title', `Open ${text}`);
            a.setAttribute('data-file-path', dataPath);
            return;
          }

          // Case 2: host itself looks like a filename (rare but happens), use it
          if (noPath && BARE_FILE_REGEX.test(host)) {
            const { dataPath } = normalizePathAndLine(host);
            a.classList.add('file-path-link');
            a.setAttribute('href', '#');
            a.setAttribute('title', `Open ${text || host}`);
            a.setAttribute('data-file-path', dataPath);
            return;
          }
        } catch {
          // fall through; unparseable URL
        }
      }

      // Ignore other external protocols
      if (/^(https?|mailto|ftp|data):/i.test(href)) {
        return;
      }

      const candidate = href || text;

      // Skip if it looks like a code reference
      if (isCodeReference(candidate)) {
        return;
      }

      if (
        FILE_PATH_WITH_LINES_NO_G.test(candidate) ||
        FILE_PATH_NO_G.test(candidate)
      ) {
        const { dataPath } = normalizePathAndLine(candidate);
        a.classList.add('file-path-link');
        a.setAttribute('href', '#');
        a.setAttribute('title', `Open ${text || href}`);
        a.setAttribute('data-file-path', dataPath);
        return;
      }

      // Bare file name or relative path (e.g. README.md or docs/README.md)
      if (BARE_FILE_REGEX.test(candidate)) {
        const { dataPath } = normalizePathAndLine(candidate);
        a.classList.add('file-path-link');
        a.setAttribute('href', '#');
        a.setAttribute('title', `Open ${text || href}`);
        a.setAttribute('data-file-path', dataPath);
      }
    };

    // Helper: identify dot-chained code refs (e.g. vscode.commands.register)
    // but DO NOT treat filenames/paths as code refs.
    const isCodeReference = (str: string): boolean => {
      if (BARE_FILE_REGEX.test(str)) {
        return false; // looks like a filename
      }
      if (/[/\\]/.test(str)) {
        return false; // contains a path separator
      }
      const codeRefPattern = /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)+$/;
      return codeRefPattern.test(str);
    };

    const walk = (node: Node) => {
      // Do not transform inside existing anchors
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.tagName.toLowerCase() === 'a') {
          upgradeAnchorIfFilePath(el as HTMLAnchorElement);
          return; // Don't descend into <a>
        }
        // Avoid transforming inside code/pre blocks
        const tag = el.tagName.toLowerCase();
        if (tag === 'code' || tag === 'pre') {
          return;
        }
      }

      for (let child = node.firstChild; child; ) {
        const next = child.nextSibling; // child may be replaced
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.nodeValue || '';
          union.lastIndex = 0;
          const hasMatch = union.test(text);
          union.lastIndex = 0;
          if (hasMatch) {
            const frag = document.createDocumentFragment();
            let lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = union.exec(text))) {
              const matchText = m[0];
              const idx = m.index;

              // Skip if it looks like a code reference
              if (isCodeReference(matchText)) {
                // Just add the text as-is without creating a link
                if (idx > lastIndex) {
                  frag.appendChild(
                    document.createTextNode(text.slice(lastIndex, idx)),
                  );
                }
                frag.appendChild(document.createTextNode(matchText));
                lastIndex = idx + matchText.length;
                continue;
              }

              if (idx > lastIndex) {
                frag.appendChild(
                  document.createTextNode(text.slice(lastIndex, idx)),
                );
              }
              frag.appendChild(makeLink(matchText));
              lastIndex = idx + matchText.length;
            }
            if (lastIndex < text.length) {
              frag.appendChild(document.createTextNode(text.slice(lastIndex)));
            }
            node.replaceChild(frag, child);
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child);
        }
        child = next;
      }
    };

    walk(container);
    return container.innerHTML;
  };

  // Event delegation: intercept clicks on generated file-path links
  const handleContainerClick = (
    e: React.MouseEvent<HTMLDivElement, MouseEvent>,
  ) => {
    // If file links disabled, do nothing
    if (!enableFileLinks) {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (!target) {
      return;
    }

    // Find nearest anchor with our marker class
    const anchor = (target.closest &&
      target.closest('a.file-path-link')) as HTMLAnchorElement | null;
    if (anchor) {
      const filePath = anchor.getAttribute('data-file-path');
      if (!filePath) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onFileClick?.(filePath);
      return;
    }

    // Fallback: intercept "http://README.md" style links that slipped through
    const anyAnchor = (target.closest &&
      target.closest('a')) as HTMLAnchorElement | null;
    if (!anyAnchor) {
      return;
    }

    const href = anyAnchor.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) {
      return;
    }
    try {
      const url = new URL(href);
      const host = url.hostname || '';
      const path = url.pathname || '';
      const noPath = path === '' || path === '/';

      // Basic bare filename heuristic on the host part (e.g. README.md)
      if (noPath && /\.[a-z0-9]+$/i.test(host)) {
        // Prefer the readable text content if it looks like a file
        const text = (anyAnchor.textContent || '').trim();
        const candidate = /\.[a-z0-9]+$/i.test(text) ? text : host;
        e.preventDefault();
        e.stopPropagation();
        onFileClick?.(candidate);
      }
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="markdown-content"
      onClick={handleContainerClick}
      dangerouslySetInnerHTML={{ __html: renderMarkdown() }}
      style={{
        wordWrap: 'break-word',
        overflowWrap: 'break-word',
        whiteSpace: 'normal',
      }}
    />
  );
};
