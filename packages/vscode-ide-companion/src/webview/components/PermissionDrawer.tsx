/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState, useRef } from 'react';
import type { PermissionOption, ToolCall } from './PermissionRequest.js';

interface PermissionDrawerProps {
  isOpen: boolean;
  options: PermissionOption[];
  toolCall: ToolCall;
  onResponse: (optionId: string) => void;
  onClose?: () => void;
}

/**
 * Permission drawer component - Claude Code style bottom sheet
 */
export const PermissionDrawer: React.FC<PermissionDrawerProps> = ({
  isOpen,
  options,
  toolCall,
  onResponse,
  onClose,
}) => {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [customMessage, setCustomMessage] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLDivElement>(null);

  // Get the title for the permission request
  const getTitle = () => {
    if (toolCall.kind === 'edit' || toolCall.kind === 'write') {
      const fileName =
        toolCall.locations?.[0]?.path?.split('/').pop() || 'file';
      return (
        <>
          Allow write to{' '}
          <span className="font-mono text-[var(--app-primary-foreground)]">
            {fileName}
          </span>
          ?
        </>
      );
    }
    if (toolCall.kind === 'execute' || toolCall.kind === 'bash') {
      return 'Allow command execution?';
    }
    if (toolCall.kind === 'read') {
      const fileName =
        toolCall.locations?.[0]?.path?.split('/').pop() || 'file';
      return (
        <>
          Allow read from{' '}
          <span className="font-mono text-[var(--app-primary-foreground)]">
            {fileName}
          </span>
          ?
        </>
      );
    }
    return toolCall.title || 'Permission Required';
  };

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) {
        return;
      }

      // Number keys 1-9 for quick select
      const numMatch = e.key.match(/^[1-9]$/);
      if (
        numMatch &&
        !customInputRef.current?.contains(document.activeElement)
      ) {
        const index = parseInt(e.key, 10) - 1;
        if (index < options.length) {
          e.preventDefault();
          onResponse(options[index].optionId);
        }
        return;
      }

      // Arrow keys for navigation
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const totalItems = options.length + 1; // +1 for custom input
        if (e.key === 'ArrowDown') {
          setFocusedIndex((prev) => (prev + 1) % totalItems);
        } else {
          setFocusedIndex((prev) => (prev - 1 + totalItems) % totalItems);
        }
      }

      // Enter to select
      if (
        e.key === 'Enter' &&
        !customInputRef.current?.contains(document.activeElement)
      ) {
        e.preventDefault();
        if (focusedIndex < options.length) {
          onResponse(options[focusedIndex].optionId);
        }
      }

      // Escape to close
      if (e.key === 'Escape' && onClose) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, options, onResponse, onClose, focusedIndex]);

  // Focus container when opened
  useEffect(() => {
    if (isOpen && containerRef.current) {
      containerRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[1000] p-2">
      {/* Main container */}
      <div
        ref={containerRef}
        className="relative flex flex-col rounded-large border p-2 outline-none animate-[slideUp_0.2s_ease-out]"
        style={{
          backgroundColor: 'var(--app-input-secondary-background)',
          borderColor: 'var(--app-input-border)',
        }}
        tabIndex={0}
        data-focused-index={focusedIndex}
      >
        {/* Background layer */}
        <div
          className="absolute inset-0 rounded-large"
          style={{ backgroundColor: 'var(--app-input-background)' }}
        />

        {/* Title */}
        <div className="relative z-[1] px-3 py-3">
          <div
            className="text-sm font-medium"
            style={{ color: 'var(--app-secondary-foreground)' }}
          >
            {getTitle()}
          </div>
        </div>

        {/* Options */}
        <div className="relative z-[1] flex flex-col gap-1 px-1 pb-1">
          {options.map((option, index) => {
            const isFocused = focusedIndex === index;

            return (
              <button
                key={option.optionId}
                className={`flex items-center gap-2 px-2 py-1.5 text-left w-full box-border rounded-[4px] border-0 shadow-[inset_0_0_0_1px_var(--app-transparent-inner-border)] transition-colors duration-150 text-[var(--app-primary-foreground)] ${
                  isFocused
                    ? 'bg-[var(--app-list-active-background)] text-[var(--app-list-active-foreground)]'
                    : 'hover:bg-[var(--app-list-hover-background)]'
                }`}
                onClick={() => onResponse(option.optionId)}
                onMouseEnter={() => setFocusedIndex(index)}
              >
                {/* Number badge */}
                <span
                  className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-semibold rounded ${
                    isFocused
                      ? 'text-inherit'
                      : 'bg-[var(--app-list-hover-background)]'
                  }`}
                >
                  {index + 1}
                </span>

                {/* Option text */}
                <span className="text-sm">{option.name}</span>

                {/* Always badge */}
                {/* {isAlways && <span className="text-sm">⚡</span>} */}
              </button>
            );
          })}

          {/* Custom message input (styled consistently with option items) */}
          {(() => {
            const isFocused = focusedIndex === options.length;
            return (
              <div
                className={`flex items-center gap-2 px-2 py-1.5 text-left w-full box-border rounded-[4px] border-0 shadow-[inset_0_0_0_1px_var(--app-transparent-inner-border)] transition-colors duration-150 cursor-text text-[var(--app-primary-foreground)] ${
                  isFocused
                    ? 'bg-[var(--app-list-active-background)] text-[var(--app-list-active-foreground)]'
                    : 'hover:bg-[var(--app-list-hover-background)]'
                }`}
                onMouseEnter={() => setFocusedIndex(options.length)}
                onClick={() => customInputRef.current?.focus()}
              >
                {/* Number badge (N+1) */}
                <span
                  className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-semibold rounded ${
                    isFocused
                      ? 'text-inherit'
                      : 'bg-[var(--app-list-hover-background)]'
                  }`}
                >
                  {options.length + 1}
                </span>

                {/* Input field */}
                <input
                  ref={customInputRef as React.RefObject<HTMLInputElement>}
                  type="text"
                  placeholder="Tell Qwen what to do instead"
                  spellCheck={false}
                  className="flex-1 bg-transparent border-0 outline-none text-sm placeholder:opacity-70"
                  style={{ color: 'var(--app-input-foreground)' }}
                  value={customMessage}
                  onChange={(e) => setCustomMessage(e.target.value)}
                  onFocus={() => setFocusedIndex(options.length)}
                  onKeyDown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      customMessage.trim()
                    ) {
                      e.preventDefault();
                      const rejectOption = options.find((o) =>
                        o.kind.includes('reject'),
                      );
                      if (rejectOption) {
                        onResponse(rejectOption.optionId);
                      }
                    }
                  }}
                />
              </div>
            );
          })()}
        </div>
      </div>

      <style>{`
        @keyframes slideUp {
          from {
            transform: translateY(100%);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
};
