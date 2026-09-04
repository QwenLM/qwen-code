/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type FC,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { usePlatform } from '../../context/PlatformContext.js';
import { CopyIcon } from '../icons/EditIcons.js';
import { CheckIcon } from '../icons/StatusIcons.js';

interface MessageMetaProps {
  timestamp?: number;
  copyText: string;
  onEdit?: () => void;
  editDisabled?: boolean;
  editIcon?: ReactNode;
}

function getMessageDate(timestamp?: number): Date | null {
  if (
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    return null;
  }

  return new Date(timestamp);
}

function formatMessageTime(timestamp?: number): string | null {
  const date = getMessageDate(timestamp);
  if (!date) {
    return null;
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMessageDateTime(timestamp?: number): string | undefined {
  const date = getMessageDate(timestamp);
  if (!date) {
    return undefined;
  }

  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

export const MessageMeta: FC<MessageMetaProps> = ({
  timestamp,
  copyText,
  onEdit,
  editDisabled = false,
  editIcon,
}) => {
  const platform = usePlatform();
  const platformCopyToClipboard = platform.copyToClipboard;
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const formattedTime = formatMessageTime(timestamp);
  const canCopy = platform.features?.canCopy !== false && copyText.length > 0;
  const dateTime = formatMessageDateTime(timestamp);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!canCopy) {
        return;
      }

      try {
        if (platformCopyToClipboard) {
          await platformCopyToClipboard(copyText);
        } else {
          await navigator.clipboard.writeText(copyText);
        }

        setCopied(true);
        if (resetTimerRef.current !== null) {
          window.clearTimeout(resetTimerRef.current);
        }
        resetTimerRef.current = window.setTimeout(() => {
          setCopied(false);
          resetTimerRef.current = null;
        }, 1400);
      } catch (error) {
        console.error('Failed to copy message:', error);
      }
    },
    [canCopy, copyText, platformCopyToClipboard],
  );

  if (!formattedTime && !canCopy && !onEdit) {
    return null;
  }

  return (
    <div className="mt-1 flex min-h-6 items-center gap-1 text-xs text-[var(--app-secondary-foreground)]">
      {formattedTime && (
        <time className="select-none opacity-60" dateTime={dateTime}>
          {formattedTime}
        </time>
      )}

      <div
        className={`flex items-center gap-0.5 transition-opacity focus-within:opacity-100 ${
          copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-70'
        }`}
      >
        {canCopy && (
          <button
            type="button"
            className={`inline-flex h-6 w-6 items-center justify-center rounded-sm border border-transparent bg-transparent transition-colors hover:bg-[var(--app-ghost-button-hover-background)] hover:opacity-100 focus:opacity-100 ${copied ? 'text-[#74c991] opacity-100' : ''}`}
            title={copied ? 'Copied' : 'Copy message'}
            aria-label={copied ? 'Copied' : 'Copy message'}
            onClick={handleCopy}
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </button>
        )}

        {onEdit && (
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm border border-transparent bg-transparent transition-colors hover:bg-[var(--app-ghost-button-hover-background)] hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
            title="Edit message"
            aria-label="Edit message"
            onClick={onEdit}
            disabled={editDisabled}
          >
            {editIcon}
          </button>
        )}
      </div>
    </div>
  );
};
