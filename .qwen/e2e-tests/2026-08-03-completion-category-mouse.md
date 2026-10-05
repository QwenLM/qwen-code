# Completion Category Mouse Selection

## Scope

Verify that the tabbed `@` completion picker can switch to an exact category
with a mouse click when terminal mouse tracking is enabled. Keyboard category
navigation and suggestion-row mouse behavior must remain unchanged.

## Baseline

A released global `qwen` executable was not available in this environment, so
the before-change Warp dry-run could not be repeated locally. The issue's SGR
mouse reproduction reports that suggestion rows accept clicks while category
labels do not. Source inspection on `upstream/main` confirms that suggestion
rows have a mouse controller, while category labels have no refs or click
handler.

## Manual Scenario

1. Run Qwen Code in Warp with `ui.mouseTracking` enabled and the terminal
   buffer enabled.
2. Open a workspace where `@` completion shows at least three tabs, such as
   **All / Files / Sessions**.
3. Click **Files**, then **Sessions**, then **All**.
4. Confirm that each click activates the exact tab under the pointer, resets
   the highlighted suggestion to the first visible result, and filters the
   suggestion rows for that category.
5. Confirm that clicking outside every tab does not change the active tab.
6. While the tab bar is visible, confirm that bare `Left` / `Right` cycles the
   categories. Press `Esc` to dismiss the picker and confirm the arrows return
   to normal input-caret behavior.
7. Set `ui.mouseTracking` to `false`, restart Qwen Code, and confirm that tab
   clicks are not intercepted by Qwen Code.

## Regression Checks

- Only a left-button press activates a category; pointer movement and button
  release do not.
- The category hit area follows the rendered tab bounds in both normal and
  overflow layouts.
- Suggestion-row hover and click handling still use their existing controller.
- Export completion, command search, and reverse search do not receive a
  category-selection callback.

## Automated Verification

```bash
cd packages/cli
npx vitest run \
  src/ui/components/CompletionCategoryMouseController.test.tsx \
  src/ui/components/SuggestionsDisplay.mouse.test.tsx \
  src/ui/components/InputPrompt.suggestionMouse.test.tsx \
  src/ui/hooks/useCompletion.test.ts

cd ../..
npm run lint
npm run build
npm run typecheck
```

## Results

- The focused mouse/category regression suite passes: 4 files, 41 tests.
- Repository lint, build, and typecheck pass.
- Manual Warp execution remains for reviewer verification because Warp and a
  released global `qwen` executable were not available in this environment.
