# Live bilingual text, input animation and movable settings

## User-visible scope

Increase normal microphone-level orb animation without changing captured audio.
Add Simplified Chinese and English to the last Settings group. The first init
question selects these languages with left/right keys, before the setup banner
or overwrite prompt; all subsequent fixed wizard text follows that choice.
Use one editable, browser-safe typed catalogue with English/Chinese pairs for
Live Host, setup, native menus, status/error messages and CLI user guidance.
User data, device/model names, transcripts, provider error detail and model
prompts remain unchanged. Existing configs default to English; a fresh init
offers Chinese first. The setting is independent of Memory and may change
during a call without reconnecting media or changing model settings.

## Ownership and integration

The canonical dictionary is `packages/qwen-live/src/i18n/messages.ts`, exported
through the package's public `./i18n` entry. Host build/type aliases compile this
same pure module into its standalone bundle, without Electron dependencies in
root workspaces or a new runtime package installation. No duplicate dictionary
or cross-package relative production import is introduced.

Top-level Live config stores `language: 'en' | 'zh-CN'`. The authenticated Host
protocol advertises an optional language setting, distinct from Memory, and
uses correlated request/result messages. Writes atomically merge with config,
preserving credentials and unrelated preferences, and only confirmed state is
applied. Legacy daemons do not acquire permission to write standalone config;
Host can retain its local language preference when no supporting daemon is
present, while a connected standalone daemon's setting is authoritative.

Display messages use stable IDs and parameter substitution. Fixed native and
daemon failures visible in UI are included; unowned external detail is left
unchanged. Switching language updates text/ARIA/title in existing DOM nodes,
without rebuilding controls, losing drafts, changing device IDs or stopping
camera preview. Tests enumerate catalogue keys and placeholders in both locales.

## Settings placement and dragging

Reuse the current authenticated renderer drag channel with a title-bar drag
handle, excluding buttons and inputs. Retain shared desired position unless
the user chooses otherwise; temporary opening clamps must not overwrite it.
Constrain CSS tracks and nested content so long names or translated strings
cannot widen the panel. Verify both native bounds and actual painted DOM bounds.
Ensure native full-panel placement completes before displaying Settings, with
cancel/disconnect guards, if the edge-opening timing reproduction confirms it.
Keep Escape, outside click and focus return. No real device/provider action is
needed for validation.

## Animation

Use a bounded nonlinear visual gain for normal small peaks, fast attack and
slower release. Keep silence at base scale and reset on mute/stop. The maximal
visual envelope, including outline, remains inside the existing motion area;
do not increase input gain, alter PCM or change daemon call-state semantics.

## Verification

Independent pre-fix probes already show no Settings drag events and only
0.67/1.34px diameter increase at microphone peaks 0.05/0.1. Init and Settings
have no language choice. Use source/DOM/native fixtures for UI because the
global CLI cannot expose this standalone native overlay. Test real terminal
left/right selection with isolated config and no installer/provider calls;
test runtime persistence, invalid/stale requests, disconnect, and reload.
Run scoped package tests, root build/typecheck/bundle, Host build, applicable
format/lint checks and two final review passes. No clean/reinstall, release,
user config modification or model/device use.
