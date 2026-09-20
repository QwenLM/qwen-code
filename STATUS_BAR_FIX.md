# Status Bar Hiding Feature

## Summary

This fix adds a new setting `ui.hideStatusBar` to hide the status bar at the bottom of the terminal.

## Changes Made

1. **Added setting** in `packages/cli/src/config/settingsSchema.ts`:
   - New boolean setting `hideStatusBar` under `ui` category
   - Default: `false`
   - Requires restart: `false`
   - Shows in settings dialog

2. **Modified `OpenTuiFooter`** in `packages/cli/src/ui/opentui/opentui-footer.tsx`:
   - Added `settings: LoadedSettings` prop
   - Checks `settings.merged.ui?.hideStatusBar`
   - Returns `null` when hidden

3. **Updated tests** in `packages/cli/src/ui/opentui/opentui-footer.test.tsx`:
   - Updated all tests to pass `settings` prop
   - Added new test for `hideStatusBar` functionality

4. **Modified `OpenTuiAppShell`** in `packages/cli/src/ui/opentui/opentui-app-shell.tsx`:
   - Passed `settings` to `OpenTuiFooter`

## How to Use

### Option 1: Through Settings Dialog

1. Run `/settings` in Qwen Code
2. Search for "hideStatusBar"
3. Toggle to `true`
4. Restart Qwen Code

### Option 2: Edit Configuration File

Add to your Qwen Code config file (usually `~/.qwen/qwen.json` or similar):

```json
{
  "ui": {
    "hideStatusBar": true
  }
}
```

## Fix for Issue #6137 (Flickering)

The `hideStatusBar` setting can help reduce flickering in tmux/xterm/alacritty environments by:
- Reducing the number of elements being re-rendered
- Minimizing footer updates during streaming
- Decreasing terminal repaint overhead

Users experiencing flickering should try:
1. Enable `hideStatusBar: true`
2. Consider using `renderMode: "raw"` if not already set
3. Ensure `useTerminalBuffer: true` is set for VP mode

## Testing

Run tests:
```bash
cd packages/cli
npm test src/ui/opentui/opentui-footer.test.tsx
```

## Related Issues

- #6137: Flickering in Qwen Code (xterm/tmux/alacritty)
- #3979: Flickering in Ghostty terminal
- #8580: TUI flickering in tmux < 3.5
