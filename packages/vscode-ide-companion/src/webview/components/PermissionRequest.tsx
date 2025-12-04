/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';

export interface PermissionOption {
  name: string;
  kind: string;
  optionId: string;
}

export interface ToolCall {
  title?: string;
  kind?: string;
  toolCallId?: string;
  rawInput?: {
    command?: string;
    description?: string;
    [key: string]: unknown;
  };
  content?: Array<{
    type: string;
    [key: string]: unknown;
  }>;
  locations?: Array<{
    path: string;
    line?: number | null;
  }>;
  status?: string;
}

export interface PermissionRequestProps {
  options: PermissionOption[];
  toolCall: ToolCall;
  onResponse: (optionId: string) => void;
}

export const PermissionRequest: React.FC<PermissionRequestProps> = ({
  options,
  toolCall,
  onResponse,
}) => {
  const [selected, setSelected] = useState<string | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);

  const getToolInfo = () => {
    if (!toolCall) {
      return {
        title: 'Permission Request',
        description: 'Agent is requesting permission',
        icon: '🔐',
      };
    }

    const displayTitle =
      toolCall.title || toolCall.rawInput?.description || 'Permission Request';

    const kindIcons: Record<string, string> = {
      edit: '✏️',
      read: '📖',
      fetch: '🌐',
      execute: '⚡',
      delete: '🗑️',
      move: '📦',
      search: '🔍',
      think: '💭',
      other: '🔧',
    };

    return {
      title: displayTitle,
      icon: kindIcons[toolCall.kind || 'other'] || '🔧',
    };
  };

  const { title, icon } = getToolInfo();

  const handleConfirm = async () => {
    if (hasResponded || !selected) {
      return;
    }

    setIsResponding(true);
    try {
      await onResponse(selected);
      setHasResponded(true);
    } catch (error) {
      console.error('Error confirming permission:', error);
    } finally {
      setIsResponding(false);
    }
  };

  if (!toolCall) {
    return null;
  }

  return (
    <div className="permission-request-card">
      <div className="permission-card-body">
        {/* Header with icon and title */}
        <div className="permission-header">
          <div className="permission-icon-wrapper">
            <span className="permission-icon">{icon}</span>
          </div>
          <div className="permission-info">
            <div className="permission-title">{title}</div>
            <div className="permission-subtitle">Waiting for your approval</div>
          </div>
        </div>

        {/* Show command if available */}
        {(toolCall.rawInput?.command || toolCall.title) && (
          <div className="permission-command-section">
            <div className="permission-command-header">
              <div className="permission-command-status">
                <span className="permission-command-dot">●</span>
                <span className="permission-command-label">COMMAND</span>
              </div>
            </div>
            <div className="permission-command-content">
              <div className="permission-command-input-section">
                <span className="permission-command-io-label">IN</span>
                <code className="permission-command-code">
                  {toolCall.rawInput?.command || toolCall.title}
                </code>
              </div>
              {toolCall.rawInput?.description && (
                <div className="permission-command-description">
                  {toolCall.rawInput.description}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Show file locations if available */}
        {toolCall.locations && toolCall.locations.length > 0 && (
          <div className="permission-locations-section">
            <div className="permission-locations-label">Affected Files</div>
            {toolCall.locations.map((location, index) => (
              <div key={index} className="permission-location-item">
                <span className="permission-location-icon">📄</span>
                <span className="permission-location-path">
                  {location.path}
                </span>
                {location.line !== null && location.line !== undefined && (
                  <span className="permission-location-line">
                    ::{location.line}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Options */}
        {!hasResponded && (
          <div className="permission-options-section">
            <div className="permission-options-label">Choose an action:</div>
            <div className="permission-options-list">
              {options && options.length > 0 ? (
                options.map((option, index) => {
                  const isSelected = selected === option.optionId;
                  const isAllow = option.kind.includes('allow');
                  const isAlways = option.kind.includes('always');

                  return (
                    <label
                      key={option.optionId}
                      className={`permission-option ${isSelected ? 'selected' : ''} ${
                        isAllow ? 'allow' : 'reject'
                      } ${isAlways ? 'always' : ''}`}
                    >
                      <input
                        type="radio"
                        name="permission"
                        value={option.optionId}
                        checked={isSelected}
                        onChange={() => setSelected(option.optionId)}
                        className="permission-radio"
                      />
                      <span className="permission-option-content">
                        <span className="permission-option-number">
                          {index + 1}
                        </span>
                        {isAlways && (
                          <span className="permission-always-badge">⚡</span>
                        )}
                        {option.name}
                      </span>
                    </label>
                  );
                })
              ) : (
                <div className="permission-no-options">
                  No options available
                </div>
              )}
            </div>
            <div className="permission-actions">
              <button
                className="permission-confirm-button"
                disabled={!selected || isResponding}
                onClick={handleConfirm}
              >
                {isResponding ? 'Processing...' : 'Confirm'}
              </button>
            </div>
          </div>
        )}

        {/* Success message */}
        {hasResponded && (
          <div className="permission-success">
            <span className="permission-success-icon">✓</span>
            <span className="permission-success-text">
              Response sent successfully
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
