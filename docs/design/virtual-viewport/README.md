# Virtual viewport for long conversations on ink 7

Status: **implemented**, V.0 + character-scrollbar + V.2 (setting gate) shipped in PR #4146;
ScrollProvider / animated scrollbar / integration tests deferred to follow-up PRs (V.3+).
Author: 秦奇
Tracking branch: `feat/virtual-viewport-on-ink7` (stacked on `chore/re-upgrade-ink-7-0-3`)

## 1. Problem

Several user-reported flicker / lag issues all bottom-out in the same architectural fact: ink's `<Static>` is **append-only** and qwen-code's `MainContent.tsx` feeds the _entire_ `mergedHistory` through it on every render. For a 1000-turn conversation, that is 1000 `HistoryItemDisplay` React renders + ink layout passes per state change.

The current symptoms this enables:

| Issue           | Symptom                                            | Current contributor                                           |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| #2950           | Long session shows continuous up/down scroll storm | full Static remount on every refresh                          |
| #3118           | Switching back to window keeps flickering          | `clearTerminal` + `historyRemountKey++` triggers full remount |
| #3007           | Generic interface flickering                       | same as #3118                                                 |
| #3838 (UI side) | Scrollbar grows unboundedly                        | each cumulative-delta render adds rows; no viewport eviction  |
| #3899 → #3905   | Ctrl+O froze terminal for seconds                  | the partially-fixed case, sealed with `setImmediate` chunking |

PR #3905 explicitly notes:

> Discussion of alternatives (sealed prefix + live tail, **true viewport virtualization**, ANSI-output caching) was considered but each changes UX or requires an architectural rewrite.

That architectural rewrite is what this design proposes.

## 2. Reference implementations

Surveyed two open-source ink-based CLIs that already solved (or worked around) the same problem:

### 2.1 claude-code (`/Users/gawain/Documents/codebase/opensource/claude-code`)

Maintains its **own forked ink** at `src/ink/`:

- `ink.tsx` — 1722 LoC custom main loop
- `log-update.ts` — 773 LoC custom diff renderer with scroll-region (`DECSTBM`) optimization, full-frame fallback when scrollback would be touched
- `screen.ts` / `frame.ts` — explicit Screen / Frame objects, `cellAt` / `diffEach` cell-level diffing
- `render-to-screen.ts` — exposes `renderToScreen(node)` to render ANY node tree to a `Screen` object out of band. This is the underlying capability for "render once, cache, replay" — i.e. virtualization
- `screens/REPL.tsx`:
  - `visibleStreamingText = streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null` — only complete lines exposed to renderer
  - `ScrollBox` with `scrollRef`, `cursorNavRef`
  - `Markdown.tsx` `StreamingMarkdown` splits content at last top-level block boundary, memoizes stable prefix, only re-parses unstable suffix
- `Markdown.tsx` token cache (LRU-500) — survives unmount→remount, so virtual-scroll re-mounts hit cache without re-lexing

**Why we don't replicate this approach**: forking ink wholesale is unsustainable maintenance (1722 LoC `ink.tsx` alone, plus a custom reconciler). Every upstream ink fix has to be hand-merged. That cost is justified for claude-code's scale; not for qwen-code.

### 2.2 gemini-cli (`/Users/gawain/Documents/codebase/opensource/gemini-cli`)

Uses `@jrichman/ink@6.6.9` (a smaller fork that adds `ResizeObserver` and `StaticRender` exports), and ships **a complete virtualized list as plain components**:

| File                                    | LoC | Role                                                                   |
| --------------------------------------- | --- | ---------------------------------------------------------------------- |
| `components/shared/VirtualizedList.tsx` | 764 | Core viewport + measurement + scroll-anchor + per-item resize tracking |
| `components/shared/ScrollableList.tsx`  | 278 | Wraps `VirtualizedList`, adds keypress nav + smooth scroll + scrollbar |
| `contexts/ScrollProvider.tsx`           | 469 | Mouse drag, scroll lock, focus context                                 |
| `hooks/useBatchedScroll.ts`             | 35  | Coalesces same-tick scroll updates                                     |
| `hooks/useAnimatedScrollbar.ts`         | 130 | Scrollbar fade-in/out animation                                        |

`MainContent.tsx` switches between two render paths via a `isAlternateBufferOrTerminalBuffer` flag:

```tsx
if (isAlternateBufferOrTerminalBuffer) {
  return <ScrollableList data={virtualizedData} renderItem={renderItem} ... />;
}

return <Static items={[<AppHeader />, ...staticHistoryItems, ...lastResponseHistoryItems]}>...</Static>;
```

`HistoryItemDisplay` is wrapped in `React.memo` so unchanged items don't re-render.

**This is the production-grade reference.**

## 3. ink 7 capability check

qwen-code is on the in-flight `chore/upgrade-ink-7` branch. Inspected `node_modules/ink/build/index.d.ts` exports:

- ✅ `useBoxMetrics(ref): {width, height, left, top, hasMeasured}` — auto-updates on layout change. **Functional equivalent of `ResizeObserver`.**
- ✅ `measureElement(node)` — single-shot imperative measure
- ✅ `useWindowSize` — terminal resize
- ✅ `useAnimation` — for scrollbar fade
- ✅ `Static`, `Box`, `Text`, etc.
- ❌ `ResizeObserver` (component/class) — needs adaptation
- ❌ `StaticRender` — needs custom implementation

**Conclusion**: ink 7 has every primitive needed. No fork swap required.

## 4. Strategic decision

**Port gemini-cli's `ScrollableList` + `VirtualizedList` + supporting hooks/contexts to qwen-code, adapting `ResizeObserver` → `useBoxMetrics` and rolling a custom `StaticRender`.**

Rejected alternatives:

| Alternative                       | Why rejected                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Fork ink like claude-code         | Unsustainable maintenance burden                                                                                  |
| Switch to `@jrichman/ink`         | Reverses the in-flight ink 7 upgrade; loses ink 7's React 19.2 + reconciler 0.33 + new diff renderer improvements |
| Build virtualization from scratch | Reinvents ~1700 LoC of proven design; gemini-cli's reference exists and works                                     |

## 5. Architecture

### File map after PR #4146

```
packages/cli/src/ui/
├── components/shared/
│   ├── VirtualizedList.tsx          [NEW] core viewport + ASCII scrollbar
│   ├── ScrollableList.tsx           [NEW] keyboard scroll wrapper
│   └── StaticRender.tsx             [NEW] React.memo wrapper (replaces gemini-cli's ink fork export)
├── hooks/
│   └── useBatchedScroll.ts          [NEW] coalesce same-tick scroll updates
├── components/MainContent.tsx       [MOD] add virtualized branch + stability refs
└── AppContainer.tsx                 [MOD] feed scroll-related UI state into context + gate refreshStatic
```

Deferred to follow-up PRs:

- `contexts/ScrollProvider.tsx` — mouse drag / scroll lock / focus
- `hooks/useAnimatedScrollbar.ts` — scrollbar fade-in/out (V.0 ships a plain ASCII bar)

### Setting (V.2)

```ts
// settings schema
ui: {
  /**
   * Enables virtualized history rendering for long conversations.
   * When true, only items in the visible viewport are rendered through React;
   * scrolled-out items remain in the terminal scrollback buffer.
   *
   * Default: false. Opt-in until proven stable on long conversations.
   */
  useTerminalBuffer?: boolean;  // alias kept compat with gemini-cli
}
```

`MainContent.tsx` reads the setting and switches paths:

```tsx
const useTerminalBuffer = uiState.settings?.ui?.useTerminalBuffer ?? false;

if (useTerminalBuffer) {
  return <ScrollableList .../>; // virtualized
}

return <Static .../>; // existing path, untouched
```

The legacy `<Static>` path stays as-is — no regression risk for users who don't opt in.

## 6. Key adaptations from gemini-cli source

### 6.1 `ResizeObserver` → `useBoxMetrics`

gemini-cli's container observer (imperative pattern):

```ts
const containerObserverRef = useRef<ResizeObserver | null>(null);

const containerRefCallback = useCallback((node: DOMElement | null) => {
  containerObserverRef.current?.disconnect();
  containerRef.current = node;
  if (node) {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const newHeight = Math.round(entry.contentRect.height);
        const newWidth = Math.round(entry.contentRect.width);
        setContainerHeight((prev) => (prev !== newHeight ? newHeight : prev));
        setContainerWidth((prev) => (prev !== newWidth ? newWidth : prev));
      }
    });
    observer.observe(node);
    containerObserverRef.current = observer;
  }
}, []);
```

Our adaptation (declarative ink 7 hook):

```ts
const containerRef = useRef<DOMElement>(null);
const { width: containerWidth, height: containerHeight } =
  useBoxMetrics(containerRef);
```

`useBoxMetrics` already handles attach/detach + layout-change subscription; the imperative bookkeeping disappears.

### 6.2 Per-item resize tracker (`itemsObserver`)

Harder. gemini-cli observes N item nodes via a single `ResizeObserver` and routes the entry → key via a `WeakMap`:

```ts
const nodeToKeyRef = useRef(new WeakMap<DOMElement, string>());
const itemsObserver = useMemo(
  () =>
    new ResizeObserver((entries) => {
      setHeights((prev) => {
        let next = null;
        for (const entry of entries) {
          const key = nodeToKeyRef.current.get(entry.target);
          if (key && prev[key] !== Math.round(entry.contentRect.height)) {
            if (!next) next = { ...prev };
            next[key] = Math.round(entry.contentRect.height);
          }
        }
        return next ?? prev;
      });
    }),
  [],
);
```

`useBoxMetrics` is **single-ref-per-hook**, so we cannot 1:1 replace this. Two options:

**Option A — push measurement down to `VirtualizedListItem`**

Each `VirtualizedListItem` already runs as its own component (memoized). Add `useBoxMetrics` inside it; report height up via a callback prop:

```tsx
const VirtualizedListItem = memo(({ itemKey, onHeightChange, ...props }) => {
  const ref = useRef<DOMElement>(null);
  const { height, hasMeasured } = useBoxMetrics(ref);
  useEffect(() => {
    if (hasMeasured) onHeightChange(itemKey, height);
  }, [itemKey, height, hasMeasured, onHeightChange]);
  return <Box ref={ref}>{...}</Box>;
});
```

**Option B — use `measureElement` + `useLayoutEffect`** in the parent

Parent stores refs for visible items, runs a layout-effect after each render to measure them. Less reactive but simpler:

```ts
useLayoutEffect(() => {
  const newHeights: Record<string, number> = { ...heights };
  let changed = false;
  for (const [key, ref] of itemRefs.current) {
    if (ref) {
      const { height } = measureElement(ref);
      if (newHeights[key] !== height) {
        newHeights[key] = height;
        changed = true;
      }
    }
  }
  if (changed) setHeights(newHeights);
});
```

**Recommendation: Option A.** Cleaner separation, leverages ink 7's built-in change detection. Avoids the "measure storm" risk where every render measures everything.

### 6.3 `StaticRender` — custom implementation

gemini-cli imports `StaticRender` from `@jrichman/ink`. Looking at usage in `VirtualizedList.tsx`:

```tsx
{shouldBeStatic ? (
  <StaticRender width={...} key={`${itemKey}-static-${width}`}>
    {content}
  </StaticRender>
) : (
  content
)}
```

Semantics: render `content` once at the given width; subsequent renders with the same key + width return the cached render.

For ink 7, the equivalent is plain `React.memo` with a stable component that the parent guarantees not to re-render. Custom implementation:

```tsx
import { memo } from 'react';
import { Box } from 'ink';

interface StaticRenderProps {
  children: React.ReactElement;
  width?: number | string;
}

const StaticRender = memo(
  ({ children, width }: StaticRenderProps) => (
    <Box width={width} flexDirection="column" flexShrink={0}>
      {children}
    </Box>
  ),
  (prev, next) => prev.children === next.children && prev.width === next.width,
);
```

Combined with the parent's stable `key` prop (`${itemKey}-static-${width}`), changing children or width causes a fresh mount; otherwise React skips re-rendering.

This is the core capability: items that ARE static (e.g. completed Gemini messages) get measured + rendered once and never re-walk through React.

### 6.4 Memoize `HistoryItemDisplay`

gemini-cli does:

```ts
const MemoizedHistoryItemDisplay = memo(HistoryItemDisplay);
```

Same pattern in qwen-code. Required for virtualization to actually skip re-renders.

## 7. PR sequence

| PR        | Title (draft)                                                               | Scope                                                                                                         | Lines             | Dependencies                                      | Risk                                           |
| --------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------- | ---------------------------------------------- |
| **#4146** | feat(cli): virtual viewport for long conversations on ink 7                 | core primitives + ASCII scrollbar + `ui.useTerminalBuffer` gate + `MainContent`/`AppContainer` wiring + tests | ~2150 LoC         | `chore/re-upgrade-ink-7-0-3` (→ `main` on rebase) | ✅ **shipped** — typecheck clean, vitest green |
| **V.3**   | test(integration): capture-suite regressions for streaming / resize / shell | port 3 capture scripts from PR #3663                                                                          | ~2000 (test-only) | #4146                                             | pending                                        |
| **V.4**   | feat(cli): ScrollProvider — mouse drag / scroll lock                        | `contexts/ScrollProvider.tsx` + `useAnimatedScrollbar.ts`                                                     | ~500              | #4146                                             | deferred                                       |
| **V.5**   | feat(cli): alternate-buffer mode (full alt-screen takeover)                 | additional setting `ui.useAlternateBuffer`                                                                    | ~500              | #4146                                             | deferred — separate UX decision required       |

V.3 (integration tests) is the remaining critical-path item. V.4 (mouse / animated scrollbar) and V.5 (alt-screen) deferred.

## 8. Verification plan

Per-PR (mandatory before any "ready for review"):

- `npm run typecheck --workspace=@qwen-code/qwen-code` — clean
- `npm run lint --workspace=@qwen-code/qwen-code` — clean
- `cd packages/cli && npx vitest run` — all green
- Multi-round directionless audit per project workflow

End-to-end (after V.3):

- Long-conversation benchmark: 1000-turn session, measure
  - First-paint time (initial mount + paint)
  - Ctrl+O toggle latency
  - Resize latency
  - Per-frame render time during streaming
- Compare `useTerminalBuffer: false` (legacy) vs `true` (virtualized)

## 9. Open questions / decisions needed

1. **Setting name**: `ui.useTerminalBuffer` (gemini-cli compat) vs `ui.virtualizedHistory` (more descriptive)?
2. **Default value**: ship as `false` (opt-in) or stage rollout via env var first?
3. **Static-item heuristic**: gemini-cli marks only `header` as static. Should we also mark completed Gemini messages, tool results that are no longer in `pendingHistoryItems`, etc.?
4. **Mouse support**: gemini-cli's `ScrollProvider` includes mouse drag for scrollbar. Worth porting now or skip until V.4?
5. **Compatibility with #3905**: ~~PR #3905 (Ctrl+O freeze fix) is open and modifies the same `MainContent.tsx`. Coordinate merge order — likely V.2 rebases on top of #3905.~~ **Resolved**: #3905's progressive-replay landed in `main` and is preserved in the legacy `<Static>` branch of `MainContent.tsx`; the VP branch supersedes it for opt-in users because the freeze trigger (full Static remount) no longer applies.
6. **Compatibility with `chore/re-upgrade-ink-7-0-3`**: PR #4146 stacks on it. After #4119 (the ink 7.0.3 re-upgrade PR) merges to `main`, PR #4146's base will re-target to `main`.

## 10. Risks

| Risk                                                                      | Likelihood | Mitigation                                                                                              |
| ------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `useBoxMetrics` per-item creates measurement storms on long lists         | medium     | Option A in §6.2 already memoizes per-item; only items in render window pay the cost. Benchmark in V.3. |
| `StaticRender` custom impl misses an edge case the @jrichman fork handled | medium     | Audit gemini-cli's StaticRender source if available; otherwise rely on functional tests + benchmark.    |
| `<Static>` legacy path drift as the new path evolves                      | low        | Feature-flag gate keeps both paths active; CI runs both via setting matrix.                             |
| ink 7 still has unfilled bugs upstream                                    | low        | We're already on ink 7 via `chore/upgrade-ink-7`; this PR doesn't introduce additional ink risk.        |
| Long-running sessions accumulate memory in measurement caches             | medium     | Add LRU eviction on `heights` Record once size exceeds N×viewport (e.g. 5×). V.3 benchmarks this.       |

## 11. Approval checklist

- [x] Architectural direction approved — port from gemini-cli (§4)
- [x] Setting name + default decided — `ui.useTerminalBuffer`, default `false` (opt-in)
- [x] Static-item heuristic — `isStaticItem={(item) => item.id > 0}` (completed history items)
- [x] Mouse-support scope — deferred to V.4; keyboard-only scroll in #4146
- [x] Merge ordering with #3905 (§9.5) — #3905 already in `main`; #4146 preserves the legacy progressive-replay path and supersedes it only for VP users
- [x] PR #4146 implementation complete
