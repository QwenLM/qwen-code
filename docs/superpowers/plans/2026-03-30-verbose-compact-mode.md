# Verbose / Compact Mode Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Ctrl+O hot-toggle between compact mode (default, hides tool results + thinking) and verbose mode (shows everything), persisted to settings.json.

**Architecture:** New read-only `VerboseModeContext` provides a `verboseMode: boolean` to any descendant. `AppContainer` owns the state, persists to `settings.json`, and handles the Ctrl+O keypress. Two render sites consume the context: `HistoryItemDisplay` (hides thought items) and `ToolMessage` (hides `resultDisplay`). The Footer shows a `verbose` label when active.

**Tech Stack:** React 19 + Ink 6, Vitest, ink-testing-library, existing `keyBindings` / `settingsSchema` / `historyManager` patterns.

---

## File Map

| File                                                           | Action     | Responsibility                                                          |
| -------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| `packages/cli/src/ui/contexts/VerboseModeContext.tsx`          | **CREATE** | Context definition, `useVerboseMode` hook, `VerboseModeProvider` export |
| `packages/cli/src/config/settingsSchema.ts`                    | modify     | Add `ui.verboseMode: boolean` field                                     |
| `packages/cli/src/config/keyBindings.ts`                       | modify     | Add `TOGGLE_VERBOSE_MODE` command + Ctrl+O binding                      |
| `packages/cli/src/ui/AppContainer.tsx`                         | modify     | State init, keypress handler, Provider mount                            |
| `packages/cli/src/ui/components/HistoryItemDisplay.tsx`        | modify     | Hide `gemini_thought` / `gemini_thought_content` in compact mode        |
| `packages/cli/src/ui/components/messages/ToolMessage.tsx`      | modify     | Hide `resultDisplay` in compact mode via `effectiveDisplayRenderer`     |
| `packages/cli/src/ui/components/Footer.tsx`                    | modify     | Show `verbose` label in right section when verbose mode active          |
| `packages/cli/src/i18n/locales/en.js`                          | modify     | Add 4 i18n keys                                                         |
| `packages/cli/src/i18n/locales/zh.js`                          | modify     | Add 4 i18n keys (Chinese translations)                                  |
| `packages/cli/src/i18n/locales/de.js`                          | modify     | Add 4 i18n keys (English placeholder)                                   |
| `packages/cli/src/i18n/locales/ja.js`                          | modify     | Add 4 i18n keys (English placeholder)                                   |
| `packages/cli/src/i18n/locales/ru.js`                          | modify     | Add 4 i18n keys (English placeholder)                                   |
| `packages/cli/src/i18n/locales/pt.js`                          | modify     | Add 4 i18n keys (English placeholder)                                   |
| `docs/users/reference/keyboard-shortcuts.md`                   | modify     | Update Ctrl+O description                                               |
| `packages/cli/src/ui/keyMatchers.test.ts`                      | modify     | Add 2 test cases for TOGGLE_VERBOSE_MODE binding                        |
| `packages/cli/src/ui/components/messages/ToolMessage.test.tsx` | modify     | Update `renderWithContext` + add 2 verbose mode test cases              |
| `packages/cli/src/ui/components/HistoryItemDisplay.test.tsx`   | modify     | Add 2 test cases for thought visibility                                 |
| `packages/cli/src/ui/components/Footer.test.tsx`               | modify     | Add 2 test cases for verbose indicator                                  |

---

## Task 1: Create VerboseModeContext

**Files:**

- Create: `packages/cli/src/ui/contexts/VerboseModeContext.tsx`

- [ ] **Step 1: Create the context file**

```typescript
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext } from 'react';

interface VerboseModeContextType {
  verboseMode: boolean;
}

const VerboseModeContext = createContext<VerboseModeContextType>({
  verboseMode: false, // default: compact mode
});

export const useVerboseMode = (): VerboseModeContextType =>
  useContext(VerboseModeContext);

export const VerboseModeProvider = VerboseModeContext.Provider;
```

- [ ] **Step 2: Run TypeScript check to confirm the file is valid**

```bash
cd packages/cli && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors related to VerboseModeContext.tsx

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/ui/contexts/VerboseModeContext.tsx
git commit -m "feat: add VerboseModeContext for compact/verbose toggle"
```

---

## Task 2: Add Key Binding + Failing Test

**Files:**

- Modify: `packages/cli/src/config/keyBindings.ts`
- Modify: `packages/cli/src/ui/keyMatchers.test.ts`

- [ ] **Step 1: Write the failing test first**

Open `packages/cli/src/ui/keyMatchers.test.ts` and add this `describe` block **before the final closing `});`** of the outer `describe('keyMatchers', ...)`:

```typescript
describe('TOGGLE_VERBOSE_MODE binding', () => {
  it('matches Ctrl+O', () => {
    expect(
      keyMatchers[Command.TOGGLE_VERBOSE_MODE](createKey('o', { ctrl: true })),
    ).toBe(true);
  });

  it('does not match plain O', () => {
    expect(
      keyMatchers[Command.TOGGLE_VERBOSE_MODE](createKey('o', { ctrl: false })),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm test fails** (Command.TOGGLE_VERBOSE_MODE doesn't exist yet)

```bash
cd packages/cli && npx vitest run src/ui/keyMatchers.test.ts 2>&1 | tail -20
```

Expected: TypeScript/import error — `TOGGLE_VERBOSE_MODE` is not a member of `Command`

- [ ] **Step 3: Add the enum member and binding to keyBindings.ts**

In `packages/cli/src/config/keyBindings.ts`, find line 48 (the `TOGGLE_TOOL_DESCRIPTIONS` line) and add the new enum member after it:

```typescript
// BEFORE (around line 47-49):
  // App level bindings
  TOGGLE_TOOL_DESCRIPTIONS = 'toggleToolDescriptions',
  TOGGLE_IDE_CONTEXT_DETAIL = 'toggleIDEContextDetail',

// AFTER:
  // App level bindings
  TOGGLE_TOOL_DESCRIPTIONS = 'toggleToolDescriptions',
  TOGGLE_VERBOSE_MODE = 'toggleVerboseMode',
  TOGGLE_IDE_CONTEXT_DETAIL = 'toggleIDEContextDetail',
```

Then find line 169 (the `TOGGLE_TOOL_DESCRIPTIONS` binding) and add the new binding after it:

```typescript
// BEFORE (around line 168-170):
  // App level bindings
  [Command.TOGGLE_TOOL_DESCRIPTIONS]: [{ key: 't', ctrl: true }],
  [Command.TOGGLE_IDE_CONTEXT_DETAIL]: [{ key: 'g', ctrl: true }],

// AFTER:
  // App level bindings
  [Command.TOGGLE_TOOL_DESCRIPTIONS]: [{ key: 't', ctrl: true }],
  [Command.TOGGLE_VERBOSE_MODE]: [{ key: 'o', ctrl: true }],
  [Command.TOGGLE_IDE_CONTEXT_DETAIL]: [{ key: 'g', ctrl: true }],
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
cd packages/cli && npx vitest run src/ui/keyMatchers.test.ts 2>&1 | tail -20
```

Expected: all tests pass, including the 2 new TOGGLE_VERBOSE_MODE cases

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config/keyBindings.ts packages/cli/src/ui/keyMatchers.test.ts
git commit -m "feat: add TOGGLE_VERBOSE_MODE command and Ctrl+O key binding"
```

---

## Task 3: Add Settings Schema Field

**Files:**

- Modify: `packages/cli/src/config/settingsSchema.ts`

- [ ] **Step 1: Add the verboseMode field**

In `packages/cli/src/config/settingsSchema.ts`, find the `enableUserFeedback` property block (around line 494–503) and insert the new field **after its closing `},`** and **before the `accessibility` property**:

```typescript
// BEFORE (lines 502-505):
        showInDialog: true,
      },
      accessibility: {

// AFTER:
        showInDialog: true,
      },
      verboseMode: {
        type: 'boolean',
        label: 'Verbose Mode',
        category: 'UI',
        requiresRestart: false,
        default: false,
        description:
          'Show full tool output and thinking in verbose mode (toggle with ctrl+o).',
        showInDialog: false,
      },
      accessibility: {
```

- [ ] **Step 2: Verify TypeScript can infer the new type**

```bash
cd packages/cli && npx tsc --noEmit 2>&1 | grep -i verbose
```

Expected: no output (no errors)

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/config/settingsSchema.ts
git commit -m "feat: add ui.verboseMode setting to schema"
```

---

## Task 4: Update ToolMessage — Write Failing Test, Then Implement

**Files:**

- Modify: `packages/cli/src/ui/components/messages/ToolMessage.test.tsx`
- Modify: `packages/cli/src/ui/components/messages/ToolMessage.tsx`

- [ ] **Step 1: Update renderWithContext in ToolMessage.test.tsx to include VerboseModeProvider**

The existing `renderWithContext` function (around line 104–117) must wrap with `VerboseModeProvider value={{ verboseMode: true }}` so existing tests (which test result visibility) continue to pass after we hide results in compact mode.

At the top of the file, add the import after the other context imports (around line 14):

```typescript
import { VerboseModeProvider } from '../../../ui/contexts/VerboseModeContext.js';
```

Then update `renderWithContext`:

```typescript
// BEFORE:
const renderWithContext = (
  ui: React.ReactElement,
  streamingState: StreamingState,
) => {
  const contextValue: StreamingState = streamingState;
  return render(
    <SettingsContext.Provider value={mockSettings}>
      <StreamingContext.Provider value={contextValue}>
        {ui}
      </StreamingContext.Provider>
    </SettingsContext.Provider>,
  );
};

// AFTER:
const renderWithContext = (
  ui: React.ReactElement,
  streamingState: StreamingState,
  verboseMode = true,  // default true: preserves existing test expectations
) => {
  const contextValue: StreamingState = streamingState;
  return render(
    <VerboseModeProvider value={{ verboseMode }}>
      <SettingsContext.Provider value={mockSettings}>
        <StreamingContext.Provider value={contextValue}>
          {ui}
        </StreamingContext.Provider>
      </SettingsContext.Provider>
    </VerboseModeProvider>,
  );
};
```

- [ ] **Step 2: Add the 2 verbose mode test cases**

Append this `describe` block **before the final `});`** of `describe('<ToolMessage />', ...)`:

```typescript
  describe('verbose mode', () => {
    it('hides resultDisplay in compact mode (verboseMode=false)', () => {
      const { lastFrame } = renderWithContext(
        <ToolMessage
          {...baseProps}
          resultDisplay="unique-tool-output-xyz"
        />,
        StreamingState.Idle,
        false, // compact mode
      );
      expect(lastFrame()).not.toContain('unique-tool-output-xyz');
    });

    it('shows resultDisplay in verbose mode (verboseMode=true)', () => {
      const { lastFrame } = renderWithContext(
        <ToolMessage
          {...baseProps}
          resultDisplay="unique-tool-output-xyz"
        />,
        StreamingState.Idle,
        true, // verbose mode
      );
      expect(lastFrame()).toContain('MockMarkdown:unique-tool-output-xyz');
    });
  });
```

- [ ] **Step 3: Run to confirm compact mode test FAILS (result still visible)**

```bash
cd packages/cli && npx vitest run src/ui/components/messages/ToolMessage.test.tsx 2>&1 | tail -30
```

Expected: "hides resultDisplay in compact mode" test FAILS with "expected string not to contain 'unique-tool-output-xyz'"

- [ ] **Step 4: Implement the compact mode filter in ToolMessage.tsx**

In `packages/cli/src/ui/components/messages/ToolMessage.tsx`, at the top of the file add the import after the other context imports:

```typescript
import { useVerboseMode } from '../../contexts/VerboseModeContext.js';
```

Then, inside the `ToolMessage` component function, add the hook call and `effectiveDisplayRenderer` computation immediately after the existing `const displayRenderer = useResultDisplayRenderer(resultDisplay);` line:

```typescript
const { verboseMode } = useVerboseMode();
const effectiveDisplayRenderer = verboseMode
  ? displayRenderer
  : { type: 'none' as const };
```

Then find the JSX at line 347 that reads `{displayRenderer.type !== 'none' && (` and replace `displayRenderer` with `effectiveDisplayRenderer`:

```typescript
// BEFORE:
      {displayRenderer.type !== 'none' && (

// AFTER:
      {effectiveDisplayRenderer.type !== 'none' && (
```

- [ ] **Step 5: Run the test to confirm all ToolMessage tests pass**

```bash
cd packages/cli && npx vitest run src/ui/components/messages/ToolMessage.test.tsx 2>&1 | tail -20
```

Expected: all tests pass including the 2 new verbose mode cases

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/ui/components/messages/ToolMessage.tsx packages/cli/src/ui/components/messages/ToolMessage.test.tsx
git commit -m "feat: hide tool result display in compact mode"
```

---

## Task 5: Update HistoryItemDisplay — Write Failing Test, Then Implement

**Files:**

- Modify: `packages/cli/src/ui/components/HistoryItemDisplay.test.tsx`
- Modify: `packages/cli/src/ui/components/HistoryItemDisplay.tsx`

- [ ] **Step 1: Add the import and 2 failing test cases to HistoryItemDisplay.test.tsx**

At the top, add the import alongside the other imports (around line 11):

```typescript
import { VerboseModeProvider } from '../../contexts/VerboseModeContext.js';
```

Add this `describe` block **before the final `});`** of the outer `describe('<HistoryItemDisplay />', ...)`:

```typescript
  describe('verbose mode — thought rendering', () => {
    const thoughtItem: HistoryItem = {
      ...baseItem,
      type: 'gemini_thought',
      text: 'thinking-text-xyz',
    };

    it('hides gemini_thought in compact mode', () => {
      const { lastFrame } = renderWithProviders(
        <VerboseModeProvider value={{ verboseMode: false }}>
          <HistoryItemDisplay
            item={thoughtItem}
            isPending={false}
            availableTerminalHeight={24}
            terminalWidth={80}
          />
        </VerboseModeProvider>,
        { config: mockConfig },
      );
      expect(lastFrame()).not.toContain('thinking-text-xyz');
    });

    it('shows gemini_thought in verbose mode', () => {
      const { lastFrame } = renderWithProviders(
        <VerboseModeProvider value={{ verboseMode: true }}>
          <HistoryItemDisplay
            item={thoughtItem}
            isPending={false}
            availableTerminalHeight={24}
            terminalWidth={80}
          />
        </VerboseModeProvider>,
        { config: mockConfig },
      );
      expect(lastFrame()).toContain('thinking-text-xyz');
    });
  });
```

- [ ] **Step 2: Run to confirm compact mode test FAILS**

```bash
cd packages/cli && npx vitest run src/ui/components/HistoryItemDisplay.test.tsx 2>&1 | tail -20
```

Expected: "hides gemini_thought in compact mode" FAILS — thought is currently always rendered

- [ ] **Step 3: Implement the compact mode filter in HistoryItemDisplay.tsx**

Add the import at the top of the file alongside the other local imports:

```typescript
import { useVerboseMode } from '../contexts/VerboseModeContext.js';
```

Add the hook call inside the component function, immediately after the existing `const contentWidth = terminalWidth - 4;` line:

```typescript
const { verboseMode } = useVerboseMode();
```

Then modify the `gemini_thought` render block (around line 116). Replace:

```typescript
      {itemForDisplay.type === 'gemini_thought' && (
        <ThinkMessage
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
        />
      )}
```

With:

```typescript
      {verboseMode && itemForDisplay.type === 'gemini_thought' && (
        <ThinkMessage
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
        />
      )}
```

Then modify the `gemini_thought_content` render block (around line 126). Replace:

```typescript
      {itemForDisplay.type === 'gemini_thought_content' && (
        <ThinkMessageContent
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
        />
      )}
```

With:

```typescript
      {verboseMode && itemForDisplay.type === 'gemini_thought_content' && (
        <ThinkMessageContent
          text={itemForDisplay.text}
          isPending={isPending}
          availableTerminalHeight={
            availableTerminalHeightGemini ?? availableTerminalHeight
          }
          contentWidth={contentWidth}
        />
      )}
```

- [ ] **Step 4: Run to confirm all HistoryItemDisplay tests pass**

```bash
cd packages/cli && npx vitest run src/ui/components/HistoryItemDisplay.test.tsx 2>&1 | tail -20
```

Expected: all tests pass including the 2 new verbose mode cases

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/components/HistoryItemDisplay.tsx packages/cli/src/ui/components/HistoryItemDisplay.test.tsx
git commit -m "feat: hide thinking chain in compact mode"
```

---

## Task 6: Update AppContainer — State, Handler, Provider

**Files:**

- Modify: `packages/cli/src/ui/AppContainer.tsx`

- [ ] **Step 1: Add the VerboseModeProvider import**

At the top of `packages/cli/src/ui/AppContainer.tsx`, add the import alongside the other context imports (search for `VimModeContext` or `UIStateContext` imports):

```typescript
import { VerboseModeProvider } from './contexts/VerboseModeContext.js';
```

- [ ] **Step 2: Add verboseMode state initialization**

Find the existing `showToolDescriptions` state (around line 963):

```typescript
const [showToolDescriptions, setShowToolDescriptions] =
  useState<boolean>(false);
```

Add the `verboseMode` state immediately after it:

```typescript
const [verboseMode, setVerboseMode] = useState<boolean>(
  settings.merged.ui?.verboseMode ?? false,
);
```

- [ ] **Step 3: Add the Ctrl+O keypress handler**

Find the `if (keyMatchers[Command.TOGGLE_TOOL_DESCRIPTIONS](key)) {` block (around line 1327) and add the new handler as a new `if` block right after the closing `}` of that block (before the next `} else if`):

```typescript
if (keyMatchers[Command.TOGGLE_VERBOSE_MODE](key)) {
  const newValue = !verboseMode;
  setVerboseMode(newValue);
  settings.setValue(SettingScope.User, 'ui.verboseMode', newValue);
  historyManager.addItem(
    {
      type: MessageType.INFO,
      text: newValue
        ? t('Verbose mode on — showing full tool output and thinking')
        : t('Compact mode on — showing tool names and final responses only'),
    },
    Date.now(),
  );
}
```

- [ ] **Step 4: Add verboseMode to the useCallback dependency array**

Find the dependency array of `handleGlobalKeypress` (the `useCallback` that contains the key handler). It starts around line 1352. Add `verboseMode` and `setVerboseMode` to the array, alongside `showToolDescriptions` and `setShowToolDescriptions`:

```typescript
// Find this in the deps array and add verboseMode, setVerboseMode next to it:
      showToolDescriptions,
      setShowToolDescriptions,
      verboseMode,       // ADD THIS
      setVerboseMode,    // ADD THIS
```

- [ ] **Step 5: Wrap with VerboseModeProvider in the JSX return**

Find the JSX return (around line 1800). Locate this block:

```tsx
<ShellFocusContext.Provider value={isFocused}>
  <App />
</ShellFocusContext.Provider>
```

Replace it with:

```tsx
<VerboseModeProvider value={{ verboseMode }}>
  <ShellFocusContext.Provider value={isFocused}>
    <App />
  </ShellFocusContext.Provider>
</VerboseModeProvider>
```

- [ ] **Step 6: Run TypeScript check**

```bash
cd packages/cli && npx tsc --noEmit 2>&1 | grep -i verbose
```

Expected: no output (no errors)

- [ ] **Step 7: Run all CLI tests to catch regressions**

```bash
cd packages/cli && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/ui/AppContainer.tsx
git commit -m "feat: wire VerboseModeContext into AppContainer with Ctrl+O toggle and settings persistence"
```

---

## Task 7: Update Footer — Write Failing Test, Then Implement

**Files:**

- Modify: `packages/cli/src/ui/components/Footer.test.tsx`
- Modify: `packages/cli/src/ui/components/Footer.tsx`

- [ ] **Step 1: Add the import and 2 failing test cases to Footer.test.tsx**

At the top, add the import alongside the other context imports:

```typescript
import { VerboseModeProvider } from '../../contexts/VerboseModeContext.js';
```

Add this `describe` block **before the final `});`** of `describe('<Footer />', ...)`:

```typescript
  describe('verbose mode indicator', () => {
    it('shows verbose label when verboseMode=true', () => {
      useTerminalSizeMock.mockReturnValue({ columns: 120, rows: 24 });
      const { lastFrame } = render(
        <VerboseModeProvider value={{ verboseMode: true }}>
          <ConfigContext.Provider value={createMockConfig() as never}>
            <VimModeProvider settings={createMockSettings()}>
              <UIStateContext.Provider value={createMockUIState()}>
                <Footer />
              </UIStateContext.Provider>
            </VimModeProvider>
          </ConfigContext.Provider>
        </VerboseModeProvider>,
      );
      expect(lastFrame()).toContain('verbose');
    });

    it('hides verbose label when verboseMode=false', () => {
      useTerminalSizeMock.mockReturnValue({ columns: 120, rows: 24 });
      const { lastFrame } = render(
        <VerboseModeProvider value={{ verboseMode: false }}>
          <ConfigContext.Provider value={createMockConfig() as never}>
            <VimModeProvider settings={createMockSettings()}>
              <UIStateContext.Provider value={createMockUIState()}>
                <Footer />
              </UIStateContext.Provider>
            </VimModeProvider>
          </ConfigContext.Provider>
        </VerboseModeProvider>,
      );
      expect(lastFrame()).not.toContain('verbose');
    });
  });
```

- [ ] **Step 2: Run to confirm verbose=true test FAILS**

```bash
cd packages/cli && npx vitest run src/ui/components/Footer.test.tsx 2>&1 | tail -20
```

Expected: "shows verbose label when verboseMode=true" FAILS — Footer doesn't show 'verbose' yet

- [ ] **Step 3: Implement the verbose label in Footer.tsx**

Add the import at the top of `packages/cli/src/ui/components/Footer.tsx`:

```typescript
import { useVerboseMode } from '../contexts/VerboseModeContext.js';
```

Inside the `Footer` component function, add the hook call after the existing `const { vimEnabled, vimMode } = useVimMode();` line:

```typescript
const { verboseMode } = useVerboseMode();
```

Find the `rightItems` push block (the one for context usage, ending around line 94). After its closing `}` add:

```typescript
  if (verboseMode) {
    rightItems.push({
      key: 'verbose',
      node: <Text color={theme.text.accent}>{t('verbose')}</Text>,
    });
  }
```

- [ ] **Step 4: Run to confirm all Footer tests pass**

```bash
cd packages/cli && npx vitest run src/ui/components/Footer.test.tsx 2>&1 | tail -20
```

Expected: all tests pass. Note: the golden snapshot tests (`toMatchSnapshot`) may need updating because the footer layout changed slightly — if so, run `npx vitest run --update-snapshots src/ui/components/Footer.test.tsx` to update them, review the diff, and accept if correct.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/components/Footer.tsx packages/cli/src/ui/components/Footer.test.tsx
git commit -m "feat: add verbose mode indicator to Footer"
```

---

## Task 8: Add i18n Keys

**Files:**

- Modify: `packages/cli/src/i18n/locales/en.js`
- Modify: `packages/cli/src/i18n/locales/zh.js`
- Modify: `packages/cli/src/i18n/locales/de.js`
- Modify: `packages/cli/src/i18n/locales/ja.js`
- Modify: `packages/cli/src/i18n/locales/ru.js`
- Modify: `packages/cli/src/i18n/locales/pt.js`

- [ ] **Step 1: Add keys to en.js**

In `packages/cli/src/i18n/locales/en.js`, find the final line before the closing `};` (currently line 1991) and insert the 4 new keys:

```javascript
  'Verbose mode on — showing full tool output and thinking':
    'Verbose mode on — showing full tool output and thinking',
  'Compact mode on — showing tool names and final responses only':
    'Compact mode on — showing tool names and final responses only',
  'verbose': 'verbose',
  'Show full tool output and thinking in verbose mode (toggle with ctrl+o).':
    'Show full tool output and thinking in verbose mode (toggle with ctrl+o).',
```

- [ ] **Step 2: Add keys to zh.js**

In `packages/cli/src/i18n/locales/zh.js`, find the final line before `};` and insert:

```javascript
  'Verbose mode on — showing full tool output and thinking':
    '已切换到详细模式 — 完整显示工具输出和思考过程',
  'Compact mode on — showing tool names and final responses only':
    '已切换到精简模式 — 仅显示工具名称和最终回答',
  'verbose': '详细',
  'Show full tool output and thinking in verbose mode (toggle with ctrl+o).':
    '详细模式下显示完整工具输出和思考过程（ctrl+o 切换）。',
```

- [ ] **Step 3: Add keys to de.js, ja.js, ru.js, pt.js (English placeholders)**

For each of these 4 files, find the final line before `};` and insert:

```javascript
  'Verbose mode on — showing full tool output and thinking':
    'Verbose mode on — showing full tool output and thinking',
  'Compact mode on — showing tool names and final responses only':
    'Compact mode on — showing tool names and final responses only',
  'verbose': 'verbose',
  'Show full tool output and thinking in verbose mode (toggle with ctrl+o).':
    'Show full tool output and thinking in verbose mode (toggle with ctrl+o).',
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/i18n/locales/
git commit -m "feat: add i18n keys for verbose/compact mode messages"
```

---

## Task 9: Update Keyboard Shortcuts Documentation

**Files:**

- Modify: `docs/users/reference/keyboard-shortcuts.md`

- [ ] **Step 1: Update the Ctrl+O entry**

In `docs/users/reference/keyboard-shortcuts.md`, find line 13:

```
| `Ctrl+O`                       | Toggle the display of the debug console.                                                                              |
```

Replace with:

```
| `Ctrl+O`                       | Toggle verbose mode (show/hide full tool output and thinking).                                                        |
```

- [ ] **Step 2: Commit**

```bash
git add docs/users/reference/keyboard-shortcuts.md
git commit -m "docs: update Ctrl+O keyboard shortcut description for verbose mode"
```

---

## Task 10: Full Test Suite Verification

- [ ] **Step 1: Run all CLI unit tests**

```bash
cd packages/cli && npx vitest run 2>&1 | tail -30
```

Expected: all tests pass, no failures

- [ ] **Step 2: Run TypeScript check for the entire CLI package**

```bash
cd packages/cli && npx tsc --noEmit 2>&1
```

Expected: no output (zero errors)

- [ ] **Step 3: Run TypeScript check for core package**

```bash
cd packages/core && npx tsc --noEmit 2>&1
```

Expected: no output (zero errors)

- [ ] **Step 4: Commit a final summary if needed**

If the previous tasks' commits cover all changes and tests pass, no additional commit is needed. Otherwise:

```bash
git add -p  # review and stage any remaining unstaged changes
git commit -m "test: verify full test suite passes for verbose mode feature"
```

---

## Acceptance Checklist

After all tasks are complete, verify against the spec:

- [ ] Default startup is compact mode (tool results hidden, no verbose label in Footer)
- [ ] Ctrl+O toggles to verbose mode (tool results visible, verbose label appears, info message shown)
- [ ] Ctrl+O again returns to compact mode (tool results hidden again, label gone, info message shown)
- [ ] `settings.json` contains `"verboseMode": true` after switching to verbose mode
- [ ] Restarting qwen-code preserves the mode (footer shows verbose label on restart if set)
- [ ] Thinking chain (`gemini_thought`) is hidden in compact, visible in verbose
- [ ] Pre-switch history (Static content) is NOT retroactively affected by mode change
- [ ] All 8 new test cases pass
- [ ] Zero TypeScript errors
- [ ] Zero test regressions
