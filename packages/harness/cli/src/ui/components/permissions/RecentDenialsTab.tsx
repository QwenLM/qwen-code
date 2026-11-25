/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useCallback, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { type AutoModeDenial } from '@qwen-code/core';
import { RadioButtonSelect } from '../shared/RadioButtonSelect.js';
import { theme } from '../../semantic-colors.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RecentDenialsState {
  approved: Set<number>;
  retry: Set<number>;
  denials: readonly AutoModeDenial[];
}

interface RecentDenialsTabProps {
  /**
   * The refusals this session's classifier recorded, snapshotted by the parent
   * when the dialog opened. Injected rather than read from a global so the tab
   * can only ever list this session's denials.
   */
  initialDenials: readonly AutoModeDenial[];
  /** Called when approved/retry state changes so parent can act on exit */
  onStateChange: (state: RecentDenialsState) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * "Recently denied" tab content for the /permissions dialog.
 *
 * Shows commands recently blocked by the auto-mode classifier.
 * Users can:
 *  - Press Enter to toggle approval (✓/✗)
 *  - Press 'r' to mark for retry (will re-execute on exit)
 */
export function RecentDenialsTab({
  initialDenials,
  onStateChange,
}: RecentDenialsTabProps): React.JSX.Element {
  const [denials] = useState<readonly AutoModeDenial[]>(() => initialDenials);
  const [approved, setApproved] = useState<Set<number>>(() => new Set());
  const [retry, setRetry] = useState<Set<number>>(() => new Set());
  const [focusedIdx, setFocusedIdx] = useState(0);

  // Notify parent of state changes
  useEffect(() => {
    onStateChange({ approved, retry, denials });
  }, [approved, retry, denials, onStateChange]);

  // Handle 'r' key for retry toggle
  const handleRetryKey = useCallback(
    (key: Key) => {
      if (key.sequence === 'r') {
        setRetry((prev) => {
          const next = new Set(prev);
          if (next.has(focusedIdx)) {
            next.delete(focusedIdx);
          } else {
            next.add(focusedIdx);
          }
          return next;
        });
        // Auto-approve when marking for retry
        setApproved((prev) => {
          if (prev.has(focusedIdx)) return prev;
          const next = new Set(prev);
          next.add(focusedIdx);
          return next;
        });
        return true;
      }
      return false;
    },
    [focusedIdx],
  );

  useKeypress(handleRetryKey, { isActive: denials.length > 0 });

  const items = useMemo(
    () =>
      denials.map((d, idx) => {
        const suffix = retry.has(idx) ? ' (retry)' : '';
        const label = `${d.toolName} \u2014 ${d.reason}${suffix}`;

        return {
          key: String(idx),
          label,
          value: idx,
        };
      }),
    [denials, retry],
  );

  const handleSelect = useCallback((value: number) => {
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  }, []);

  if (denials.length === 0) {
    return (
      <Text dimColor>
        No recent denials. Commands denied by the auto mode classifier will
        appear here.
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>Commands recently denied by the auto mode classifier.</Text>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          onSelect={handleSelect}
          onHighlight={(value) => setFocusedIdx(value)}
          isFocused={true}
          maxItemsToShow={Math.min(10, items.length)}
          renderItem={(item, ctx) => {
            const isApproved = approved.has(item.value);
            const icon = isApproved ? '✓' : '✗';
            const iconColor = isApproved
              ? theme.status.success
              : theme.status.error;
            return (
              <Text color={ctx.isSelected ? ctx.titleColor : undefined}>
                <Text color={iconColor}>{icon} </Text>
                {item.label}
              </Text>
            );
          }}
        />
      </Box>
    </Box>
  );
}
