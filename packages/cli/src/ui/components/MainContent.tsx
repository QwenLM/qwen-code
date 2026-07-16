/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Static } from 'ink';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import { isHistoryItemVisibleAfterRestore } from '../types.js';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import { ShowMoreLines } from './ShowMoreLines.js';
import { Notifications } from './Notifications.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useAppContext } from '../contexts/AppContext.js';
import { AppHeader } from './AppHeader.js';
import { DebugModeNotification } from './DebugModeNotification.js';
import {
  countMarkdownSourceBlocks,
  type MarkdownSourceCopyIndexOffsets,
} from '../utils/MarkdownDisplay.js';
import { buildThoughtHeadIdMap } from '../utils/historyUtils.js';
import {
  ScrollableList,
  SCROLL_TO_ITEM_END,
  type ScrollableListRef,
} from './shared/ScrollableList.js';
import { TextSelectionController } from '../selection/use-text-selection.js';

// Limit Gemini messages to a very high number of lines to mitigate performance
// issues in the worst case if we somehow get an enormous response from Gemini.
// This threshold is arbitrary but should be high enough to never impact normal
// usage.
const MAX_GEMINI_MESSAGE_LINES = 65536;

function createEmptySourceCopyOffsets(): MarkdownSourceCopyIndexOffsets {
  return {
    codeBlockLanguageCounts: new Map<string, number>(),
    mathBlockCount: 0,
  };
}

function cloneSourceCopyOffsets(
  offsets: MarkdownSourceCopyIndexOffsets,
): MarkdownSourceCopyIndexOffsets {
  return {
    codeBlockLanguageCounts: new Map(offsets.codeBlockLanguageCounts),
    mathBlockCount: offsets.mathBlockCount,
  };
}

function addSourceBlockCounts(
  offsets: MarkdownSourceCopyIndexOffsets,
  text: string,
) {
  const counts = countMarkdownSourceBlocks(text);
  for (const [lang, count] of counts.codeBlockLanguageCounts) {
    const current = offsets.codeBlockLanguageCounts.get(lang) ?? 0;
    offsets.codeBlockLanguageCounts.set(lang, current + count);
  }
  offsets.mathBlockCount += counts.mathBlockCount;
}

// Issue #3899: Ink's <Static> renders all items synchronously on (re)mount.
// For long histories that's O(N) blocking work — bad on Ctrl+O which clears
// the terminal and forces a full remount. To keep input responsive, we
// progressively grow the slice of history fed to <Static> when the catch-up
// gap is large (initial mount of a resumed session, or post-Ctrl+O remount).
// Below the threshold the slice jumps to full length in one render so normal
// runtime appends are bit-identical to the previous behavior.
//
// TODO(#3899 follow-up): the thresholds below are unbenchmarked. Per-item
// render cost varies hugely (a one-line user message vs. thousands of lines
// of tool stdout), so an item-count budget over-yields for tiny items and
// under-yields for big ones. Consider switching to a *line-budget* per
// chunk once we have telemetry on actual render times.
const PROGRESSIVE_REPLAY_THRESHOLD = 100;
const PROGRESSIVE_REPLAY_CHUNK_SIZE = 50;

function initialReplayCount(length: number): number {
  return length <= PROGRESSIVE_REPLAY_THRESHOLD
    ? length
    : Math.min(PROGRESSIVE_REPLAY_CHUNK_SIZE, length);
}

// Memoized wrapper used only by the virtual scroll path. Prevents re-rendering
// stable completed items when unrelated UIState fields change during streaming.
const VirtualHistoryItem = memo(HistoryItemDisplay);

// Banner sentinel injected as the first virtual-scroll item so it scrolls with
// content instead of being pinned at the top (saves vertical space on small
// terminals).
type VpBannerItem = { type: 'vp-banner'; id: number };
type VpItem = HistoryItem | VpBannerItem;
const VP_BANNER_ID = Number.MIN_SAFE_INTEGER;
const VP_BANNER_ITEM: VpBannerItem = { type: 'vp-banner', id: VP_BANNER_ID };

// Pure functions with no closure deps — defined outside the component so they
// are stable references and never trigger useMemo/useCallback invalidation.
// index 0 is always the banner sentinel (VP_BANNER_ITEM is prepended first).
const virtualEstimatedItemHeight = (index: number) => (index === 0 ? 10 : 3);
const virtualKeyExtractor = (item: VpItem) =>
  item.type === 'vp-banner'
    ? 'vp-banner'
    : item.id >= 0
      ? `h-${item.id}`
      : `p-${-item.id - 1}`;
const virtualIsStaticItem = (item: VpItem) =>
  item.type === 'vp-banner' || item.id > 0;

export const MainContent = () => {
  const { version } = useAppContext();
  const uiState = useUIState();
  const showScrollbar = uiState.showScrollbar ?? true;
  const {
    pendingHistoryItems,
    terminalWidth,
    mainAreaWidth,
    staticAreaMaxItemHeight,
    availableTerminalHeight,
    historyRemountKey,
  } = uiState;

  // Filter out items whose display is suppressed (e.g. /history collapse).
  const visibleHistory = useMemo(
    () => uiState.history.filter(isHistoryItemVisibleAfterRestore),
    [uiState.history],
  );

  // History is rendered as-is (no cross-group merging).

  // Virtual viewport path short-circuits below before any of the
  // <Static>-only machinery is needed. The offsets / progressive-replay
  // state still computes because it lives at the top of the component, but
  // useMemo keeps it cheap when nothing changes.
  const useVirtualScroll = uiState.useTerminalBuffer;
  const scrollRef = useRef<ScrollableListRef<VpItem>>(null);

  const { historyItemsWithSourceCopyOffsets, pendingStartSourceCopyOffsets } =
    useMemo(() => {
      let runningOffsets = createEmptySourceCopyOffsets();

      const items = visibleHistory.map((item) => {
        if (item.type === 'gemini') {
          runningOffsets = createEmptySourceCopyOffsets();
          const offsets = cloneSourceCopyOffsets(runningOffsets);
          addSourceBlockCounts(runningOffsets, item.text);
          return { item, sourceCopyIndexOffsets: offsets };
        }

        if (item.type === 'gemini_content') {
          const offsets = cloneSourceCopyOffsets(runningOffsets);
          addSourceBlockCounts(runningOffsets, item.text);
          return { item, sourceCopyIndexOffsets: offsets };
        }

        if (item.type === 'user') {
          runningOffsets = createEmptySourceCopyOffsets();
        }

        return { item, sourceCopyIndexOffsets: undefined };
      });

      return {
        historyItemsWithSourceCopyOffsets: items,
        pendingStartSourceCopyOffsets: cloneSourceCopyOffsets(runningOffsets),
      };
    }, [visibleHistory]);

  const pendingHistoryItemsWithSourceCopyOffsets = useMemo(() => {
    let runningOffsets = cloneSourceCopyOffsets(pendingStartSourceCopyOffsets);

    return pendingHistoryItems.map((item) => {
      if (item.type === 'gemini') {
        runningOffsets = createEmptySourceCopyOffsets();
        const offsets = cloneSourceCopyOffsets(runningOffsets);
        addSourceBlockCounts(runningOffsets, item.text);
        return { item, sourceCopyIndexOffsets: offsets };
      }

      if (item.type === 'gemini_content') {
        const offsets = cloneSourceCopyOffsets(runningOffsets);
        addSourceBlockCounts(runningOffsets, item.text);
        return { item, sourceCopyIndexOffsets: offsets };
      }

      if (item.type === 'user') {
        runningOffsets = createEmptySourceCopyOffsets();
      }

      return { item, sourceCopyIndexOffsets: undefined };
    });
  }, [pendingHistoryItems, pendingStartSourceCopyOffsets]);

  // Progressive Static replay (issue #3899). `replayCount` is the number of
  // history items currently passed to <Static>. It catches up to
  // visibleHistory.length either in one shot (small lag) or chunk-by-chunk
  // through setImmediate (large lag, e.g., post-Ctrl+O remount of a 500-item
  // session).
  //
  // Note: source-copy offsets are computed across the FULL visibleHistory
  // above so each code block keeps its stable copy index even when only a
  // prefix is visible; we slice the post-offset array here.
  const [replayCount, setReplayCount] = useState(() =>
    initialReplayCount(visibleHistory.length),
  );
  const visibleHistoryLengthRef = useRef(visibleHistory.length);
  visibleHistoryLengthRef.current = visibleHistory.length;

  // The reset MUST happen during render (not in an effect): historyRemountKey
  // also drives the <Static> key below, and Ink remounts Static synchronously
  // on its first render with the new key. If we reset replayCount in a
  // useEffect, that first render would already feed the full history to the
  // new <Static> and we'd hit the freeze the PR is trying to avoid. The
  // canonical "store previous prop in state" pattern queues a re-render
  // that discards this one before commit, so <Static> never sees the
  // stale full slice. Refs alone won't work — they don't trigger a re-render.
  // See: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastRemountKey, setLastRemountKey] = useState(historyRemountKey);
  if (lastRemountKey !== historyRemountKey) {
    setLastRemountKey(historyRemountKey);
    // VP path consumes the full `allVirtualItems` array and never reads
    // `replayCount` / `visibleHistoryItemsWithSourceCopyOffsets`. Skip the
    // chunked-replay reset for VP users so a Ctrl+O / model-change bump
    // doesn't trigger ~M/CHUNK_SIZE extra setImmediate-scheduled
    // re-renders (M = visibleHistory.length) that the VP path discards.
    if (!useVirtualScroll) {
      setReplayCount(initialReplayCount(visibleHistoryLengthRef.current));
    }
  }

  useEffect(() => {
    if (useVirtualScroll) return;
    if (replayCount >= visibleHistory.length) return;
    const remaining = visibleHistory.length - replayCount;
    if (remaining <= PROGRESSIVE_REPLAY_CHUNK_SIZE) {
      setReplayCount(visibleHistory.length);
      return;
    }
    const handle = setImmediate(() => {
      setReplayCount((c) =>
        Math.min(
          c + PROGRESSIVE_REPLAY_CHUNK_SIZE,
          visibleHistoryLengthRef.current,
        ),
      );
    });
    return () => clearImmediate(handle);
  }, [useVirtualScroll, replayCount, visibleHistory.length]);

  // Render the full list when the tail gap is small (≤ CHUNK_SIZE). This
  // covers the normal append path: a pending item finalizes, replayCount is
  // already close to the new length, so we skip one useless slice frame.
  // Without this, a just-finalized item could briefly disappear for one tick
  // because it is gone from pendingHistoryItems but not yet in the Static
  // slice. Chunked replay is still used for large remount gaps (Ctrl+O on a
  // long session) where the gap is >> CHUNK_SIZE.
  const visibleHistoryItemsWithSourceCopyOffsets =
    historyItemsWithSourceCopyOffsets.length - replayCount <=
    PROGRESSIVE_REPLAY_CHUNK_SIZE
      ? historyItemsWithSourceCopyOffsets
      : historyItemsWithSourceCopyOffsets.slice(0, replayCount);

  // Combine completed history + live pending items for the virtualized list.
  // The banner sentinel is prepended so it scrolls with content (not pinned).
  // Pending items get negative IDs (-(i+1)) so renderItem can tell them apart.
  const allVirtualItems = useMemo(
    (): VpItem[] => [
      VP_BANNER_ITEM,
      ...visibleHistory,
      ...pendingHistoryItems.map((item, i) => ({ ...item, id: -(i + 1) })),
    ],
    [visibleHistory, pendingHistoryItems],
  );

  // Source-copy index offsets propagation. The legacy <Static> path threads
  // per-item offsets so `/copy mermaid N` / `/copy latex N` hints under each
  // diagram stay stable across continuation messages. Build lookup tables so
  // the VP renderItem can attach the same offsets without changing the
  // VirtualizedList API.
  //   - Static items: look up by HistoryItem reference (visibleHistory items
  //     are passed by ref, so identity-keyed lookup is stable).
  //   - Pending items: look up by pending-array index (the spread
  //     `{...item, id: -(i+1)}` creates a new object every render, so the
  //     index is the only stable handle).
  const sourceCopyOffsetsByHistoryItem = useMemo(() => {
    const map = new Map<
      HistoryItem | HistoryItemWithoutId,
      MarkdownSourceCopyIndexOffsets
    >();
    for (const {
      item,
      sourceCopyIndexOffsets,
    } of historyItemsWithSourceCopyOffsets) {
      if (sourceCopyIndexOffsets) {
        map.set(item, sourceCopyIndexOffsets);
      }
    }
    return map;
  }, [historyItemsWithSourceCopyOffsets]);

  const thoughtHeadIdByItem = useMemo(
    () => buildThoughtHeadIdMap(visibleHistory),
    [visibleHistory],
  );
  const thoughtHeadIdByItemRef = useRef(thoughtHeadIdByItem);
  thoughtHeadIdByItemRef.current = thoughtHeadIdByItem;

  const pendingSourceCopyOffsetsByIndex = useMemo(
    () =>
      pendingHistoryItemsWithSourceCopyOffsets.map(
        ({ sourceCopyIndexOffsets }) => sourceCopyIndexOffsets,
      ),
    [pendingHistoryItemsWithSourceCopyOffsets],
  );

  // Refs for streaming-only UI state (activePtyId, embeddedShellFocused,
  // isEditorDialogOpen) AND for pending source-copy offsets. Reading these
  // via refs inside `renderVirtualItem` keeps the callback identity stable
  // when they change mid-stream (a shell tool starts/stops, a new pending
  // chunk lands). Without the refs, every change would rebuild
  // `renderVirtualItem`, invalidate `VirtualizedList.renderedItems`'s
  // useMemo, and rebuild JSX for every visible item — defeating
  // `StaticRender`/`memo(HistoryItemDisplay)`'s skip. Pending items are
  // still correctly re-rendered because their `item` reference changes
  // per tick, so the per-item render is called fresh and reads the latest
  // ref values.
  const pendingStateRef = useRef({
    activePtyId: uiState.activePtyId,
    embeddedShellFocused: uiState.embeddedShellFocused,
    isEditorDialogOpen: uiState.isEditorDialogOpen,
    constrainHeight: uiState.constrainHeight,
    availableTerminalHeight,
  });
  pendingStateRef.current = {
    activePtyId: uiState.activePtyId,
    embeddedShellFocused: uiState.embeddedShellFocused,
    isEditorDialogOpen: uiState.isEditorDialogOpen,
    constrainHeight: uiState.constrainHeight,
    availableTerminalHeight,
  };
  const pendingSourceCopyOffsetsRef = useRef(pendingSourceCopyOffsetsByIndex);
  pendingSourceCopyOffsetsRef.current = pendingSourceCopyOffsetsByIndex;

  // Stable renderItem: deps shrink to inputs that legitimately change the
  // render output for a given item identity (terminalWidth, slashCommands,
  // static-history source-copy offsets).
  // Streaming-only state — including pending source-copy offsets — is read
  // from refs so callback identity is stable.
  const renderVirtualItem = useCallback(
    ({ item }: { item: VpItem }) => {
      if (item.type === 'vp-banner') {
        return (
          <Box flexDirection="column">
            <AppHeader version={version} />
            <DebugModeNotification />
            <Notifications />
          </Box>
        );
      }
      const isPending = item.id < 0;
      const sourceCopyIndexOffsets = isPending
        ? pendingSourceCopyOffsetsRef.current[-item.id - 1]
        : sourceCopyOffsetsByHistoryItem.get(item);
      if (isPending) {
        const ps = pendingStateRef.current;
        return (
          <VirtualHistoryItem
            terminalWidth={terminalWidth}
            mainAreaWidth={mainAreaWidth}
            availableTerminalHeight={
              ps.constrainHeight ? ps.availableTerminalHeight : undefined
            }
            item={{ ...item, id: 0 }}
            isPending={true}
            isFocused={!ps.isEditorDialogOpen}
            activeShellPtyId={ps.activePtyId}
            embeddedShellFocused={ps.embeddedShellFocused}
            commands={uiState.slashCommands}
            sourceCopyIndexOffsets={sourceCopyIndexOffsets}
          />
        );
      }
      return (
        <VirtualHistoryItem
          terminalWidth={terminalWidth}
          mainAreaWidth={mainAreaWidth}
          availableTerminalHeight={staticAreaMaxItemHeight}
          availableTerminalHeightGemini={MAX_GEMINI_MESSAGE_LINES}
          item={item}
          isPending={false}
          commands={uiState.slashCommands}
          sourceCopyIndexOffsets={sourceCopyIndexOffsets}
          thoughtHeadId={thoughtHeadIdByItemRef.current.get(item)}
        />
      );
    },
    [
      version,
      terminalWidth,
      mainAreaWidth,
      staticAreaMaxItemHeight,
      uiState.slashCommands,
      sourceCopyOffsetsByHistoryItem,
    ],
  );

  if (useVirtualScroll) {
    const scrollContainerHeight = Math.max(
      0,
      uiState.availableTerminalHeight ?? 0,
    );

    return (
      <OverflowProvider>
        <ScrollableList
          ref={scrollRef}
          hasFocus={!uiState.dialogsVisible}
          data={allVirtualItems}
          renderItem={renderVirtualItem}
          estimatedItemHeight={virtualEstimatedItemHeight}
          keyExtractor={virtualKeyExtractor}
          initialScrollIndex={
            allVirtualItems.length <= 1 ? 0 : SCROLL_TO_ITEM_END
          }
          isStaticItem={virtualIsStaticItem}
          containerHeight={scrollContainerHeight}
          showScrollbar={showScrollbar}
        />
        <TextSelectionController
          isActive={!uiState.dialogsVisible}
          getViewportRect={() => scrollRef.current?.getViewportRect() ?? null}
          getScrollState={() =>
            scrollRef.current?.getScrollState() ?? {
              scrollTop: 0,
              scrollHeight: 0,
              innerHeight: 0,
            }
          }
          hitTestScrollbar={(location) =>
            scrollRef.current?.hitTestScrollbar(location) ?? false
          }
        />
        <ShowMoreLines constrainHeight={uiState.constrainHeight} />
      </OverflowProvider>
    );
  }

  return (
    <>
      {/*
        renderMode is intentionally omitted here. AppContainer calls
        refreshStatic() when renderMode changes, which updates
        historyRemountKey; including both would remount Static twice.
      */}
      <Static
        key={`${historyRemountKey}-${uiState.currentModel}`}
        items={[
          <AppHeader key="app-header" version={version} />,
          <DebugModeNotification key="debug-notification" />,
          <Notifications key="notifications" />,
          ...visibleHistoryItemsWithSourceCopyOffsets.map(
            ({ item: h, sourceCopyIndexOffsets }) => (
              <HistoryItemDisplay
                terminalWidth={terminalWidth}
                mainAreaWidth={mainAreaWidth}
                availableTerminalHeight={staticAreaMaxItemHeight}
                availableTerminalHeightGemini={MAX_GEMINI_MESSAGE_LINES}
                key={h.id}
                item={h}
                isPending={false}
                commands={uiState.slashCommands}
                sourceCopyIndexOffsets={sourceCopyIndexOffsets}
                thoughtHeadId={thoughtHeadIdByItem.get(h)}
              />
            ),
          ),
        ]}
      >
        {(item) => item}
      </Static>
      <OverflowProvider>
        <Box flexDirection="column">
          {/*
            Hard Ink backstop on the live (non-<Static>) pending region. The
            estimator's source-line slice (MarkdownDisplay's fitPendingSlice) is
            the primary bound, but it is disabled whenever availableTerminalHeight
            is undefined — which is exactly what happens when constrainHeight is
            off (ctrl-s "show more lines"). A tall pending item (e.g. a long
            vertical-fallback table) then renders past the viewport, Ink cannot
            update incrementally and clears the terminal, redrawing from the top
            on every repaint — the "scroll-to-top lock". Capping this region at
            availableTerminalHeight (which already excludes the footer/controls)
            keeps its measured height within the viewport so Ink never trips that
            path. While constrained the estimator keeps content well under this,
            so the clamp is a no-op there and only engages on residual overflow.
            ShowMoreLines stays OUTSIDE the clamp; it only renders while
            constrained (so the clamp is inert) and must not be clipped.
          */}
          <Box
            flexDirection="column"
            flexShrink={0}
            maxHeight={availableTerminalHeight || undefined}
            overflow="hidden"
          >
            {pendingHistoryItemsWithSourceCopyOffsets.map(
              ({ item, sourceCopyIndexOffsets }, i) => (
                <HistoryItemDisplay
                  key={i}
                  availableTerminalHeight={
                    uiState.constrainHeight
                      ? availableTerminalHeight
                      : undefined
                  }
                  terminalWidth={terminalWidth}
                  mainAreaWidth={mainAreaWidth}
                  item={{ ...item, id: 0 }}
                  isPending={true}
                  isFocused={!uiState.isEditorDialogOpen}
                  activeShellPtyId={uiState.activePtyId}
                  embeddedShellFocused={uiState.embeddedShellFocused}
                  sourceCopyIndexOffsets={sourceCopyIndexOffsets}
                />
              ),
            )}
          </Box>
          <ShowMoreLines constrainHeight={uiState.constrainHeight} />
        </Box>
      </OverflowProvider>
    </>
  );
};
