# Compact Mode Design: Competitive Analysis & Optimization

> Ctrl+O compact/verbose mode toggle — competitive analysis with Claude Code, current implementation review, and optimization recommendations.
>
> User documentation: [Settings — ui.compactMode](../../users/configuration/settings.md).

## 1. Executive Summary

Qwen Code and Claude Code both provide a Ctrl+O shortcut for toggling between compact and detailed tool output views, but the **design philosophy, default state, and interaction model differ fundamentally**. This document provides a deep source-level comparison, identifies UX gaps, and proposes optimizations for Qwen Code.

| Dimension            | Claude Code                                 | Qwen Code                                     |
| -------------------- | ------------------------------------------- | --------------------------------------------- |
| Default mode         | Compact (verbose=false)                     | Verbose (compactMode=false)                   |
| Toggle semantics     | Temporary peek at details                   | Persistent preference switch                  |
| Persistence          | Session-only, resets on restart             | Persisted to settings.json                    |
| Scope                | Global screen switch (prompt ↔ transcript) | Per-component rendering toggle                |
| Frozen snapshot      | None (no concept)                           | None (removed)                                |
| Per-tool expand hint | Yes ("ctrl+o to expand")                    | Yes ("Press Ctrl+O to show full tool output") |

## 2. Claude Code Implementation Analysis

### 2.1 Architecture

Claude Code uses a **screen-based** approach rather than a component-level rendering toggle:

```
┌──────────────────────────────────┐
│         AppState (Zustand)       │
│  verbose: boolean (default: false)│
│  screen: 'prompt' | 'transcript' │
└──────────┬───────────────────────┘
           │
     ┌─────┴──────┐
     │  Ctrl+O    │  toggles screen mode
     │  Handler    │  NOT a rendering flag
     └─────┬──────┘
           │
     ┌─────▼──────────────┐
     │    REPL.tsx         │
     │  screen='prompt'  → compact view (default)
     │  screen='transcript'→ detailed view
     └────────────────────┘
```

### 2.2 Key Source Files

| Component        | File                                               | Key Logic                                               |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Toggle handler   | `src/hooks/useGlobalKeybindings.tsx:90-132`        | Switches `screen` between `'prompt'` and `'transcript'` |
| Keybinding       | `src/keybindings/defaultBindings.ts:44`            | `app:toggleTranscript`                                  |
| State definition | `src/state/AppStateStore.ts:472`                   | `verbose: false` (session-only)                         |
| Expand hint      | `src/components/CtrlOToExpand.tsx:29-46`           | Per-tool "(ctrl+o to expand)" text                      |
| Message filter   | `src/components/Messages.tsx:93-151`               | `filterForBriefTool()` for compact view                 |
| Permission       | `src/components/permissions/PermissionRequest.tsx` | Rendered in overlay layer, never hidden                 |

### 2.3 Design Decisions

1. **Compact is the default.** Users see a clean interface out of the box; detail is opt-in.
2. **Session-scoped.** `verbose` resets to `false` on every new session — Claude Code assumes users generally prefer the compact view and only need details temporarily.
3. **Screen-level toggle.** Ctrl+O doesn't change how components render; it switches the entire display between a "prompt" screen (compact) and a "transcript" screen (detailed).
4. **No frozen snapshot.** There is no snapshot freezing concept. When toggling, the display updates immediately with current state.
5. **Permission dialogs are separate.** Tool approvals are rendered in a dedicated overlay layer that is never affected by the verbose/compact toggle.
6. **Per-tool hint.** `CtrlOToExpand` component shows a contextual hint on individual tools when they produce large output, suppressed in sub-agents.

### 2.4 User Flow

```
Session start → compact mode (default)
     │
     ├─ Tool outputs are summarized in a single line
     ├─ Large tool output shows "(ctrl+o to expand)" hint
     │
     ├─ User presses Ctrl+O
     │     └─→ Screen switches to transcript (detailed view)
     │         └─ User sees all tool output, thinking, etc.
     │
     ├─ User presses Ctrl+O again
     │     └─→ Screen switches back to prompt (compact)
     │
     └─ Session ends → verbose resets to false
```

## 3. Qwen Code Implementation Analysis

### 3.1 Architecture

Qwen Code uses a **component-level rendering flag** that each UI component reads from context:

```
┌─────────────────────────────────────┐
│      CompactModeContext             │
│  compactMode: boolean (default: false)│
│  setCompactMode: (v) => void        │
└──────────┬──────────────────────────┘
           │
     ┌─────┴──────┐
     │  Ctrl+O    │  toggles compactMode
     │  Handler    │  persists to settings
     └─────┬──────┘
           │
     ┌─────▼──────────────────┐
     │  Each component reads  │
     │  compactMode and       │
     │  decides how to render │
     └────────────────────────┘
           │
     ┌─────▼──────────────────────────────┐
     │  ToolGroupMessage                   │
     │    showCompact = compactMode        │
     │      && !hasConfirmingTool          │
     │      && !hasErrorTool               │
     │      && !isEmbeddedShellFocused     │
     │      && !isUserInitiated            │
     └────────────────────────────────────┘
```

### 3.2 Key Source Files

| Component       | File                                  | Key Logic                                       |
| --------------- | ------------------------------------- | ----------------------------------------------- |
| Toggle handler  | `AppContainer.tsx:1684-1690`          | Toggles `compactMode`, persists to settings     |
| Context         | `CompactModeContext.tsx`              | `compactMode`, `setCompactMode`                 |
| Tool group      | `ToolGroupMessage.tsx:105-110`        | `showCompact` with 4 force-expand conditions    |
| Tool message    | `ToolMessage.tsx:346-350`             | Hides `displayRenderer` in compact mode         |
| Compact display | `CompactToolGroupDisplay.tsx:49-108`  | Single-line summary with status + hint          |
| Confirmation    | `ToolConfirmationMessage.tsx:113-147` | Simplified 3-option compact approval            |
| Tips            | `Tips.tsx:14-29`                      | Startup tip rotation includes compact mode hint |
| Settings sync   | `SettingsDialog.tsx:189-193`          | Syncs with CompactModeContext + refreshStatic   |
| MainContent     | `MainContent.tsx:60-76`               | Renders live pendingHistoryItems                |
| Thinking        | `HistoryItemDisplay.tsx:123-133`      | Hides `gemini_thought` in compact mode          |

### 3.3 Design Decisions

1. **Verbose is the default.** Users see all tool output and thinking by default.
2. **Persistent preference.** `compactMode` is saved to `settings.json` and survives across sessions.
3. **Component-level rendering.** Each component reads `compactMode` from context and adjusts its own rendering.
4. **Force-expand protection.** Four conditions override compact mode to ensure critical UI elements are always visible (confirmations, errors, shell, user-initiated).
5. **No snapshot freezing.** The toggle always shows live output — no frozen snapshots.
6. **Settings dialog sync.** Toggling compact mode from Settings updates React state immediately via `setCompactMode`.
7. **Non-intrusive discoverability.** Compact mode is introduced via the startup Tips rotation rather than a persistent footer indicator, avoiding UI clutter.

### 3.4 User Flow

```
Session start → verbose mode (default)
     │
     ├─ All tool outputs, thinking, details visible
     │
     ├─ User presses Ctrl+O (or toggles in Settings)
     │     └─→ compactMode = true, persisted
     │         ├─ Tool groups show single-line summary
     │         ├─ Thinking/thought content hidden
     │         └─ Confirmations, errors, shell still expanded
     │
     ├─ User presses Ctrl+O again
     │     └─→ compactMode = false, persisted
     │         └─ All details visible again
     │
     └─ Next session → same mode as last session
```

## 4. Key Differences Deep Dive

### 4.1 Default Mode Philosophy

| Aspect               | Claude Code (compact default)         | Qwen Code (verbose default)                   |
| -------------------- | ------------------------------------- | --------------------------------------------- |
| First impression     | Clean, minimal — professional feel    | Information-rich — full transparency          |
| Learning curve       | User must learn Ctrl+O to see details | User can immediately see everything           |
| Target audience      | Experienced users who trust the tool  | Users who want to understand what's happening |
| Information overload | Avoided by default                    | Possible for new users                        |
| Discoverability      | Per-tool "(ctrl+o to expand)" hints   | Startup Tips rotation + ? shortcuts + /help   |

**Analysis:** Claude Code's compact default works because its user base is generally experienced developers who trust the tool and don't need to see every tool invocation. Qwen Code's verbose default is appropriate for its earlier stage where building user trust through transparency is important.

### 4.2 Persistence Model

| Aspect           | Claude Code               | Qwen Code                  |
| ---------------- | ------------------------- | -------------------------- |
| Persisted?       | No — session-only         | Yes — to settings.json     |
| Rationale        | Verbose is temporary peek | Mode is user preference    |
| Restart behavior | Always starts compact     | Starts with last-used mode |

**Analysis:** Claude Code treats detail viewing as a momentary need — you look, then go back. Qwen Code treats it as a stable preference — some users always want details, others always want compact. Both are valid; Qwen Code's approach is more flexible.

### 4.3 Confirmation Protection

| Aspect                  | Claude Code                                 | Qwen Code                                            |
| ----------------------- | ------------------------------------------- | ---------------------------------------------------- |
| Mechanism               | Overlay/modal layer (structurally separate) | Force-expand conditions in `showCompact`             |
| Coverage                | Complete — approvals can never be hidden    | Complete — 4 conditions cover all interactive states |
| Compact confirmation UI | N/A (overlay is always full)                | Simplified 3-option RadioButtonSelect                |

**Analysis:** Claude Code's architectural separation (overlay layer) is more robust. Qwen Code's force-expand approach is effective but requires each new interactive state to be explicitly added to the condition list.

### 4.4 Rendering Approach

| Aspect       | Claude Code                         | Qwen Code                                  |
| ------------ | ----------------------------------- | ------------------------------------------ |
| Toggle scope | Screen-level (prompt ↔ transcript) | Component-level (each component decides)   |
| Granularity  | All-or-nothing                      | Fine-grained per component                 |
| Flexibility  | Low — global switch                 | High — components can override             |
| Consistency  | Guaranteed                          | Depends on each component's implementation |

**Analysis:** Qwen Code's component-level approach is more flexible (e.g., force-expand for specific conditions) but requires more discipline to maintain consistency. Claude Code's screen-level approach is simpler and guarantees consistent behavior.

## 5. Optimization Recommendations

### 5.1 [P0] Keep Verbose as Default — No Change Needed

Qwen Code's verbose default is the right choice for its current stage. Users who are new to the tool need transparency to build trust. As the product matures, consider making compact the default (like Claude Code).

### 5.2 [P1] Per-Tool Expansion for Large Outputs

Claude Code shows "(ctrl+o to expand)" on individual tools that produce large output. Qwen Code currently only has a global toggle. Consider:

- When a single tool produces output exceeding N lines, show a per-tool "expand" hint in compact mode.
- Scope: future enhancement, not current priority.

### 5.3 [P2] Consider Session-Scoped Override

Some users may want compact mode as their default but occasionally need verbose for a specific session. Consider supporting both:

- `settings.json` → persistent default (current behavior)
- Ctrl+O during session → temporary override for current session only (Claude Code behavior)
- On session restart → revert to settings.json value

This gives users the best of both worlds. Implementation would require separating "settings default" from "session override" state.

### 5.4 [P2] Structural Separation for Confirmations

Currently, confirmation protection relies on `showCompact` conditions in `ToolGroupMessage`. Consider a more robust approach:

- Render confirmations in a separate layer (like Claude Code's overlay approach).
- This would make it architecturally impossible for compact mode to affect confirmations.
- Lower priority since the current force-expand approach works correctly.

## 6. Current Implementation Status

After the `feat/compact-mode-optimization` branch changes:

| Feature                          | Status | Notes                                             |
| -------------------------------- | ------ | ------------------------------------------------- |
| Startup Tips hint                | Done   | Compact mode tip in Tips rotation (non-intrusive) |
| Ctrl+O in keyboard shortcuts (?) | Done   | Added to KeyboardShortcuts component              |
| Ctrl+O in /help                  | Done   | Added to Help component                           |
| Settings dialog sync             | Done   | Syncs compactMode with CompactModeContext         |
| No snapshot freezing             | Done   | Toggle always shows live output                   |
| Confirmation protection          | Done   | Force-expand + WaitingForConfirmation guard       |
| Shell protection                 | Done   | `!isEmbeddedShellFocused` force-expand            |
| Error protection                 | Done   | `!hasErrorTool` force-expand                      |
| User docs updated                | Done   | settings.md, keyboard-shortcuts.md                |

## 7. File Reference

### Qwen Code

| File                                                                  | Purpose                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/cli/src/ui/AppContainer.tsx`                                | Toggle handler, state initialization, context provider |
| `packages/cli/src/ui/contexts/CompactModeContext.tsx`                 | Context definition                                     |
| `packages/cli/src/ui/components/messages/ToolGroupMessage.tsx`        | Force-expand logic                                     |
| `packages/cli/src/ui/components/messages/ToolMessage.tsx`             | Per-tool output hiding                                 |
| `packages/cli/src/ui/components/messages/CompactToolGroupDisplay.tsx` | Compact view rendering                                 |
| `packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx` | Compact confirmation UI                                |
| `packages/cli/src/ui/components/MainContent.tsx`                      | Pending history items rendering                        |
| `packages/cli/src/ui/components/Tips.tsx`                             | Startup tip with compact mode hint                     |
| `packages/cli/src/ui/components/Help.tsx`                             | /help shortcut entry                                   |
| `packages/cli/src/ui/components/KeyboardShortcuts.tsx`                | ? shortcut entry                                       |
| `packages/cli/src/ui/components/SettingsDialog.tsx`                   | Settings sync                                          |
| `packages/cli/src/ui/components/HistoryItemDisplay.tsx`               | Thinking content hiding                                |
| `packages/cli/src/config/settingsSchema.ts`                           | Setting definition                                     |
| `packages/cli/src/config/keyBindings.ts`                              | Ctrl+O binding                                         |

### Claude Code (Reference)

| File                                               | Purpose                           |
| -------------------------------------------------- | --------------------------------- |
| `src/hooks/useGlobalKeybindings.tsx`               | Toggle handler                    |
| `src/state/AppStateStore.ts`                       | State definition (verbose: false) |
| `src/components/CtrlOToExpand.tsx`                 | Per-tool expand hint              |
| `src/components/Messages.tsx`                      | Brief message filter              |
| `src/screens/REPL.tsx`                             | Screen-level mode switching       |
| `src/components/permissions/PermissionRequest.tsx` | Overlay-based confirmation        |
