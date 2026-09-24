# Monitor delivery diagnostics and capture-event isolation

[English](2026-09-09-live-monitor-diagnostics.md) | [简体中文](2026-09-09-live-monitor-diagnostics.zh-CN.md)

The user reports that real Screen monitoring still does not trigger and capture
appears to move the orb. The full-display feature was previously verified with
inert fixtures/native compilation, not an actual desktop-to-model session.

A real synthetic probe through the production Monitor and configured DashScope
model returned wait / Reply / wait for green / red / green frames. This proves
basic visual delivery works for the configured model, not that the user's
screen capture or actual condition works. No private desktop/audio was sent.

An independent reproduction confirmed that a colorSpace-only display event
invalidated a pending frame and interrupted drag despite unchanged geometry.
Only geometry-relevant metrics and display add/remove should invalidate capture.
For those events, clamp the current logical orb position only if necessary;
keep first-launch anchoring and ordinary saved-position/layout behavior.

Existing debug modes gain metadata only: a SHA256 JPEG prefix connects Host
capture, daemon receipt and actual Monitor socket write; per-commit image/audio
counts report submitted input, and action classes distinguish wait/reply/tool
proposal/invalid output without logging text. Packet counters reset at the same
commit/clear/recycle boundaries as actual media. Queue admission is not reported
as successful socket delivery. Provider credentials and raw media stay omitted.
Native display, explicit positioning and native window-move diagnostics identify
the cause of motion without themselves moving windows.

Validate metadata/counters, capture invalidation, drag/geometry, all existing
live behavior, build and lint; repeat the independent reproduction. A separate
local native probe is prepared for a user-approved safe display, saving at most
three private local frames and event bounds, never sending desktop images to a
provider. Until that run occurs, actual screenshot-to-movement and the user's
failed visual condition remain unconfirmed. Do not change model prompts or
protocol based on those unconfirmed causes. No PR submission is part of this fix.

## Summary

The real model correctly returned wait / reply / wait for a green / red / green
sequence of synthetic images; this does not verify the user's actual desktop
path. The reproduced defect is that non-geometric display events drop frames and
interrupt dragging, so only this confirmed mechanism is fixed. Add hashes,
actually submitted frame/audio counts, model action classifications and window
coordinate logs, without recording images or speech by default. The real desktop
capture probe requires safe content prepared by the user for local verification;
it does not automatically send desktop content to a model.
