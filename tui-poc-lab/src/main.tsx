/**
 * POC entry point. Run with:  bun src/main.tsx
 *
 * Renderer config notes:
 *  - targetFps 60: frame budget; the Zig core coalesces all React commits per frame.
 *  - useMouse: enables ?1000h+?1002h+?1003h+?1006h (opentui default incl. movement).
 *  - externalOutputMode "passthrough": stray console output goes above the frame
 *    instead of opening the console overlay.
 *  - DEC 2026 synchronized output + cell-level diff are handled inside the
 *    native renderer (this is what kills the Warp/Tabby flicker).
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { applyThemeMode } from "./theme";

const renderer = await createCliRenderer({
  targetFps: 60,
  useKittyKeyboard: {},
  useMouse: true,
  exitOnCtrlC: false,
  externalOutputMode: "passthrough",
  autoFocus: true,
});

// Detect terminal light/dark theme before first paint (OSC 10/11 query).
// POC_THEME env override for testing: POC_THEME=light|dark.
const mode =
  process.env.POC_THEME === "light" || process.env.POC_THEME === "dark"
    ? process.env.POC_THEME
    : await renderer.waitForThemeMode(1000);
applyThemeMode(mode);

createRoot(renderer).render(<App />);
