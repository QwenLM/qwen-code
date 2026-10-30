# Web Shell response speed

[中文](./2026-10-15-web-shell-response-speed.zh-CN.md)

## Problem

Issue #14226: Web Shell exposes `ui.showResponseTokensPerSecond` in Settings,
but its streaming status never consumes the setting.

## Design

Read the effective setting from the existing Web Shell settings resource and
apply that App-level preference to the single-session status and all split-view
panes. The default remains
disabled. Use each status instance's existing estimated output token count and
turn timer to display the average in `t/s`, matching the terminal's rounding.
Show the rate only while receiving response content with positive elapsed time.
Idle, waiting, and disabled states omit it. No new setting or backend field is
needed.

## Verification

Check enabled/disabled rendering, low and high rates, waiting and idle states,
and a new turn's timer. Exercise the real settings-to-renderer path in the Web
Shell browser fixture, including split view. Run the same visible enabled case
against the base to prove the missing indicator, then against the candidate.

## Limits

The value uses the existing estimated token counter and elapsed turn time; it
is not a provider-reported instantaneous generation speed. Settings retain the
Web Shell's existing effective workspace/user resolution.
