/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-control-regex -- ANSI escape sequences require control chars */

import { exec } from 'node:child_process';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('HYPERLINK_CLICK');

/** A hyperlink region with its visual column range and URL. */
export interface HyperlinkRegion {
  url: string;
  /** Visual column where the link text starts (0-based). */
  startCol: number;
  /** Visual column where the link text ends (exclusive). */
  endCol: number;
}

/**
 * Extracts hyperlink regions from raw markdown text, computing visual
 * column positions by simulating how the markdown renderer strips
 * link syntax: `[text](url)` renders as `text` at the current column.
 *
 * Also detects bare URLs (https?://...) that are not inside markdown
 * link syntax.
 */
export function extractHyperlinkRegions(text: string): HyperlinkRegion[] {
  const regions: HyperlinkRegion[] = [];
  let visualCol = 0;
  let i = 0;

  while (i < text.length) {
    // Markdown link: [text](url)
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = text.slice(i + 1, closeBracket);
          const url = text.slice(closeBracket + 2, closeParen);
          if (url && /^https?:\/\//.test(url)) {
            regions.push({
              url,
              startCol: visualCol,
              endCol: visualCol + linkText.length,
            });
          }
          visualCol += linkText.length;
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Bare URL (not inside markdown link syntax)
    if (text[i] === 'h' && text.slice(i, i + 8) === 'https://') {
      const urlMatch = text.slice(i).match(/^https?:\/\/[^\s)\]>]+/);
      if (urlMatch) {
        // Only add if not already covered by a markdown link region
        const alreadyCovered = regions.some(
          (r) => visualCol >= r.startCol && visualCol < r.endCol,
        );
        if (!alreadyCovered) {
          regions.push({
            url: urlMatch[0],
            startCol: visualCol,
            endCol: visualCol + urlMatch[0].length,
          });
        }
        visualCol += urlMatch[0].length;
        i += urlMatch[0].length;
        continue;
      }
    }
    if (text[i] === 'h' && text.slice(i, i + 7) === 'http://') {
      const urlMatch = text.slice(i).match(/^https?:\/\/[^\s)\]>]+/);
      if (urlMatch) {
        const alreadyCovered = regions.some(
          (r) => visualCol >= r.startCol && visualCol < r.endCol,
        );
        if (!alreadyCovered) {
          regions.push({
            url: urlMatch[0],
            startCol: visualCol,
            endCol: visualCol + urlMatch[0].length,
          });
        }
        visualCol += urlMatch[0].length;
        i += urlMatch[0].length;
        continue;
      }
    }

    // Skip ANSI escape sequences (don't advance visual column)
    if (text[i] === '\x1b') {
      const csiMatch = text.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (csiMatch) {
        i += csiMatch[0].length;
        continue;
      }
      const oscMatch = text.slice(i).match(/^\x1b\][^\x07]*\x07/);
      if (oscMatch) {
        i += oscMatch[0].length;
        continue;
      }
    }

    // Newline resets column
    if (text[i] === '\n') {
      visualCol = 0;
      i++;
      continue;
    }

    // Regular character advances visual column by 1
    // (simplified: doesn't handle wide characters)
    visualCol++;
    i++;
  }

  return regions;
}

/**
 * Finds the URL at a given visual column from a list of hyperlink regions.
 * Returns the URL if the column falls within a region, or undefined.
 */
export function findUrlAtColumn(
  regions: HyperlinkRegion[],
  col: number,
): string | undefined {
  for (const region of regions) {
    if (col >= region.startCol && col < region.endCol) {
      return region.url;
    }
  }
  return undefined;
}

/**
 * Opens a URL using the platform's default handler.
 */
export function openUrl(url: string): void {
  let cmd: string;
  switch (process.platform) {
    case 'darwin':
      cmd = 'open';
      break;
    case 'win32':
      cmd = 'start';
      break;
    default:
      cmd = 'xdg-open';
      break;
  }
  exec(`${cmd} '${url.replace(/'/g, "'\\''")}'`, (error) => {
    if (error) {
      debugLogger.warn(`Failed to open URL ${url}: ${error.message}`);
    }
  });
}
