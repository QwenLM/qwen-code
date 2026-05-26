# §3.7 Ctrl+O Transcript — Rewrite

## Goal

> 整体修养下 Ctrl+O 的行为，改成和 claude code 一致的，不要整体的模式切换，Ctrl+O 作用于长工具调用、长文本输出等等情形，支持 Ctrl+O 查看当前 block 的明细，应该是要冻结当前 block，按 Esc 后退出冻结恢复正常的显示模式。

## Reference (Claude Code)

```
/Users/gawain/Documents/codebase/opensource/claude-code/src/keybindings/defaultBindings.ts:44
  'ctrl+o': 'app:toggleTranscript',

/Users/gawain/Documents/codebase/opensource/claude-code/src/components/REPL.tsx:1325-1328
  const [frozenTranscriptState, setFrozenTranscriptState] = useState<{
    messagesLength: number;
    streamingToolUsesLength: number;
  } | null>(null);

REPL.tsx:4184-4189   handleEnterTranscript ⇒ 记录长度，进入 transcript screen，verbose=true
REPL.tsx:4381-4382   transcript 渲染时 deferredMessages.slice(0, frozenLength)

defaultBindings.ts:162-169   Transcript context: escape → 'transcript:exit'
useGlobalKeybindings.tsx:144-154   handleExitTranscript ⇒ setScreen('prompt'); 清空 frozen state
```

要点：

1. 只记录 **长度** (snapshot 不复制数组)；后续新消息照常追加到底层数组，但被 slice 隐藏。
2. transcript screen 全展开渲染（verbose 等价）。
3. ESC 退出，flip 回 'prompt' screen，再恢复 live 渲染。

## qwen-code 适配设计

### A. State

新增 hook + context：

```ts
// packages/cli/src/ui/hooks/useTranscriptOverlay.ts
type FrozenSnapshot = {
  historyLength: number;
  pendingHistoryLength: number;
  frozenAt: number; // 时间戳，用于 footer 显示
};

export function useTranscriptOverlay() {
  const [snapshot, setSnapshot] = useState<FrozenSnapshot | null>(null);
  const enter = (history, pending) =>
    setSnapshot({
      historyLength: history.length,
      pendingHistoryLength: pending.length,
      frozenAt: Date.now(),
    });
  const exit = () => setSnapshot(null);
  return { snapshot, enter, exit, isActive: snapshot !== null };
}
```

提供 `TranscriptOverlayContext` 供 keypress + 渲染层共享。

### B. Keybindings

`packages/cli/src/config/keyBindings.ts`：

```ts
// REMOVE: TOGGLE_COMPACT_MODE  (不再有全局 toggle)
// ADD:
ENTER_TRANSCRIPT = 'enterTranscript',     // Ctrl+O when overlay inactive
EXIT_TRANSCRIPT = 'exitTranscript',       // Esc when overlay active

[Command.ENTER_TRANSCRIPT]: [{ key: 'o', ctrl: true }],
[Command.EXIT_TRANSCRIPT]: [{ key: 'escape' }],
```

> 兼容：保留 `TOGGLE_COMPACT_MODE` enum 值以免 keybinding config 加载报错（设为 no-op），加 deprecation 注释。下一个 major 删。

### C. Keypress 路由 (v2 — 含 6 个现有 ESC 分支)

`AppContainer.handleGlobalKeypress` 中，对 ESC chain 加严格优先级。**transcript active 时短路整条 chain，不 fall through**：

```ts
// Ctrl+O 路由（任何时候）
if (keyMatchers[Command.ENTER_TRANSCRIPT](key)) {
  if (transcriptActive) {
    transcriptOverlay.exit(); // toggle: 在 transcript 中再按 Ctrl+O = 退出
  } else {
    transcriptOverlay.enter(historyRef.current, pendingHistoryItemsRef.current);
  }
  return;
}

// ESC 优先级表（自上而下）
if (key.name === 'escape') {
  if (transcriptActive) {
    // 1. transcript active → 退出（最高优先级，短路）
    transcriptOverlay.exit();
    return;
  }
  if (dialogsVisibleRef.current) {
    /* close dialog */ return;
  } // 2.
  if (btwItem) {
    /* cancel btw */ return;
  } // 3. (现有)
  if (embeddedShellFocused) {
    /* give to shell */ return;
  } // 4. (现有)
  if (buffer.text.length > 0) {
    /* clear / prompt */ return;
  } // 5. (现有)
  if (streamingState === Responding) {
    /* cancel */ return;
  } // 6. (现有)
  if (streamingState === Idle && !ideMode) {
    /* double-esc rewind */
  } // 7. (现有)
}
```

**关键不变量**：transcript active 期间，buffer / shell / streaming abort 都被 transcript 覆盖。Esc 仅退 transcript；用户重新进 prompt 后 ESC 行为恢复。

### D. Rendering

`MainContent`：根据 `transcriptActive` 分流。

```tsx
if (transcriptActive) {
  return <TranscriptOverlay snapshot={snapshot} />;
}
// else 走原有 VP / Static 路径
```

**TranscriptOverlay 组件**：

```tsx
const TranscriptOverlay: React.FC<{ snapshot: FrozenSnapshot }> = ({ snapshot }) => {
  const { history, pendingHistoryItems } = useUIState();
  const slicedHistory = history.slice(0, snapshot.historyLength);
  const slicedPending = pendingHistoryItems.slice(0, snapshot.pendingHistoryLength);
  return (
    <DisplayModeContext.Provider value={{ verbose: true, transcript: true }}>
      <Box flexDirection="column">
        <TranscriptHeader frozenAt={snapshot.frozenAt} />
        <ScrollableList
          data={[...slicedHistory, ...slicedPending]}
          renderItem={(item) => (
            <HistoryItemDisplay
              item={item}
              forceVerbose
              // 也强制 force-expand 所有 tool_group / subagent 详情
            />
          )}
          ...
        />
        <TranscriptFooter />  {/* "Frozen at HH:MM:SS · Esc to exit · ↑/↓ scroll · PgUp/PgDn page" */}
      </Box>
    </DisplayModeContext.Provider>
  );
};
```

> `ScrollableList` 已在 virtual-viewport 分支引入；transcript overlay 直接复用，键盘 scroll 行为同 VP 模式（↑↓ / PgUp PgDn / Ctrl+Home/End）。

### E. Live state behind the overlay

- 后台仍 streaming —— `history` / `pendingHistoryItems` 数组继续增长。
- transcript overlay 只 `slice(0, frozenLength)` 显示。
- Esc 退出后，新到的内容自然出现在底部（因为底层数组已经有最新值；slice 不再生效）。

### F. UX detail (v2)

- **transcript 中可滚动到顶**：默认进入 transcript 时滚到底（=刚冻结的最新一条），与 CC 一致。
- **transcript 中按 Ctrl+O**：**toggle 退出 transcript**（与 CC `useGlobalKeybindings.tsx:118-132` 一致）。等价于按 Esc。v1 写 "no-op" 已修正。
- **onboarding hint**: 不做（明示 non-goal）。footer 长期显示 "Esc to exit · ↑/↓ scroll" 足够。

### G. Backward-compat for `compactMode` setting

- 老用户 settings 里有 `ui.compactMode: false` —— 现在视为 "verbose = !compactMode"。详细见 `07-verbose-and-settings.md`。
- 不再有 keypress 写入这个值；唯一改动来源是 settings dialog 或 `--verbose` flag。

## VP interaction

- VP 路径 `MainContent.tsx:551` `if (useVirtualScroll)` 短路 —— transcript overlay 在更上层判定，VP 路径与 transcript 互斥。

```tsx
if (transcriptActive) return <TranscriptOverlay ... />;     // 先判 transcript
if (useVirtualScroll) return <VP ... />;
return <StaticPath ... />;
```

- 进入 transcript 时不需要 `refreshStatic()` —— 因为 `<Static>` 没在渲染（被 transcript 替换）。退出时若回 Static 路径，会因 unmount→remount 自然重新 paint；保险起见在 `exit()` 里调一次 `refreshStatic()`。

## 设计意图回看用户原话

| 用户要求                             | 对应实现                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| "Ctrl+O 不要整体模式切换"            | ✅ 移除 TOGGLE_COMPACT_MODE 全局行为；compactMode 不再随 Ctrl+O 改变                |
| "作用于长工具调用、长文本输出等情形" | ✅ overlay 全展开渲染（verbose=true + force-expand 全 tool），任何 block 都能完整看 |
| "查看当前 block 的明细"              | ✅ snapshot 包含所有当前 block；用 Scrollable 滚动查看                              |
| "应该是要冻结当前 block"             | ✅ snapshot.historyLength + pendingHistoryLength 冻结视图边界                       |
| "按 Esc 退出冻结恢复正常显示模式"    | ✅ Esc → exit → 回 live 渲染                                                        |
| "参考 claude code 源码"              | ✅ 设计来源即 CC defaultBindings.ts + REPL.tsx frozen state                         |

## Files touched

- 新：`packages/cli/src/ui/hooks/useTranscriptOverlay.ts`
- 新：`packages/cli/src/ui/contexts/TranscriptOverlayContext.tsx`
- 新：`packages/cli/src/ui/components/TranscriptOverlay.tsx`
- 改：`packages/cli/src/config/keyBindings.ts`（新 Command）
- 改：`packages/cli/src/ui/keyMatchers.ts`（新匹配器）
- 改：`packages/cli/src/ui/AppContainer.tsx`（替换 Ctrl+O handler、加 Esc handler）
- 改：`packages/cli/src/ui/components/MainContent.tsx`（顶层路由）
- 改：`packages/cli/src/ui/components/HistoryItemDisplay.tsx`（接受 `forceVerbose`）
- 改：`packages/cli/src/ui/components/KeyboardShortcuts.tsx`（更新文案）
- i18n：`ui.transcript.header`, `ui.transcript.footer`, `ui.transcript.frozenAt`

## Risks

1. **ESC 冲突**：dialog / streaming abort / IDE 模式取消都用 ESC。要严格按优先级路由；下加测试。
2. **Snapshot stale**：用户进 transcript 后 30 秒退出，期间到了 200 条消息 —— exit 后底层数组 length 已涨到 X，slice 失效，自然显示新内容。**正确**。但 VP/Static 切换可能闪烁。补救：exit 时 `refreshStatic()` 保证 Static 路径重渲染。
3. **TranscriptOverlay 性能**：N 条历史 + 1 snapshot 进 ScrollableList，复用 VP 实测 ≤ 1000 条流畅；超出留待后续 PR。
4. **Esc 误触退出**：用户在 transcript 里编辑/复制 → 不会触发 Esc；安全。
5. **Subagent group summary 与 transcript 视图**：transcript 中 force-verbose，所以 subagent group 也会逐个展开显示完整 stats —— 这正是用户想看的"细节"。
