/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC } from 'react';
import { useState, useMemo } from 'react';
import { MessageContent } from './MessageContent.js';

/**
 * Parsed segment of user message content
 */
export interface ContentSegment {
  type: 'text' | 'file_reference';
  content: string;
  /** File path for file_reference type */
  filePath?: string;
  /** File name extracted from path */
  fileName?: string;
}

/**
 * Pattern markers for file reference content
 */
const FILE_REFERENCE_START = '--- Content from referenced files ---';
const FILE_REFERENCE_END = '--- End of content ---';
const FILE_CONTENT_PREFIX = /^Content from @([^\n:]+):\n?/m;

/**
 * Parse content to identify file references and regular text
 * @param content - The raw content string
 * @returns Array of content segments
 */
export function parseContentWithFileReferences(
  content: string,
): ContentSegment[] {
  const segments: ContentSegment[] = [];

  // Find the file reference section
  const startIndex = content.indexOf(FILE_REFERENCE_START);
  const endIndex = content.indexOf(FILE_REFERENCE_END);

  // No file reference section found
  if (startIndex === -1) {
    return [{ type: 'text', content }];
  }

  // Add text before file references
  const textBefore = content.substring(0, startIndex).trim();
  if (textBefore) {
    segments.push({ type: 'text', content: textBefore });
  }

  // Extract file reference section
  const fileRefSection =
    endIndex !== -1
      ? content.substring(startIndex + FILE_REFERENCE_START.length, endIndex)
      : content.substring(startIndex + FILE_REFERENCE_START.length);

  // Parse individual file references
  // Split by "Content from @" pattern
  const fileRefParts = fileRefSection.split(/(?=\nContent from @)/);

  for (const part of fileRefParts) {
    const trimmedPart = part.trim();
    if (!trimmedPart) continue;

    // Try to extract file path
    const match = trimmedPart.match(FILE_CONTENT_PREFIX);
    if (match) {
      const filePath = match[1].trim();
      const fileName = filePath.split('/').pop() || filePath;
      const fileContent = trimmedPart.substring(match[0].length);

      segments.push({
        type: 'file_reference',
        content: fileContent.trim(),
        filePath,
        fileName,
      });
    } else if (trimmedPart && !trimmedPart.startsWith('Content from @')) {
      // This might be content without proper prefix, still treat as file reference
      segments.push({
        type: 'file_reference',
        content: trimmedPart,
      });
    }
  }

  // Add text after file references
  if (endIndex !== -1) {
    const textAfter = content
      .substring(endIndex + FILE_REFERENCE_END.length)
      .trim();
    if (textAfter) {
      segments.push({ type: 'text', content: textAfter });
    }
  }

  return segments;
}

/**
 * Props for CollapsibleFileReference
 */
interface CollapsibleFileReferenceProps {
  segment: ContentSegment;
  onFileClick?: (path: string) => void;
  defaultExpanded?: boolean;
}

/**
 * CollapsibleFileReference - A single collapsible file reference block
 */
const CollapsibleFileReference: FC<CollapsibleFileReferenceProps> = ({
  segment,
  onFileClick,
  defaultExpanded = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const lineCount = useMemo(
    () => segment.content.split('\n').length,
    [segment.content],
  );

  const handleToggle = () => {
    setIsExpanded(!isExpanded);
  };

  const handleFileClick = () => {
    if (segment.filePath && onFileClick) {
      onFileClick(segment.filePath);
    }
  };

  return (
    <div
      className="rounded-md overflow-hidden"
      style={{
        border: '1px solid var(--app-input-border)',
        backgroundColor: 'var(--app-secondary-background)',
      }}
    >
      <button
        type="button"
        className="flex items-center gap-1.5 w-full py-1.5 px-2.5 bg-transparent border-none cursor-pointer text-left text-xs transition-colors duration-150 hover:bg-black/5"
        style={{ color: 'var(--app-secondary-foreground)' }}
        onClick={handleToggle}
        aria-expanded={isExpanded}
      >
        <span
          className="text-[8px] flex-shrink-0 transition-transform duration-200"
          style={{
            color: 'var(--app-secondary-foreground)',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ▶
        </span>
        <span className="text-sm flex-shrink-0">📄</span>
        <span
          className="font-medium cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0 hover:underline"
          style={{ color: 'var(--app-link-color, #0066cc)' }}
          onClick={(e) => {
            e.stopPropagation();
            handleFileClick();
          }}
          title={segment.filePath}
        >
          {segment.fileName || 'Referenced file'}
        </span>
        <span
          className="text-[11px] flex-shrink-0 ml-auto"
          style={{ color: 'var(--app-tertiary-foreground, #999)' }}
        >
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
      </button>
      {isExpanded && (
        <div
          className="py-2 px-2.5 max-h-[300px] overflow-y-auto text-xs leading-normal"
          style={{
            borderTop: '1px solid var(--app-input-border)',
            backgroundColor: 'var(--app-primary-background)',
          }}
        >
          <MessageContent
            content={segment.content}
            onFileClick={onFileClick}
            enableFileLinks={true}
          />
        </div>
      )}
    </div>
  );
};

/**
 * Props for CollapsibleFileContent
 */
export interface CollapsibleFileContentProps {
  content: string;
  onFileClick?: (path: string) => void;
  enableFileLinks?: boolean;
}

/**
 * CollapsibleFileContent - Renders content with collapsible file references
 *
 * Detects file reference patterns in user messages and renders them as
 * collapsible blocks to improve readability.
 */
export const CollapsibleFileContent: FC<CollapsibleFileContentProps> = ({
  content,
  onFileClick,
  enableFileLinks = false,
}) => {
  const segments = useMemo(
    () => parseContentWithFileReferences(content),
    [content],
  );

  // If no file references found, render as normal content
  if (segments.length === 1 && segments[0].type === 'text') {
    return (
      <MessageContent
        content={content}
        onFileClick={onFileClick}
        enableFileLinks={enableFileLinks}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return (
            <div key={index}>
              <MessageContent
                content={segment.content}
                onFileClick={onFileClick}
                enableFileLinks={enableFileLinks}
              />
            </div>
          );
        }

        return (
          <CollapsibleFileReference
            key={index}
            segment={segment}
            onFileClick={onFileClick}
            defaultExpanded={false}
          />
        );
      })}
    </div>
  );
};

export default CollapsibleFileContent;
