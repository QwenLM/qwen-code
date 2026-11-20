# Web Shell first-prompt titles

[English](web-shell-first-prompt-title.md) | [简体中文](web-shell-first-prompt-title.zh-CN.md)

## Problem

Submitting the first prompt creates the daemon session. Web Shell used to
await a metadata PATCH for short, prompt-derived titles before attaching
the session and sending the prompt. A slow title write extended the
composer's preparing state.

## Design

On allocation, the workspace catalog can display the draft's provisional
title. Web Shell starts persistence in the background through the newly
allocated session client. The existing [first-prompt navigation flow](web-shell-first-prompt-navigation.md)
uses that session even when creation finishes after the user switches away.
The host's `onSessionCreated` callback and a manual title carried by
`/clear` keep their existing preparation order.

The owner-scoped metadata PATCH sends a distinct `initialDisplayName` field.
An older daemon or ACP worker receives no `displayName` to treat as an
unconditional rename. The handler starts the ACP write and releases the
session lease while persistence runs. The recorder checks pending writes
and existing titles before queuing the automatic title. Explicit renames
received later can append their titles through the same recording queue.

After persistence succeeds, the bridge refreshes the catalog revision and
publishes the title event only if the same session owner is still active
and the live session has no newer title. The browser reconciles names from
daemon events and catalog reads, so a delayed PATCH response cannot restore
an older title in the UI.

## Acceptance

- With the title PATCH held open, Chromium observes the first prompt reach
  the daemon and receive HTTP 202 before the title response.
- Switching sessions during creation leaves the selected session visible.
  The first prompt reaches the allocated session exactly once.
- With the automatic PATCH held before application, perform a manual
  rename, release the PATCH, and check that the catalog and stored title
  show the manual name.
