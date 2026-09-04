/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * MarkdownRenderer component - renders markdown content with syntax highlighting and clickable file paths
 */

import type { FC } from 'react';
import { useMemo, useCallback } from 'react';
import MarkdownIt from 'markdown-it';
import type { Options as MarkdownItOptions } from 'markdown-it';
import './MarkdownRenderer.css';

export interface MarkdownRendererProps {
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

// Known file extensions for validation of explicit markdown links
const KNOWN_FILE_EXTENSIONS =
  /\.(tsx?|jsx?|css|scss|json|md|py|java|go|rs|c|cpp|h|hpp|sh|ya?ml|toml|xml|html|vue|svelte)$/i;

const FILE_URI_PATTERN = /^file:\/\//i;
const FILE_URI_TEXT_PATTERN = /file:\/\//i;
const EXTERNAL_LINK_PATTERN = /^(?:https?|mailto|ftp|data):/i;

const splitLineFragment = (
  raw: string,
): { filePath: string; line?: number } => {
  const hashIndex = raw.indexOf('#');
  if (hashIndex < 0) {
    return { filePath: raw };
  }

  const fragment = raw.slice(hashIndex + 1);
  const lineMatch = fragment.match(/^L?(\d+)(?:-\d+)?$/i);
  return {
    filePath: raw.slice(0, hashIndex),
    line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
  };
};

const appendLineNumber = (filePath: string, line?: number): string =>
  line === undefined ? filePath : filePath + ':' + line;

const safeDecodePath = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

type ParsedLocalFileUri = {
  filePath: string;
  line?: number;
};

const parseAllowedLocalFileUri = (
  raw: string,
): ParsedLocalFileUri | undefined => {
  if (!FILE_URI_PATTERN.test(raw)) {
    return undefined;
  }

  const { filePath: rawUri, line } = splitLineFragment(raw);
  let uri: URL;
  try {
    uri = new URL(rawUri);
  } catch {
    return undefined;
  }

  if (uri.protocol.toLowerCase() !== 'file:') {
    return undefined;
  }

  const hostname = uri.hostname.toLowerCase();
  if (hostname !== '' && hostname !== 'localhost') {
    return undefined;
  }

  const decodedPath = safeDecodePath(uri.pathname).replace(/\\/g, '/');
  const encodedNetworkPath = uri.pathname
    .replace(/%2f/gi, '/')
    .replace(/%5c/gi, '\\')
    .replace(/\\/g, '/');

  // An empty authority can still carry a UNC-like pathname (file:////server).
  if (decodedPath.startsWith('//') || encodedNetworkPath.startsWith('//')) {
    return undefined;
  }

  const filePath =
    decodedPath.length > 1 && /^[a-zA-Z]:\//.test(decodedPath.slice(1))
      ? decodedPath.slice(1)
      : decodedPath;

  return { filePath, line };
};

const isAllowedLocalFileUri = (url: string): boolean =>
  parseAllowedLocalFileUri(url) !== undefined;

const shouldSkipFilePathUpgrade = (href: string): boolean =>
  EXTERNAL_LINK_PATTERN.test(href) || FILE_URI_PATTERN.test(href);

const normalizeExplicitFileLink = (raw: string): string => {
  const parsed = parseAllowedLocalFileUri(raw);
  if (parsed) {
    return appendLineNumber(parsed.filePath, parsed.line);
  }

  const { filePath: rawPath, line } = splitLineFragment(raw);
  const decodedPath = safeDecodePath(rawPath).replace(/\\/g, '/');
  return appendLineNumber(decodedPath, line);
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
 * Create a cached MarkdownIt instance
 */
const createMarkdownInstance = (): MarkdownIt => {
  const md = new MarkdownIt({
    html: false, // Disable HTML for security
    xhtmlOut: false,
    breaks: true,
    linkify: true,
    typographer: true,
  } as MarkdownItOptions);

  const defaultValidateLink = md.validateLink;
  md.validateLink = (url: string): boolean =>
    FILE_URI_PATTERN.test(url)
      ? isAllowedLocalFileUri(url)
      : defaultValidateLink(url);

  return md;
};

/**
 * MarkdownRenderer component - renders markdown content with enhanced features
 */
export const MarkdownRenderer: FC<MarkdownRendererProps> = ({
  content,
  onFileClick,
  enableFileLinks = true,
}) => {
  // Cache MarkdownIt instance
  const md = useMemo(() => createMarkdownInstance(), []);

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

    const normalizePathAndLine = (
      raw: string,
    ): { displayText: string; dataPath: string } => {
      const { filePath, line } = splitLineFragment(raw);
      return {
        displayText: raw,
        dataPath: line === undefined ? raw : appendLineNumber(filePath, line),
      };
    };

    const makeLink = (text: string) => {
      const link = document.createElement('a');
      const { dataPath } = normalizePathAndLine(text);
      link.className = 'file-path-link';
      link.textContent = text;
      link.setAttribute('href', '#');
      link.setAttribute('title', `Open ${text}`);
      link.setAttribute('data-file-path', dataPath);
      return link;
    };

    // Helper: identify dot-chained code refs (e.g. vscode.commands.register)
    const isCodeReference = (str: string): boolean => {
      if (BARE_FILE_REGEX.test(str)) {
        return false;
      }
      if (/[/\\]/.test(str)) {
        return false;
      }
      const codeRefPattern = /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)+$/;
      return codeRefPattern.test(str);
    };

    const upgradeAnchorIfFilePath = (a: HTMLAnchorElement) => {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').trim();

      const httpMatch = href.match(/^https?:\/\/(.+)$/i);
      if (httpMatch) {
        try {
          const url = new URL(href);
          const host = url.hostname || '';
          const pathname = url.pathname || '';
          const noPath = pathname === '' || pathname === '/';

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

          if (noPath && BARE_FILE_REGEX.test(host)) {
            const { dataPath } = normalizePathAndLine(host);
            a.classList.add('file-path-link');
            a.setAttribute('href', '#');
            a.setAttribute('title', `Open ${text || host}`);
            a.setAttribute('data-file-path', dataPath);
            return;
          }
        } catch {
          // fall through
        }
      }

      if (shouldSkipFilePathUpgrade(href)) {
        return;
      }

      const candidate = href || text;

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

      if (BARE_FILE_REGEX.test(candidate)) {
        const { dataPath } = normalizePathAndLine(candidate);
        a.classList.add('file-path-link');
        a.setAttribute('href', '#');
        a.setAttribute('title', `Open ${text || href}`);
        a.setAttribute('data-file-path', dataPath);
      }
    };

    const walk = (node: Node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.tagName.toLowerCase() === 'a') {
          upgradeAnchorIfFilePath(el as HTMLAnchorElement);
          return;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === 'code' || tag === 'pre') {
          return;
        }
      }

      for (let child = node.firstChild; child; ) {
        const next = child.nextSibling;
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.nodeValue || '';

          // MarkdownIt emits rejected file URIs as text. Keep them inert so
          // path linkification cannot turn a later slash segment into a
          // file-path-link.
          if (FILE_URI_TEXT_PATTERN.test(text)) {
            child = next;
            continue;
          }

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

              if (isCodeReference(matchText)) {
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

  const removeFileUriImages = (html: string): string => {
    if (
      typeof document === 'undefined' ||
      !html.toLowerCase().includes('file:')
    ) {
      return html;
    }

    const container = document.createElement('div');
    container.innerHTML = html;
    for (const image of Array.from(container.querySelectorAll('img'))) {
      if (FILE_URI_PATTERN.test(image.getAttribute('src') || '')) {
        image.replaceWith(document.createTextNode(image.alt));
      }
    }
    return container.innerHTML;
  };

  /**
   * Render markdown content to HTML (memoized)
   */
  const renderedHtml = useMemo(() => {
    try {
      let html = removeFileUriImages(md.render(content));

      if (enableFileLinks) {
        html = processFilePaths(html);
      }

      return html;
    } catch (error) {
      console.error('Error rendering markdown:', error);
      return escapeHtml(content);
    }
  }, [content, enableFileLinks, md]);

  // Event delegation: intercept clicks on generated file-path links
  const handleContainerClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
      const target = e.target as HTMLElement | null;
      if (!target) {
        return;
      }

      // Check for file-path-link (created by processFilePaths when enableFileLinks=true)
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

      // Handle explicit markdown links (file:// URIs and normal file-path hrefs).
      // Every file:// link is intercepted so the browser never navigates to it.
      // Normal file-path links (absolute or with known extensions) are also
      // supported so that intentional markdown links remain clickable even
      // when enableFileLinks is false.
      const anyAnchor = (target.closest &&
        target.closest('a')) as HTMLAnchorElement | null;
      if (!anyAnchor) {
        return;
      }

      const href = anyAnchor.getAttribute('href') || '';

      // Only local file:/// URIs may reach the host file-open handler.
      if (FILE_URI_PATTERN.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        if (isAllowedLocalFileUri(href)) {
          onFileClick?.(normalizeExplicitFileLink(href));
        }
        return;
      }

      // Skip external links — let browser handle them normally
      if (shouldSkipFilePathUpgrade(href)) {
        return;
      }

      // Handle explicit markdown file-path links (e.g. [filename](/path/to/file))
      // even when enableFileLinks=false, so intentional links like Export Session
      // output remain clickable.
      const text = (anyAnchor.textContent || '').trim();
      const candidate = normalizeExplicitFileLink(href || text);

      const isAbsolutePath = /^(?:[a-zA-Z]:[/\\]|[/\\])/i.test(candidate);
      const isRelativeFile =
        !isAbsolutePath &&
        KNOWN_FILE_EXTENSIONS.test(candidate.replace(/:\d+(?::\d+)?$/, ''));

      if ((isAbsolutePath || isRelativeFile) && onFileClick) {
        e.preventDefault();
        e.stopPropagation();
        onFileClick(candidate);
      }
    },
    [onFileClick],
  );

  return (
    <div
      className="markdown-content"
      onClick={handleContainerClick}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
      style={{
        wordWrap: 'break-word',
        overflowWrap: 'break-word',
        whiteSpace: 'normal',
      }}
    />
  );
};
