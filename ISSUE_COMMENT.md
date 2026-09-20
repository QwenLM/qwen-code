# Comment to post on Issue #6137

## Title: Fix for status bar hiding - reduces flickering in terminal environments

This PR implements a new `ui.hideStatusBar` setting that can help reduce flickering in tmux/xterm/alacritty environments.

### What changed:

1. **New setting**: `ui.hideStatusBar` (boolean, default: false)
   - Hides the status bar at the bottom of the terminal
   - Reduces render overhead during streaming

2. **Files modified**:
   - `packages/cli/src/config/settingsSchema.ts` - Added setting definition
   - `packages/cli/src/ui/opentui/opentui-footer.tsx` - Implemented hide logic
   - `packages/cli/src/ui/opentui/opentui-app-shell.tsx` - Passed settings prop
   - `packages/cli/src/ui/opentui/opentui-footer.test.tsx` - Added tests

### How to test:

1. Enable the setting in your config:
   ```json
   {
     "ui": {
       "hideStatusBar": true
     }
   }
   ```

2. Restart Qwen Code

3. Test in your terminal environment (tmux/xterm/alacritty)

### Why this helps with flickering:

- Fewer elements to re-render during streaming
- Reduced footer updates
- Less terminal repaint overhead

### Related:
- Issue: #6137 (Flickering in Qwen Code)
- Tested in: xterm, alacritty, tmux environments

---

**Tagged users**: @klobastov @chiga0 @leondimitrios
