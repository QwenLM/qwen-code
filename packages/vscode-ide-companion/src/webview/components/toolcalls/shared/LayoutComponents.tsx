/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared layout components for tool call UI
 * Uses Claude Code style: bullet point + label + content
 */

import type React from 'react';
import { FileLink } from '../../ui/FileLink.js';
import './LayoutComponents.css';

/**
 * Props for ToolCallContainer - Claude Code style layout
 */
interface ToolCallContainerProps {
  /** Operation label (e.g., "Read", "Write", "Search") */
  label: string;
  /** Status for bullet color: 'success' | 'error' | 'warning' | 'loading' | 'default' */
  status?: 'success' | 'error' | 'warning' | 'loading' | 'default';
  /** Main content to display */
  children: React.ReactNode;
  /** Tool call ID for debugging */
  toolCallId?: string;
  /** Optional trailing content rendered next to label (e.g., clickable filename) */
  labelSuffix?: React.ReactNode;
  /** Optional custom class name */
  className?: string;
}

// NOTE: We previously computed a bullet color class in JS, but the current
// implementation uses CSS classes (e.g. `.toolcall-status-success`) with
// pseudo-elements. Remove the unused helper to satisfy ESLint.

/**
 * Main container with Claude Code style bullet point and timeline
 */
export const ToolCallContainer: React.FC<ToolCallContainerProps> = ({
  label,
  status = 'success',
  children,
  toolCallId: _toolCallId,
  labelSuffix,
  className: _className,
}) => (
  <div
    className={`qwen-message message-item ${_className || ''} relative pl-[30px] py-2 select-text toolcall-container toolcall-status-${status}`}
  >
    {/* Timeline connector line using ::after pseudo-element */}
    <div className="toolcall-content-wrapper flex flex-col gap-1 min-w-0 max-w-full">
      <div className="flex items-center gap-2 relative min-w-0">
        <span className="text-[14px] leading-none font-bold text-[var(--app-primary-foreground)]">
          {label}
        </span>
        {/* TODO: for 调试 */}
        {_toolCallId && (
          <span className="text-[10px] opacity-30">
            [{_toolCallId.slice(-8)}]
          </span>
        )}
        {labelSuffix}
      </div>
      {children && (
        <div className="text-[var(--app-secondary-foreground)] py-2">
          {children}
        </div>
      )}
    </div>
  </div>
);

/**
 * Props for ToolCallCard wrapper (legacy - for complex layouts)
 */
interface ToolCallCardProps {
  icon: string;
  children: React.ReactNode;
}

/**
 * Legacy card wrapper - kept for backward compatibility with complex layouts like diffs
 */
export const ToolCallCard: React.FC<ToolCallCardProps> = ({
  icon: _icon,
  children,
}) => (
  <div className="grid grid-cols-[auto_1fr] gap-medium bg-[var(--app-input-background)] border border-[var(--app-input-border)] rounded-medium p-large my-medium items-start animate-[fadeIn_0.2s_ease-in] toolcall-card">
    <div className="flex flex-col gap-medium min-w-0">{children}</div>
  </div>
);

/**
 * Props for ToolCallRow
 */
interface ToolCallRowProps {
  label: string;
  children: React.ReactNode;
}

/**
 * A single row in the tool call grid (legacy - for complex layouts)
 */
export const ToolCallRow: React.FC<ToolCallRowProps> = ({
  label,
  children,
}) => (
  <div className="grid grid-cols-[80px_1fr] gap-medium min-w-0">
    <div className="text-xs text-[var(--app-secondary-foreground)] font-medium pt-[2px]">
      {label}
    </div>
    <div className="text-[var(--app-primary-foreground)] min-w-0 break-words">
      {children}
    </div>
  </div>
);

/**
 * Props for StatusIndicator
 */
interface StatusIndicatorProps {
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  text: string;
}

/**
 * Get status color class
 */
const getStatusColorClass = (
  status: 'pending' | 'in_progress' | 'completed' | 'failed',
): string => {
  switch (status) {
    case 'pending':
      return 'bg-[#ffc107]';
    case 'in_progress':
      return 'bg-[#2196f3]';
    case 'completed':
      return 'bg-[#4caf50]';
    case 'failed':
      return 'bg-[#f44336]';
    default:
      return 'bg-gray-500';
  }
};

/**
 * Status indicator with colored dot
 */
export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  text,
}) => (
  <div className="inline-block font-medium relative" title={status}>
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle ${getStatusColorClass(status)}`}
    />
    {text}
  </div>
);

/**
 * Props for CodeBlock
 */
interface CodeBlockProps {
  children: string;
}

/**
 * Code block for displaying formatted code or output
 */
export const CodeBlock: React.FC<CodeBlockProps> = ({ children }) => (
  <pre className="font-mono text-[var(--app-monospace-font-size)] bg-[var(--app-primary-background)] border border-[var(--app-input-border)] rounded-small p-medium overflow-x-auto mt-1 whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
    {children}
  </pre>
);

/**
 * Props for LocationsList
 */
interface LocationsListProps {
  locations: Array<{
    path: string;
    line?: number | null;
  }>;
}

/**
 * List of file locations with clickable links
 */
export const LocationsList: React.FC<LocationsListProps> = ({ locations }) => (
  <div className="toolcall-locations-list flex flex-col gap-1 max-w-full">
    {locations.map((loc, idx) => (
      <FileLink key={idx} path={loc.path} line={loc.line} showFullPath={true} />
    ))}
  </div>
);
