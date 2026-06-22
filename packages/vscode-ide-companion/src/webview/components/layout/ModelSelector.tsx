/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FC } from 'react';
import type { ModelInfo } from '@agentclientprotocol/sdk';
import { PlanCompletedIcon } from '@qwen-code/webui';
import {
  DISCONTINUED_MESSAGES,
  isDiscontinuedModel,
} from '../../utils/discontinuedModel.js';

interface ModelSelectorProps {
  visible: boolean;
  models: ModelInfo[];
  currentModelId: string | null;
  onSelectModel: (modelId: string) => void;
  onClose: () => void;
}

export const ModelSelector: FC<ModelSelectorProps> = ({
  visible,
  models,
  currentModelId,
  onSelectModel,
  onClose,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);

  // Reset selection when models change or when opened
  useEffect(() => {
    if (visible) {
      // Find current model index or default to 0
      const currentIndex = models.findIndex(
        (m) => m.modelId === currentModelId,
      );
      setSelected(currentIndex >= 0 ? currentIndex : 0);
      setMounted(true);
      setBlockedMessage(null);
    } else {
      setMounted(false);
      setBlockedMessage(null);
    }
  }, [visible, models, currentModelId]);

  const handleModelSelect = useCallback(
    (modelId: string) => {
      if (isDiscontinuedModel(modelId)) {
        setBlockedMessage(DISCONTINUED_MESSAGES.blockedError);
        return;
      }
      onSelectModel(modelId);
      onClose();
    },
    [onSelectModel, onClose],
  );

  // Handle clicking outside to close and keyboard navigation
  useEffect(() => {
    if (!visible) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelected((prev) => Math.min(prev + 1, models.length - 1));
          // Clear stale block banner so keyboard navigation gives the same
          // feedback as mouse hover.
          setBlockedMessage(null);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelected((prev) => Math.max(prev - 1, 0));
          setBlockedMessage(null);
          break;
        case 'Enter': {
          // Prevent form submission AND stop propagation so the input form
          // does not treat this Enter as a message send.
          event.preventDefault();
          event.stopPropagation();
          const target = models[selected];
          if (!target) {
            break;
          }
          if (isDiscontinuedModel(target.modelId)) {
            setBlockedMessage(DISCONTINUED_MESSAGES.blockedError);
            break;
          }
          onSelectModel(target.modelId);
          onClose();
          break;
        }
        case 'Escape':
          event.preventDefault();
          onClose();
          break;
        default:
          break;
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    // Use capture phase so Enter is handled before bubble-phase handlers
    // (e.g. the InputForm's Enter-to-submit) and stopPropagation can
    // prevent an empty user message.
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [visible, models, selected, onSelectModel, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    const selectedEl = containerRef.current?.querySelector(
      `[data-index="${selected}"]`,
    );
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selected]);

  if (!visible) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      role="menu"
      className={[
        'model-selector',
        // Positioning controlled by parent container
        'flex flex-col overflow-hidden',
        'rounded-large border bg-[var(--app-menu-background)]',
        'border-[var(--app-input-border)] max-h-[50vh] z-[1000]',
        // Mount animation
        mounted ? 'animate-completion-menu-enter' : '',
      ].join(' ')}
    >
      {/* Header */}
      <div className="px-3 py-1.5 text-[var(--app-secondary-foreground)] text-[0.8em] uppercase tracking-wider">
        Select a model
      </div>

      {/* Inline blocked-selection error (cleared on hover or close) */}
      {blockedMessage && (
        <div
          role="alert"
          data-testid="model-selector-blocked"
          className="mx-2 mb-1 rounded px-3 py-2 text-[0.85em]"
          style={{
            background: 'var(--vscode-inputValidation-warningBackground)',
            color: 'var(--vscode-inputValidation-warningForeground)',
            border:
              '1px solid var(--vscode-inputValidation-warningBorder, transparent)',
          }}
        >
          <span aria-hidden="true">⚠ </span>
          {blockedMessage}
        </div>
      )}

      {/* Model list */}
      <div className="flex max-h-[300px] flex-col overflow-y-auto p-[var(--app-list-padding)] pb-2">
        {models.length === 0 ? (
          <div className="px-3 py-4 text-center text-[var(--app-secondary-foreground)] text-sm">
            No models available. Check console for details.
          </div>
        ) : (
          models.map((model, index) => {
            const isActive = index === selected;
            const isCurrentModel = model.modelId === currentModelId;
            const discontinued = isDiscontinuedModel(model.modelId);
            const description = discontinued
              ? DISCONTINUED_MESSAGES.description
              : model.description;
            return (
              <div
                key={model.modelId}
                data-index={index}
                data-discontinued={discontinued ? 'true' : undefined}
                role="menuitem"
                aria-disabled={discontinued ? 'true' : undefined}
                onClick={() => handleModelSelect(model.modelId)}
                onMouseEnter={() => {
                  setSelected(index);
                  // Clear stale block message when hovering a different row so
                  // back-to-back attempts on different discontinued models still
                  // produce fresh feedback.
                  setBlockedMessage(null);
                }}
                className={[
                  'model-selector-item',
                  'mx-1 rounded-[var(--app-list-border-radius)]',
                  discontinued
                    ? 'cursor-not-allowed opacity-60'
                    : 'cursor-pointer',
                  'p-[var(--app-list-item-padding)]',
                  isActive ? 'bg-[var(--app-list-active-background)]' : '',
                ].join(' ')}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <span
                      className={[
                        'block truncate',
                        isActive
                          ? 'text-[var(--app-list-active-foreground)]'
                          : 'text-[var(--app-primary-foreground)]',
                      ].join(' ')}
                    >
                      {model.name}
                      {discontinued && (
                        <span
                          data-testid="discontinued-badge"
                          className="ml-1.5 text-[0.85em]"
                          style={{
                            color:
                              'var(--vscode-editorWarning-foreground, #cca700)',
                          }}
                        >
                          {DISCONTINUED_MESSAGES.badge}
                        </span>
                      )}
                    </span>
                    {description && (
                      <span
                        className="block truncate text-[0.85em] text-[var(--app-secondary-foreground)] opacity-70"
                        style={
                          discontinued
                            ? {
                                color:
                                  'var(--vscode-editorWarning-foreground, #cca700)',
                                opacity: 1,
                              }
                            : undefined
                        }
                      >
                        {description}
                      </span>
                    )}
                  </div>
                  {isCurrentModel && (
                    <span className="flex-shrink-0 text-[var(--app-list-active-foreground)]">
                      <PlanCompletedIcon size={16} />
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
