/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Static, type DOMElement } from 'ink';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { HistoryItem, HistoryItemWithoutId } from '../types.js';
import {
  isHistoryItemVisibleAfterRestore,
  StreamingState,
  ToolCallStatus,
} from '../types.js';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import { ShowMoreLines } from './ShowMoreLines.js';
import { Notifications } from './Notifications.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useAppContext } from '../contexts/AppContext.js';
import { useThoughtExpanded } from '../contexts/ThoughtExpandedContext.js';
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
import { measureElementPosition } from '../utils/measure-element-position.js';

// Limit LLM messages to a very high number of lines to mitigate performance
// issues in the worst case if we somehow get an enormous model response.
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

interface MainContentProps {
  footerRef?: RefObject<DOMElement | null>;
}

export const MainContent = ({ footerRef }: MainContentProps) => {
  const { version } = useAppContext();
  const uiState = useUIState();
  const { allExpanded: fullDetail } = useThoughtExpanded();
  const streamingState = uiState.streamingState;
  const showScrollbar = uiState.showScrollbar ?? true;
  const {
    history,
    pendingHistoryItems,
    terminalWidth,
    mainAreaWidth,
    staticAreaMaxItemHeight,
    availableTerminalHeight,
    historyRemountKey,
  } = uiState;

  // Filter out items whose display is suppressed (e.g. /history collapse)
  // and tool groups folded into a preceding thought line ("Thought for 9s,
  // searched 2 patterns"). The folded groups stay in history (turn mapping,
  // export, SDK) but render only in full detail, where the Ctrl+O remount
  // re-runs this filter with fullDetail on.
  const visibleHistory = useMemo(
    () =>
      history.filter(
        (item) =>
          isHistoryItemVisibleAfterRestore(item) &&
          (fullDetail ||
            item.type !== 'tool_group' ||
            !item.display?.mergedIntoThought),
      ),
    [history, fullDetail],
  );

  // Merging happens at commit time (useGeminiStream folds a completed
  // all-read/search batch into the thought item); rendering stays per-item.

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

        // Steer items (sentToModel === false) are mid-turn injections, not turn
        // boundaries; don't reset code-block copy numbering on them.
        if (item.type === 'user' && item.sentToModel !== false) {
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

      // Steer items (sentToModel === false) are mid-turn injections, not turn
      // boundaries; don't reset code-block copy numbering on them.
      if (item.type === 'user' && item.sentToModel !== false) {
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

  // batchIds of committed tool_groups folded into a thought line
  // (display.mergedIntoThought), fullDetail-agnostic. The scheduler keeps its
  // LIVE pending display copy until onComplete's await (tool-response
  // submission) returns, so BOTH render paths must suppress that live copy
  // by batchId identity for that window, or the user sees the merged thought
  // line PLUS a duplicate group row — in BOTH fullDetail states: fullDetail
  // OFF filters the committed copy out of visibleHistory (the live copy is
  // the duplicate); fullDetail ON re-admits the committed copy, and the
  // #9420 collapse only exists in allVirtualItems — the VP path — so on the
  // legacy Static path the live copy is the duplicate again.
  const mergedBatchIdsAll = useMemo(() => {
    const ids = new Set<string>();
    for (const item of history) {
      if (
        item.type === 'tool_group' &&
        item.batchId !== undefined &&
        item.display?.mergedIntoThought
      ) {
        ids.add(item.batchId);
      }
    }
    return ids;
  }, [history]);

  // The VP path's suppression set, gated on fullDetail: under fullDetail ON
  // the committed copy re-renders and allVirtualItems' #9420 collapse keeps
  // the LIVE copy (it still updates), so the VP path must NOT suppress it
  // there (it suppresses the committed copy instead). The legacy Static path
  // never consumes allVirtualItems and uses the ungated set below.
  const mergedBatchIds = useMemo(
    () => (fullDetail ? new Set<string>() : mergedBatchIdsAll),
    [fullDetail, mergedBatchIdsAll],
  );

  // The legacy Static path renders the pending region unfiltered; suppress a
  // merged batch's live pending copy there regardless of fullDetail (see
  // mergedBatchIdsAll), so the default (useTerminalBuffer=false) renderer
  // does not show the merged thought line PLUS a duplicate group row.
  const staticPendingItems = useMemo(
    () =>
      mergedBatchIdsAll.size === 0
        ? pendingHistoryItemsWithSourceCopyOffsets
        : pendingHistoryItemsWithSourceCopyOffsets.filter(
            ({ item }) =>
              !(
                item.type === 'tool_group' &&
                item.batchId !== undefined &&
                mergedBatchIdsAll.has(item.batchId)
              ),
          ),
    [pendingHistoryItemsWithSourceCopyOffsets, mergedBatchIdsAll],
  );

  // Combine completed history + live pending items for the virtualized list.
  // The banner sentinel is prepended so it scrolls with content (not pinned).
  // Pending items get negative IDs (-(i+1)) so renderItem can tell them apart.
  const allVirtualItems = useMemo((): VpItem[] => {
    const combined: VpItem[] = [
      VP_BANNER_ITEM,
      ...visibleHistory,
      ...pendingHistoryItems.map((item, i) => ({ ...item, id: -(i + 1) })),
    ];
    // Collapse duplicate tool_group rows (#9420): the same in-flight batch
    // renders from both committed history and the live pending list between
    // the onComplete commit and the scheduler clearing its display state.
    // Continuation thought/content items can land between the copies, so
    // match across the whole list — never by adjacency — on the scheduler-
    // minted batchId stamped on both copies of one batch, and only when a
    // live pending counterpart exists (it keeps updating, so it wins).
    // callIds are NOT an identity (ids are re-minted after core-history
    // compaction and providers can reuse wire ids), so unrelated batches
    // whose callIds collide keep rendering. Groups without a batchId
    // (adapters) are never collapsed; restored-history ids are unique per
    // mount, so they can never match a live pending batch either.
    const livePendingBatchIds = new Set<string>();
    for (const item of pendingHistoryItems) {
      if (item.type === 'tool_group' && item.batchId !== undefined) {
        livePendingBatchIds.add(item.batchId);
      }
    }
    if (livePendingBatchIds.size === 0) return combined;
    const dropped = new Set<VpItem>();
    const committedByBatchId = new Map<string, VpItem>();
    // Same batch twice within the pending list: keep the latest copy only.
    const keptPendingByBatchId = new Map<string, VpItem>();
    for (const item of combined) {
      if (
        item.type !== 'tool_group' ||
        item.batchId === undefined ||
        !livePendingBatchIds.has(item.batchId)
      ) {
        continue;
      }
      if (item.id > 0) {
        committedByBatchId.set(item.batchId, item);
      } else {
        const kept = keptPendingByBatchId.get(item.batchId);
        if (kept) dropped.add(kept);
        keptPendingByBatchId.set(item.batchId, item);
      }
    }
    for (const item of committedByBatchId.values()) dropped.add(item);
    // A MERGED batch's committed copy is filtered out of visibleHistory
    // above (fullDetail off), so the collapse loop never sees it — suppress
    // its live pending copy by the shared mergedBatchIds identity (see the
    // memo above; the legacy Static path filters via the ungated
    // mergedBatchIdsAll set in staticPendingItems).
    if (mergedBatchIds.size > 0) {
      for (const item of combined) {
        if (
          item.id < 0 &&
          item.type === 'tool_group' &&
          item.batchId !== undefined &&
          mergedBatchIds.has(item.batchId)
        ) {
          dropped.add(item);
        }
      }
    }
    if (dropped.size === 0) return combined;
    return combined.filter((item) => !dropped.has(item));
  }, [visibleHistory, pendingHistoryItems, mergedBatchIds]);

  // Ctrl+O (fullDetail) inserts/removes merged tool_groups in the MIDDLE of
  // the virtual list, but VirtualizedList's scroll anchor is index-based —
  // without help, the anchored ITEM changes identity and a user scrolled up
  // loses their reading position. Capture the anchored item during the
  // fullDetail-flip render (the ref still holds the pre-flip handle and the
  // pre-flip list) and scroll back to it once the new list commits.
  const prevFullDetailRef = useRef(fullDetail);
  const allVirtualItemsRef = useRef(allVirtualItems);
  const anchorRestoreItemRef = useRef<VpItem | null>(null);
  const anchorRestoreOffsetRef = useRef(0);
  if (prevFullDetailRef.current !== fullDetail) {
    prevFullDetailRef.current = fullDetail;
    anchorRestoreItemRef.current = null;
    anchorRestoreOffsetRef.current = 0;
    if (useVirtualScroll) {
      const list = scrollRef.current;
      const prevItems = allVirtualItemsRef.current;
      const state = list?.getScrollState();
      const atBottom =
        !!state &&
        state.innerHeight > 0 &&
        state.scrollTop + state.innerHeight >= state.scrollHeight - 1;
      const anchor = list?.getScrollAnchor() ?? { index: -1, offset: 0 };
      const anchorIndex = anchor.index;
      // At-bottom stays glued to the end via VirtualizedList's own
      // data-change re-anchor; restoring there would fight it. Pending
      // items (negative ids) get a fresh object every render, so only
      // committed history items keep a stable identity across the filter
      // re-run. Anchors in the pending region therefore get no
      // capture/restore at all: a toggle that inserts/removes merged
      // groups above the pending tail shifts it by that many rows, and
      // there is no identity-stable handle to restore to (restoring by
      // recomputed index would need the pending item's own height, which
      // re-measures after the flip). Accepted limitation — the pending
      // region is transient by nature; the committed-history case below is
      // the one that loses real reading position.
      if (!atBottom && anchorIndex >= 0 && anchorIndex < prevItems.length) {
        let item: VpItem | undefined = prevItems[anchorIndex];
        // Toggle-OFF removes merged tool_groups: when the anchored item is
        // itself one, restoring to it no-ops (indexOf fails) while the
        // shrunken list slides the viewport up by every removed group's
        // height. Restore to the thought line it folded into instead —
        // committed immediately before it.
        if (
          item &&
          !fullDetail &&
          item.type === 'tool_group' &&
          item.display?.mergedIntoThought
        ) {
          const prev = prevItems[anchorIndex - 1];
          item =
            prev && prev.type !== 'vp-banner' && prev.id > 0 ? prev : undefined;
        }
        if (item && item.type !== 'vp-banner' && item.id > 0) {
          anchorRestoreItemRef.current = item;
          // Preserve the within-item pixel offset: anchor offsets are
          // routinely non-zero under incremental VP scrolling, and
          // scrollToItem's default (viewOffset 0) snaps the item's TOP to
          // the viewport top, dropping the reading depth inside tall items.
          // Depth preservation is only correct when the anchored item does
          // not SHRINK across the flip. Toggle-ON grows items, so the offset
          // stays valid. Toggle-OFF collapses thought bodies (fullDetail
          // forces them open; ThinkBody returns null when collapsed, so a
          // tall expanded thought becomes a 1-line label, and the
          // merged-group → preceding-thought remap above targets that same
          // 1-line thought), AND tool_group rows: fullDetail force-expands
          // every tool (forceExpandAll), un-truncates results, and expands
          // memory-only/parallel-agent groups, all of which toggle-OFF
          // re-collapses. Re-applying the pre-toggle offset then lands N
          // rows PAST the top of the now-short item, scrolling it off above
          // the viewport (and, on a short transcript, the maxScroll clamp
          // lands the restore at the bottom). Items that keep their height
          // on toggle-OFF (answers, user rows) preserve their offset.
          // Restore to a shrinking item's top on toggle-OFF.
          anchorRestoreOffsetRef.current =
            anchor.offset === SCROLL_TO_ITEM_END ||
            (!fullDetail &&
              (item.type === 'gemini_thought' ||
                item.type === 'gemini_thought_content' ||
                item.type === 'tool_group'))
              ? 0
              : anchor.offset;
        }
      }
    }
  }
  allVirtualItemsRef.current = allVirtualItems;
  useLayoutEffect(() => {
    const item = anchorRestoreItemRef.current;
    if (!item) return;
    anchorRestoreItemRef.current = null;
    // Runs after VirtualizedList's own data-change layout effect
    // (child effects fire before parent effects), so the restore wins.
    // scrollToItem resolves via data.indexOf(item) — reference identity —
    // and no-ops if the toggle filtered the item out of the new list.
    scrollRef.current?.scrollToItem({
      item,
      viewOffset: anchorRestoreOffsetRef.current,
    });
  }, [allVirtualItems]);

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
  });
  pendingStateRef.current = {
    activePtyId: uiState.activePtyId,
    embeddedShellFocused: uiState.embeddedShellFocused,
    isEditorDialogOpen: uiState.isEditorDialogOpen,
  };
  const pendingAvailableTerminalHeight =
    pendingHistoryItems.length > 0 && uiState.constrainHeight
      ? availableTerminalHeight
      : undefined;
  const hasPendingPlainTextConfirmation = pendingHistoryItems.some(
    (item) =>
      item.type === 'tool_group' &&
      item.tools.some(
        (tool) =>
          tool.status === ToolCallStatus.Confirming &&
          tool.confirmationDetails?.type === 'info' &&
          tool.confirmationDetails.renderPromptAsPlainText === true,
      ),
  );
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
            availableTerminalHeight={pendingAvailableTerminalHeight}
            item={{ ...item, id: 0 }}
            isPending={true}
            isFocused={!ps.isEditorDialogOpen}
            activeShellPtyId={ps.activePtyId}
            embeddedShellFocused={ps.embeddedShellFocused}
            commands={uiState.slashCommands}
            sourceCopyIndexOffsets={sourceCopyIndexOffsets}
            fullDetail={fullDetail}
          />
        );
      }
      return (
        <VirtualHistoryItem
          terminalWidth={terminalWidth}
          mainAreaWidth={mainAreaWidth}
          availableTerminalHeight={
            uiState.constrainHeight ? staticAreaMaxItemHeight : undefined
          }
          availableTerminalHeightLlm={
            uiState.constrainHeight ? MAX_GEMINI_MESSAGE_LINES : undefined
          }
          item={item}
          isPending={false}
          commands={uiState.slashCommands}
          sourceCopyIndexOffsets={sourceCopyIndexOffsets}
          thoughtHeadId={thoughtHeadIdByItemRef.current.get(item)}
          fullDetail={fullDetail}
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
      fullDetail,
      pendingAvailableTerminalHeight,
      uiState.constrainHeight,
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
          measureAtFullHeight={hasPendingPlainTextConfirmation}
          showScrollbar={showScrollbar}
        />
        <TextSelectionController
          isActive={!uiState.dialogsVisible}
          getViewportRect={() => scrollRef.current?.getViewportRect() ?? null}
          getAdditionalSelectableRects={() =>
            footerRef?.current
              ? [measureElementPosition(footerRef.current)]
              : []
          }
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
                availableTerminalHeightLlm={MAX_GEMINI_MESSAGE_LINES}
                key={h.id}
                item={h}
                isPending={false}
                commands={uiState.slashCommands}
                sourceCopyIndexOffsets={sourceCopyIndexOffsets}
                thoughtHeadId={thoughtHeadIdByItem.get(h)}
                fullDetail={fullDetail}
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

            The clamp engages while constrained OR while the model is actively
            streaming (Responding) — i.e. the case that trips the scroll-to-top
            lock. It is deliberately dropped in "show more lines" mode
            (constrainHeight off) once streaming has settled to a static
            confirmation (WaitingForConfirmation): a tall edit/write_file diff
            preview must render every row so the user can scroll the terminal
            scrollback and review the full change before approving (#6809). A
            static confirmation is a single render, so it does not trip Ink's
            from-top full-redraw path the way a streaming table does.
          */}
          <Box
            flexDirection="column"
            flexShrink={0}
            maxHeight={
              uiState.constrainHeight ||
              streamingState === StreamingState.Responding
                ? availableTerminalHeight || undefined
                : undefined
            }
            overflow="hidden"
          >
            {staticPendingItems.map(({ item, sourceCopyIndexOffsets }, i) => (
              <HistoryItemDisplay
                key={i}
                availableTerminalHeight={
                  uiState.constrainHeight ? availableTerminalHeight : undefined
                }
                terminalWidth={terminalWidth}
                mainAreaWidth={mainAreaWidth}
                item={{ ...item, id: 0 }}
                isPending={true}
                isFocused={!uiState.isEditorDialogOpen}
                activeShellPtyId={uiState.activePtyId}
                embeddedShellFocused={uiState.embeddedShellFocused}
                sourceCopyIndexOffsets={sourceCopyIndexOffsets}
                fullDetail={fullDetail}
              />
            ))}
          </Box>
          <ShowMoreLines constrainHeight={uiState.constrainHeight} />
        </Box>
      </OverflowProvider>
    </>
  );
};
